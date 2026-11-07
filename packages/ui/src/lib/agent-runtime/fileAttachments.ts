import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import { attachmentMimeType, type Attachment } from '@varin/protocol';
import { isAttachment } from './thread-content';
import { useThreadDraftStore, type DraftFileAttachment } from '@/stores/useThreadDraftStore';
import { flattenAnnotations, type ImageAnnotationDocument } from '@/lib/images/annotations';
import { nextImageReference, renumberDraftImages } from '@/lib/images/references';

/** Picking is not uploading or delivering. Keep the exact original Blob and an idempotent upload key. */
export function selectThreadFiles(draftKey: string, files: readonly File[], insertReference?: (number: number) => void): DraftFileAttachment[] {
  const selected: DraftFileAttachment[] = files.map(file => ({ id: crypto.randomUUID(), filename: file.name,
    mimeType: attachmentMimeType(file.name, file.type === 'application/octet-stream' ? '' : file.type), data: file, status: 'selected' as const }));
  useThreadDraftStore.getState().patch(draftKey, draft => {
    let reference = nextImageReference(draft) - 1;
    for (const file of selected) if (file.mimeType.startsWith('image/')) file.imageReference = ++reference;
    return { files: [...(draft.files ?? []), ...selected] };
  });
  for (const file of selected) if (file.imageReference !== undefined) insertReference?.(file.imageReference);
  return selected;
}

export function removeDraftFile(key: string, id: string) {
  useThreadDraftStore.getState().patch(key, draft => {
    return renumberDraftImages(draft, { images: draft.images, files: draft.files?.filter(file => file.id !== id) });
  });
}

export function annotatedImageBlob(image: { data: string; mimeType: string }): Blob {
  return new Blob([Uint8Array.from(atob(image.data), character => character.charCodeAt(0))], { type: image.mimeType });
}

export function updateDraftFileAnnotation(key: string, id: string, annotation: ImageAnnotationDocument, image?: { data: string; mimeType: string }) {
  useThreadDraftStore.getState().patch(key, draft => {
    if (draft.pendingInput || draft.firstSend || draft.externalInput || draft.collaboration?.sending || draft.collaboration?.attempts) return {};
    return { files: draft.files?.map(file => {
      if (file.id !== id || file.status === 'preparing' || image && file.annotation !== annotation) return file;
      return { ...file, annotation, ...(image ? { data: annotatedImageBlob(image), mimeType: image.mimeType } : {}),
        ...(file.annotation === annotation ? {} : { uploadKey: crypto.randomUUID(), attachment: undefined, preparedScope: undefined, preparationHost: undefined, status: 'selected' as const, error: undefined }) };
    }) };
  });
}

/** Current draft numbers identify their retained originals at the send boundary. */
export function attachmentImageReferences(files: readonly DraftFileAttachment[], attachments: readonly Attachment[]) {
  const entries = files.flatMap((file, index) => file.imageReference === undefined || !attachments[index] ? [] : [[attachments[index]!.ref, file.imageReference] as const]);
  return entries.length ? { attachmentImageReferences: Object.fromEntries(entries) } : {};
}

const preparing = new Map<string, Promise<Attachment>>();
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
    draft => ({ files: draft.files?.map(file => file.id === id ? { ...file, ...change } : file) }));
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
        if (!file.annotation) return upload(file, signal);
        const image = await flattenAnnotations(file.annotation);
        signal?.throwIfAborted();
        if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing attachments');
        return upload({ ...file, data: annotatedImageBlob(image), mimeType: image.mimeType,
          filename: image.mimeType === 'image/png' ? file.filename.replace(/\.[^.]+$/, '') + '.png' : file.filename }, signal);
      });
      preparing.set(key, pending);
      void pending.finally(() => { if (preparing.get(key) === pending) preparing.delete(key); }).catch(() => {});
    }
    try {
      const attachment = await pending;
      if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing attachments');
      signal?.throwIfAborted();
      if (!isAttachment(attachment)) throw new Error('The original attachment was not retained. Retry preparation.');
      patch(file.id, { status: 'ready', attachment, preparedScope: scope, preparationHost: host, error: undefined });
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

