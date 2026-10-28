import React from 'react';
import type { ImageAttachment, QueuedInput } from '@varin/protocol';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { inputParts, inputText } from '@/lib/agent-runtime/thread-content';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { fileToImageAttachment, removeImageReference } from '@/components/chat/composer/imageAttachments';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ThreadContent } from './ThreadContent';
import { ThreadSkillMaterials } from './ThreadSkillMaterials';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { Icon } from '@/components/icon/Icon';

/** The edit draft retains its original revision even if the Catalog changes or delivers it. */
export function ThreadInputQueue({ api, identity, inputs, pending, onSave, onCancel, onSendNow }: {
  api: Pick<ThreadsAPI, 'mediaRead'>; identity: ThreadIdentity; inputs: QueuedInput[]; pending: boolean;
  onSave(input: QueuedInput, text: string, images?: ImageAttachment[]): Promise<boolean>;
  onCancel(input: QueuedInput): Promise<void>;
  onSendNow?(input: QueuedInput): Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = React.useState<{ input: QueuedInput; text: string } | null>(null);
  const [images, setImages] = React.useState<ImageAttachment[]>();
  const [reading, setReading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const generation = React.useRef(0);
  const saving = React.useRef(false);
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => () => { generation.current += 1; }, []);
  const changeImages = (next: ImageAttachment[] | undefined) => { generation.current += 1; setReading(false); setImages(next); setError(undefined); };
  const close = () => { generation.current += 1; setReading(false); setEditing(null); setImages(undefined); setError(undefined); };
  const begin = (input: QueuedInput) => { close(); setEditing({ input, text: inputText(input.content) }); };
  const queued = inputs.filter(input => input.state === 'queued');
  const editIsCurrent = Boolean(editing && queued.some(input => input.id === editing.input.id && input.revision === editing.input.revision));
  const replace = async (files: File[]) => {
    if (files.length === 0 || pending || !editIsCurrent) return;
    const current = ++generation.current; setReading(true); setError(undefined);
    try {
      if (files.some(file => !file.type.startsWith('image/'))) throw new Error('Choose image files to replace the queued images.');
      const originals = inputParts(editing!.input.content).flatMap(part => part.kind === 'media' ? [part.imageReference ?? part.partIndex + 1] : []);
      let reference = Math.max(0, ...originals);
      const next = await Promise.all(files.map((file, index) => {
        const number = originals[index] ?? ++reference;
        return fileToImageAttachment(file).then(image => ({ ...image, reference: number }));
      }));
      if (generation.current === current) setImages(next);
    } catch (value) { if (generation.current === current) setError(value instanceof Error ? value.message : 'Could not read these images.'); }
    finally { if (generation.current === current) setReading(false); }
  };
  const save = async () => {
    if (!editing || pending || reading || saving.current || !editIsCurrent) return;
    const current = generation.current; saving.current = true;
    const text = images === undefined ? editing.text : inputParts(editing.input.content).reduce((text, part) =>
      part.kind === 'media' && part.imageReference !== undefined && !images.some(image => image.reference === part.imageReference)
        ? removeImageReference(text, part.imageReference) : text, editing.text);
    try { if (await onSave(editing.input, text, images) && current === generation.current) close(); }
    finally { saving.current = false; }
  };
  const editor = editing && <form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void save(); }}>
    <label className="text-xs text-muted-foreground">{t(editing.input.mode === 'next_run' ? 'thread.composer.afterRun' : editing.input.mode === 'interrupt' ? 'thread.composer.interrupt' : 'thread.composer.boundary')}</label>
    {images === undefined ? <ThreadContent api={api} identity={identity} holder={{ kind: 'input', inputId: editing.input.id, expectedRevision: editing.input.revision }}
      messageId={editing.input.id} parts={inputParts(editing.input.content).filter(part => part.kind !== 'text')} /> : <ImageAttachmentStrip images={images}
        onReference={pending || !editIsCurrent ? undefined : number => {
          const input = textarea.current; if (!input) return;
          const token = t('chat.imageReference.token', { number });
          const position = input.selectionStart ?? editing.text.length, end = input.selectionEnd ?? position;
          setEditing({ ...editing, text: editing.text.slice(0, position) + token + editing.text.slice(end) });
          requestAnimationFrame(() => { input.focus(); input.setSelectionRange(position + token.length, position + token.length); });
        }} />}
    <ThreadSkillMaterials content={editing.input.content} />
    <Textarea ref={textarea} name="text" aria-label={t('chat.queuedMessage.edit')} value={editing.text} disabled={pending} autoFocus
      onChange={event => setEditing({ ...editing, text: event.target.value })}
      onKeyDown={event => {
        if (isIMECompositionEvent(event.nativeEvent)) return;
        if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); close(); }
        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void save(); }
      }} />
    {!editIsCurrent && <p role="status" className="text-xs text-muted-foreground">{t('chat.queuedMessage.editStale')}</p>}
    <label>Replace queued images <input type="file" accept="image/*" multiple aria-label="Replace queued images" disabled={pending || reading || !editIsCurrent}
      onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void replace(files); }} /></label>
    <Button type="button" variant="ghost" size="sm" disabled={pending || !editIsCurrent} onClick={() => changeImages([])}>Remove queued images</Button>
    {images !== undefined && <Button type="button" variant="ghost" size="sm" disabled={pending || !editIsCurrent} onClick={() => changeImages(undefined)}>Keep original images</Button>}
    {images?.length === 0 && <p>Images will be removed when you save.</p>}
    {reading && <p role="status">Reading replacement images…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={close}>{t('settings.common.actions.cancel')}</Button>
      <Button type="submit" variant="ghost" size="sm" disabled={pending || reading || !editIsCurrent}>{t('settings.common.actions.saveChanges')}</Button>
    </div>
  </form>;
  if (!queued.length && !editing) return null;
  return <section aria-label={t('chat.queuedMessage.title')} className="max-h-[40vh] space-y-2 overflow-y-auto overscroll-contain">
    {queued.map(input => <div key={input.id} data-queued-input={input.id} className="mx-auto max-w-3xl rounded-xl border border-border/60 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon name={input.mode === 'next_run' ? 'time' : 'arrow-up'} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={inputText(input.content)}>{inputText(input.content) || t('chat.queuedMessage.empty')}</span>
        {input.mode === 'next_run' && onSendNow && <button type="button" disabled={pending || Boolean(editing)}
          title={t('chat.queuedMessage.sendHint')} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 typography-micro text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
          onClick={() => void onSendNow(input)}><Icon name="arrow-up" className="size-3.5" />{t('chat.queuedMessage.sendNow')}</button>}
        <button type="button" disabled={pending || Boolean(editing)} aria-label={t('chat.queuedMessage.edit')} aria-expanded={editing?.input.id === input.id} className="rounded p-1 hover:bg-interactive-hover" onClick={() => begin(input)}><Icon name="edit" className="size-3.5" /></button>
        <button type="button" disabled={pending || Boolean(editing)} aria-label={t('chat.queuedMessage.removeAria')} className="rounded p-1 hover:bg-interactive-hover" onClick={() => void onCancel(input)}><Icon name="close" className="size-3.5" /></button>
      </div>
      {editing?.input.id === input.id && editor}
    </div>)}
    {editing && !queued.some(input => input.id === editing.input.id) && <div className="mx-auto max-w-3xl rounded-xl border border-border/60 px-3 py-2 text-sm">{editor}</div>}
  </section>;
}
