import React from 'react';
import { createExternalAgentsHttpAPI, ExternalAgentError, getRuntimeEndpointGeneration, type ExternalConversationSnapshot } from '@varin/application-client';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore, type ThreadDraft } from '@/stores/useThreadDraftStore';
import { useI18n } from '@/lib/i18n';

type Operation = { scope: object; cancelled: boolean; promise: Promise<ExternalConversationSnapshot | undefined> };
/** Reads/observes on mount; only explicit interaction prepares. Concurrent callers share the same result. */
export function useExternalDraftPreparation({ draftKey, host, configurationId, cwd, name }: {
  draftKey: string; host: number; configurationId?: string | null; cwd?: string; name?: string;
}) {
  const { t } = useI18n();
  const draft = useThreadDraftStore(value => value.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const sourceOwnerKey = JSON.stringify([draft.sourceSelection?.resourceOwner ?? { kind: 'local' }, draft.sourceSelection?.expectedWorkspaceId]);
  const scope = React.useMemo(() => ({ draftKey, host, configurationId, cwd, sourceOwnerKey }), [draftKey, host, configurationId, cwd, sourceOwnerKey]);
  const currentScope = React.useRef(scope); currentScope.current = scope;
  const api = React.useMemo(() => createExternalAgentsHttpAPI(host), [host]);
  const [state, setState] = React.useState<{ scope: object; snapshot?: ExternalConversationSnapshot; error?: unknown; busy?: boolean; cancelling?: boolean }>({ scope });
  const stateRef = React.useRef(state); stateRef.current = state;
  const operation = React.useRef<Operation | null>(null);
  const creating = React.useRef<{ scope: object; promise: Promise<string | undefined> } | null>(null);
  const cancellation = React.useRef<{ scope: object; promise: Promise<boolean> } | null>(null);
  const changing = React.useRef<{ scope: object; value: Partial<ThreadDraft>; promise: Promise<boolean> } | null>(null);
  const activity = React.useRef(0);
  const alive = React.useRef(true);
  const current = () => alive.current && currentScope.current === scope && host === getRuntimeEndpointGeneration();
  const update = (value: Partial<typeof state>) => { if (current()) setState(old => ({ ...(old.scope === scope ? old : {}), scope, ...value })); };
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const id = draft.externalConversationHost === host ? draft.externalConversationId : undefined;
  React.useEffect(() => {
    if (!id || !configurationId) return;
    const controller = new AbortController(); let sequence = 0;
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
  const ensureConversation = (): Promise<string | undefined> => {
    if (creating.current?.scope === scope) return creating.current.promise;
    const latest = useThreadDraftStore.getState().drafts[draftKey] ?? EMPTY_THREAD_DRAFT;
    if (latest.externalConversationId && latest.externalConversationHost === host) return Promise.resolve(latest.externalConversationId);
    if (!configurationId) return Promise.reject(new Error(t('external.noAgent')));
    if (!cwd) return Promise.reject(new Error(t('external.sharedSource')));
    const key = latest.externalConversationHost === host && latest.externalPreparationKey ? latest.externalPreparationKey : crypto.randomUUID();
    useThreadDraftStore.getState().patch(draftKey, { externalPreparationKey: key, externalConversationHost: host });
    const token = { scope, promise: Promise.resolve(undefined) as Promise<string | undefined> };
    creating.current = token;
    token.promise = api.create({ key, configurationId, cwd, ...(latest.sourceSelection ? {source:{resourceOwner:latest.sourceSelection.resourceOwner,path:latest.sourceSelection.path,expectedWorkspaceId:latest.sourceSelection.expectedWorkspaceId}} : {}), title: name || 'Agent', ...(latest.organization ? { organization: latest.organization } : {}) }).then(conversation => {
      if (!current()) return;
      useThreadDraftStore.getState().patch(draftKey, { externalConversationId: conversation.id });
      return conversation.id;
    }).finally(() => { if (creating.current === token) creating.current = null; });
    return token.promise;
  };
  const run = (action: (token: Operation) => Promise<ExternalConversationSnapshot | undefined>) => {
    if (operation.current?.scope === scope) return operation.current.promise;
    if (!current() || cancellation.current?.scope === scope || changing.current?.scope === scope) return Promise.resolve(undefined);
    const token: Operation = { scope, cancelled: false, promise: Promise.resolve(undefined) };
    operation.current = token; activity.current++; update({ error: undefined, busy: true });
    token.promise = action(token).then(snapshot => {
      if (!token.cancelled && current()) update({ ...(snapshot ? { snapshot } : {}), busy: false });
      return token.cancelled || !current() ? undefined : snapshot;
    }).catch(error => { if (!token.cancelled && current()) { update({ error, busy: false }); throw error; } return undefined; }).finally(() => {
      if (operation.current === token) { operation.current = null; activity.current++; }
    });
    return token.promise;
  };
  const prepare = (force: boolean | 'models' = false) => {
    const latest = stateRef.current;
    if (force === true && latest.scope === scope && latest.snapshot?.connected && latest.snapshot.capabilities?.resume === false) return Promise.reject(new ExternalAgentError('resume_unsupported', t('external.reconnectUnsupported')));
    if (force === true && latest.scope === scope && latest.snapshot?.turns.some(turn => ['queued', 'preparing', 'running', 'waiting_user', 'stopping'].includes(turn.status))) return Promise.resolve(undefined);
    if (!force && latest.scope === scope && latest.snapshot?.connected && latest.snapshot.capabilitiesSource !== 'cached') return Promise.resolve(latest.snapshot);
    return run(async token => {
      const conversationId = await ensureConversation();
      if (!conversationId || !current() || token.cancelled) return;
      if (force === true) await api.disconnect(conversationId);
      if (!current() || token.cancelled) return;
      await api.connect(conversationId);
      if (!current() || token.cancelled) return;
      return api.read(conversationId);
    });
  };
  const cancel = (): Promise<boolean> => {
    if (cancellation.current?.scope === scope) return cancellation.current.promise;
    if (!current()) return Promise.resolve(false);
    const active = operation.current?.scope === scope ? operation.current : undefined;
    if (active) active.cancelled = true;
    const token = { scope, promise: Promise.resolve(false) }; cancellation.current = token;
    activity.current++; update({ cancelling: true });
    token.promise = (async () => {
      // Creation cannot be aborted by dropping HTTP: resolve its durable identity before stopping it.
      const conversationId = await ensureConversation();
      if (!conversationId || !current()) return false;
      await api.disconnect(conversationId);
      if (!current()) return false;
      if (operation.current === active) operation.current = null;
      const snapshot = await api.read(conversationId);
      update({ snapshot, error: undefined, busy: false, cancelling: false });
      return true;
    })().catch(error => { update({ error, cancelling: false }); return false; }).finally(() => {
      if (cancellation.current === token) cancellation.current = null; activity.current++;
    });
    return token.promise;
  };
  return {
    snapshot: state.scope === scope ? state.snapshot : undefined,
    error: state.scope === scope ? state.error : undefined,
    busy: state.scope === scope && Boolean(state.busy || state.cancelling),
    cancelling: state.scope === scope && Boolean(state.cancelling), prepare, cancel,
    authenticate: (methodId: string) => run(async () => {
      const conversationId = await ensureConversation(); if (!conversationId || !current()) return;
      await api.authenticate(conversationId, methodId); if (current()) return api.read(conversationId);
    }),
    change: (value: Partial<ThreadDraft>): Promise<boolean> => {
      if (!current()) return Promise.resolve(false);
      if (changing.current?.scope === scope) { changing.current.value = value; return changing.current.promise; }
      const token = { scope, value, promise: Promise.resolve(false) }; changing.current = token;
      token.promise = (async () => {
        if (operation.current?.scope === scope && !await cancel()) return false;
        const latest = useThreadDraftStore.getState().drafts[draftKey];
        const conversationId = latest?.externalConversationHost === host && latest.externalPreparationKey ? await ensureConversation() : id;
        if (!current()) return false;
        update({ busy: true, error: undefined }); activity.current++;
        if (conversationId) {
          const snapshot = await api.read(conversationId).catch(error => { if (error instanceof ExternalAgentError && error.status === 404) return undefined; throw error; });
          if (!current()) return false;
          if (snapshot?.turns.length || useThreadDraftStore.getState().drafts[draftKey]?.externalInput) throw new Error(t('external.inputExists'));
          if (snapshot) await api.update(conversationId, snapshot.conversation.revision, { deleted: true });
          if (!current()) return false;
        }
        useThreadDraftStore.getState().patch(draftKey, { ...token.value, externalConversationId: undefined, externalPreparationKey: undefined, externalConversationHost: undefined, externalInput: undefined });
        setState({ scope }); return true;
      })().catch(error => { update({ error, busy: false }); return false; }).finally(() => { if (changing.current === token) changing.current = null; activity.current++; });
      return token.promise;
    },
  };
}
