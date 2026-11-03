import { getRuntimeEndpointGeneration } from '@varin/application-client';
import React, { useSyncExternalStore } from 'react';
import { assertExtensionCodeReview, type ExtensionCodeReview } from './code-trust';
import type {
  VarinExtensionCandidateCapabilityReviewRequest,
  VarinExtensionCapabilityReviewRequest,
  VarinExtensionCatalogSnapshot,
  VarinExtensionHostStateSnapshot,
  VarinExtensionPackageSource,
  VarinExtensionServiceRoutingContext,
} from '@varin/extension-contract';
import { parseVarinExtensionServiceRoutingRule, serviceRoutingRuleKey } from '@varin/extension-contract';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { VARIN_AGENT_DRIVER_SERVICE_ID } from '@varin/extension-contract';

export interface VarinExtensionCatalogStoreState {
  busyExtensionId: string | null;
  error: string | null;
  loading: boolean;
  snapshot: VarinExtensionHostStateSnapshot | null;
}

const initialState = (): VarinExtensionCatalogStoreState => ({
  busyExtensionId: null,
  error: null,
  loading: false,
  snapshot: null,
});

let state = initialState();
let generation = 0;
let startPromise: Promise<void> | null = null;
let watchController: AbortController | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
let catalogConsumers = 0;
const listeners = new Set<() => void>();

interface CatalogSurfaceRuntime {
  applyCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
    expectedHostId?: string,
    api?: ReturnType<typeof extensionsApi>,
  ): Promise<VarinExtensionCatalogSnapshot>;
  refresh(): Promise<void>;
}

let catalogSurfaceRuntimeOverride: CatalogSurfaceRuntime | null = null;

const catalogSurfaceRuntime = async (): Promise<CatalogSurfaceRuntime> => {
  if (catalogSurfaceRuntimeOverride) return catalogSurfaceRuntimeOverride;
  const runtime = await import('./managed-runtime');
  return {
    applyCandidate: (extensionId, candidateIntegrity, expectedRevision, expectedHostId, api) => (
      runtime.applySurfaceExtensionCandidate(extensionId, candidateIntegrity, expectedRevision, expectedHostId, api)
    ),
    refresh: runtime.refreshSurfaceExtensions,
  };
};

const defaultWatchRetry = (attempt: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) {
    resolve();
    return;
  }
  // This is transport backoff, not a lifecycle timeout or retry ceiling. A healthy Host-state
  // response resets it immediately; repeated failures never make the watcher give up.
  const delayMs = Math.min(10_000, 250 * (2 ** Math.min(attempt - 1, 6)));
  const timeout = setTimeout(done, delayMs);
  const onAbort = () => done();
  function done(): void {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
    resolve();
  }
  signal.addEventListener('abort', onAbort, { once: true });
});

const extensionsApi = () => {
  const api = getRegisteredRuntimeAPIs()?.extensions;
  if (!api) throw new Error('Varin application-host extension API is unavailable');
  return api;
};

const publish = (next: VarinExtensionCatalogStoreState): void => {
  state = next;
  for (const listener of listeners) listener();
};

const acceptSnapshot = (snapshot: VarinExtensionHostStateSnapshot, requestGeneration: number): boolean => {
  if (requestGeneration !== generation) return false;
  const current = state.snapshot;
  if (
    current
    && current.catalog.hostId === snapshot.catalog.hostId
    && (snapshot.revision < current.revision || snapshot.catalog.revision < current.catalog.revision)
  ) return false;
  publish({ ...state, error: null, loading: false, snapshot });
  return true;
};

