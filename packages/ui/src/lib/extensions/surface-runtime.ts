import {
  SurfaceExtensionRuntime,
  type SurfaceActivation,
  type SurfaceContextProvider,
  type SurfaceOwnerHandle,
  type SurfaceOwnerIdentity,
} from '@varin/extension-surface';
import type { VarinApplicationSurface, VarinContextValue } from '@varin/extension-contract';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import {
  batchWorkbenchContextKeyUpdates,
  createOwnerScopedContextWriter,
  getWorkbenchContextKeyStore,
  previewWorkbenchContextKeyUpdates,
  subscribeWorkbenchContextKey,
} from '@/lib/workbench/editors/context-keys';

const FALLBACK_HOST_ID = '00000000-0000-4000-8000-000000000000';

const readSurface = (): VarinApplicationSurface => {
  if (typeof window === 'undefined') return 'web';
  if (window.__VARIN_SURFACE__ === 'mobile') return 'mobile';
  const runtime = getRegisteredRuntimeAPIs()?.runtime;
  if (runtime?.isDesktop) return 'desktop';
  return 'web';
};

const newRealmId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `surface-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Adapter that exposes the workbench context key store as a
 * SurfaceContextProvider for `when` expression evaluation.
 * Supports owner-scoped writers with namespace, generation fencing,
 * and cleanup.
 */
const workbenchContextProvider: SurfaceContextProvider = {
  batch(operation): void {
    batchWorkbenchContextKeyUpdates(operation);
  },
  getContext(): ReadonlyMap<string, VarinContextValue> {
    return getWorkbenchContextKeyStore() as ReadonlyMap<string, VarinContextValue>;
  },
  subscribe(keys: readonly string[], listener: () => void): () => void {
    const unsubscribers = keys.map((key) => subscribeWorkbenchContextKey(key, listener));
    return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
  },
  previewContext: previewWorkbenchContextKeyUpdates,
  createWriter(owner: SurfaceOwnerIdentity) {
    return createOwnerScopedContextWriter(owner);
  },
};

export const varinSurfaceRuntime = new SurfaceExtensionRuntime({
  surface: readSurface(),
  contextProvider: workbenchContextProvider,
});

let hostIdPromise: Promise<string> | null = null;

const resolveHostId = async (): Promise<string> => {
  if (typeof window === 'undefined') return FALLBACK_HOST_ID;
  const result = await getRegisteredRuntimeAPIs()?.extensions.catalog().catch(() => null);
  return result?.supported === true && result.status === 'ready'
    ? result.snapshot.hostId
    : FALLBACK_HOST_ID;
};

const getHostId = (): Promise<string> => {
  hostIdPromise ??= resolveHostId();
  return hostIdPromise;
};

interface BuiltinSurfaceControllerOptions {
  activate: SurfaceActivation;
  entrypointId?: string;
  extensionId: string;
  extensionVersion: string;
}

export interface BuiltinSurfaceController {
  ensure(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
}

export const createBuiltinSurfaceController = (
  options: BuiltinSurfaceControllerOptions,
): BuiltinSurfaceController => {
  const entrypointId = options.entrypointId ?? 'main';
  const realmId = newRealmId();
  let initialized = false;
  let enabled = true;
  let desiredRevision = 1;
  let generation = 1;
  let handle: SurfaceOwnerHandle | null = null;
  let transition: Promise<void> | null = null;

  const startTransition = (): Promise<void> => {
    const requestedEnabled = enabled;
    const requestedDesiredRevision = desiredRevision;
    const requestedGeneration = generation;
    const next = getHostId().then(async (hostId) => {
      const owner = {
        extensionId: options.extensionId,
        extensionVersion: options.extensionVersion,
        entrypointId,
        realmId,
        hostId,
        desiredRevision: requestedDesiredRevision,
        generation: requestedGeneration,
      };
      if (!requestedEnabled) {
        await varinSurfaceRuntime.deactivate(owner);
        if (desiredRevision === requestedDesiredRevision && generation === requestedGeneration) handle = null;
        return;
      }
      const activated = await varinSurfaceRuntime.activate({ owner }, options.activate);
      if (desiredRevision === requestedDesiredRevision && generation === requestedGeneration) handle = activated;
    });
    transition = next;
    void next.finally(() => {
      if (transition === next) transition = null;
    }).catch(() => undefined);
    return next;
  };

  const ensure = (): Promise<void> => {
    if (!initialized) initialized = true;
    if (!enabled) return Promise.resolve();
    if (handle) return Promise.resolve();
    if (transition) return transition;
    return startTransition();
  };

  return {
    ensure,
    setEnabled: (nextEnabled) => {
      if (!initialized) {
        initialized = true;
        enabled = nextEnabled;
        return nextEnabled ? startTransition() : Promise.resolve();
      }
      if (enabled === nextEnabled) return transition ?? ensure();
      enabled = nextEnabled;
      desiredRevision += 1;
      generation += 1;
      return startTransition();
    },
  };
};
