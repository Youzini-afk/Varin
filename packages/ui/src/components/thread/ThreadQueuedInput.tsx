import React from 'react';
import type { ImageAttachment, QueuedInput } from '@varin/protocol';
import { getRuntimeEndpointGeneration, type ContentReferenceInput, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import { inputParts, inputText } from '@/lib/agent-runtime/thread-content';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import { Button } from '@/components/ui/button';
import { ComposerEditor, type ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { composerMarkerObjects, type ComposerMarkerObject } from '@/components/chat/composer/editor/markers';
import { freezeDraftContentReferences } from '@/lib/agent-editor/contentReferences';
import { DraftMarkerPreview } from './DraftContentReferences';
import { queuedQuoteDraft, queuedMediaObjects, replaceQueuedMedia, prepareQueuedImages, queuedMarkerPasteError } from './queuedQuoteDraft';
import { ThreadContent } from './ThreadContent';
import { ThreadMedia } from './ThreadMedia';
import { ThreadSkillMaterials } from './ThreadSkillMaterials';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { Icon } from '@/components/icon/Icon';

/** The edit draft retains its original revision even if the Catalog changes or delivers it. */
export function ThreadInputQueue({ api, identity, inputs, pending, onSave, onCancel, onSendNow, reportDelivery = false }: {
  api: Pick<ThreadsAPI, 'mediaRead'> & Partial<Pick<ThreadsAPI, 'attachments'>>; identity: ThreadIdentity; inputs: QueuedInput[]; pending: boolean;
  onSave(input: QueuedInput, text: string, images?: ImageAttachment[], quotes?: ContentReferenceInput): Promise<boolean>;
  onCancel(input: QueuedInput): Promise<void>;
  onSendNow?(input: QueuedInput): Promise<void>;
  reportDelivery?: boolean;
}) {
  const { t } = useI18n();
  const previousInputs = React.useRef(new Map(inputs.map(input => [input.id, input.state])));
  const [received, setReceived] = React.useState<{ id: string; text: string }>();
  React.useEffect(() => {
    const delivered = inputs.find(input => input.state === 'delivered' && previousInputs.current.get(input.id) === 'queued');
    previousInputs.current = new Map(inputs.map(input => [input.id, input.state]));
    if (reportDelivery && delivered) setReceived({ id: delivered.id, text: inputText(delivered.content) });
  }, [inputs, reportDelivery]);
  React.useEffect(() => {
    if (!received) return;
    const timer = setTimeout(() => setReceived(undefined), 4000);
    return () => clearTimeout(timer);
  }, [received]);
  const [editing, setEditing] = React.useState<({ input: QueuedInput } & ReturnType<typeof queuedQuoteDraft>) | null>(null);
  const [markerPreviewId, setMarkerPreviewId] = React.useState<string>();
  const originalObjects = React.useRef<readonly ComposerMarkerObject[]>([]);
  const live = React.useRef({ inputs, identity }); live.current = { inputs, identity };
  const [reading, setReading] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const generation = React.useRef(0);
  const saving = React.useRef(false);
  const textarea = React.useRef<ComposerEditorHandle>(null);
  React.useEffect(() => () => { generation.current += 1; }, []);
  const changeImages = (next: ImageAttachment[] | undefined) => {
    if (!editing) return;
    generation.current += 1; setReading(false); setError(undefined);
    const current = textarea.current?.getEditorState()?.field(composerMarkerObjects) ?? editing.markerObjects;
    const objects = next === undefined ? [...current.filter(object => !queuedMediaObjects(current).includes(object)), ...queuedMediaObjects(originalObjects.current)] : replaceQueuedMedia(current, next);
    textarea.current?.replaceMarkerObjects(objects, { renumber: false });
  };
  const close = () => { generation.current += 1; setReading(false); setEditing(null); setMarkerPreviewId(undefined); setError(undefined); };
  const begin = (input: QueuedInput) => { close(); const draft = queuedQuoteDraft(input, identity); originalObjects.current = draft.markerObjects; setEditing({ input, ...draft }); };
  const images = editing?.markerObjects.flatMap(object => object.payload.kind === 'image' ? [object.payload.image] : []) ?? [];
  const originalMedia = queuedMediaObjects(originalObjects.current);
  const currentMedia = queuedMediaObjects(editing?.markerObjects ?? []);
  const imagesChanged = originalMedia.length !== currentMedia.length || originalMedia.some((object, index) => object !== currentMedia[index]);
  const markerPreview = editing?.markerObjects.find(object => object.id === markerPreviewId);
  const queued = inputs.filter(input => input.state === 'queued');
  const editIsCurrent = Boolean(editing && queued.some(input => input.id === editing.input.id && input.revision === editing.input.revision));
  const replace = async (files: File[]) => {
    if (files.length === 0 || pending || !editIsCurrent) return;
    const current = ++generation.current, host = getRuntimeEndpointGeneration(); setReading(true); setError(undefined);
    const captured = editing!.markerObjects, targetIds = new Set(queuedMediaObjects(captured).map(object => object.id));
    try {
      if (files.some(file => !file.type.startsWith('image/'))) throw new Error('Choose image files to replace the queued images.');
      const originals = queuedMediaObjects(editing!.markerObjects).map(object => object.number);
      let reference = Math.max(0, ...editing!.markerObjects.filter(object => object.kind === 'image').map(object => object.number));
      const next = await Promise.all(files.map((file, index) => {
        const number = originals[index] ?? ++reference;
        return fileToImageAttachment(file).then(image => ({ ...image, reference: number }));
      }));
      if (generation.current === current) {
        if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing queued images');
        const latest = textarea.current?.getEditorState()?.field(composerMarkerObjects) ?? editing!.markerObjects;
        let highest = Math.max(0, ...latest.filter(object => object.kind === 'image').map(object => object.number));
        const prepared = next.map((image, index) => index < originals.length ? image : { ...image, reference: ++highest });
        const replaced = replaceQueuedMedia(captured, prepared).filter(object => object.kind === 'image' && object.payload.kind !== 'attachment-image');
        textarea.current?.replaceMarkerObjects([...latest.filter(object => !targetIds.has(object.id)), ...replaced], { renumber: false });
      }
    } catch (value) { if (generation.current === current) setError(value instanceof Error ? value.message : 'Could not read these images.'); }
    finally { if (generation.current === current) setReading(false); }
  };
  const save = async () => {
    if (!editing || pending || reading || saving.current || !editIsCurrent) return;
    const current = generation.current; saving.current = true;
    const frozen = editing, host = getRuntimeEndpointGeneration(), source = { ...identity };
    try {
      const quotes = freezeDraftContentReferences(frozen);
      const images = await prepareQueuedImages(api, originalObjects.current, frozen.markerObjects);
      if (generation.current !== current || host !== getRuntimeEndpointGeneration() || live.current.identity.threadId !== source.threadId || live.current.identity.branchId !== source.branchId
        || !live.current.inputs.some(input => input.id === frozen.input.id && input.revision === frozen.input.revision && input.state === 'queued')) return;
      if (await onSave(frozen.input, frozen.text, images, quotes) && current === generation.current) close();
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { saving.current = false; }
  };

  const editor = editing && <form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void save(); }}>
    <label className="text-xs text-muted-foreground">{t(editing.input.mode === 'next_run' ? 'thread.composer.afterRun' : editing.input.mode === 'interrupt' ? 'chat.queuedMessage.steering' : 'thread.composer.boundary')}</label>
    {editing.markerObjects.flatMap(object => object.payload.kind === 'stored-image' ? [<ThreadMedia key={object.id} api={api} identity={object.payload.identity} holder={object.payload.holder}
      media={object.payload.media} partIndex={object.payload.partIndex} imageReference={object.number} thumbnail />] : [])}
    <ImageAttachmentStrip key={editing.input.id} images={images}
      onUpdate={pending || !editIsCurrent ? undefined : (index, image) => {
        const previous = images[index];
        textarea.current?.replaceMarkerObjects(editing.markerObjects.map(object => object.payload.kind === 'image' && object.payload.image === previous ? { ...object, payload: { ...object.payload, image } } : object), { renumber: false });
      }}
      onRemove={pending || !editIsCurrent ? undefined : index => textarea.current?.replaceMarkerObjects(editing.markerObjects.filter(object => object.payload.kind !== 'image' || object.payload.image !== images[index]), { renumber: false })}
      onReference={pending || !editIsCurrent ? undefined : number => {
        const object = editing.markerObjects.find(object => object.kind === 'image' && object.number === number);
        if (object) void textarea.current?.insertMarker(object);
      }} />
    {editing.markerObjects.filter(object => object.kind === 'quote' || object.payload.kind === 'stored-image' || object.payload.kind === 'file-image').map(object => <button type="button" key={object.id} onClick={() => setMarkerPreviewId(object.id)} className="rounded px-2 py-1 text-xs text-primary hover:bg-primary/10">{object.label}{object.sourceLabel ? ` · ${object.sourceLabel}` : ''}</button>)}
    <ThreadContent api={api} identity={identity} holder={{ kind: 'input', inputId: editing.input.id, expectedRevision: editing.input.revision }}
      messageId={editing.input.id} parts={inputParts(editing.input.content).filter(part => part.kind === 'attachment')} />
    <ThreadSkillMaterials content={editing.input.content} />
    <ComposerEditor ref={textarea} value={editing.text} references={editing.references} markerObjects={editing.markerObjects}
      aria-label={t('chat.queuedMessage.edit')} editable={!pending && editIsCurrent} host={getRuntimeEndpointGeneration()} onMarkerActivate={object => setMarkerPreviewId(object.id)} onMarkerError={setError} validateMarkerPaste={objects => queuedMarkerPasteError(editing.input, objects)}
      languageContext={{ inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(), knownSlashNames: new Set(), attachmentFilenames: [] }}
      onChange={change => setEditing(current => current && current.input.id === editing.input.id ? { ...current, text: change.value, references: [...change.references], markerObjects: [...change.markerObjects] } : current)}
      onKeyDown={event => {
        if (isIMECompositionEvent(event)) return false;
        if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); close(); return true; }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); void save(); return true; }
        return false;
      }} />
    {markerPreview && <DraftMarkerPreview object={markerPreview} draftKey="" onClose={() => setMarkerPreviewId(undefined)} />}

    {!editIsCurrent && <p role="status" className="text-xs text-muted-foreground">{t('chat.queuedMessage.editStale')}</p>}
    <label>Replace queued images <input type="file" accept="image/*" multiple aria-label="Replace queued images" disabled={pending || reading || !editIsCurrent}
      onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void replace(files); }} /></label>
    <Button type="button" variant="ghost" size="sm" disabled={pending || !editIsCurrent} onClick={() => changeImages([])}>Remove queued images</Button>
    {imagesChanged && <Button type="button" variant="ghost" size="sm" disabled={pending || !editIsCurrent} onClick={() => changeImages(undefined)}>Keep original images</Button>}
    {imagesChanged && currentMedia.length === 0 && <p>Images will be removed when you save.</p>}
    {reading && <p role="status">Reading replacement images…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={close}>{t('settings.common.actions.cancel')}</Button>
      <Button type="submit" variant="ghost" size="sm" disabled={pending || reading || !editIsCurrent}>{t('settings.common.actions.saveChanges')}</Button>
    </div>
  </form>;
  if (!queued.length && !editing && !received) return null;
  return <section aria-label={t('chat.queuedMessage.title')} className="max-h-[40vh] space-y-2 overflow-y-auto overscroll-contain">
    {received && <p role="status" className="bot-input-received"><Icon name="check" className="size-3" /><span>{t('bot.workspace.received')} · {received.text}</span></p>}
    {queued.map(input => <div key={input.id} data-queued-input={input.id} className="mx-auto max-w-3xl rounded-xl border border-border/60 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon name={input.mode === 'next_run' ? 'time' : 'arrow-up'} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={inputText(input.content)}>{inputText(input.content) || t('chat.queuedMessage.empty')}</span>
        <span className="shrink-0 typography-micro text-muted-foreground max-sm:hidden">{t(input.mode === 'next_run' ? 'bot.workspace.queued' : 'bot.workspace.accepted')}</span>
        {input.mode === 'next_run' && onSendNow && <button type="button" disabled={pending || Boolean(editing)}
          title={t('chat.queuedMessage.sendHint')} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 typography-micro text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
          onClick={() => void onSendNow(input)}><Icon name="arrow-up" className="size-3.5" />{t('chat.queuedMessage.sendNow')}</button>}
        <button type="button" disabled={pending || Boolean(editing)} aria-label={t('chat.queuedMessage.edit')} aria-expanded={editing?.input.id === input.id} className="rounded p-1 hover:bg-interactive-hover" onClick={() => begin(input)}><Icon name="edit" className="size-3.5" /></button>
        <button type="button" disabled={pending || Boolean(editing)} aria-label={t('chat.queuedMessage.removeAria')} className="rounded p-1 hover:bg-interactive-hover" onClick={() => void onCancel(input)}><Icon name="close" className="size-3.5" /></button>
      </div>
      {editing?.input.id !== input.id && <ThreadContent api={api} identity={identity} holder={{ kind: 'input', inputId: input.id, expectedRevision: input.revision }}
        messageId={input.id} parts={inputParts(input.content).filter(part => part.kind === 'attachment')} />}
      {editing?.input.id === input.id && editor}
    </div>)}
    {editing && !queued.some(input => input.id === editing.input.id) && <div className="mx-auto max-w-3xl rounded-xl border border-border/60 px-3 py-2 text-sm">{editor}</div>}
  </section>;
}
