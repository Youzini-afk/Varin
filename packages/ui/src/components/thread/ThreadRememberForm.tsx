import React from 'react';
import { composerWorkflowFailure } from './composerWorkflowState';
import { ThreadRequestError, getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadRememberScope, type ThreadsAPI } from '@varin/application-client';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useI18n } from '@/lib/i18n';
import { ComposerModelAssist } from './ComposerModelAssist';
import { Button } from '@/components/ui/button';

export function ThreadRememberForm({ api, identity, draftKey, initialText, onOpen }: { api: ThreadsAPI; identity: ThreadIdentity; draftKey: string; initialText: string; onOpen?(): void }) {
  const { t } = useI18n(), key = `${draftKey}:remember`;
  const draft = useThreadDraftStore(state => state.drafts[key] ?? EMPTY_THREAD_DRAFT);
  const patch = React.useCallback((value: Parameters<ReturnType<typeof useThreadDraftStore.getState>['patch']>[1]) => useThreadDraftStore.getState().patch(key, value), [key]);
  const initial = React.useRef(initialText);
  const [host] = React.useState(getRuntimeEndpointGeneration), [scopes, setScopes] = React.useState<ThreadRememberScope[]>();
  const [index, setIndex] = React.useState(0), [trigger, setTrigger] = React.useState('');
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string>();
  const pending = React.useRef(false), alive = React.useRef(true);
  const state = draft.composerWorkflow?.remember, locked = busy || Boolean(state?.pending || state?.receipt);
  const destination = state?.pending?.destination ?? state?.receipt?.destination ?? scopes?.[index]?.destination;
  const current = () => alive.current && host === getRuntimeEndpointGeneration();
  const load = React.useCallback(async () => {
    if (!api.workflows || host !== getRuntimeEndpointGeneration()) return;
    try { const result = await api.workflows.memoryScopes({ runtime: 'agent', threadId: identity.threadId, branchId: identity.branchId }); if (alive.current && host === getRuntimeEndpointGeneration()) { setScopes(result); setError(undefined); } }
    catch (cause) { if (alive.current && host === getRuntimeEndpointGeneration()) setError(composerWorkflowFailure(cause)); }
  }, [api, host, identity.threadId, identity.branchId]);
  React.useEffect(() => { alive.current = true; if (!useThreadDraftStore.getState().drafts[key]) patch({ text: initial.current }); void load(); return () => { alive.current = false; }; }, [key, load, patch]);
  const scopeLabel = (scope: ThreadRememberScope['destination']) => `${t(`composer.workflow.scope.${scope.kind}`)}${'id' in scope ? ` · ${scope.id}` : ''}`;
  const save = async () => {
    if (!api.workflows || pending.current || !current() || !state?.pending && !scopes?.[index]) return;
    pending.current = true; setBusy(true); setError(undefined);
    const input = state?.pending ?? { ...identity, key: crypto.randomUUID(), destination: scopes![index]!.destination, revision: scopes![index]!.revision, content: draft.text, trigger };
    patch({ composerWorkflow: { remember: { pending: input } } });
    try { const receipt = await api.workflows.remember(input); patch({ composerWorkflow: { remember: { receipt } } }); }
    catch (cause) { if (cause instanceof ThreadRequestError && [400, 403, 409].includes(cause.status)) patch({ composerWorkflow: { remember: { pending: input, rejected: true } } }); if (current()) setError(composerWorkflowFailure(cause)); }
    finally { pending.current = false; if (current()) setBusy(false); }
  };
  return <div className="space-y-3 typography-ui-label">
    <label className="block space-y-1"><span>{t('composer.workflow.destination')}</span><select aria-label={t('composer.workflow.destination')} disabled={locked || !scopes} value={(state?.pending || state?.receipt) && scopes ? scopes.findIndex(scope => JSON.stringify(scope.destination) === JSON.stringify(destination)) : index} onChange={event => setIndex(Number(event.target.value))} className="w-full rounded border bg-background p-2">
      {scopes?.map((scope, at) => <option key={at} value={at}>{scopeLabel(scope.destination)}</option>)}
    </select></label>
    <label className="block space-y-1">{t('composer.remember.content')}<textarea rows={5} aria-label={t('composer.remember.content')} value={draft.text} disabled={locked} onChange={event => patch({ text: event.target.value })} className="w-full resize-y rounded border bg-background p-2" /></label>
    {(destination?.kind === 'bot' || destination?.kind === 'user') && <label className="block space-y-1">{t('composer.workflow.memoryTrigger')}<input aria-label={t('composer.workflow.memoryTrigger')} value={state?.pending?.trigger ?? trigger} disabled={locked} onChange={event => setTrigger(event.target.value)} className="w-full rounded border bg-background p-2" /></label>}
    <p className="text-muted-foreground">{t('composer.workflow.rememberPrivacy')}</p>
    <ComposerModelAssist api={api} identity={identity} draftKey={draftKey} text={draft.text} purpose="memory" disabled={locked} onApply={text => patch({ text })} />
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {state?.receipt ? <div role="status">{t('composer.remember.saved')} · #{state.receipt.id}<p className="whitespace-pre-wrap">{state.receipt.content}</p>{onOpen && <Button type="button" variant="ghost" onClick={onOpen}>{t('composer.workflow.openMemory')}</Button>}</div>
      : <Button type="button" disabled={busy || !state?.pending && (!draft.text.trim() || !scopes?.length)} onClick={() => void save()}>{t(state?.pending ? 'composer.menu.retry' : 'composer.confirm')}</Button>}
    {!scopes && error && <Button type="button" variant="ghost" onClick={() => void load()}>{t('composer.menu.retry')}</Button>}
    {state?.rejected && !busy && <Button type="button" variant="ghost" onClick={() => { patch({ composerWorkflow: undefined }); void load(); }}>{t('composer.workflow.refreshMemory')}</Button>}
    {state?.pending && !busy && <p className="text-muted-foreground">{t('composer.workflow.retrySameSave')}</p>}
    {state?.receipt && <Button type="button" variant="ghost" onClick={() => { patch({ text: '', composerWorkflow: undefined }); void load(); }}>{t('composer.workflow.newMemory')}</Button>}
  </div>;
}
