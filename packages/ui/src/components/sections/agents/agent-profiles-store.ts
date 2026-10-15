import { useSyncExternalStore } from 'react';
import {
  getRuntimeEndpointGeneration, getRuntimeKey,
  type AgentProfileSaveRequest, type AgentProfilesAPI, type AgentProfilesSnapshot, type AgentRuntime,
} from '@varin/application-client';

interface AgentProfilesState {
  runtime: AgentRuntime;
  host: string;
  snapshot: AgentProfilesSnapshot | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  selectedId: string | null;
  creating: boolean;
  view: 'profiles' | 'plugins';
  query: string;
  showAllFocuses: boolean;
}
const initial: AgentProfilesState = {
  runtime: 'agent', host: '', snapshot: null, loading: false, saving: false, error: null,
  selectedId: null, creating: false, view: 'profiles', query: '', showAllFocuses: false,
};
let state = initial;
let epoch = 0;
let readGeneration = 0;
let readController: AbortController | undefined;
const listeners = new Set<() => void>();
const publish = (patch: Partial<AgentProfilesState>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};
export const useAgentProfilesState = () => useSyncExternalStore(
  listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  () => state, () => state,
);
export function selectAgentProfilesRuntime(runtime: AgentRuntime) {
  if (state.runtime === runtime) return;
  epoch += 1; readGeneration += 1; readController?.abort();
  publish({ ...initial, runtime, host: state.host });
}
export function beginAgentProfilesHost(host: string) {
  if (state.host === host) return;
  epoch += 1; readGeneration += 1; readController?.abort();
  publish({ ...initial, runtime: state.runtime, host });
}
export function selectAgentProfile(id: string | null) { publish({ selectedId: id, creating: false, view: 'profiles', error: null }); }
export function createAgentProfile() { publish({ creating: true, view: 'profiles', error: null }); }
export function cancelAgentProfileCreation() { publish({ creating: false, error: null }); }
export function selectAgentPlugin() { publish({ creating: false, view: 'plugins' }); }
export function setAgentProfilesQuery(query: string) { publish({ query }); }
export function setAgentProfilesShowAllFocuses(showAllFocuses: boolean) { publish({ showAllFocuses }); }

export async function refreshAgentProfiles(api: AgentProfilesAPI, host: string, force = false) {
  beginAgentProfilesHost(host);
  if (state.saving || (state.loading && !force)) return;
  const runtime = state.runtime, requestEpoch = epoch, generation = ++readGeneration;
  const endpoint = getRuntimeEndpointGeneration();
  readController?.abort();
  const controller = new AbortController(); readController = controller;
  const current = () => epoch === requestEpoch && generation === readGeneration
    && state.host === host && endpoint === getRuntimeEndpointGeneration() && !controller.signal.aborted;
  publish({ loading: true, error: null });
  try {
    const snapshot = await api.read({ runtime }, controller.signal);
    if (!current()) return;
    if (snapshot.runtime !== runtime) throw new Error('Agent settings returned a different runtime. Reload the settings.');
    publish({ snapshot, loading: false,
      selectedId: snapshot.profiles.some(profile => profile.id === state.selectedId) ? state.selectedId : snapshot.profiles[0]?.id ?? null });
  } catch (error) {
    if (current()) publish({ loading: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function saveAgentProfile(api: AgentProfilesAPI, input: AgentProfileSaveRequest): Promise<boolean> {
  if (state.saving || input.runtime !== state.runtime) return false;
  return mutateAgentProfiles(() => api.save(input), true);
}
export async function removeAgentProfile(api: AgentProfilesAPI, id: string, expectedRevision: string): Promise<boolean> {
  if (state.saving) return false;
  const runtime = state.runtime;
  return mutateAgentProfiles(async () => ({ snapshot: await api.remove({ runtime, expectedRevision, id }), profileId: '' }), false);
}
async function mutateAgentProfiles(
  action: () => Promise<{ snapshot: AgentProfilesSnapshot; profileId: string }>, selectResult: boolean,
): Promise<boolean> {
  const requestEpoch = ++epoch, endpoint = getRuntimeEndpointGeneration(), host = getRuntimeKey(), runtime = state.runtime;
  readGeneration += 1; readController?.abort();
  const selection = { id: state.selectedId, creating: state.creating, view: state.view };
  const current = () => epoch === requestEpoch && endpoint === getRuntimeEndpointGeneration() && host === getRuntimeKey();
  publish({ saving: true, loading: false, error: null });
  try {
    const { snapshot, profileId } = await action();
    if (!current()) return false;
    if (snapshot.runtime !== runtime) throw new Error('Agent settings returned a different runtime. Reload the settings.');
    publish({ snapshot, saving: false,
      ...(selectResult && state.selectedId === selection.id && state.creating === selection.creating && state.view === selection.view ? { selectedId: profileId, creating: false, view: 'profiles' as const, ...(selection.creating ? { showAllFocuses: true } : {}) }
        : { selectedId: snapshot.profiles.some(profile => profile.id === state.selectedId) ? state.selectedId : snapshot.profiles[0]?.id ?? null }) });
    return true;
  } catch (error) {
    if (current()) publish({ saving: false, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
