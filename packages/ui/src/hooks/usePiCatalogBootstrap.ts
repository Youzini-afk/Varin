import React from 'react';
import type { PiRuntimeSnapshot } from '@varin/protocol';
import type { PiRuntimeManagementAPI } from '@varin/application-client';
import { shouldApplyPiRuntimeSnapshot } from '@/lib/pi-runtime/snapshot-order';
import { usePiSessionStore } from '@/stores/usePiSessionStore';

export function usePiCatalogBootstrap({ isDesktopRuntime, piRuntime, runtimeEndpointEpoch }: {
  isDesktopRuntime: boolean;
  piRuntime: Pick<PiRuntimeManagementAPI, 'getSnapshot' | 'subscribe'> | undefined;
  runtimeEndpointEpoch: number;
}) {
  const [candidate, setCandidate] = React.useState<{
    api: typeof piRuntime; epoch: number; snapshot: PiRuntimeSnapshot;
  } | null>(null);
  // A changed endpoint must become unready during render, before its effects
  // run. The previous endpoint's ready snapshot cannot admit the new socket.
  const snapshot = candidate && candidate.api === piRuntime && candidate.epoch === runtimeEndpointEpoch
    ? candidate.snapshot : null;
  const runtimeStatus = snapshot?.status ?? null;
  const canLoadCatalog = !isDesktopRuntime || runtimeStatus === 'ready';

  React.useEffect(() => {
    setCandidate(null);
    const publish = (snapshot: PiRuntimeSnapshot) => setCandidate({ api: piRuntime, epoch: runtimeEndpointEpoch, snapshot });
    if (!piRuntime) { publish({ installations: [], revision: 0, status: 'failed' }); return; }
    let cancelled = false;
    let revision = 0;
    let receivedSnapshot = false;
    const applySnapshot = (next: PiRuntimeSnapshot) => {
      if (cancelled || !shouldApplyPiRuntimeSnapshot(revision, next)) return;
      revision = next.revision;
      receivedSnapshot = true;
      publish(next);
    };
    const unsubscribe = piRuntime.subscribe(applySnapshot);
    void piRuntime.getSnapshot().then(applySnapshot).catch((error: unknown) => {
      if (cancelled || receivedSnapshot) return;
      publish({ installations: [], issue: error instanceof Error ? error.message : String(error), revision: 0, status: 'failed' });
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [piRuntime, runtimeEndpointEpoch]);

  React.useEffect(() => {
    // HTTP can serve the shell before the catalog worker's handshake completes.
    // An early socket is rejected by the gateway; waiting here avoids racing
    // that failed attempt against the readiness notification.
    if (!canLoadCatalog) return;
    const state = usePiSessionStore.getState();
    if (state.catalogLoaded || state.catalogLoading) return;
    void state.loadCatalog().catch((catalogError) => {
      console.warn('[Varin] failed to load the Pi session catalog:', catalogError);
    });
  }, [canLoadCatalog, runtimeEndpointEpoch]);
  return snapshot;
}
