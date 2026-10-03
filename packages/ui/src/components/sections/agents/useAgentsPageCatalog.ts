import React from 'react';
import type { RuntimeContextTarget } from '@varin/protocol';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useI18n } from '@/lib/i18n';
import { filterAgentsCatalog, nativeAgentDescription, nativeAgentLabel } from './agents-catalog-model';
import { EMPTY_AGENT_CATALOG, refreshAgentsCatalog, useAgentsCatalogState } from './agents-catalog-store';

export function useAgentsPageCatalog() {
  const { t } = useI18n();
  const cwd = useDirectoryStore(state => state.currentDirectory);
  const runtimeKey = usePiSessionStore(state => state.runtimeKey);
  const session = usePiSessionStore(state => {
    const record = state.currentSessionId ? state.records[state.currentSessionId] : undefined;
    return record?.open ? record.snapshot : undefined;
  });
  const projectFocus = useProjectsStore(state => state.projects.find(project => project.id === state.activeProjectId)?.defaultWorkFocus);
  const sessionId = session?.sessionId;
  const target = React.useMemo<RuntimeContextTarget>(() => sessionId ? { sessionId } : { cwd }, [cwd, sessionId]);
  const targetKey = JSON.stringify([runtimeKey, target]);
  const state = useAgentsCatalogState();
  const catalog = state.targetKey === targetKey ? state.catalog : EMPTY_AGENT_CATALOG;
  const focus = session?.workFocus?.selected.id ?? projectFocus ?? 'code';
  const refresh = React.useCallback((afterMutation = false) => refreshAgentsCatalog(target, targetKey, afterMutation), [target, targetKey]);
  React.useEffect(() => {
    void refresh();
    return subscribeVarinEvents(event => {
      if (event.type === 'settings-changed' && event.owner === 'pi-settings') void refresh();
    });
  }, [refresh]);
  const rawMatches = new Set(filterAgentsCatalog(catalog, state.query, state.providerFilter, state.statusFilter).map(agent => agent.id));
  const needle = state.query.trim().toLocaleLowerCase();
  const agents = filterAgentsCatalog(catalog, '', state.providerFilter, state.statusFilter)
    .filter(agent => rawMatches.has(agent.id) || `${nativeAgentLabel(agent, t)} ${nativeAgentDescription(agent, t)}`.toLocaleLowerCase().includes(needle))
    .filter(agent => state.showAllFocuses || !agent.workFocus?.length || agent.workFocus.includes(focus));
  const selected = agents.find(agent => agent.id === state.selectedAgentId) ?? agents[0] ?? null;
  return { cwd, runtimeKey, target, targetKey, focus, state, catalog, agents, selected, refresh };
}
