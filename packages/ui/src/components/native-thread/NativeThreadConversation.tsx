import type { ImageAttachment } from '@varin/protocol';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import { useI18n } from '@/lib/i18n';
import React from 'react';
import { NativeThreadRequestError } from '@varin/application-client';
import type { NativeThreadIdentity, NativeThreadSnapshot, NativeThreadsAPI } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { NativeThreadProjection, nativeHistoryText, nativeHistoryImages } from '@/lib/native-runtime/thread-projection';

export function NativeThreadConversation({ api, identity }: { api: NativeThreadsAPI; identity: NativeThreadIdentity }) {
  const { t } = useI18n();
  const [images, setImages] = React.useState<ImageAttachment[]>([]);
  const fileInput = React.useRef<HTMLInputElement | null>(null);
  const fileReadGeneration = React.useRef(0);
  const [readingFiles, setReadingFiles] = React.useState(false);
  const [snapshot, setSnapshot] = React.useState<NativeThreadSnapshot>();
  const [progress, setProgress] = React.useState('');
  const [text, setText] = React.useState('');
  const draftRef = React.useRef({ text, images });
  draftRef.current = { text, images };
  const [providerId, setProviderId] = React.useState('');
  const [modelId, setModelId] = React.useState('');
  const [models, setModels] = React.useState<Array<{ providerId: string; modelId: string; name?: string; acceptsImages?: boolean }>>([]);
  React.useEffect(() => { let active = true; void api.listModels().then(value => { if (active) setModels(value); }, value => { if (active) setError(value instanceof Error ? value.message : 'Model catalog unavailable'); }); return () => { active = false; }; }, [api]);
  const [error, setError] = React.useState<string>();
  const [inputMode, setInputMode] = React.useState<'boundary' | 'interrupt' | 'next_run'>('boundary');
  const [pending, setPending] = React.useState(false);
  const pendingInput = React.useRef<{ fingerprint: string; send(): Promise<unknown> } | undefined>(undefined);
  const projection = React.useRef<NativeThreadProjection | undefined>(undefined);
  React.useEffect(() => {
    setSnapshot(undefined); setProgress(''); setImages([]); setReadingFiles(false); pendingInput.current = undefined; fileReadGeneration.current += 1;
    const view = new NativeThreadProjection(api, identity, setSnapshot, value => setError(value instanceof Error ? value.message : 'Native thread unavailable'), setProgress);
    projection.current = view; view.start();
    return () => { fileReadGeneration.current += 1; view.close(); };
  }, [api, identity]);
  const branch = snapshot?.thread.branches.find(value => value.branch_id === identity.branchId);
  const run = snapshot?.activeRun ?? branch?.latest_run;
  const active = Boolean(branch?.active_run_id);
  const acceptsImages = active ? (run?.configuration as { acceptsImages?: boolean } | undefined)?.acceptsImages
    : models.find(model => model.providerId === providerId && model.modelId === modelId)?.acceptsImages;
  React.useEffect(() => {
    const config = run?.configuration as { providerId?: string; model?: string } | undefined;
    if (config?.providerId && config.model && (active || !providerId)) { setProviderId(config.providerId); setModelId(config.model); }
  }, [run?.configuration, active, providerId]);
  const act = async (work: () => Promise<unknown>) => {
    setPending(true); setError(undefined);
    try { await work(); await projection.current?.refresh(); }
    catch (value) {
      if (value instanceof NativeThreadRequestError && value.status === 409) { pendingInput.current = undefined; await projection.current?.refresh(); }
      setError(value instanceof NativeThreadRequestError && ['kernel-frame-too-large', 'native-http-body-too-large'].includes(value.code)
        ? 'These images exceed the current transport request size. Remove or resize an image and retry; your attachments are still here.'
        : value instanceof NativeThreadRequestError && value.code === 'native-model-images-unsupported' ? 'The selected model does not accept images. Choose an image-capable model or remove the images.'
        : value instanceof Error ? value.message : 'Native thread request failed');
    }
    finally { setPending(false); }
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
  return <section className="flex h-full min-h-0 flex-col" aria-label="Native thread conversation">
    <div className="border-b px-4 py-2 text-xs text-muted-foreground">nativeThread · {identity.threadId} · {run?.state ?? 'Ready'}{run?.waiting_on ? ` · ${run.waiting_on}` : ''}</div>
    <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-4">
      {snapshot?.history.map(item => <article key={item.id} className="mx-auto max-w-3xl">
        <div className="mb-1 text-xs text-muted-foreground">{item.source}</div>
        <MarkdownRenderer messageId={item.id} content={nativeHistoryText(item.content)} />
        <ImageAttachmentStrip images={nativeHistoryImages(item.content)} />
      </article>)}
      {progress && <article className="mx-auto max-w-3xl" aria-label="Streaming assistant response"><MarkdownRenderer messageId={`${identity.threadId}:progress`} isStreaming content={progress} /></article>}
      {snapshot?.operations.map(operation => <div key={operation.id} className="mx-auto max-w-3xl rounded border p-2 text-sm">
        <div>Background operation · {operation.phase} · {operation.outcome ?? 'In progress'} · effect: {operation.effect}</div>
        {operation.external_receipt && <div className="text-xs text-muted-foreground">{operation.external_receipt.executor} · {operation.external_receipt.outcome}</div>}
        {operation.phase !== 'terminal' && <Button variant="ghost" size="sm" onClick={() => void act(() => api.cancelOperation(operation.id))}>Cancel operation</Button>}
      </div>)}
      {snapshot?.inputs.filter(input => input.state === 'queued').map(input => <div key={input.id} className="mx-auto max-w-3xl rounded border p-2 text-sm">
        <form onSubmit={event => { event.preventDefault(); const edited = new FormData(event.currentTarget).get('text');
          if (typeof edited === 'string') void act(() => api.editInput(input.id, input.revision, edited)); }}>
          <label className="text-xs text-muted-foreground">{input.mode}</label>
          <ImageAttachmentStrip images={nativeHistoryImages(input.content)} />
          <Textarea key={`${input.id}:${input.revision}`} name="text" aria-label="Edit queued input" defaultValue={nativeHistoryText(input.content)} />
          <Button type="submit" variant="ghost" size="sm">Save queued input</Button>
        </form>
        <Button variant="ghost" size="sm" onClick={() => void act(() => api.cancelInput(input.id, input.revision))}>Cancel queued input</Button>
      </div>)}
    </div>
    <form className="mx-auto w-full max-w-3xl space-y-2 p-4" onSubmit={event => {
      event.preventDefault();
      void act(async () => {
        const fingerprint = JSON.stringify([identity.threadId, identity.branchId, text, images, providerId, modelId, inputMode]);
        if (pendingInput.current?.fingerprint !== fingerprint) {
          const key = crypto.randomUUID();
          const submit = { ...identity, key, text, images, expectedHead: branch?.head ?? null, model: { providerId, modelId } };
          const queued = { ...identity, key, text, images, mode: inputMode };
          pendingInput.current = { fingerprint, send: active ? () => api.enqueue(queued) : () => api.submit(submit) };
        }
        await pendingInput.current.send();
        pendingInput.current = undefined;
        if (draftRef.current.text === text) setText('');
        setImages(current => current.filter(image => !images.includes(image)));
      });
    }}>
      {snapshot?.launch?.preparation_failure && <p role="alert" className="text-sm text-destructive">Preparation needs attention: {snapshot.launch.preparation_failure}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <select aria-label="Registered model" disabled={active} className="w-full rounded border bg-background px-2 py-1 text-sm"
        value={JSON.stringify([providerId, modelId])} onChange={event => {
          const [provider, model] = JSON.parse(event.target.value) as [string, string]; setProviderId(provider); setModelId(model);
        }}>
        <option value={JSON.stringify(['', ''])}>Choose a registered model</option>
        {models.map(model => <option key={JSON.stringify([model.providerId, model.modelId])} value={JSON.stringify([model.providerId, model.modelId])}>{model.providerId} · {model.name ?? model.modelId}</option>)}
      </select>
      {active && <select aria-label="Input delivery" className="rounded border bg-background text-sm" value={inputMode} onChange={event => setInputMode(event.target.value as typeof inputMode)}>
        <option value="boundary">At next model boundary</option><option value="interrupt">Interrupt current generation</option><option value="next_run">After current run</option>
      </select>}
      {images.length > 0 && acceptsImages === false && <p role="alert" className="text-sm text-destructive">Choose an image-capable model or remove these images before sending</p>}
      <ImageAttachmentStrip images={images} removeLabel={t('chat.fileAttachment.actions.removeImage')}
        onRemove={index => setImages(current => current.filter((_, candidate) => candidate !== index))} />
      <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label="Choose image attachments"
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addImages(files); }} />
      <Textarea aria-label="Message native thread" value={text} onChange={event => setText(event.target.value)}
        onPaste={event => { const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); void addImages(files); } }}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
        onDrop={event => { const files = [...event.dataTransfer.files]; if (files.length) { event.preventDefault(); void addImages(files); } }} />
      <div className="flex gap-2">
        <Button type="button" variant="ghost" disabled={readingFiles || acceptsImages === false} onClick={() => fileInput.current?.click()}>Attach images</Button>
        <Button type="submit" disabled={pending || readingFiles || (images.length > 0 && acceptsImages === false) || (!text.trim() && !images.length) || (!active && (!providerId || !modelId))}>{active ? 'Queue message' : 'Send'}</Button>
        {active && branch?.active_run_id && <Button type="button" variant="outline" onClick={() => void act(() => api.cancelRun(branch.active_run_id!))}>Stop run</Button>}
        {run && !['completed', 'cancelled', 'failed'].includes(run.state) && <Button type="button" variant="ghost" onClick={() => void act(() => api.resume(run.id))}>Resume preparation</Button>}
      </div>
    </form>
  </section>;
}
