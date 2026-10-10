import { ThreadPlan } from './ThreadPlan';
import { ThreadFollowups } from './ThreadFollowups';
import { ThreadMemory } from './ThreadMemory';
import { ThreadResources } from './ThreadResources';
import { ThreadPermission } from './ThreadPermission';
import { ThreadQuestion } from './ThreadQuestion';
import { ThreadSourcePicker } from './ThreadSourcePicker';
import type { ImageAttachment } from '@varin/protocol';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import { useI18n } from '@/lib/i18n';
import React from 'react';
import { ThreadRequestError, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { ThreadIdentity, ThreadModelInfo, ThreadThinkingLevel, ThreadSnapshot, ThreadsAPI, ThreadHistoryPage, ThreadPreparedSource } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ThreadProjection, historyText, historyImages } from '@/lib/agent-runtime/thread-projection';

export function ThreadConversation({ api, identity, onBranchCreated, initialWorkspacePath }: { api: ThreadsAPI; identity: ThreadIdentity; onBranchCreated?: (identity: ThreadIdentity) => void; initialWorkspacePath?: string }) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [images, setImages] = React.useState<ImageAttachment[]>([]);
  const fileInput = React.useRef<HTMLInputElement | null>(null);
  const fileReadGeneration = React.useRef(0);
  const [readingFiles, setReadingFiles] = React.useState(false);
  const [preparedSource, setPreparedSource] = React.useState<ThreadPreparedSource | null>(null);
  const [preparingSource, setPreparingSource] = React.useState(false);
  const [snapshotState, setSnapshot] = React.useState<ThreadSnapshot>();
  const [historyView, setHistoryView] = React.useState<ThreadHistoryPage | null>(null);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const historyGeneration = React.useRef(0);
  const identityGeneration = React.useRef(0);
  const forkKeys = React.useRef(new Map<string, string>());
  const compactionKeys = React.useRef(new Map<string, string>());
  const [progress, setProgress] = React.useState('');
  const [text, setText] = React.useState('');
  const draftRef = React.useRef({ text, images });
  draftRef.current = { text, images };
  const [providerId, setProviderId] = React.useState('');
  const [modelId, setModelId] = React.useState('');
  const [thinkingLevel, setThinkingLevel] = React.useState<ThreadThinkingLevel>('off');
  const [models, setModels] = React.useState<ThreadModelInfo[]>([]);
  React.useEffect(() => { let active = true; void api.listModels().then(value => { if (active) setModels(value); }, value => { if (active) setError(value instanceof Error ? value.message : 'Model catalog unavailable'); }); return () => { active = false; }; }, [api, host]);
  const [error, setError] = React.useState<string>();
  const [inputMode, setInputMode] = React.useState<'boundary' | 'interrupt' | 'next_run'>('boundary');
  const [pending, setPending] = React.useState(false);
  const pendingAction = React.useRef<object | null>(null);
  const pendingInput = React.useRef<{ fingerprint: string; send(): Promise<unknown> } | undefined>(undefined);
  const projection = React.useRef<ThreadProjection | undefined>(undefined);
  React.useEffect(() => {
    identityGeneration.current += 1; forkKeys.current.clear(); compactionKeys.current.clear();
    historyGeneration.current += 1; setHistoryView(null); setHistoryLoading(false);
    setPreparedSource(null); setPreparingSource(false);
    pendingAction.current = null; setPending(false); setError(undefined);
    setSnapshot(undefined); setProgress(''); setImages([]); setReadingFiles(false); pendingInput.current = undefined; fileReadGeneration.current += 1;
    const view = new ThreadProjection(api, identity, setSnapshot, value => setError(value instanceof Error ? value.message : 'Thread unavailable'), setProgress);
    projection.current = view; view.start();
    return () => { identityGeneration.current += 1; historyGeneration.current += 1; fileReadGeneration.current += 1; view.close(); };
  }, [api, identity, host]);
  const snapshot = snapshotState?.identity.threadId === identity.threadId && snapshotState?.identity.branchId === identity.branchId ? snapshotState : undefined;
  const branch = snapshot?.thread.branches.find(value => value.branch_id === identity.branchId);
  const run = snapshot?.activeRun ?? branch?.latest_run;
  const active = Boolean(branch?.active_run_id);
  const launch = snapshot?.launch?.run_id === run?.id ? snapshot?.launch : null;
  const pause = run?.state === 'waiting' && launch?.pause?.wait_id === run.waiting_on ? launch.pause : null;
  const policy = snapshot?.policySelection;
  const policyUpdate = policy?.desired && policy.desired.run_id === run?.id ? policy.desired : null;
  const policyUpdatePending = policyUpdate?.status === 'preparing' || policyUpdate?.status === 'ready';
  const policyIncompatible = policyUpdate?.status === 'failed' && policyUpdate.failure === 'policy_state_incompatible';
  const acceptsImages = active ? (run?.configuration as { acceptsImages?: boolean } | undefined)?.acceptsImages
    : models.find(model => model.providerId === providerId && model.modelId === modelId)?.acceptsImages;
  React.useEffect(() => {
    const config = (snapshot?.modelSelection.desired?.configuration ?? run?.configuration) as { providerId?: string; model?: string; thinkingLevel?: ThreadThinkingLevel } | undefined;
    if (config?.providerId && config.model && (active || !providerId)) { setProviderId(config.providerId); setModelId(config.model); setThinkingLevel(config.thinkingLevel ?? 'off'); }
  }, [run?.configuration, snapshot?.modelSelection.desired, active, providerId]);
  const act = async (work: () => Promise<unknown>, interrupt = false) => {
    if (pendingAction.current && !interrupt) return;
    const action = {}; pendingAction.current = action;
    const generation = identityGeneration.current;
    const current = () => generation === identityGeneration.current && host === getRuntimeEndpointGeneration() && pendingAction.current === action;
    setPending(true); setError(undefined);
    try { await work(); if (current()) await projection.current?.refresh(); }
    catch (value) {
      if (!current()) return;
      if (value instanceof ThreadRequestError && value.status === 409) { pendingInput.current = undefined; await projection.current?.refresh(); }
      if (!current()) return;
      setError(value instanceof ThreadRequestError && ['kernel-frame-too-large', 'http-body-too-large'].includes(value.code)
        ? 'These images exceed the current transport request size. Remove or resize an image and retry; your attachments are still here.'
        : value instanceof ThreadRequestError && value.code === 'model-images-unsupported' ? 'The selected model does not accept images. Choose an image-capable model or remove the images.'
        : value instanceof Error ? value.message : 'Thread request failed');
    }
    finally { if (current()) { pendingAction.current = null; setPending(false); } }
  };
  const addImages = async (files: File[]) => {
    const generation = fileReadGeneration.current;
    setReadingFiles(true); setError(undefined);
    try {
      if (acceptsImages === false) throw new Error('The selected model does not accept images');
      if (files.some(file => !file.type.startsWith('image/'))) throw new Error('This attachment action accepts images; other files need their material workflow');
      const added = await Promise.all(files.map(fileToImageAttachment));
      if (generation === fileReadGeneration.current) setImages(current => [...current, ...added]);
    } catch (value) { if (generation === fileReadGeneration.current) setError(value instanceof Error ? value.message : 'Could not read images'); }
    finally { if (generation === fileReadGeneration.current) setReadingFiles(false); }
  };
  const selectModel = (provider: string, model: string, thinking: ThreadThinkingLevel) => {
    if (active && run) {
      void act(()=>api.selectModel({...identity,runId:run.id,key:crypto.randomUUID(),model:{providerId:provider,modelId:model,thinkingLevel:thinking}}));
    } else {setProviderId(provider);setModelId(model);setThinkingLevel(thinking);}
  };
  const returnToLatest = () => { historyGeneration.current += 1; setHistoryView(null); setHistoryLoading(false); };
  const loadEarlier = async () => {
    if (!snapshot) return;
    const current = historyView ?? { ...snapshot.historyPage, items: snapshot.history };
    if (!current.head || !current.previous) return;
    const generation = ++historyGeneration.current;
    setHistoryLoading(true); setError(undefined);
    try {
      const page = await api.historyPage(identity, { headId: current.head, beforeId: current.previous });
      if (generation === historyGeneration.current) setHistoryView({ head: current.head, previous: page.previous, items: [...page.items, ...current.items] });
    } catch (value) { if (generation === historyGeneration.current) setError(value instanceof Error ? value.message : 'Earlier history is unavailable'); }
    finally { if (generation === historyGeneration.current) setHistoryLoading(false); }
  };
  const forkFrom = async (headId: string) => {
    const generation = identityGeneration.current;
    let key = forkKeys.current.get(headId);
    if (!key) { key = crypto.randomUUID(); forkKeys.current.set(headId, key); }
    await act(async () => {
      const created = await api.fork({ ...identity, key, headId });
      if (generation === identityGeneration.current) { forkKeys.current.delete(headId); onBranchCreated?.(created); }
    });
  };
  const compactThrough = async (throughId: string) => {
    if (!snapshot) return;
    const generation = identityGeneration.current;
    const expectedRevision = snapshot.context.checkpoint?.revision ?? 0;
    const fingerprint = JSON.stringify([throughId, expectedRevision, providerId, modelId, thinkingLevel]);
    let key = compactionKeys.current.get(fingerprint);
    if (!key) { key = crypto.randomUUID(); compactionKeys.current.set(fingerprint, key); }
    await act(async () => {
      await api.compact({ ...identity, key, throughId, expectedRevision, model: { providerId, modelId, thinkingLevel } });
      if (generation === identityGeneration.current) compactionKeys.current.delete(fingerprint);
    });
  };
  const visibleHistory = historyView?.items ?? snapshot?.history ?? [];
  const previousHistory = historyView ? historyView.previous : snapshot?.historyPage.previous;
  const submissionFingerprint = () => JSON.stringify([identity.threadId, identity.branchId, text, images, providerId, modelId, thinkingLevel, inputMode, preparedSource?.source]);
  const sourceCannotBeApplied = active && Boolean(preparedSource) && pendingInput.current?.fingerprint !== submissionFingerprint();
  return <section className="flex h-full min-h-0 flex-col" aria-label="Thread conversation">
    <div className="border-b px-4 py-2 text-xs text-muted-foreground">thread · {identity.threadId} · branch {identity.branchId.slice(-8)} · {run?.state ?? 'Ready'}{pause ? ' · Paused' : run?.waiting_on ? ` · ${run.waiting_on}` : ''}</div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
        {previousHistory && <Button variant="ghost" size="sm" disabled={historyLoading} onClick={() => void loadEarlier()}>{historyLoading ? 'Loading earlier history' : 'Load earlier history'}</Button>}
        {historyView && <Button variant="outline" size="sm" onClick={returnToLatest}>{historyView.head !== snapshot?.historyPage.head ? 'Show latest messages' : 'Return to latest view'}</Button>}
        {historyView && <span className="text-xs text-muted-foreground">Viewing saved history</span>}
      </div>
      {api.plan && <ThreadPlan api={api.plan} identity={identity} contextRevision={snapshot?.context.checkpoint?.revision} />}
      {visibleHistory.map(item => <article key={item.id} className="mx-auto max-w-3xl">
        <div className="mb-1 text-xs text-muted-foreground">{item.source}</div>
        <MarkdownRenderer messageId={item.id} content={historyText(item.content)} />
        <ImageAttachmentStrip images={historyImages(item.content)} />
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Summarize through this message</summary>
          <p className="py-2">Generate a continuation summary with the selected model. Original messages stay available. Apply the completed summary below when ready.</p>
          <Button variant="ghost" size="sm" disabled={pending || !snapshot || !providerId || !modelId} onClick={() => void compactThrough(item.id)}>Generate context summary</Button>
        </details>
        {onBranchCreated && <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Branch from this message</summary>
          <p className="py-2">Keeps conversation through this message. Choose a model for the new branch. Running work, workspace tools and context summaries stay on the original branch.</p>
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void forkFrom(item.id)}>Branch conversation only</Button>
        </details>}
      </article>)}
      {!historyView && progress && <article className="mx-auto max-w-3xl" aria-label="Streaming assistant response"><MarkdownRenderer messageId={`${identity.threadId}:progress`} isStreaming content={progress} /></article>}
      {snapshot?.children?.map(child => <div key={child.operation_id} className="mx-auto max-w-3xl rounded border p-3 text-sm" aria-label="Child task">
        <div>{child.input.profile === 'read_only' ? 'Read-only child' : child.input.profile === 'isolated_write' ? 'Isolated writable child' : child.input.profile} · {child.state}</div>
        <div className="text-xs text-muted-foreground">{child.source.kind === 'pending' ? 'Preparing a stable source' : `Source ready · ${child.source.provenance.consistency}`}</div>
        {child.source.kind === 'ready' && child.source.provenance.consistency !== 'fixed-root' && <div className="text-xs text-muted-foreground">{child.source.provenance.contentMode === 'saved-files' ? 'Saved files' : 'Fixed draft baseline'}{child.source.provenance.omittedDraftPaths.length > 0 ? ` · ${child.source.provenance.omittedDraftPaths.length} unsaved overlays omitted` : ''}</div>}
        <div className="text-xs text-muted-foreground">{child.code_result.kind === 'published'
          ? `File result fixed · revision ${child.code_result.result.result_revision} · effect: ${child.code_result.effect} · parent integration requires a separate action`
          : child.code_result.kind === 'no_changes' ? 'No file changes'
          : child.code_result.kind === 'unavailable' ? `File result unavailable · ${child.code_result.code} · effect: ${child.code_result.effect}`
          : child.code_result.kind === 'candidate' ? 'File result fixed; publication pending'
          : child.code_result.kind === 'settling' ? 'Waiting for child writers and original receipts before fixing the file result'
          : 'File result pending'}</div>
        <div className="text-xs text-muted-foreground">{child.child_thread_id}</div>
        <p>{child.input.task}</p>
        {child.report && <><div className="text-xs text-muted-foreground">Report · {child.report.outcome}</div><MarkdownRenderer messageId={`child:${child.operation_id}`} content={child.report.detail ?? "Report stored in child history."} /></>}
        {child.report?.history_ids.map(itemId => <ChildReportPage key={itemId} api={api} identity={identity} operationId={child.operation_id} itemId={itemId} />)}
        {!child.report && api.collaboration && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.collaboration!.cancelChild(identity, child.operation_id))}>Cancel child task</Button>}
      </div>)}
      {snapshot?.children?.some(child => !child.report) && api.collaboration && <Button variant="outline" size="sm" disabled={pending} onClick={() => void act(() => api.collaboration!.cancelTree(identity))}>Stop task and children</Button>}
      {snapshot && <ThreadFollowups key={`${host}:${identity.threadId}:${identity.branchId}`} api={api.followups} identity={identity}
        operations={snapshot.operations} followups={snapshot.followups} pending={pending} act={act} />}
      {snapshot?.operations.filter(operation => operation.id !== pause?.action_id).map(operation => <div key={operation.id} className="mx-auto max-w-3xl rounded border p-2 text-sm">
        <ThreadPermission operation={operation} enabled={!pending && operation.run_id === run?.id && !run?.cancel_requested} onDecide={(permissionId, decision) => act(() => api.decidePermission({ ...identity, operationId: operation.id, permissionId, decision }))} />
        {operation.executor === 'ask_user' && <ThreadQuestion operation={operation} enabled={!pending && run?.state === 'waiting' && run.waiting_on === operation.waiting_on} onAnswer={answer => act(() => api.answerQuestion({ ...identity, operationId: operation.id, answer }))} />}
        <div>Background operation · {operation.phase} · {operation.outcome ?? 'In progress'} · effect: {operation.effect}</div>
        {operation.external_receipt && <div className="text-xs text-muted-foreground">{operation.external_receipt.executor} · {operation.external_receipt.outcome}</div>}
        {operation.phase !== 'terminal' && (operation.executor !== 'ask_user' || run?.waiting_on === operation.waiting_on) && <Button variant="ghost" size="sm" onClick={() => void act(() => api.cancelOperation(operation.id), true)}>{operation.executor === 'dispatch' ? 'Cancel child task' : operation.executor === 'wait_child' ? 'Cancel observation wait' : 'Cancel operation'}</Button>}
      </div>)}
      {snapshot?.inputs.filter(input => input.state === 'queued').map(input => <div key={input.id} className="mx-auto max-w-3xl rounded border p-2 text-sm">
        <form onSubmit={event => { event.preventDefault(); const edited = new FormData(event.currentTarget).get('text');
          if (typeof edited === 'string') void act(() => api.editInput(input.id, input.revision, edited)); }}>
          <label className="text-xs text-muted-foreground">{input.mode}</label>
          <ImageAttachmentStrip images={historyImages(input.content)} />
          <Textarea key={`${input.id}:${input.revision}`} name="text" aria-label="Edit queued input" defaultValue={historyText(input.content)} />
          <Button type="submit" variant="ghost" size="sm">Save queued input</Button>
        </form>
        <Button variant="ghost" size="sm" onClick={() => void act(() => api.cancelInput(input.id, input.revision), true)}>Cancel queued input</Button>
      </div>)}
    </div>
    {snapshot?.context.checkpoint?.personalization && <ThreadMemory key={identity.threadId} identity={identity} basis={snapshot.context.checkpoint.personalization} />}
    {snapshot?.context.checkpoint && <ThreadResources checkpoint={snapshot.context.checkpoint} pending={pending}
      onRefresh={() => void act(() => api.resources.refresh({ ...identity, expectedRevision: snapshot.context.checkpoint!.revision }))} />}
    <ThreadSourcePicker key={identity.branchId} api={api} identity={identity} initialPath={initialWorkspacePath}
      active={active || pending} launch={snapshot?.launch ?? null} prepared={preparedSource} onPrepared={setPreparedSource} onPreparingChange={setPreparingSource} />
    {snapshot && <details className="mx-auto max-h-64 w-full max-w-3xl shrink-0 overflow-y-auto px-4 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Context summaries · checkpoint {snapshot.context.checkpoint?.revision ?? 0} · {snapshot.context.jobs.length} jobs</summary>
      {snapshot.context.checkpoint?.proposal.through_id && <div className="my-2" aria-label="Active context summary">
        <MarkdownRenderer messageId={snapshot.context.checkpoint.id} content={snapshot.context.checkpoint.proposal.summary} />
      </div>}
      {snapshot.context.jobs.map(({ job, run: jobRun }) => {
        const published = snapshot.context.checkpoint?.id === job.request.key;
        const superseded = (snapshot.context.checkpoint?.revision ?? 0) > job.request.expected_revision;
        const terminal = ['completed', 'cancelled', 'failed'].includes(jobRun.state);
        return <div key={jobRun.id} className="my-2 rounded border p-2">
          <p>Summary through {job.request.through_id.slice(-8)} · {published ? 'Applied' : jobRun.state}{!published && superseded ? ' · Checkpoint has changed' : ''}</p>
          {jobRun.state === 'completed' && !published && !superseded && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.publishContext(identity, jobRun.id))}>Apply context summary</Button>}
          {!terminal && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.cancelContext(identity, jobRun.id))}>Cancel summary</Button>}
          {!terminal && ['accepted', 'preparing', 'runnable', 'waiting', 'recovering'].includes(jobRun.state) && <Button variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => api.resumeContext(identity, jobRun.id))}>Resume summary preparation</Button>}
        </div>;
      })}
    </details>}
    <form className="mx-auto w-full max-w-3xl space-y-2 p-4" onSubmit={event => {
      event.preventDefault();
      if (preparingSource || sourceCannotBeApplied) return;
      const generation = identityGeneration.current;
      void act(async () => {
        const fingerprint = submissionFingerprint();
        if (pendingInput.current?.fingerprint !== fingerprint) {
          const key = crypto.randomUUID();
          const submit = { ...identity, key, text, images, expectedHead: branch?.head ?? null, model: { providerId, modelId, thinkingLevel }, ...(preparedSource ? { source: preparedSource.source } : {}) };
          const queued = { ...identity, key, text, images, mode: inputMode };
          pendingInput.current = { fingerprint, send: active ? () => api.enqueue(queued) : () => api.submit(submit) };
        }
        await pendingInput.current.send();
        if (generation !== identityGeneration.current || host !== getRuntimeEndpointGeneration()) return;
        pendingInput.current = undefined; setPreparedSource(null); returnToLatest();
        if (draftRef.current.text === text) setText('');
        setImages(current => current.filter(image => !images.includes(image)));
      });
    }}>
      {sourceCannotBeApplied && <p role="status" className="text-sm text-muted-foreground">The prepared workspace needs a new run. Keep the current workspace to queue this message, or wait for this run to finish.</p>}
      {pause && <p role="status" aria-label="Policy pause" className="text-sm text-muted-foreground">Paused: {pause.reason || 'Waiting for your explicit resume.'} Messages can be queued while paused.</p>}
      {policy && <p className="text-xs text-muted-foreground">Strategy: {policy.active.target.kind === 'extension' ? policy.active.target.artifact.declaredIdentity.name : 'Default'} · generation {policy.active.generation}</p>}
      {policy?.preparation && <p role="status" aria-label="Strategy preparation" className="text-sm text-muted-foreground">{policy.preparation.status === 'preparing' ? 'The Host is preparing a strategy candidate.' : `The Host could not prepare the strategy candidate: ${policy.preparation.code ?? 'preparation failed'}`}</p>}
      {policyUpdatePending && <p role="status" aria-label="Policy update" className="text-sm text-muted-foreground">{policyUpdate?.status === 'preparing' ? 'Preparing the selected strategy. The current strategy remains active.' : 'Strategy prepared for the next closed decision boundary.'}{pause ? ' This run remains paused until you resume it.' : ''}</p>}
      {policyUpdate?.status === 'failed' && <p role="status" aria-label="Policy update failed" className="text-sm text-muted-foreground">{policyIncompatible ? 'The selected strategy cannot preserve this private checkpoint. The current strategy remains active. Restarting strategy state keeps conversation history and independent tasks.' : `Strategy update was not applied: ${policyUpdate.failure ?? 'preparation failed'}`}</p>}
      {snapshot?.launch?.preparation_failure && <p role="alert" className="text-sm text-destructive">Preparation needs attention: {snapshot.launch.preparation_failure}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {snapshot?.modelSelection.desired?.status === 'failed' && <p role="alert" className="text-sm text-destructive">Model preparation failed: {snapshot.modelSelection.desired.failure}</p>}
      {snapshot?.modelSelection.desired && snapshot.modelSelection.desired.id !== snapshot.modelSelection.active?.id && snapshot.modelSelection.desired.status !== 'failed' && <p role="status" className="text-sm text-muted-foreground">Applies to the next model request</p>}
      <select aria-label="Registered model" disabled={pending} className="w-full rounded border bg-background px-2 py-1 text-sm"
        value={JSON.stringify([providerId, modelId])} onChange={event => {
          const [provider, model] = JSON.parse(event.target.value) as [string, string];
          const available = models.find(candidate => candidate.providerId === provider && candidate.modelId === model)?.thinkingLevels ?? ['off'];
          selectModel(provider,model,available.includes(thinkingLevel) ? thinkingLevel : available[0] ?? 'off');
        }}>
        <option value={JSON.stringify(['', ''])}>Choose a registered model</option>
        {models.map(model => <option key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])}>{model.providerId} · {model.name ?? model.modelId}</option>)}
      </select>
      {(models.find(model => model.providerId === providerId && model.modelId === modelId)?.thinkingLevels?.length ?? 0) > 1 && <select aria-label="Thinking level" disabled={pending}
        className="rounded border bg-background px-2 py-1 text-sm" value={thinkingLevel} onChange={event => selectModel(providerId,modelId,event.target.value as ThreadThinkingLevel)}>
        {models.find(model => model.providerId === providerId && model.modelId === modelId)?.thinkingLevels?.map(level => <option key={level} value={level}>{level}</option>)}
      </select>}
      {active && <select aria-label="Input delivery" className="rounded border bg-background text-sm" value={inputMode} onChange={event => setInputMode(event.target.value as typeof inputMode)}>
        <option value="boundary">At next model boundary</option><option value="interrupt">Interrupt current generation</option><option value="next_run">After current run</option>
      </select>}
      {images.length > 0 && acceptsImages === false && <p role="alert" className="text-sm text-destructive">Choose an image-capable model or remove these images before sending</p>}
      <ImageAttachmentStrip images={images} removeLabel={t('chat.fileAttachment.actions.removeImage')}
        onRemove={index => setImages(current => current.filter((_, candidate) => candidate !== index))} />
      <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label="Choose image attachments"
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addImages(files); }} />
      <Textarea aria-label="Message thread" value={text} onChange={event => setText(event.target.value)}
        onPaste={event => { const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void addImages(files); } }}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
        onDrop={event => { const files = [...event.dataTransfer.files]; if (files.length) { event.preventDefault(); void addImages(files); } }} />
      <div className="flex gap-2">
        <Button type="button" variant="ghost" disabled={readingFiles || acceptsImages === false} onClick={() => fileInput.current?.click()}>Attach images</Button>
        <Button type="submit" disabled={pending || preparingSource || sourceCannotBeApplied || readingFiles || (images.length > 0 && acceptsImages === false) || (!text.trim() && !images.length) || (!active && (!providerId || !modelId))}>{active ? 'Queue message' : 'Send'}</Button>
        {active && branch?.active_run_id && <Button type="button" variant="outline" onClick={() => void act(() => api.cancelRun(branch.active_run_id!), true)}>Stop run</Button>}
        {run && pause && <Button type="button" variant="outline" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.resume(run.id, pause.wait_id))}>Resume run</Button>}
        {active && run && policyUpdate && policyIncompatible && <Button type="button" variant="outline" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.restartPolicy(identity, run.id, policyUpdate.selection_id))}>Restart strategy state</Button>}
        {active && run && policyUpdate && policyUpdatePending && <Button type="button" variant="ghost" disabled={pending || run.cancel_requested} onClick={() => void act(() => api.cancelPolicyUpdate(identity, run.id, policyUpdate.selection_id))}>Cancel strategy update</Button>}
        {run && launch?.startable && launch.requires_rebind && !pause && <Button type="button" variant="ghost" disabled={pending} onClick={() => void act(() => api.retryPreparation(run.id))}>Retry preparation</Button>}
      </div>
    </form>
  </section>;
}

function ChildReportPage({api, identity, operationId, itemId}: {api: ThreadsAPI; identity: ThreadIdentity; operationId: string; itemId: string}) {
  const [page, setPage] = React.useState<Awaited<ReturnType<NonNullable<ThreadsAPI['collaboration']>['readReport']>> | null>(null);
  const [error, setError] = React.useState('');
  const read = (offset: number) => { void api.collaboration?.readReport(identity, operationId, itemId, offset).then(setPage).catch(e => setError(String(e))); };
  return <div><div className="text-xs">Other-agent report data · {itemId}</div>{error && <p>{error}</p>}{page && <><MarkdownRenderer messageId={`${itemId}:${page.offset}`} content={page.text} /><p>Bytes {page.offset}–{page.offset + new TextEncoder().encode(page.text).length} of {page.total_bytes}</p></>}
    {!page ? <Button variant="ghost" size="sm" onClick={() => read(0)}>Read report</Button> : page.next_offset !== null && <Button variant="ghost" size="sm" onClick={() => read(page.next_offset!)}>Read next page</Button>}
  </div>;
}
