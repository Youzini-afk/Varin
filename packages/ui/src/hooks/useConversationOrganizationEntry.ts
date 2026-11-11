import React from 'react';
import { getRuntimeEndpointGeneration, type ConversationOrganizationEntry, type ConversationOrganizationRef } from '@varin/application-client';
import { useRuntimeAPIs } from './useRuntimeAPIs';
import { useConversationOrganization } from '@/stores/useConversationOrganizationStore';

/** Open details read one original object, never drain the paged navigation tree. */
export function useConversationOrganizationEntry(reference: ConversationOrganizationRef, active = true) {
  const api = useRuntimeAPIs().conversationOrganization;
  const organization = useConversationOrganization();
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
  return { entry: owned?.error ? undefined : owned?.entry ?? cached, error: owned?.error, loading: active && (owned?.loading ?? Boolean(api)) };
}
