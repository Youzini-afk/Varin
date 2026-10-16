import React from 'react';
import type { ThreadSnapshot } from '@varin/application-client';
import { useRuntimeAPIs } from './useRuntimeAPIs';
import { ThreadProjection } from '@/lib/agent-runtime/thread-projection';
import { useThreadStore } from '@/stores/useThreadStore';

/** Disposable native projection for peripheral views. Never an execution or storage owner. */
export function useSelectedThreadSnapshot(active = true) {
  const api = useRuntimeAPIs().threads;
  const identity = useThreadStore(state => state.selectedIdentity);
  const host = useThreadStore(state => state.hostKey);
  const [view, setView] = React.useState<{ owner: string; snapshot?: ThreadSnapshot; error?: string }>({ owner: '' });
  const owner = JSON.stringify([host, identity?.threadId, identity?.branchId]);
  React.useEffect(() => {
    setView({ owner });
    if (!active || !api || !identity) return;
    const projection = new ThreadProjection(api, identity, snapshot => setView({ owner, snapshot }), error => setView(previous => ({ ...previous, owner, error: error instanceof Error ? error.message : String(error) })));
    projection.start(); return () => projection.close();
  }, [active, api, owner, identity]);
  return { identity, ...(view.owner === owner ? { snapshot: view.snapshot, error: view.error } : {}) };
}
