import React from 'react';
import { createExternalAgentsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type ExternalAgentSettings } from '@varin/application-client';
import type { SourceResourceOwner } from '@varin/protocol';

/** Read the execution Host's configuration and optionally locate installed programs. */
export function useSourceExternalAgents(owner: SourceResourceOwner | undefined, enabled: boolean, discover: boolean) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const ownerKey = JSON.stringify(owner ?? { kind: 'local' });
  const scope = `${host}:${ownerKey}`;
  const [revision, retry] = React.useReducer(value => value + 1, 0);
  const [state, setState] = React.useState<{ scope: string; settings?: ExternalAgentSettings; error?: string; loading: boolean }>({ scope, loading: false });
  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState(previous => ({ scope, settings: previous.scope === scope ? previous.settings : undefined, loading: true }));
    void createExternalAgentsHttpAPI(host).settings(controller.signal, JSON.parse(ownerKey), discover).then(settings => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setState({ scope, settings, loading: false });
    }).catch(error => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration())
        setState(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error), loading: false }));
    });
    return () => controller.abort();
  }, [scope, ownerKey, host, enabled, discover, revision]);
  return { settings: state.scope === scope ? state.settings ?? null : null, error: state.scope === scope ? state.error : undefined, loading: enabled && (state.scope !== scope || state.loading), retry };
}