const watch = async (requestGeneration: number, controller: AbortController): Promise<void> => {
  let consecutiveFailures = 0;
  for (;;) {
    if (controller.signal.aborted || requestGeneration !== generation) return;
    try {
      const current = state.snapshot;
      if (!current) return;
      // A failed long-poll may have crossed a Host restart. Re-establish an authoritative baseline
      // before sending another wait request instead of reusing the old Host identity/revision.
      const next = consecutiveFailures > 0
        ? await extensionsApi().hostState()
        : await extensionsApi().waitForHostState({
          hostId: current.catalog.hostId,
          revision: current.revision,
        }, controller.signal);
      if (controller.signal.aborted || requestGeneration !== generation) return;
      if (!acceptSnapshot(next, requestGeneration)) {
        if (requestGeneration !== generation) return;
        continue;
      }
      consecutiveFailures = 0;
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation) return;
      const failedDuringBaseline = consecutiveFailures > 0;
      consecutiveFailures += 1;
      if (consecutiveFailures === 1) {
        publish({
          ...state,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
      }
      // Re-fetching the authoritative baseline is the first recovery step after a failed
      // long-poll. Back off only when that recovery read also fails.
      if (failedDuringBaseline) await defaultWatchRetry(consecutiveFailures, controller.signal);
    }
  }
};

const loadInitialSnapshot = async (
  requestGeneration: number,
  controller: AbortController,
): Promise<void> => {
  let consecutiveFailures = 0;
  for (;;) {
    if (controller.signal.aborted || requestGeneration !== generation) return;
    try {
      const snapshot = await extensionsApi().hostState();
      if (controller.signal.aborted || requestGeneration !== generation) return;
      if (!acceptSnapshot(snapshot, requestGeneration)) return;
      void watch(requestGeneration, controller).catch((error) => {
        if (controller.signal.aborted || requestGeneration !== generation) return;
        publish({ ...state, error: error instanceof Error ? error.message : String(error), loading: false });
        startPromise = null;
      });
      return;
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation) return;
      consecutiveFailures += 1;
      publish({
        ...state,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
      await defaultWatchRetry(consecutiveFailures, controller.signal);
    }
  }
};

export const startVarinExtensionCatalog = (): Promise<void> => {
  if (startPromise) return startPromise;
  const requestGeneration = ++generation;
  watchController?.abort('Varin extension catalog restarted');
  const controller = new AbortController();
  watchController = controller;
  publish({ ...state, error: null, loading: true });
  const operation = loadInitialSnapshot(requestGeneration, controller);
  startPromise = operation;
  return operation;
};

export const stopVarinExtensionCatalog = (): void => {
  generation += 1;
  watchController?.abort('Varin extension catalog stopped');
  watchController = null;
  startPromise = null;
  if (state.loading) publish({ ...state, loading: false });
};

export const refreshVarinExtensionCatalog = async (): Promise<void> => {
  const requestGeneration = generation;
  try {
    const snapshot = await extensionsApi().hostState();
    acceptSnapshot(snapshot, requestGeneration);
  } catch (error) {
    if (requestGeneration === generation) {
      publish({ ...state, error: error instanceof Error ? error.message : String(error), loading: false });
    }
    throw error;
  }
};

const runMutation = (
  extensionId: string,
  mutate: (snapshot: VarinExtensionCatalogSnapshot, api: ReturnType<typeof extensionsApi>, assertCurrentHost: () => void) => Promise<VarinExtensionCatalogSnapshot>,
  refreshAfter = true,
  expectedHostId?: string,
): Promise<void> => {
  const operation = mutationQueue.then(async () => {
    await startVarinExtensionCatalog();
    let current = state.snapshot;
    if (!current) throw new Error('Varin extension catalog is unavailable');
    const requestGeneration = generation;
    const api = extensionsApi(), endpointGeneration = getRuntimeEndpointGeneration();
    const assertCurrentHost = () => {
      if (expectedHostId !== undefined && (api !== extensionsApi() || endpointGeneration !== getRuntimeEndpointGeneration())) {
        throw new Error('Application Host changed after code confirmation. Review this action on the current Host.');
      }
    };
    publish({ ...state, busyExtensionId: extensionId, error: null });
    try {
      if (expectedHostId !== undefined) {
        // A reconnect can leave a previous Host snapshot on screen. Check the real current endpoint,
        // not just that cached display, before interpreting its code confirmation as admission.
        const observed = await api.hostState();
        assertCurrentHost();
        if (observed.catalog.hostId !== expectedHostId) throw new Error('Application Host changed after code confirmation. Review this action on the current Host.');
        if (!observed.catalog.authoritative) throw new Error('Extension catalog is not authoritative. Refresh before reviewing code.');
        current = observed;
        acceptSnapshot(observed, requestGeneration);
      }
      const catalog = await mutate(current.catalog, api, assertCurrentHost);
      if (requestGeneration !== generation || state.snapshot?.catalog.hostId !== catalog.hostId) return;
      if (!state.snapshot || catalog.revision >= state.snapshot.catalog.revision) {
        publish({
          ...state,
          snapshot: state.snapshot ? { ...state.snapshot, catalog } : state.snapshot,
        });
      }
      if (refreshAfter) {
        const refreshed = await extensionsApi().hostState();
        acceptSnapshot(refreshed, requestGeneration);
      }
    } catch (error) {
      if (requestGeneration === generation) {
        const message = error instanceof Error ? error.message : String(error);
        await refreshVarinExtensionCatalog().catch(() => undefined);
        if (requestGeneration === generation) publish({ ...state, error: message });
      }
      throw error;
    } finally {
      if (requestGeneration === generation && state.busyExtensionId === extensionId) {
        publish({ ...state, busyExtensionId: null });
      }
    }
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
};

export const setVarinExtensionEnabled = (
  extensionId: string,
  enabled: boolean,
  codeReview?: ExtensionCodeReview,
): Promise<void> => {
  const capturedReview = codeReview ? structuredClone(codeReview) : undefined;
  return runMutation(extensionId, (catalog, api) => {
    if (enabled && capturedReview) {
      assertExtensionCodeReview(catalog, capturedReview);
      if (!capturedReview.artifacts.some(artifact => artifact.extensionId === extensionId)) {
        throw new Error('The code confirmation did not include this extension.');
      }
    }
    return api.setEnabled(extensionId, enabled, catalog.revision);
  }, true, enabled ? capturedReview?.hostId : undefined);
};

export const installVarinExtension = (
  source: VarinExtensionPackageSource,
  expectedHostId?: string,
): Promise<void> => {
  const capturedSource = structuredClone(source);
  return runMutation('__install__', (catalog, api) => api.install({ expectedRevision: catalog.revision, source: capturedSource }), true, expectedHostId);
};

export const reloadVarinExtensionLocalSource = (
  extensionId: string,
): Promise<void> => runMutation(extensionId, async (catalog) => {
  const result = await extensionsApi().reloadLocalSource({
    expectedRevision: catalog.revision,
    extensionId,
  });
  // A local edit is new code even when its capability list is unchanged. Stage it for the
  // same artifact-specific confirmation as any other update; reload is not code approval.
  return result.snapshot;
});

export const selectVarinExtensionCandidate = (
  extensionId: string,
  candidateIntegrity: string,
  expectedHostId?: string,
): Promise<void> => runMutation(extensionId, async (catalog, api, assertCurrentHost) => {
  const runtime = await catalogSurfaceRuntime();
  assertCurrentHost();
  return runtime.applyCandidate(extensionId, candidateIntegrity, catalog.revision, expectedHostId, api);
}, true, expectedHostId);

export const discardVarinExtensionCandidate = (
  extensionId: string,
  candidateIntegrity: string,
): Promise<void> => runMutation(extensionId, (catalog) => (
  extensionsApi().discardCandidate({ candidateIntegrity, expectedRevision: catalog.revision, extensionId })
));

export const removeVarinExtension = (
  extensionId: string,
  deleteData: boolean,
): Promise<void> => runMutation(extensionId, async (catalog) => {
  const entry = catalog.extensions.find((candidate) => candidate.manifest.id === extensionId);
  const disabled = entry?.desired.enabled
    ? await extensionsApi().setEnabled(extensionId, false, catalog.revision)
    : catalog;
  await (await catalogSurfaceRuntime()).refresh();
  return extensionsApi().removeExtension({ deleteData, expectedRevision: disabled.revision, extensionId });
});

export const reviewVarinExtensionCandidateCapabilities = (
  request: Omit<VarinExtensionCandidateCapabilityReviewRequest, 'expectedRevision'>,
): Promise<void> => runMutation(request.extensionId, (catalog) => (
  extensionsApi().reviewCandidateCapabilities({ ...request, expectedRevision: catalog.revision })
));

export const reviewVarinExtensionCapabilities = (
  request: Omit<VarinExtensionCapabilityReviewRequest, 'expectedRevision'>,
): Promise<void> => runMutation(request.extensionId, (catalog) => (
  extensionsApi().reviewCapabilities({ ...request, expectedRevision: catalog.revision })
));

export const setVarinExtensionServiceRoute = (
  serviceId: string,
  version: number,
  scope: VarinExtensionServiceRoutingContext,
  selection: readonly string[] | null,
  expectedHostId?: string,
): Promise<void> => {
  // Capture the user's ordered choice before it enters the shared mutation queue. Empty is an
  // explicit collection; only null removes the override and restores automatic routing.
  const selected = selection === null ? null : [...selection];
  const originalScope = { ...scope };
  const originalApi = expectedHostId ? extensionsApi() : undefined;
  const originalEndpoint = getRuntimeEndpointGeneration();
  const operation = mutationQueue.then(async () => {
    await startVarinExtensionCatalog();
    const api = originalApi ?? extensionsApi();
    const assertCurrent = () => {
      if (originalApi && (getRuntimeEndpointGeneration() !== originalEndpoint || extensionsApi() !== originalApi)) {
        throw new Error('Service routing Runtime changed before selection');
      }
    };
    assertCurrent();
    const current = originalApi ? await api.hostState() : state.snapshot;
    assertCurrent();
    if (!current) throw new Error('Varin extension routing is unavailable');
    if (expectedHostId && (!current.routing.authoritative || current.catalog.hostId !== expectedHostId)) {
      throw new Error('Service routing Host changed before selection');
    }
    const requestGeneration = generation;
    const identity = serviceRoutingRuleKey({ scope: originalScope, serviceId, version });
    const existing = current.routing.document.rules.find((rule) => serviceRoutingRuleKey(rule) === identity);
    if (selected === null) {
      if (!existing) return;
      await api.removeServiceRoutingRule({
        expectedRevision: current.routing.document.revision,
        scope: originalScope,
        serviceId,
        version,
      });
    } else {
      await api.upsertServiceRoutingRule({
        expectedRevision: current.routing.document.revision,
        rule: parseVarinExtensionServiceRoutingRule({
          allowFallback: serviceId === VARIN_AGENT_DRIVER_SERVICE_ID ? false : existing?.allowFallback ?? false,
          providerKeys: selected,
          scope: originalScope,
          serviceId,
          version,
        }),
      });
    }
    if (requestGeneration === generation) await refreshVarinExtensionCatalog();
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
};

export const useVarinExtensionCatalog = (): VarinExtensionCatalogStoreState => {
  React.useEffect(() => {
    catalogConsumers += 1;
    void startVarinExtensionCatalog().catch(() => undefined);
    return () => {
      catalogConsumers = Math.max(0, catalogConsumers - 1);
      if (catalogConsumers === 0) stopVarinExtensionCatalog();
    };
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
};

export const subscribeVarinExtensionCatalog = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getVarinExtensionCatalogState = (): VarinExtensionCatalogStoreState => state;

export const getVarinExtensionCatalogWatchGeneration = (): number => generation;

export const resetVarinExtensionCatalogForTests = (
  surfaceRuntime: CatalogSurfaceRuntime | null = null,
): void => {
  generation += 1;
  watchController?.abort('Varin extension catalog reset');
  watchController = null;
  startPromise = null;
  catalogConsumers = 0;
  mutationQueue = Promise.resolve();
  catalogSurfaceRuntimeOverride = surfaceRuntime;
  state = initialState();
  listeners.clear();
};

/** An explicit restart action has its own stable ID, including after response loss. */
export const restartVarinExtensionCandidate = (extensionId: string, candidateIntegrity: string, expectedHostId?: string): Promise<void> => {
  const handoffId = crypto.randomUUID();
  return runMutation(extensionId, async (catalog, api) => {
    try { return await api.requestRestartHandoff({ extensionId, candidateIntegrity, expectedRevision: catalog.revision, handoffId }); }
    catch (error) {
      const observed = await api.hostState().catch(() => undefined);
      if (observed?.catalog.authoritative && observed.catalog.extensions.some(entry => entry.manifest.id === extensionId && entry.restartHandoffs?.some(handoff => handoff.id === handoffId))) return observed.catalog;
      throw error;
    }
  }, false, expectedHostId);
};

export const recoverVarinExtensionRestart = (extensionId: string, handoffId: string, expectedHostId?: string): Promise<void> => runMutation(extensionId,
  (catalog, api) => api.recoverRestartHandoff({ extensionId, handoffId, expectedRevision: catalog.revision }), false, expectedHostId);
