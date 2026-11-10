import React from 'react';
import { ImageAttachmentStrip } from '@/components/chat/composer/ImageAttachmentStrip';
import { updateDraftImage } from '@/components/chat/composer/imageAttachments';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { ReferenceNavigationContext } from '@/components/conversation/ReferenceNavigation';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { ThreadMedia } from './ThreadMedia';
import { ThreadAttachments, ThreadFileDrafts } from './ThreadAttachments';
import { Icon } from '@/components/icon/Icon';
import { ContentReferencePreview } from '@/components/conversation/ContentReferencePreview';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { insertDraftMarker, removeDraftMarker } from '@/lib/agent-editor/contentReferences';
import type { ComposerMarkerObject } from '@/components/chat/composer/editor/markers';
import { useI18n } from '@/lib/i18n';

export function DraftMarkerPreview({ object, draftKey, onClose }: { object: ComposerMarkerObject; draftKey: string; onClose(): void }) {
  const { t } = useI18n();
  const captured = object.payload.kind === 'quote' ? object.payload.reference : object.payload.contentReference;
  const reference = captured && object.kind === 'image' ? { ...captured, imageReference: object.number } : captured;
  const navigation = React.useContext(ReferenceNavigationContext);
  const api = getRegisteredRuntimeAPIs()?.threads;
  const insert = draftKey ? () => { void insertDraftMarker(draftKey, object).then(onClose, error => useThreadDraftStore.getState().patch(draftKey, { sendError: error instanceof Error ? error.message : String(error) })); } : undefined;
  const draft = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const locked = object.host !== getRuntimeEndpointGeneration() || Boolean(draft.pendingInput || draft.firstSend || draft.externalInput || draft.collaboration?.sending || draft.collaboration?.attempts);
  const payload = object.payload;
  const image = payload.kind === 'image' ? <ImageAttachmentStrip key={`${draftKey}:${object.id}`} images={[payload.image]} onReference={locked ? undefined : insert}
    onUpdate={locked ? undefined : (_index, image) => {
      if (object.host !== getRuntimeEndpointGeneration()) return;
      const current = useThreadDraftStore.getState().drafts[draftKey];
      const owner = current?.markerObjects?.find(value => value.id === object.id);
      if (owner?.payload.kind !== 'image') return;
      const index = current.images.indexOf(owner.payload.image);
      if (index >= 0) updateDraftImage(draftKey, index, image);
    }} /> : payload.kind === 'file-image' ? <ThreadFileDrafts key={`${draftKey}:${object.id}`} draftKey={draftKey} files={[payload.file]} locked={locked}
      onRemove={() => removeDraftMarker(draftKey, object.id)} onReference={locked ? undefined : insert} /> : payload.kind === 'stored-image' ? api ? <ThreadMedia api={api} identity={payload.identity} holder={payload.holder} media={payload.media} partIndex={payload.partIndex} imageReference={object.number} /> : <p role="alert">{t('chat.quote.sourceUnavailable')}</p> : undefined;
  if (reference) return <ContentReferencePreview reference={reference} number={object.number} image={image} attachments={payload.kind === 'attachment-image' ? [payload.attachment] : undefined} api={api} identity={payload.kind === 'attachment-image' ? payload.identity ?? navigation?.identity : navigation?.identity} onClose={onClose} onInsert={insert} />;
  if (object.payload.kind === 'image') return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>{object.label}</DialogTitle></DialogHeader>
    {image}
    {insert && <button type="button" onClick={insert}>{t('chat.quote.insertMarker')}</button>}</DialogContent></Dialog>;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>{object.payload.kind === 'file-image' ? object.payload.file.filename : object.label}</DialogTitle></DialogHeader>
    {image ?? (payload.kind === 'attachment-image' && api && (payload.identity || navigation) ? <ThreadAttachments api={api} identity={payload.identity ?? navigation!.identity} attachments={[payload.attachment]} /> : <p role="alert">{t('chat.quote.sourceUnavailable')}</p>)}{insert && <button type="button" onClick={insert}>{t('chat.quote.insertMarker')}</button>}</DialogContent></Dialog>;
}
export function DraftContentReferences({ draftKey, locked = false }: { draftKey: string; locked?: boolean }) {
  const { t } = useI18n();
  const draft = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const [previewId, setPreviewId] = React.useState<string>();
  React.useEffect(() => setPreviewId(undefined), [draftKey]);
  const preview = draft.markerObjects?.find(object => object.id === previewId);
  const objects = draft.markerObjects?.filter(object => object.kind === 'quote') ?? [];
  const storedImages = draft.markerObjects?.filter(object => object.payload.kind === 'stored-image') ?? [];
  const api = getRegisteredRuntimeAPIs()?.threads;
  if (!objects.length && !storedImages.length && !preview) return null;
  return <div className="flex flex-wrap gap-1.5">
    {objects.map(object => <span key={object.id} className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 typography-micro">
      <Icon name={object.payload.kind === 'quote' && object.payload.reference.source.kind === 'file' ? 'file' : 'chat-quote'} className="size-3.5 shrink-0" />
      <button type="button" className="max-w-[min(22rem,65vw)] truncate" onClick={() => setPreviewId(object.id)}>{object.label} · {object.sourceLabel}{object.excerpt ? `：${object.excerpt}` : ''}</button>
      <button type="button" disabled={locked} aria-label={t('workbench.attachment.removeAria', { name: object.label })} className="text-muted-foreground hover:text-foreground" onClick={() => removeDraftMarker(draftKey, object.id)}><Icon name="close" className="size-3.5" /></button>
    </span>)}
    {storedImages.map(object => <div key={object.id} className="max-w-40 rounded-lg border border-border/60 p-2">
      {object.payload.kind === 'stored-image' && object.host === getRuntimeEndpointGeneration() && api
        ? <ThreadMedia api={api} identity={object.payload.identity} holder={object.payload.holder} media={object.payload.media} partIndex={object.payload.partIndex} imageReference={object.number} thumbnail />
        : <p role="alert">{t('chat.quote.sourceUnavailable')}</p>}
      <div className="flex items-center gap-2 typography-micro"><button type="button" onClick={() => setPreviewId(object.id)}>{object.label}</button>
        <button type="button" disabled={locked} aria-label={t('workbench.attachment.removeAria', { name: object.label })} onClick={() => removeDraftMarker(draftKey, object.id)}><Icon name="close" className="size-3.5" /></button></div>
    </div>)}
    {preview && <DraftMarkerPreview object={preview} draftKey={draftKey} onClose={() => setPreviewId(undefined)} />}
  </div>;
}
