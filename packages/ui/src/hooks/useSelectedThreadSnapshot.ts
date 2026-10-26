import React from 'react';
import type { ThreadSnapshot, ThreadIdentity } from '@varin/application-client';
import { useRuntimeAPIs } from './useRuntimeAPIs';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { useThreadStore } from '@/stores/useThreadStore';

/** Disposable native projection for peripheral views. Never an execution or storage owner. */
export function useSelectedThreadSnapshot(active = true, requestedIdentity?: ThreadIdentity) {
  const api = useRuntimeAPIs().threads;
  const selectedIdentity = useThreadStore(state => state.selectedIdentity);
  const identity = requestedIdentity ?? selectedIdentity;
  const host = useThreadStore(state => state.hostKey);
  const [view, setView] = React.useState<{ owner: string; snapshot?: ThreadSnapshot; error?: string }>({ owner: '' });
  const owner = JSON.stringify([host, identity?.threadId, identity?.branchId]);
  const projectionRef = React.useRef<{ owner: string; api: typeof api; projection: ThreadProjection } | null>(null);
  const refresh = React.useCallback(async () => {
    const current = projectionRef.current;
    if (active && current?.owner === owner && current.api === api) await current.projection.refresh();
  }, [active, owner, api]);
  React.useEffect(() => {
    setView({ owner });
    if (!active || !api || !identity) return;
    const projection = new ThreadProjection(api, identity, snapshot => setView({ owner, snapshot }), error => setView(previous => ({ ...previous, owner, error: error instanceof Error ? error.message : String(error) })));
    const binding = { owner, api, projection }; projectionRef.current = binding;
    projection.start(); return () => { projection.close(); if (projectionRef.current === binding) projectionRef.current = null; };
  }, [active, api, owner, identity]);
  return { identity, refresh, ...(view.owner === owner ? { snapshot: view.snapshot, error: view.error } : {}) };
}
