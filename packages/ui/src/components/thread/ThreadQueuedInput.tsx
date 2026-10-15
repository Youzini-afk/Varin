import React from 'react';
import type { ImageAttachment, QueuedInput } from '@varin/protocol';
import type { ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { inputParts, inputText } from '@/lib/agent-runtime/thread-content';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ThreadContent } from './ThreadContent';
import { ThreadSkillMaterials } from './ThreadSkillMaterials';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';

export function ThreadQueuedInput({ api, identity, input, pending, onSave, onCancel }: {
  api: Pick<ThreadsAPI, 'mediaRead'>; identity: ThreadIdentity; input: QueuedInput; pending: boolean;
  onSave(text: string, images?: ImageAttachment[]): Promise<void>; onCancel(): Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = React.useState(false);
  const [images, setImages] = React.useState<ImageAttachment[]>();
  const [reading, setReading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const generation = React.useRef(0);
  React.useEffect(() => () => { generation.current += 1; }, []);
  const changeImages = (next: ImageAttachment[] | undefined) => { generation.current += 1; setReading(false); setImages(next); setError(undefined); };
  const replace = async (files: File[]) => {
    if (files.length === 0) return;
    const current = ++generation.current; setReading(true); setError(undefined);
    try {
      if (files.some(file => !file.type.startsWith('image/'))) throw new Error('Choose image files to replace the queued images.');
      const next = await Promise.all(files.map(fileToImageAttachment));
      if (generation.current === current) setImages(next);
    } catch (value) { if (generation.current === current) setError(value instanceof Error ? value.message : 'Could not read these images.'); }
    finally { if (generation.current === current) setReading(false); }
  };
  return <div className="mx-auto max-w-3xl rounded-xl border border-border/60 px-3 py-2 text-sm">
    <div className="flex items-center gap-2 text-muted-foreground">
      <Icon name="time" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={inputText(input.content)}>{inputText(input.content) || t('chat.queuedMessage.empty')}</span>
      <button type="button" disabled={pending} aria-label={t('chat.queuedMessage.edit')} aria-expanded={editing} className="rounded p-1 hover:bg-interactive-hover" onClick={() => setEditing(value => !value)}><Icon name="edit" className="size-3.5" /></button>
      <button type="button" disabled={pending} aria-label={t('chat.queuedMessage.removeAria')} className="rounded p-1 hover:bg-interactive-hover" onClick={() => void onCancel()}><Icon name="close" className="size-3.5" /></button>
    </div>
    <form hidden={!editing} className="mt-2 space-y-2" onSubmit={event => {
      event.preventDefault(); const text = new FormData(event.currentTarget).get('text');
      if (!pending && !reading && typeof text === 'string') void onSave(text, images);
    }}>
      <label className="text-xs text-muted-foreground">{t(input.mode === 'next_run' ? 'thread.composer.afterRun' : input.mode === 'interrupt' ? 'thread.composer.interrupt' : 'thread.composer.boundary')}</label>
      {images === undefined ? <ThreadContent api={api} identity={identity} holder={{ kind: 'input', inputId: input.id, expectedRevision: input.revision }}
        messageId={input.id} parts={inputParts(input.content).filter(part => part.kind !== 'text')} />
        : <ImageAttachmentStrip images={images} />}
      <ThreadSkillMaterials content={input.content} />
      <Textarea name="text" aria-label="Edit queued input" defaultValue={inputText(input.content)} disabled={pending} />
      <label>Replace queued images <input type="file" accept="image/*" multiple aria-label="Replace queued images" disabled={pending || reading}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void replace(files); }} /></label>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => changeImages([])}>Remove queued images</Button>
      {images !== undefined && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => changeImages(undefined)}>Keep original images</Button>}
      {images?.length === 0 && <p>Images will be removed when you save.</p>}
      {reading && <p role="status">Reading replacement images…</p>}
      {error && <p role="alert">{error}</p>}
      <Button type="submit" variant="ghost" size="sm" disabled={pending || reading}>Save queued input</Button>
    </form>
  </div>;
}
