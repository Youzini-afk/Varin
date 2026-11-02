import React from 'react';
import { createExternalAgentsHttpAPI, ExternalAgentError, getRuntimeEndpointGeneration, type ExternalConversationSnapshot } from '@varin/application-client';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore, type ThreadDraft } from '@/stores/useThreadDraftStore';
import { useI18n } from '@/lib/i18n';

/** Prepares a connection, not a model request. Durable identity survives failed/repeated preparation. */
export function useExternalDraftPreparation({ draftKey, host, configurationId, cwd, name }: {
  draftKey: string; host: number; configurationId?: string | null; cwd?: string; name?: string;
}) {
  const { t } = useI18n();
  const scope = React.useMemo(() => ({ draftKey, host, configurationId, cwd }), [draftKey, host, configurationId, cwd]);
  const currentScope = React.useRef(scope);
  currentScope.current = scope;
  const api = React.useMemo(() => createExternalAgentsHttpAPI(host), [host]);
  const [state, setState] = React.useState<{ scope: object; snapshot?: ExternalConversationSnapshot; error?: unknown; busy?: boolean; cancelling?: boolean }>({ scope });
  const operation = React.useRef<object | null>(null);
  const cancellation = React.useRef<object | null>(null);
  const activity = React.useRef(0);
  const alive = React.useRef(true);
  const current = () => alive.current && currentScope.current === scope && host === getRuntimeEndpointGeneration();
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => { operation.current = null; cancellation.current = null; }, [scope]);
  const draft = useThreadDraftStore(value => value.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const id = draft.externalConversationHost === host ? draft.externalConversationId : undefined;
  React.useEffect(() => {
    if (!id || !configurationId) return;
    const controller = new AbortController();
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence, initialActivity = activity.current;
      const valid = () => !controller.signal.aborted && request === sequence && initialActivity === activity.current && currentScope.current === scope && host === getRuntimeEndpointGeneration();
      try {
        const snapshot = await api.read(id, undefined, controller.signal);
        if (valid()) setState(old => old.scope === scope && (old.busy || old.cancelling) ? old : { ...(old.scope === scope ? old : {}), scope, snapshot });
      } catch (error) {
        if (valid()) setState(old => old.scope === scope && (old.busy || old.cancelling || old.error) ? old : { ...(old.scope === scope ? old : {}), scope, error });
      }
    };
    void refresh();
    void api.observe(id, event => { if (event.kind === 'refresh' && !controller.signal.aborted) void refresh(); }, controller.signal)
      .catch(error => { if (!controller.signal.aborted && currentScope.current === scope && host === getRuntimeEndpointGeneration())
        setState(old => ({ ...(old.scope === scope ? old : {}), scope, error: old.scope === scope ? old.error ?? error : error })); });
    return () => controller.abort();
  }, [id, configurationId, api, host, scope]);
  const ensureConversation = async () => {
    const latest = useThreadDraftStore.getState().drafts[draftKey] ?? EMPTY_THREAD_DRAFT;
    if (latest.externalConversationId && latest.externalConversationHost === host) return latest.externalConversationId;
    if (!configurationId) throw new Error(t('external.noAgent'));
    const key = latest.externalConversationHost === host && latest.externalPreparationKey ? latest.externalPreparationKey : crypto.randomUUID();
    useThreadDraftStore.getState().patch(draftKey, { externalPreparationKey: key, externalConversationHost: host });
    const conversation = await api.create({ key, configurationId, ...(cwd ? { cwd } : {}), title: name || 'Agent' });
    if (!current()) return;
    useThreadDraftStore.getState().patch(draftKey, { externalConversationId: conversation.id });
    return conversation.id;
  };
  const run = async (action: () => Promise<ExternalConversationSnapshot | void>) => {
    if (operation.current || cancellation.current || !current()) return;
    const token = {};
    operation.current = token;
    activity.current++;
    setState(old => ({ ...(old.scope === scope ? old : {}), scope, error: undefined, busy: true }));
    try {
      const snapshot = await action();
      if (current() && operation.current === token) setState(old => ({ ...(old.scope === scope ? old : {}), scope, ...(snapshot ? { snapshot } : {}), busy: false }));
    } catch (error) {
      if (current() && operation.current === token) setState(old => ({ ...(old.scope === scope ? old : {}), scope, error, busy: false }));
    } finally { if (operation.current === token) { operation.current = null; activity.current++; } }
  };
  return {
    snapshot: state.scope === scope ? state.snapshot : undefined,
    error: state.scope === scope ? state.error : undefined,
    busy: state.scope === scope && Boolean(state.busy || state.cancelling),
    cancelling: state.scope === scope && Boolean(state.cancelling),
    cancel: async () => {
      if (!id || cancellation.current || !current()) return;
      const token = {};
      cancellation.current = token;
      setState(old => ({ ...(old.scope === scope ? old : {}), scope, cancelling: true }));
      try {
        await api.disconnect(id);
        if (!current()) return;
        operation.current = null; activity.current++;
        setState(old => ({ ...(old.scope === scope ? old : {}), scope, busy: false, cancelling: true,
          ...(old.scope === scope && old.snapshot ? { snapshot: { ...old.snapshot, connected: false, capabilities: undefined } } : {}) }));
        const snapshot = await api.read(id);
        if (current()) setState({ scope, snapshot });
      } catch (error) {
        if (current()) setState(old => ({ ...(old.scope === scope ? old : {}), scope, error, cancelling: false }));
      } finally { if (cancellation.current === token) cancellation.current = null; }
    },
    prepare: () => run(async () => {
      const conversationId = await ensureConversation();
      if (!conversationId || !current()) return;
      await api.connect(conversationId);
      if (!current()) return;
      return api.read(conversationId);
    }),
    authenticate: (methodId: string) => run(async () => {
      if (!id) return;
      await api.authenticate(id, methodId);
      if (!current()) return;
      return api.read(id);
    }),
    change: (value: Partial<ThreadDraft>) => run(async () => {
      // Resolve an uncertain create with its original key before cleaning up its binding.
      const latest = useThreadDraftStore.getState().drafts[draftKey];
      const conversationId = latest?.externalConversationHost === host && latest.externalPreparationKey
        ? await ensureConversation() : id;
      if (!current()) return;
      if (conversationId) {
        // A lost delete response leaves the candidate retained until a read confirms it is gone.
        const snapshot = await api.read(conversationId).catch(error => {
          if (error instanceof ExternalAgentError && error.status === 404) return undefined;
          throw error;
        });
        if (!current()) return;
        if (snapshot?.turns.length || latest?.externalInput) throw new Error(t('external.inputExists'));
        if (snapshot) await api.update(conversationId, snapshot.conversation.revision, { deleted: true });
        if (!current()) return;
      }
      useThreadDraftStore.getState().patch(draftKey, { ...value, externalConversationId: undefined, externalPreparationKey: undefined,
        externalConversationHost: undefined, externalInput: undefined });
      setState({ scope });
    }),
  };
}
