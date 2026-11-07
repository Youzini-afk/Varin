import React from 'react';
import { createExternalAgentsHttpAPI, getRuntimeEndpointGeneration, type ExternalConversationSnapshot } from '@varin/application-client';
import { useExternalAgents, useExternalAgentStore } from '@/stores/useExternalAgentStore';
import { useI18n } from '@/lib/i18n';

export const arrangementTargetKey = (value: { threadId: string; branchId: string; externalConversationId?: string | null }) => value.externalConversationId
  ? JSON.stringify(['external', value.externalConversationId, null]) : JSON.stringify([value.threadId, value.branchId]);
export const externalTargetId = (key: string): string | undefined => {
  try { const value: unknown = JSON.parse(key); return Array.isArray(value) && value.length === 3 && value[0] === 'external' && typeof value[1] === 'string' ? value[1] : undefined; } catch { return undefined; }
};

/** Reuse the external directory and inspect only the selected receiver, without connecting it. */
export function useArrangementExternalTargets(target: string) {
  const { t } = useI18n();
  const settings = useExternalAgents();
  const conversations = useExternalAgentStore(state => state.conversations);
  const children = useExternalAgentStore(state => state.children);
  const directoryError = useExternalAgentStore(state => state.error);
  const [revision, setRevision] = React.useState(0);
  const [read, setRead] = React.useState<{ id: string; snapshot?: ExternalConversationSnapshot; error?: string }>();
  const id = externalTargetId(target);
  const unavailable = t('arrangements.externalUnavailable');
  const selected = conversations.find(value => value.id === id);
  React.useEffect(() => {
    if (!id) return;
    const controller = new AbortController(); const host = getRuntimeEndpointGeneration(); setRead(undefined);
    void createExternalAgentsHttpAPI(host).read(id, undefined, controller.signal).then(snapshot => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setRead(snapshot.conversation.id === id ? { id, snapshot } : { id, error: unavailable });
    }, cause => { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setRead({ id, error: cause instanceof Error ? cause.message : String(cause) }); });
    return () => controller.abort();
  }, [id, selected?.revision, revision, unavailable]);
  const snapshot = read && read.id === id ? read.snapshot : undefined;
  const reason = (conversation: ExternalConversationSnapshot['conversation'] | undefined, live?: ExternalConversationSnapshot) => {
    if (!conversation) return undefined;
    if (conversation.deleted) return t('arrangements.externalDeleted');
    if (conversation.archived) return t('arrangements.externalArchived');
    if (conversation.needsReview) return t('arrangements.externalReview');
    if (settings) {
      const configuration = settings.agents.find(value => value.id === conversation.configurationId);
      if (!configuration) return t('arrangements.externalConfigurationMissing');
      if (!configuration.enabled) return t('arrangements.externalDisabled');
    }
    if (live && !live.connected && live.connection?.status === 'authentication_required') return t('arrangements.externalAuthentication');
    return undefined;
  };
  const entries = new Map<string, { id: string; label: string; reason?: string }>();
  for (const conversation of conversations.filter(value => !value.deleted)) entries.set(conversation.id, { id: conversation.id,
    label: `${conversation.title || conversation.id} · ${conversation.harness}`, reason: reason(conversation, conversation.id === id ? snapshot : undefined) });
  for (const child of children) if (!entries.has(child.conversationId)) entries.set(child.conversationId, { id: child.conversationId, label: `${child.name || child.conversationId} · ${child.harness}` });
  if (snapshot && !snapshot.conversation.deleted) entries.set(snapshot.conversation.id, { id: snapshot.conversation.id, label: `${snapshot.conversation.title || snapshot.conversation.id} · ${snapshot.conversation.harness}`, reason: reason(snapshot.conversation, snapshot) });
  const failure = id ? read?.id === id ? read.error ?? reason(snapshot?.conversation ?? selected, snapshot) : reason(selected) : undefined;
  return { entries: [...entries.values()], id, loading: !!id && read?.id !== id, error: failure,
    directoryError, selectable: !id || !!snapshot && !failure,
    note: id && snapshot && !failure ? (snapshot.connection?.error ? `${snapshot.connection.error} · ` : '') + t(snapshot.connected ? 'arrangements.externalLive' : 'arrangements.externalVerify') : undefined,
    refresh: () => { setRevision(value => value + 1); void useExternalAgentStore.getState().refresh(); } };
}
