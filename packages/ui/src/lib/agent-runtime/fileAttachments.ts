import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import { attachmentMimeType, type Attachment } from '@varin/protocol';
import { isAttachment } from './thread-content';
import { useThreadDraftStore, type DraftFileAttachment } from '@/stores/useThreadDraftStore';
import { flattenAnnotations, type ImageAnnotationDocument } from '@/lib/images/annotations';
import { nextImageReference, renumberDraftImages } from '@/lib/images/references';

import { ensureDraftImageMarkers } from '@/components/chat/composer/imageAttachments';
import { insertDraftMarker, removeDraftMarker, imageMarkerLabel, draftMarkerState, saveComposerState } from '@/lib/agent-editor/contentReferences';
import { findMarkerComposer } from '@/components/chat/composer/editor/markerComposerRegistry';
import { replaceComposerMarkerObjects, type ComposerMarkerObject } from '@/components/chat/composer/editor/markers';

/** Picking is not uploading or delivering. Keep the exact original Blob and an idempotent upload key. */
export function selectThreadFiles(draftKey: string, files: readonly File[]): DraftFileAttachment[] {
  ensureDraftImageMarkers(draftKey);
  const selected: DraftFileAttachment[] = files.map(file => ({ id: crypto.randomUUID(), filename: file.name,
    mimeType: attachmentMimeType(file.name, file.type === 'application/octet-stream' ? '' : file.type), data: file, status: 'selected' as const }));
  useThreadDraftStore.getState().patch(draftKey, draft => {
    let reference = nextImageReference(draft) - 1;
    for (const file of selected) if (file.mimeType.startsWith('image/')) file.imageReference = ++reference;
    return { files: [...(draft.files ?? []), ...selected] };
  });
  for (const file of selected) if (file.imageReference !== undefined) {
    void insertDraftMarker(draftKey, { id: file.id, kind: 'image', number: file.imageReference, label: imageMarkerLabel(file.imageReference), host: getRuntimeEndpointGeneration(), sourceLabel: file.filename, payload: { kind: 'file-image', file } })
      .catch(error => useThreadDraftStore.getState().patch(draftKey, { sendError: error instanceof Error ? error.message : String(error) }));
  }
  return selected;
}

export function removeDraftFile(key: string, id: string) {
  ensureDraftImageMarkers(key);
  if (useThreadDraftStore.getState().drafts[key]?.markerObjects?.some(object => object.payload.kind === 'file-image' && object.payload.file.id === id)) { removeDraftMarker(key, id); return; }
  useThreadDraftStore.getState().patch(key, draft => {
    return renumberDraftImages(draft, { images: draft.images, files: draft.files?.filter(file => file.id !== id) });
  });
}

export function annotatedImageBlob(image: { data: string; mimeType: string }): Blob {
  return new Blob([Uint8Array.from(atob(image.data), character => character.charCodeAt(0))], { type: image.mimeType });
}

/** Explicit file-only fallback, with the same marker identity and one undo step.
 * Annotation flattening and upload remain with the existing file preparation owner. */
