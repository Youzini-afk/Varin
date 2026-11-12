import { useShallow } from 'zustand/react/shallow';
import React from 'react';
import { getRuntimeEndpointGeneration, type ConversationOrganizationEntry, type ConversationOrganizationRef } from '@varin/application-client';
import { useRuntimeAPIs } from './useRuntimeAPIs';
import { loadOrganizationPage, organizationQueryKey, useConversationOrganization } from '@/stores/useConversationOrganizationStore';
import { organizationContainerPath } from '@/components/conversation/organizationProjection';

/** Open details read one original object, never drain the paged navigation tree. */
export function useConversationOrganizationEntry(reference: ConversationOrganizationRef, active = true, includeLocation = false) {
  const api = useRuntimeAPIs().conversationOrganization;
  const organization = useConversationOrganization(active, useShallow(state => ({ host: state.host, snapshot: state.snapshot, pages: state.pages })));
  const host = getRuntimeEndpointGeneration(), key = JSON.stringify([host, reference.kind, reference.id]);
  const [state, setState] = React.useState<{ key: string; entry?: ConversationOrganizationEntry; error?: string; loading: boolean }>();
  const cursor = organization.host === host ? organization.snapshot?.cursor : undefined;
  React.useEffect(() => {
    if (!api || !active) return;
    const controller = new AbortController();
    const valid = () => !controller.signal.aborted && host === getRuntimeEndpointGeneration();
    setState(previous => ({ key, ...(previous?.key === key && previous.entry ? { entry: previous.entry } : {}), loading: true }));
    void api.entry({ kind: reference.kind, id: reference.id }, controller.signal).then(entry => {
      if (valid()) setState({ key, entry, loading: false });
    }, error => { if (valid()) setState({ key, error: error instanceof Error ? error.message : String(error), loading: false }); });
    return () => controller.abort();
  }, [api, active, key, host, reference.kind, reference.id, cursor]);
  const owned = state?.key === key ? state : undefined;
  const cached = organization.host === host ? organization.snapshot?.conversations.find(entry => entry.conversation.kind === reference.kind && entry.conversation.id === reference.id) : undefined;
  const entry = owned?.error ? undefined : owned?.entry ?? cached;
  const pathQuery = React.useMemo(() => includeLocation && entry?.position.containerId ? { pageNodes: true, containerId: entry.position.containerId, archived: 'include' as const, limit: 1 } : null, [includeLocation, entry?.position.containerId]);
  const pathPage = pathQuery ? organization.pages[organizationQueryKey(pathQuery)] : undefined;
  const projectedPath = includeLocation && entry && organization.host === host && organization.snapshot ? organizationContainerPath(organization.snapshot, entry.position.containerId) : undefined;
  const path = entry?.position.containerId === null && entry.path.length === 0 ? []
    : entry && projectedPath && projectedPath.length > 0 && projectedPath.length === entry.path.length && projectedPath.every((container, index) => container.id === entry.path[index]) ? projectedPath : undefined;
  const pathKnown = path !== undefined;
  React.useEffect(() => {
    // One bounded parent page supplies its ancestor context, even when navigation has
    // never opened this branch. The existing directory owner observes later changes.
    if (api && active && includeLocation && pathQuery && !pathKnown) void loadOrganizationPage(pathQuery);
  }, [api, active, includeLocation, pathQuery, pathKnown]);
  return { available: Boolean(api), entry, path, pathUnavailable: Boolean(pathPage?.snapshot && !pathPage.loading && !path), pathError: pathPage?.error, error: owned?.error, loading: active && (owned?.loading ?? Boolean(api)) };
}
