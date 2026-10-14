import React from 'react';
import { getRuntimeEndpointGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { refreshAgentProfiles, useAgentProfilesState } from './agent-profiles-store';

export function useAgentProfiles() {
  const api = useRuntimeAPIs().agentProfiles;
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const host = JSON.stringify([getRuntimeKey(), generation]);
  const state = useAgentProfilesState();
  const refresh = React.useCallback((force = false) => api ? refreshAgentProfiles(api, host, force) : Promise.resolve(), [api, host]);
  React.useEffect(() => {
    void refresh();
    return subscribeVarinEvents(event => {
      if (event.type === 'settings-changed' && event.owner === 'agent-settings') void refresh(true);
    });
  }, [refresh, state.runtime]);
  return { api, host, state, snapshot: state.host === host ? state.snapshot : null, refresh };
}
