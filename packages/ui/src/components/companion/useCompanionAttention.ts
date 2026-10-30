import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ThreadsAPI } from '@varin/application-client';
import { CompanionAttentionCoordinator, type CompanionAttentionView } from './attentionCoordinator';
const unavailable: CompanionAttentionView = { snapshot: null, health: 'unknown', refreshing: false, observationRevision: 0 };
const noop = () => {};
const subscribeNone = () => noop;
const getUnavailable = () => unavailable;

export function useCompanionAttention(api: ThreadsAPI | undefined, hostGeneration: number) {
  const coordinator = useMemo(() => {
    void hostGeneration; // Same API facade can switch authenticated Hosts; its cache must not survive.
    return api ? new CompanionAttentionCoordinator(api) : null;
  }, [api, hostGeneration]);
  const lifetime = useMemo(() => ({ coordinator, mounted: 0 }), [coordinator]);
  useEffect(() => {
    lifetime.mounted++; lifetime.coordinator?.start();
    return () => { lifetime.mounted--; queueMicrotask(() => { if (!lifetime.mounted) lifetime.coordinator?.close(); }); };
  }, [lifetime]);
  const view = useSyncExternalStore(coordinator?.subscribe ?? subscribeNone, coordinator?.getSnapshot ?? getUnavailable, getUnavailable);
  return { ...view, refresh: coordinator?.refresh ?? noop, projectionAPI: coordinator?.projectionAPI };
}
