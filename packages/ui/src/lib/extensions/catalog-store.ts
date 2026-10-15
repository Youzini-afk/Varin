import React, { useSyncExternalStore } from 'react';
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
  ): Promise<VarinExtensionCatalogSnapshot>;
  refresh(): Promise<void>;
}

let catalogSurfaceRuntimeOverride: CatalogSurfaceRuntime | null = null;

const catalogSurfaceRuntime = async (): Promise<CatalogSurfaceRuntime> => {
  if (catalogSurfaceRuntimeOverride) return catalogSurfaceRuntimeOverride;
  const runtime = await import('./managed-runtime');
  return {
    applyCandidate: (extensionId, candidateIntegrity, expectedRevision) => (
      runtime.surfaceExtensionLoader.applyCandidate(extensionId, candidateIntegrity, expectedRevision)
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
  mutate: (snapshot: VarinExtensionCatalogSnapshot) => Promise<VarinExtensionCatalogSnapshot>,
  refreshAfter = true,
): Promise<void> => {
  const operation = mutationQueue.then(async () => {
    await startVarinExtensionCatalog();
    const current = state.snapshot;
    if (!current) throw new Error('Varin extension catalog is unavailable');
    const requestGeneration = generation;
    publish({ ...state, busyExtensionId: extensionId, error: null });
    try {
      const catalog = await mutate(current.catalog);
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
): Promise<void> => runMutation(extensionId, (catalog) => (
  extensionsApi().setEnabled(extensionId, enabled, catalog.revision)
));

export const installVarinExtension = (
  source: VarinExtensionPackageSource,
): Promise<void> => runMutation('__install__', (catalog) => (
  extensionsApi().install({ expectedRevision: catalog.revision, source })
));

export const reloadVarinExtensionLocalSource = (
  extensionId: string,
): Promise<void> => runMutation(extensionId, async (catalog) => {
  const result = await extensionsApi().reloadLocalSource({
    expectedRevision: catalog.revision,
    extensionId,
  });
  if (result.outcome === 'unchanged') return result.snapshot;
  const entry = result.snapshot.extensions.find((candidate) => candidate.manifest.id === extensionId);
  const candidate = entry?.candidate;
  if (!candidate || candidate.integrity !== result.candidateIntegrity) {
    throw new Error(`Reloaded local Varin extension candidate is no longer current: ${extensionId}`);
  }
  if (!candidate.capabilitiesReviewed) return result.snapshot;
  return (await catalogSurfaceRuntime()).applyCandidate(
    extensionId,
    candidate.integrity,
    result.snapshot.revision,
  );
});

export const selectVarinExtensionCandidate = (
  extensionId: string,
  candidateIntegrity: string,
): Promise<void> => runMutation(extensionId, async (catalog) => {
  return (await catalogSurfaceRuntime()).applyCandidate(extensionId, candidateIntegrity, catalog.revision);
});

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
): Promise<void> => {
  // Capture the user's ordered choice before it enters the shared mutation queue. Empty is an
  // explicit collection; only null removes the override and restores automatic routing.
  const selected = selection === null ? null : [...selection];
  const operation = mutationQueue.then(async () => {
    await startVarinExtensionCatalog();
    const current = state.snapshot;
    if (!current) throw new Error('Varin extension routing is unavailable');
    const requestGeneration = generation;
    const identity = serviceRoutingRuleKey({ scope, serviceId, version });
    const existing = current.routing.document.rules.find((rule) => serviceRoutingRuleKey(rule) === identity);
    if (selected === null) {
      if (!existing) return;
      await extensionsApi().removeServiceRoutingRule({
        expectedRevision: current.routing.document.revision,
        scope,
        serviceId,
        version,
      });
    } else {
      await extensionsApi().upsertServiceRoutingRule({
        expectedRevision: current.routing.document.revision,
        rule: parseVarinExtensionServiceRoutingRule({
          allowFallback: existing?.allowFallback ?? false,
          providerKeys: selected,
          scope,
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
export const restartVarinExtensionCandidate = (extensionId: string, candidateIntegrity: string): Promise<void> => {
  const handoffId = crypto.randomUUID();
  return runMutation(extensionId, async catalog => {
    try { return await extensionsApi().requestRestartHandoff({ extensionId, candidateIntegrity, expectedRevision: catalog.revision, handoffId }); }
    catch (error) {
      const observed = await extensionsApi().hostState().catch(() => undefined);
      if (observed?.catalog.authoritative && observed.catalog.extensions.some(entry => entry.manifest.id === extensionId && entry.restartHandoffs?.some(handoff => handoff.id === handoffId))) return observed.catalog;
      throw error;
    }
  }, false);
};

export const recoverVarinExtensionRestart = (extensionId: string, handoffId: string): Promise<void> => runMutation(extensionId,
  catalog => extensionsApi().recoverRestartHandoff({ extensionId, handoffId, expectedRevision: catalog.revision }), false);
