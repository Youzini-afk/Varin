import { useEffect, useState } from 'react';
import type { ExtensionsAPI } from '@varin/application-client';
import type { VarinExtensionHostStateSnapshot } from '@varin/extension-contract';
import { companionProductMode } from './companionProductMode';
import type { DirectorInteractionRoute } from './directorPresentation';

/** Existing authenticated Host workbench state; no settings owner, writes or inferred mode. */
export function useCompanionProductMode(api: ExtensionsAPI, generation: number): DirectorInteractionRoute {
  const [observed, setObserved] = useState<{ generation: number; route: DirectorInteractionRoute } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (route: DirectorInteractionRoute) => { if (!abort.signal.aborted) setObserved(old => old?.generation === generation && old.route === route ? old : { generation, route }); };
    const run = async () => {
      let snapshot: VarinExtensionHostStateSnapshot | null = null;
      while (!abort.signal.aborted) {
        try {
          const next: VarinExtensionHostStateSnapshot = snapshot ? await api.waitForHostState({ hostId: snapshot.catalog.hostId, revision: snapshot.revision }, abort.signal) : await api.hostState();
          if (abort.signal.aborted) return;
          if (snapshot && snapshot.catalog.hostId === next.catalog.hostId && next.revision < snapshot.revision) { snapshot = null; publish('unknown'); continue; }
          snapshot = next; publish(companionProductMode(next));
        } catch {
          if (abort.signal.aborted) return;
          snapshot = null; publish('unknown');
          await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); }; timer = setTimeout(done, 1000); abort.signal.addEventListener('abort', done, { once: true }); });
        }
      }
    };
    void run();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [api, generation]);
  return observed?.generation === generation ? observed.route : 'unknown';
}