export function convertDraftImagesToFiles(key: string, expectedHost = getRuntimeEndpointGeneration(), preparedStored?: ReadonlyMap<string, import('@varin/protocol').ImageAttachment>): void {
  if (expectedHost !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing attachments');
  const initial = useThreadDraftStore.getState().drafts[key];
  if (!initial || (!initial.images.length && !preparedStored?.size) || initial.pendingInput || initial.firstSend || initial.externalInput || initial.collaboration?.sending || initial.collaboration?.attempts) return;
  if (initial.markerObjects?.some(object => object.host !== expectedHost)) throw new Error('The referenced content belongs to a different Host. Select it again.');
  ensureDraftImageMarkers(key);
  const draft = useThreadDraftStore.getState().drafts[key];
  const objects = (draft.markerObjects ?? []).map((object): ComposerMarkerObject => {
    const image = object.payload.kind === 'image' ? object.payload.image : object.payload.kind === 'stored-image' ? preparedStored?.get(object.id) : undefined;
    if (!image) return object;
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp' } as Record<string, string>)[image.mimeType] ?? 'img';
    const file: DraftFileAttachment = { id: object.id, filename: `image-${object.number}.${extension}`, mimeType: image.mimeType,
      data: annotatedImageBlob(image), imageReference: object.number, annotation: 'annotation' in image ? image.annotation as DraftFileAttachment['annotation'] : undefined, status: 'selected' };
    return { ...object, payload: { kind: 'file-image', file, contentReference: object.payload.kind !== 'quote' ? object.payload.contentReference : undefined } };
  });
  const editor = findMarkerComposer(key);
  if (editor) { editor.replaceMarkerObjects(objects, { renumber: false }); return; }
  const state = draftMarkerState(draft), transaction = replaceComposerMarkerObjects(state, objects, { renumber: false });
  if (transaction) saveComposerState(key, state.update(transaction).state);
}

export function updateDraftFileAnnotation(key: string, id: string, annotation: ImageAnnotationDocument, image?: { data: string; mimeType: string }) {
  useThreadDraftStore.getState().patch(key, draft => {
    if (draft.pendingInput || draft.firstSend || draft.externalInput || draft.collaboration?.sending || draft.collaboration?.attempts) return {};
    const files = draft.files?.map(file => {
      if (file.id !== id || file.status === 'preparing' || image && file.annotation !== annotation) return file;
      return { ...file, annotation, ...(image ? { data: annotatedImageBlob(image), mimeType: image.mimeType } : {}),
        ...(file.annotation === annotation ? {} : { uploadKey: crypto.randomUUID(), attachment: undefined, preparedScope: undefined, preparationHost: undefined, status: 'selected' as const, error: undefined }) };
    });
    return { files, markerObjects: draft.markerObjects?.map(object => object.payload.kind === 'file-image' && object.payload.file.id === id
      ? { ...object, payload: { ...object.payload, file: files?.find(file => file.id === id) ?? object.payload.file } } : object) };
  });
}

/** Current draft numbers identify their retained originals at the send boundary. */
export function attachmentImageReferences(files: readonly DraftFileAttachment[], attachments: readonly Attachment[]) {
  const entries = files.flatMap((file, index) => file.imageReference === undefined || !attachments[index] ? [] : [[attachments[index]!.ref, file.imageReference] as const]);
  return entries.length ? { attachmentImageReferences: Object.fromEntries(entries) } : {};
}

const preparing = new Map<string, Promise<{ attachment: Attachment; file: DraftFileAttachment }>>();
/** Preparation never submits a partial message. Successful files and failed selections remain retryable. */
export async function prepareThreadFiles(api: ThreadsAPI, identity: ThreadIdentity, draftKey: string,
  files: readonly DraftFileAttachment[], signal?: AbortSignal): Promise<Attachment[]> {
  return prepareDraftFiles(draftKey, files, JSON.stringify([identity.runtime, identity.threadId, identity.branchId]), (file, signal) => api.attachments.upload(identity, { key: file.uploadKey ?? file.id, filename: file.filename, mimeType: file.mimeType, data: file.data }, signal), signal);
}

/** The native and external owners share selection/retry behavior, never authority. */
export async function prepareDraftFiles(draftKey: string, files: readonly DraftFileAttachment[], scope: string,
  upload: (file: DraftFileAttachment, signal?: AbortSignal) => Promise<Attachment>, signal?: AbortSignal): Promise<Attachment[]> {
  const host = getRuntimeEndpointGeneration();
  const patch = (id: string, change: Partial<DraftFileAttachment>) => useThreadDraftStore.getState().patch(draftKey,
    draft => {
      const files = draft.files?.map(file => file.id === id ? { ...file, ...change } : file);
      return { files, markerObjects: draft.markerObjects?.map(object => object.payload.kind === 'file-image' && object.payload.file.id === id ? { ...object, payload: { ...object.payload, file: files?.find(file => file.id === id) ?? object.payload.file } } : object) };
    });
  const attachments: Attachment[] = [];
  for (const selected of files) {
    signal?.throwIfAborted();
    if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing attachments');
    const file = useThreadDraftStore.getState().drafts[draftKey]?.files?.find(file => file.id === selected.id) ?? selected;
    if (file.attachment && file.preparedScope === scope && file.preparationHost === host) { attachments.push(file.attachment); continue; }
    const key = JSON.stringify([host, scope, file.uploadKey ?? file.id]);
    let pending = preparing.get(key);
    if (!pending) {
      patch(file.id, { status: 'preparing', error: undefined });
      pending = Promise.resolve().then(async () => {
        if (!file.annotation) return { attachment: await upload(file, signal), file };
        const image = await flattenAnnotations(file.annotation);
        signal?.throwIfAborted();
        if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing attachments');
        const prepared = { ...file, data: annotatedImageBlob(image), mimeType: image.mimeType,
          filename: image.mimeType === 'image/png' ? file.filename.replace(/\.[^.]+$/, '') + '.png' : file.filename };
        return { attachment: await upload(prepared, signal), file: prepared };
      });
      preparing.set(key, pending);
      void pending.finally(() => { if (preparing.get(key) === pending) preparing.delete(key); }).catch(() => {});
    }
    try {
      const prepared = await pending, { attachment } = prepared;
      if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing attachments');
      signal?.throwIfAborted();
      if (!isAttachment(attachment)) throw new Error('The original attachment was not retained. Retry preparation.');
      patch(file.id, { status: 'ready', attachment, data: prepared.file.data, mimeType: prepared.file.mimeType, filename: prepared.file.filename,
        preparedScope: scope, preparationHost: host, error: undefined });
      attachments.push(attachment);
    } catch (failure) {
      const error = failure instanceof Error ? failure.message : String(failure);
      patch(file.id, { status: 'failed', error });
      throw new Error(`${file.filename}: ${error}`, { cause: failure });
    }
  }
  return attachments;
}

export function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3;
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

