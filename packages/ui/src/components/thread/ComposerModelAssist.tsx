import React from 'react';
import { composerWorkflowFailure } from './composerWorkflowState';
import { ThreadRequestError, getRuntimeEndpointGeneration, getThreadObservationBus, type ThreadDispatchCatalog, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { readComposerAssistResult } from '@/lib/agent-runtime/composerAssist';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

/** An explicit normal Agent task, followed by review. Merely opening a workflow never calls a model. */
export function ComposerModelAssist({ api, identity, draftKey, text, purpose, disabled, onApply }: { api: ThreadsAPI; identity: ThreadIdentity; draftKey: string; text: string; purpose: 'memory' | 'handoff'; disabled?: boolean; onApply(text: string): void }) {
  const { t } = useI18n(), key = `${draftKey}:assist:${purpose}`;
  const draft = useThreadDraftStore(state => state.drafts[key] ?? EMPTY_THREAD_DRAFT), state = draft.composerWorkflow?.assist;
  const patch = React.useCallback((value: NonNullable<typeof state>) => useThreadDraftStore.getState().patch(key, { composerWorkflow: { assist: value } }), [key]);
  const [host] = React.useState(getRuntimeEndpointGeneration), [open, setOpen] = React.useState(Boolean(state?.pending || state?.receipt));
  const [catalog, setCatalog] = React.useState<ThreadDispatchCatalog>(), [model, setModel] = React.useState(state?.pending?.model ?? '');
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string>();
  const pending = React.useRef(false), alive = React.useRef(true);
  const current = () => alive.current && host === getRuntimeEndpointGeneration();
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => {
    if (!open || !api.collaboration?.dispatchCatalog) return;
    const abort = new AbortController();
    void api.collaboration.dispatchCatalog({ runtime: 'agent', threadId: identity.threadId, branchId: identity.branchId }, abort.signal).then(value => {
      if (!abort.signal.aborted && host === getRuntimeEndpointGeneration()) { setCatalog(value); setError(undefined); }
    }, cause => { if (!abort.signal.aborted && host === getRuntimeEndpointGeneration()) setError(composerWorkflowFailure(cause)); });
    return () => abort.abort();
  }, [api, host, identity.threadId, identity.branchId, open]);
  const [readVersion, setReadVersion] = React.useState(0);
  React.useEffect(() => {
    if (!open || !state?.receipt || state.result || state.failure) return;
    const receipt = state.receipt, controller = new AbortController(); let reading = false, dirty = false;
    const read = async () => {
      if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
      if (reading) { dirty = true; return; } reading = true;
      try {
        do { dirty = false; const result = await readComposerAssistResult(api, identity, receipt, controller.signal);
          if (controller.signal.aborted || host !== getRuntimeEndpointGeneration()) return;
          if (result.status === 'ready') { patch({ receipt, result: result.text }); return; }
          if (result.status === 'failed') { patch({ receipt, failure: result.message }); return; }
        } while (dirty);
      } catch (cause) { if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setError(composerWorkflowFailure(cause)); }
      finally { reading = false; }
    };
    const bus = getThreadObservationBus(api);
    const subscriptions = [...new Set([identity.threadId, receipt.threadId])].map(threadId => bus.subscribe({
      threadId, kinds: ['child.*', 'execution.*', 'run.*', 'operation.*'],
    }, () => void read()));
    void read(); return () => { subscriptions.forEach(unsubscribe => unsubscribe()); controller.abort(); };

  }, [api, host, identity, open, patch, readVersion, state?.receipt, state?.result, state?.failure]);
  if (!api.collaboration?.dispatch) return null;
  const start = async () => {
    if (pending.current || !current() || disabled || !state?.pending && !catalog?.runId) return;
    pending.current = true; setBusy(true); setError(undefined);
    const input = state?.pending ?? { ...identity, key: crypto.randomUUID(), runId: catalog!.runId!, expectedHead: catalog!.headId, model, projectId: null, workMode: 'read_only' as const,
      text: `${t(purpose === 'memory' ? 'composer.workflow.assistMemoryPrompt' : 'composer.workflow.assistHandoffPrompt')}\n\n${text}` };
    patch({ pending: input });
    try { const receipt = await api.collaboration!.dispatch(input); const latest = useThreadDraftStore.getState().drafts[key]?.composerWorkflow?.assist; patch({ ...(latest?.receipt?.executionId === receipt.executionId ? latest : {}), pending: undefined, receipt }); }
    catch (cause) { if (cause instanceof ThreadRequestError && cause.admission === 'not_started') patch({ pending: input, rejected: true }); if (current()) setError(composerWorkflowFailure(cause)); }
    finally { pending.current = false; if (current()) setBusy(false); }
  };
  return <div className="space-y-2 border-t border-border/50 pt-2">
    <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)}>{t('composer.workflow.assist')}</Button>
    {open && <div className="space-y-2">
      <p className="text-muted-foreground">{t('composer.workflow.assistDisclosure')}</p>
      {!state?.receipt && <><select aria-label={t('composer.workflow.assistModel')} value={model} disabled={disabled || busy || Boolean(state?.pending)} onChange={event => setModel(event.target.value)} className="w-full rounded border bg-background p-2"><option value="">{t('composer.workflow.chooseModel')}</option>{catalog?.models.map(choice => <option key={choice.id} value={choice.id}>{choice.name} · {choice.channelName}</option>)}</select>
        {catalog?.unavailable && <p>{catalog.unavailable}</p>}
        <Button type="button" disabled={disabled || busy || !state?.pending && (!text.trim() || !model || !catalog?.runId || Boolean(catalog.unavailable))} onClick={() => void start()}>{t(state?.pending ? 'composer.menu.retry' : 'composer.workflow.startAssist')}</Button></>}
      {state?.receipt && !state.result && !state.failure && <><p role="status">{t(state.cancelRequested ? 'composer.workflow.assistCancelling' : 'composer.workflow.assistRunning')} · {state.receipt.threadId}</p>
        <Button type="button" variant="ghost" disabled={busy || state.cancelRequested} onClick={() => {
          if (pending.current || !current()) return; pending.current = true; setBusy(true);
          void api.collaboration!.cancelChild(identity, state.receipt!.operationId).then(() => { patch({ ...useThreadDraftStore.getState().drafts[key]?.composerWorkflow?.assist, cancelRequested: true }); if (current()) setReadVersion(value => value + 1); }, cause => { if (current()) setError(composerWorkflowFailure(cause)); }).finally(() => { pending.current = false; if (current()) setBusy(false); });
        }}>{t('composer.workflow.cancelAssist')}</Button></>}
      {state?.result && <><textarea readOnly value={state.result} rows={5} aria-label={t('composer.workflow.assistResult')} className="w-full resize-y rounded border bg-background p-2" /><Button type="button" disabled={disabled} onClick={() => { if (current()) onApply(state.result!); }}>{t('composer.workflow.applyDraft')}</Button></>}
      {state?.failure && <p role="alert" className="text-destructive">{state.failure}</p>}
      {(state?.result || state?.failure) && <Button type="button" variant="ghost" onClick={() => { patch({}); setCatalog(undefined); setModel(''); setOpen(false); }}>{t('composer.workflow.newAssist')}</Button>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {state?.rejected && <Button type="button" variant="ghost" onClick={() => { patch({}); setCatalog(undefined); setOpen(false); }}>{t('composer.workflow.editRetry')}</Button>}
      {state?.receipt && error && <Button type="button" variant="ghost" onClick={() => { setError(undefined); setReadVersion(value => value + 1); }}>{t('composer.menu.retry')}</Button>}
    </div>}
  </div>;
}
