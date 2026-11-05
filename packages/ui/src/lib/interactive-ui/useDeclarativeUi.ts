import React from 'react';
import { createInteractiveUiHttpAPI, getRuntimeEndpointGeneration, InteractiveUiError, migrateConversationUiState, normalizeConversationUi, conversationUiFields, type ContentReference, type ConversationUiNode, type UiFragmentRegistrationInput, type UiObservation, type UiSourceIdentity, type UiViewRegistration, type UiViewState } from '@varin/application-client';
import type { JsonValue } from '@varin/protocol';
import { useOptionalConversationPresentation } from '@/components/conversation/ConversationContext';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { useI18n } from '@/lib/i18n';
import { uiSession, type UiSession } from './sessions';

export interface DeclarativeUiSource { node: ConversationUiNode; sourceKey: string; fragment?: UiFragmentRegistrationInput; source?: UiSourceIdentity; session?: UiSession; isStreaming?: boolean }
const empty = (node?: ConversationUiNode): UiViewState => ({ data: node ? Object.fromEntries(conversationUiFields(node).filter(field => field.type === 'input' && field.inputType === 'range').map(field => [field.key, field.type === 'input' ? String(field.min ?? 0) : ''])) : {}, controls: {}, scroll: { x: 0, y: 0 } });
function valuesOf(state: UiViewState): Record<string, JsonValue> {
  return state.data && typeof state.data === 'object' && !Array.isArray(state.data) ? state.data as Record<string, JsonValue> : {};
}
function restore(state: UiViewState | undefined, node: ConversationUiNode): UiViewState {
  const base = state ?? empty(node);
  let data = valuesOf(base), resetKeys: string[] = [];
  const definition = base.controls.__varinDefinition;
  if (definition) try { const migrated = migrateConversationUiState(normalizeConversationUi(definition), node, data); data = migrated.values; resetKeys = migrated.resetKeys; } catch { /* Host validates definitions; old views may not have one. */ }
  return { ...base, data: { ...valuesOf(empty(node)), ...data }, controls: { ...base.controls, __varinDefinition: node as unknown as JsonValue,
    ...(resetKeys.length ? { __varinResetKeys: resetKeys } : {}) } };
}
/** Declarative controls use the same view leases and immutable selections as HTML. */
export function useDeclarativeUi(props: DeclarativeUiSource) {
  const conversation = useOptionalConversationPresentation();
  const { t } = useI18n();
  const host = getRuntimeEndpointGeneration();
  const session = React.useMemo(() => props.session ?? (conversation ? uiSession(`${threadComposerKey(threadHostKey(), conversation.identity)}:fragment:${props.sourceKey}`, conversation.identity, host) : undefined),
    // Identity, not the timeline projection object, owns the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.session, conversation?.identity.runtime, conversation?.identity.threadId, conversation?.identity.branchId, host, props.sourceKey]);
  const api = React.useMemo(() => createInteractiveUiHttpAPI(host), [host]);
  const [state, setState] = React.useState<UiViewState>(() => restore(session?.state ?? session?.initialState, props.node));
  const [error, setError] = React.useState('');
  const [persistenceError, setPersistenceError] = React.useState('');
  const [resetKeys, setResetKeys] = React.useState<string[]>([]);
  const [retry, retryConnection] = React.useReducer((n: number) => n + 1, 0);
  const latest = React.useRef(state); latest.current = state;
  const owner = React.useRef<UiViewRegistration | undefined>(undefined);
  const source = React.useRef<UiSourceIdentity | undefined>(props.source);
  const writes = React.useRef(Promise.resolve());
  const dirty = React.useRef(Boolean(session?.state));
  // Schema updates migrate separately; only scope changes reset the local view.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => { const restored = restore(session?.state ?? session?.initialState, props.node); latest.current = restored; setState(restored); dirty.current = Boolean(session?.state); setError(''); setPersistenceError(''); const resets = restored.controls.__varinResetKeys; setResetKeys(Array.isArray(resets) ? resets.filter((key): key is string => typeof key === 'string') : []); }, [session]);
  const node = React.useRef(props.node); node.current = props.node;
  const previous = React.useRef(props.node);
  const mounted = React.useRef(true);
  const update = React.useCallback((next: UiViewState) => {
    dirty.current = true; latest.current = next; if (session) session.state = next; setState(next);
  }, [session]);
  React.useEffect(() => {
    if (previous.current === props.node) return;
    const migration = migrateConversationUiState(previous.current, props.node, valuesOf(latest.current));
    previous.current = props.node; setResetKeys(migration.resetKeys);
    update({ ...latest.current, data: { ...valuesOf(empty(props.node)), ...migration.values }, controls: { ...latest.current.controls, __varinDefinition: props.node as unknown as JsonValue } });
  }, [props.node, update]);
  const observation = React.useCallback((): UiObservation => {
    if (!source.current || !owner.current) throw new Error(t('ui.content.notReady'));
    return { ...source.current, viewRef: owner.current.viewRef, capturedAt: new Date().toISOString(), state: latest.current,
      context: valuesOf(latest.current), viewport: { width: 0, height: 0 }, render: { state: source.current.ref ? 'ready' : 'preview' } };
  }, [t]);
  const persist = React.useCallback((next: UiViewState) => {
    const registration = owner.current;
    if (!session || !registration) return Promise.resolve();
    const write = writes.current.then(() => api.state(session.identity, registration.viewRef, registration.token, next)).then(() => {
      if (latest.current === next) dirty.current = false;
      if (mounted.current) setPersistenceError('');
    }, failure => { if (mounted.current) setPersistenceError(failure instanceof Error ? failure.message : String(failure)); throw failure; });
    writes.current = write.catch(() => {}); return write;
  }, [api, session]);
  React.useEffect(() => {
    if (!session) return;
    const flush = async () => {
      // Uncommitted previews are not eligible for the Host's inherited branch snapshot.
      if (props.isStreaming && (!source.current?.ref || source.current.preview)) return;
      if (!dirty.current) { await writes.current; return; }
      if (!source.current?.ref || !owner.current) throw new Error(t('ui.content.notReady'));
      await persist(latest.current);
    };
    session.flushState = flush;
    return () => { if (session.flushState === flush) delete session.flushState; };
  }, [session, props.isStreaming, persist, t]);
  React.useEffect(() => {
    mounted.current = true;
    if (!session) return;
    const abort = new AbortController(); let registration: UiViewRegistration | undefined;
    void (async () => {
      try {
        await writes.current;
        if (abort.signal.aborted) return;
        let preparedSource = props.source;
        if (!preparedSource && props.fragment) {
          try { const registered = await api.registerFragment(session.identity, props.fragment, abort.signal); preparedSource = { ref: registered.ref }; session.source = registered; }
          catch (failure) {
            if (!props.isStreaming || !(failure instanceof InteractiveUiError) || failure.status !== 404) throw failure;
            preparedSource = { preview: { content: node.current, callId: `fragment:${props.fragment.messageId}:${props.fragment.contentIndex ?? 0}:${props.fragment.fragmentKey}`, sequence: 0,
              title: node.current.label ?? t('ui.content.title'), entry: '', contents: {}, messageFragment: { ...session.identity, ...props.fragment, contentVersion: '' } } };
          }
        }
        if (!preparedSource) throw new Error(t('ui.content.actionsUnavailable'));
        if (!session.viewRef) { try { session.viewRef = sessionStorage.getItem(`varin.ui-view:${session.key}`) ?? undefined; } catch { /* storage may be disabled */ } }
        if (abort.signal.aborted) return;
        registration = await api.attach(session.identity, preparedSource, session.viewRef, abort.signal);
        if (abort.signal.aborted) return;
        source.current = preparedSource; owner.current = registration; session.viewRef = registration.viewRef;
        if (!props.session) session.display = { source: preparedSource, content: node.current, files: {}, assets: {}, entry: '', title: node.current.label ?? t('ui.content.title'), committed: Boolean(preparedSource.ref), status: '' };
        try { sessionStorage.setItem(`varin.ui-view:${session.key}`, registration.viewRef); } catch { /* memory still retains this view */ }
        if (!dirty.current) { latest.current = session.state = restore(registration.state ?? session.initialState, node.current); setState(latest.current); dirty.current = Boolean(!registration.state && session.initialState); }
        delete session.initialState;
        const resets = latest.current.controls.__varinResetKeys;
        if (Array.isArray(resets)) setResetKeys(resets.filter((key): key is string => typeof key === 'string'));
        if (dirty.current) await persist(latest.current);
        setError('');
        const lease = registration;
        await api.observe(session.identity, lease.viewRef, lease.token, request => {
          void api.reply(session.identity, lease.viewRef, lease.token, request.id, observation()).catch(failure => { if (!abort.signal.aborted) setError(String(failure)); });
        }, abort.signal);
      } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    })();
    return () => {
      mounted.current = false; abort.abort(); owner.current = undefined;
      if (registration) { const lease = registration, finalState = session.state ?? empty();
        writes.current = writes.current.then(() => api.detach(session.identity, lease.viewRef, lease.token, finalState)).then(() => {}, () => {});
      }
    };
  // Source identity is stable even when the parent rebuilds the source DTO.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session, props.source?.ref, props.source?.preview?.callId, props.source?.preview?.sequence, props.fragment?.messageId, props.fragment?.fragmentKey, props.fragment?.contentIndex, props.isStreaming, retry, observation, persist]);
  React.useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => { void persist(state).catch(() => {}); }, 200);
    return () => clearTimeout(timer);
  }, [state, persist]);
  const reference = async (text: string): Promise<ContentReference | undefined> => {
    if (!session) return undefined;
    const selected = await api.select(session.identity, observation(), { text });
    return { ref: selected.ref, title: selected.title, text: selected.text, source: { kind: 'ui', thread: session.identity,
      itemId: props.fragment?.messageId, snapshotRef: selected.snapshotRef, viewRef: selected.viewRef,
      revisionRef: selected.source.ref, previewCallId: selected.source.preview?.callId } };
  };
  return { state, values: valuesOf(state), error: [error, persistenceError].filter(Boolean).join(' · '), resetKeys, session, host, reference,
    retry: () => { retryConnection(); },
    setValue: (key: string, value: JsonValue) => {
      const remaining = resetKeys.filter(reset => reset !== key && `${reset}:other` !== key); setResetKeys(remaining);
      update({ ...latest.current, data: { ...valuesOf(latest.current), [key]: value }, controls: { ...latest.current.controls, __varinResetKeys: remaining } });
    },
    setControl: (key: string, value: JsonValue) => update({ ...latest.current, controls: { ...latest.current.controls, [key]: value } }),
  };
}
