import React from 'react';
import { ThreadRequestError, getRuntimeEndpointGeneration, threadMemorySourceText, type ThreadIdentity, type ThreadSnapshot, type ThreadsAPI } from '@varin/application-client';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { prepareThreadFiles } from '@/lib/agent-runtime/fileAttachments';
import { ThreadFileDrafts } from './ThreadAttachments';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { ComposerModelAssist } from './ComposerModelAssist';
import { ComposerRecipientPicker } from './ComposerRecipientPicker';
import { directedComposerKey, type ComposerRecipient } from './composerWorkflowState';

type Collaboration = NonNullable<ThreadsAPI['collaboration']>;
type Catalog = Awaited<ReturnType<Collaboration['dispatchCatalog']>>;

/** Handoff is user-edited input. History is opt-in and selected by immutable references; no summary
 * request or dispatch is started by opening, selecting a recipient, or cancelling this view. */
export function ThreadHandoffForm({ api, identity, snapshot, draftKey, initialText, onRecipient, onDone, refresh }: {
  api: ThreadsAPI; identity: ThreadIdentity; snapshot: ThreadSnapshot; draftKey: string; initialText: string;
  onRecipient(recipient: ComposerRecipient): void; onDone(): void; refresh?(): void;
}) {
  const { t } = useI18n(), key = `${draftKey}:handoff`;
  const draft = useThreadDraftStore(state => state.drafts[key] ?? EMPTY_THREAD_DRAFT);
  const original = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const patch = React.useCallback((value: Parameters<ReturnType<typeof useThreadDraftStore.getState>['patch']>[1]) => useThreadDraftStore.getState().patch(key, value), [key]);
  const [host] = React.useState(getRuntimeEndpointGeneration), [cut] = React.useState(snapshot.historyPage.head);
  const initial = React.useRef(initialText), alive = React.useRef(true), sending = React.useRef(false);
  const [mode, setMode] = React.useState<'existing' | 'new'>(draft.composerWorkflow?.handoff?.pending || draft.composerWorkflow?.handoff?.receipt ? 'new' : 'existing'), [recipient, setRecipient] = React.useState<ComposerRecipient>();
  const [catalog, setCatalog] = React.useState<Catalog>(), [model, setModel] = React.useState(draft.composerWorkflow?.handoff?.pending?.model ?? ''), [thinking, setThinking] = React.useState(draft.composerWorkflow?.handoff?.pending?.thinking ?? '');
  const [project, setProject] = React.useState(draft.composerWorkflow?.handoff?.pending?.projectId ?? ''), [workMode, setWorkMode] = React.useState<'shared' | 'read_only' | 'isolated_write'>(draft.composerWorkflow?.handoff?.pending?.workMode ?? 'read_only');
  const [name, setName] = React.useState(draft.composerWorkflow?.handoff?.pending?.name ?? ''), [includeFiles, setIncludeFiles] = React.useState(false);
  const [history, setHistory] = React.useState(snapshot.history), [previous, setPrevious] = React.useState(snapshot.historyPage.previous);
  const [selected, setSelected] = React.useState<string[]>([]), [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string>();
  const attempt = draft.composerWorkflow?.handoff, locked = busy || Boolean(attempt?.pending || attempt?.receipt);
  const current = () => alive.current && host === getRuntimeEndpointGeneration();
  React.useEffect(() => { alive.current = true; if (!useThreadDraftStore.getState().drafts[key]) patch({ text: initial.current }); return () => { alive.current = false; }; }, [key, patch]);
  const loadCatalog = React.useCallback(async () => {
    if (!api.collaboration?.dispatchCatalog || host !== getRuntimeEndpointGeneration()) return;
    try { const result = await api.collaboration.dispatchCatalog({ runtime: 'agent', threadId: identity.threadId, branchId: identity.branchId }); if (alive.current && host === getRuntimeEndpointGeneration()) { setCatalog(result); setError(undefined); } }
    catch (cause) { if (alive.current && host === getRuntimeEndpointGeneration()) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [api, host, identity.threadId, identity.branchId]);
  React.useEffect(() => { if (mode === 'new') void loadCatalog(); }, [mode, loadCatalog]);
  const text = () => [draft.text, ...history.filter(item => selected.includes(item.id)).map(item => `${t('composer.workflow.contextMessage')} ${item.id} (${item.source})\n${threadMemorySourceText(item)}`)].filter(Boolean).join('\n\n');
  const confirm = async () => {
    if (!current() || sending.current) return;
    sending.current = true; setBusy(true); setError(undefined);
    try {
      if (mode === 'existing') {
        if (!recipient) return;
        const targetKey = directedComposerKey(draftKey, recipient.identity);
        const existing = useThreadDraftStore.getState().drafts[targetKey];
        if (existing?.collaboration?.attempts || existing?.collaboration?.sending) throw new Error(t('composer.workflow.recipientPending'));
        useThreadDraftStore.getState().patch(targetKey, value => ({ text: [value.text, text()].filter(Boolean).join('\n\n'),
          ...(includeFiles ? { files: [...(value.files ?? []), ...(original.files ?? []).filter(file => !value.files?.some(previous => previous.id === file.id))] } : {}) }));
        onRecipient(recipient); onDone(); return;
      }
      if (!api.collaboration?.dispatch) return;
      let input = attempt?.pending;
      if (!input) {
        if (!catalog?.runId) return;
        const files = includeFiles ? original.files ?? [] : [];
        // Capture only this explicit file choice. Upload, retry and reference reuse stay with the
        // same original Thread attachment owner; selecting a target does not transfer bytes.
        const attachments = await prepareThreadFiles(api, identity, draftKey, files);
        if (!current()) return;
        input = { ...identity, key: crypto.randomUUID(), runId: catalog.runId, expectedHead: catalog.headId, text: draft.text, ...(name.trim() ? { name: name.trim() } : {}),
          model, ...(thinking ? { thinking } : {}), projectId: project || null, workMode,
          ...(selected.length && cut ? { background: [{ threadId: identity.threadId, branchId: identity.branchId, headId: cut, itemIds: [...selected] }] } : {}),
          ...(attachments.length ? { attachments: attachments.map(({ ref }) => ({ ref })) } : {}) };
        patch({ composerWorkflow: { handoff: { pending: input } } });
      }
      const receipt = await api.collaboration.dispatch(input);
      patch({ composerWorkflow: { handoff: { receipt } } });
      if (current()) refresh?.();
    } catch (cause) { const request = useThreadDraftStore.getState().drafts[key]?.composerWorkflow?.handoff?.pending; if (request && cause instanceof ThreadRequestError && cause.admission === 'not_started') patch({ composerWorkflow: { handoff: { pending: request, rejected: true } } }); if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { sending.current = false; if (current()) setBusy(false); }
  };
  const selectedModel = catalog?.models.find(candidate => candidate.id === model);
  return <div className="space-y-3 typography-ui-label">
    <p className="text-muted-foreground">{t('composer.handoff.background')}</p>
    <label className="block space-y-1">{t('composer.handoff.target')}<select aria-label={t('composer.handoff.target')} value={mode} disabled={locked} onChange={event => setMode(event.target.value as 'existing' | 'new')} className="w-full rounded border bg-background p-2"><option value="existing">{t('composer.workflow.existingTask')}</option><option value="new">{t('composer.handoff.new')}</option></select></label>
    {mode === 'existing' && (recipient ? <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate">{recipient.name}</span><Button type="button" variant="ghost" disabled={locked} onClick={() => setRecipient(undefined)}>{t('composer.workflow.changeRecipient')}</Button></div> : <ComposerRecipientPicker api={api} identity={identity} onSelect={setRecipient} />)}
    {mode === 'new' && <>
      <label className="block space-y-1">{t('composer.name')}<input aria-label={t('composer.name')} value={name} disabled={locked} onChange={event => setName(event.target.value)} className="w-full rounded border bg-background p-2" /></label>
      <label className="block space-y-1">{t('composer.command.model')}<select aria-label={t('composer.command.model')} value={model} disabled={locked || !catalog} onChange={event => { setModel(event.target.value); setThinking(''); }} className="w-full rounded border bg-background p-2"><option value="">{t('composer.workflow.chooseModel')}</option>{catalog?.models.map(choice => <option key={choice.id} value={choice.id}>{choice.name} · {choice.channelName}</option>)}</select></label>
      {Boolean(selectedModel?.thinkingLevels?.length) && <label className="block space-y-1">{t('composer.command.thinking')}<select aria-label={t('composer.command.thinking')} value={thinking} disabled={locked} onChange={event => setThinking(event.target.value)} className="w-full rounded border bg-background p-2"><option value="">{selectedModel?.defaultThinkingLevel ?? t('composer.workflow.modelDefault')}</option>{selectedModel?.thinkingLevels?.map(level => <option key={level} value={level}>{level}</option>)}</select></label>}
      <label className="block space-y-1">{t('composer.workflow.executionSource')}<select aria-label={t('composer.workflow.executionSource')} value={project} disabled={locked || !catalog} onChange={event => setProject(event.target.value)} className="w-full rounded border bg-background p-2"><option value="">{t('composer.workflow.noProject')}</option>{catalog?.projects.map(choice => <option key={choice.id} value={choice.id}>{choice.name} · {choice.path}</option>)}</select></label>
      {project && <label className="block space-y-1">{t('composer.workflow.workMode')}<select aria-label={t('composer.workflow.workMode')} value={workMode} disabled={locked} onChange={event => setWorkMode(event.target.value as typeof workMode)} className="w-full rounded border bg-background p-2">{(['read_only', 'shared', 'isolated_write'] as const).map(value => <option key={value} value={value}>{t(`composer.workflow.workMode.${value}`)}</option>)}</select></label>}
      {catalog?.unavailable && <p role="alert">{catalog.unavailable}</p>}
      {!catalog && !error && <p role="status">{t('common.loading')}</p>}
    </>}
    <label className="block space-y-1">{t('composer.handoff.instructions')}<textarea aria-label={t('composer.handoff.instructions')} rows={4} value={draft.text} disabled={locked} onChange={event => patch({ text: event.target.value })} className="w-full resize-y rounded border bg-background p-2" /></label>
    <details><summary>{t('composer.workflow.chooseContext')}</summary><div className="max-h-48 space-y-2 overflow-y-auto py-2">{history.filter(item => threadMemorySourceText(item)).map(item => <label key={item.id} className="flex items-start gap-2"><input type="checkbox" disabled={locked} checked={selected.includes(item.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} /><span className="line-clamp-3">{item.source} · {threadMemorySourceText(item)}</span></label>)}</div>
      {previous && <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => { if (!cut || !previous) return; setBusy(true); void api.historyPage(identity, { headId: cut, beforeId: previous }).then(page => { if (current()) { setHistory(old => [...page.items, ...old]); setPrevious(page.previous); } }, cause => { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (current()) setBusy(false); }); }}>{t('composer.menu.more')}</Button>}
    </details>
    {Boolean(original.files?.length) && <><label className="flex items-center gap-2"><input type="checkbox" checked={includeFiles} disabled={locked} onChange={event => setIncludeFiles(event.target.checked)} />{t('composer.workflow.includeDraftFiles')}</label>{includeFiles && <ThreadFileDrafts files={original.files} locked onRemove={() => {}} />}</>}
    <ComposerModelAssist api={api} identity={identity} draftKey={draftKey} text={text()} purpose="handoff" disabled={locked} onApply={text => { patch({ text }); setSelected([]); }} />
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {attempt?.receipt ? <div role="status">{t('composer.workflow.handoffAccepted')} · {attempt.receipt.threadId}<Button type="button" variant="ghost" onClick={() => { onRecipient({ identity: { runtime: 'agent', threadId: attempt.receipt!.threadId, branchId: attempt.receipt!.branchId }, name: name || attempt.receipt!.threadId }); onDone(); }}>{t('composer.workflow.openRecipient')}</Button></div>
      : <Button type="button" disabled={busy || !draft.text.trim() || (mode === 'existing' ? !recipient : !attempt?.pending && (!catalog || Boolean(catalog.unavailable) || !model))} onClick={() => void confirm()}>{t(attempt?.pending ? 'composer.menu.retry' : mode === 'existing' ? 'composer.workflow.prepareMessage' : 'composer.confirm')}</Button>}
    {attempt?.rejected && <Button type="button" variant="ghost" onClick={() => { patch({ composerWorkflow: undefined }); void loadCatalog(); }}>{t('composer.workflow.editRetry')}</Button>}
    {mode === 'new' && !catalog && error && <Button type="button" variant="ghost" onClick={() => void loadCatalog()}>{t('composer.menu.retry')}</Button>}
  </div>;
}
