import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';

/** View-owned async feedback. Leaving the view aborts reads, not accepted work. */
export function useToolAction(identity: string) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const owner = React.useMemo(() => ({ identity, host, active: true, controller: null as AbortController | null }), [identity, host]);
  React.useEffect(() => { owner.active = true; return () => { owner.active = false; owner.controller?.abort(); }; }, [owner]);
  const [state, setState] = React.useState<{ owner: typeof owner; busy: boolean; error?: string }>({ owner, busy: false });
  const run = async <T,>(task: (signal: AbortSignal) => Promise<T>, apply: (result: T) => void) => {
    if (!owner.active || owner.controller) return;
    const controller = new AbortController(); owner.controller = controller;
    const valid = () => owner.active && host === getRuntimeEndpointGeneration() && !controller.signal.aborted;
    setState({ owner, busy: true });
    try { const value = await task(controller.signal); if (valid()) { apply(value); setState({ owner, busy: false }); } }
    catch (error) { if (valid()) setState({ owner, busy: false, error: error instanceof Error ? error.message : String(error) }); }
    finally { if (owner.controller === controller) owner.controller = null; }
  };
  return { run, busy: state.owner === owner && state.busy, error: state.owner === owner ? state.error : undefined };
}
