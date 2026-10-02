import { useSyncExternalStore } from 'react';
import type {
  PiAgentCatalogSnapshot,
  PiAgentStatus,
  RuntimeContextTarget,
} from '@varin/protocol';
import { listPiAgentProviders } from '@/lib/pi-runtime/agent-providers';
import { getRuntimeKey } from '@varin/application-client';

export type AgentProviderFilter = 'all' | string;
export type AgentStatusFilter = 'all' | PiAgentStatus;

export interface AgentsCatalogState {
  catalog: PiAgentCatalogSnapshot;
  error: string | null;
  loaded: boolean;
  loading: boolean;
  providerFilter: AgentProviderFilter;
  query: string;
  selectedAgentId: string | null;
  statusFilter: AgentStatusFilter;
  targetKey: string;
  definitionRequest: 'create-agent' | null;
}

export const EMPTY_AGENT_CATALOG: PiAgentCatalogSnapshot = {
  agents: [],
  diagnostics: [],
  projectTrusted: false,
  providers: [],
};

const EMPTY_STATE: AgentsCatalogState = {
  catalog: EMPTY_AGENT_CATALOG,
  error: null,
  loaded: false,
  loading: false,
  providerFilter: 'all',
  query: '',
  selectedAgentId: null,
  statusFilter: 'all',
  targetKey: '',
  definitionRequest: null,
};

let state = EMPTY_STATE;
let generation = 0;
const listeners = new Set<() => void>();

function publish(next: AgentsCatalogState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function useAgentsCatalogState(): AgentsCatalogState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export function setAgentsCatalogQuery(query: string): void {
  publish({ ...state, query });
}

export function setAgentsCatalogProviderFilter(providerFilter: AgentProviderFilter): void {
  publish({ ...state, providerFilter });
}

export function setAgentsCatalogStatusFilter(statusFilter: AgentStatusFilter): void {
  publish({ ...state, statusFilter });
}

export function selectAgentsCatalogAgent(selectedAgentId: string | null): void {
  publish({ ...state, selectedAgentId });
}

export function requestAgentsCatalogDefinition(
  definitionRequest: 'create-agent' | null,
): void {
  publish({ ...state, definitionRequest });
}

export function beginAgentsCatalogTarget(targetKey: string): void {
  if (state.targetKey === targetKey) return;
  generation += 1;
  publish({ ...EMPTY_STATE, targetKey });
}

export async function refreshAgentsCatalog(
  runtimeTarget: RuntimeContextTarget,
  targetKey: string,
  afterMutation = false,
): Promise<void> {
  beginAgentsCatalogTarget(targetKey);
  // A pre-mutation read cannot stand in for observing the acknowledged write.
  if (state.loading && !afterMutation) return;
  const requestGeneration = ++generation;
  const runtimeKey = getRuntimeKey();
  publish({ ...state, error: null, loading: true });
  try {
    const catalog = await listPiAgentProviders(runtimeTarget);
    if (
      requestGeneration !== generation
      || state.targetKey !== targetKey
      || runtimeKey !== getRuntimeKey()
    ) return;
    const selectedAgentId = state.selectedAgentId
      && catalog.agents.some((agent) => agent.id === state.selectedAgentId)
      ? state.selectedAgentId
      : (catalog.agents[0]?.id ?? null);
    const providerFilter = state.providerFilter === 'all'
      || catalog.providers.some((provider) => provider.id === state.providerFilter)
      ? state.providerFilter
      : 'all';
    publish({
      ...state,
      catalog,
      error: null,
      loaded: true,
      loading: false,
      providerFilter,
      selectedAgentId,
    });
  } catch (error) {
    if (
      requestGeneration !== generation
      || state.targetKey !== targetKey
      || runtimeKey !== getRuntimeKey()
    ) return;
    publish({
      ...state,
      error: error instanceof Error ? error.message : String(error),
      loading: false,
    });
  }
}
