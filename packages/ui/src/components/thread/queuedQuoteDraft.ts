import { getRuntimeEndpointGeneration, type ContentReference, type ContentReferenceOccurrence, type ThreadIdentity } from '@varin/application-client';
import type { Attachment, QueuedInput } from '@varin/protocol';
import { inputParts, inputText } from '@/lib/agent-runtime/thread-content';
import { restoreDraftReferences, imageMarkerLabel } from '@/lib/agent-editor/contentReferences';
import type { ComposerMarkerObject } from '@/components/chat/composer/editor/markers';
import type { ComposerReference } from '@/components/chat/composer/editor/references';

export function queuedQuoteDraft(input: QueuedInput, identity: ThreadIdentity) {
  const text = inputText(input.content), host = getRuntimeEndpointGeneration();
  const content = typeof input.content === 'object' && input.content ? input.content as { contentReferences?: ContentReference[]; contentReferenceOccurrences?: ContentReferenceOccurrence[]; fileAttachments?: Attachment[]; attachmentImageReferences?: Record<string, number> } : {};
  const restored = restoreDraftReferences({ identity, editorText: text, editorContentReferences: content.contentReferences, editorAttachments: content.fileAttachments, editorAttachmentImageReferences: content.attachmentImageReferences });
  const objects: ComposerMarkerObject[] = [...(restored.markerObjects ?? [])];
  for (const part of inputParts(input.content)) if (part.kind === 'media') {
    const number = part.imageReference ?? part.partIndex + 1;
    if (objects.some(object => object.kind === 'image' && object.number === number)) continue;
    const reference = content.contentReferences?.find(reference => reference.imageReference === number);
    objects.push({ id: reference?.ref ?? `queued-image:${input.id}:${part.partIndex}`, kind: 'image', number, label: imageMarkerLabel(number), host,
      sourceLabel: reference?.label ?? reference?.title, payload: { kind: 'stored-image', media: part.media, identity, holder: { kind: 'input', inputId: input.id, expectedRevision: input.revision }, partIndex: part.partIndex, contentReference: reference } });
  }
  const references: ComposerReference[] = (content.contentReferenceOccurrences ?? []).flatMap(occurrence => {
    const object = occurrence.kind === 'content' ? objects.find(object => object.id === occurrence.ref) : objects.find(object => object.kind === 'image' && object.number === occurrence.reference);
    return !object || occurrence.start < 0 || occurrence.end > text.length || occurrence.start >= occurrence.end ? [] : [{ id: crypto.randomUUID(), from: occurrence.start, to: occurrence.end, text: text.slice(occurrence.start, occurrence.end), host,
      target: object.kind === 'quote' ? { kind: 'quote' as const, quoteId: object.id } : { kind: 'image' as const, imageId: object.id } }];
  });
  return { text, references, markerObjects: objects };
}

/** Inline media can be replaced while durable file attachments keep their separate owner. */
export const queuedMediaObjects = (objects: readonly ComposerMarkerObject[]) => objects.filter(object => object.kind === 'image' && object.payload.kind !== 'attachment-image');

export function replaceQueuedMedia(objects: readonly ComposerMarkerObject[], images: readonly import('@varin/protocol').ImageAttachment[]): ComposerMarkerObject[] {
  const originals = queuedMediaObjects(objects), host = getRuntimeEndpointGeneration();
  return [...objects.filter(object => !originals.includes(object)), ...images.map((image, index): ComposerMarkerObject => {
    const number = image.reference ?? originals[index]?.number ?? Math.max(0, ...objects.filter(object => object.kind === 'image').map(object => object.number)) + index + 1;
    const previous = originals.find(object => object.number === number), id = previous?.id ?? crypto.randomUUID();
    // An explicitly replaced picture is new user material, not the old source's frozen image.
    return { id, kind: 'image', number, label: previous?.label ?? imageMarkerLabel(number), host, payload: { kind: 'image', image: { ...image, draftId: id, reference: number } } };
  })];
}

/** Text-only editing reuses the original receipt without reading bytes. Only a changed set
 * materializes retained media, using each object's exact original holder and part identity. */
export async function prepareQueuedImages(api: Pick<import('@varin/application-client').ThreadsAPI, 'mediaRead'>, original: readonly ComposerMarkerObject[], current: readonly ComposerMarkerObject[]): Promise<import('@varin/protocol').ImageAttachment[] | undefined> {
  const before = queuedMediaObjects(original), after = queuedMediaObjects(current);
  if (before.length === after.length && before.every((object, index) => object === after[index] || JSON.stringify(object) === JSON.stringify(after[index]))) return undefined;
  const { readThreadMedia } = await import('@varin/application-client');
  const { flattenAnnotations } = await import('@/lib/images/annotations');
  const host = getRuntimeEndpointGeneration();
  const base64 = (bytes: Uint8Array) => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    return btoa(binary);
  };
  const images: import('@varin/protocol').ImageAttachment[] = [];
  for (const object of after) {
    if (host !== getRuntimeEndpointGeneration() || object.host !== host) throw new Error('Application Host changed while preparing queued images');
    const payload = object.payload;
    if (payload.kind === 'image') {
      const image = payload.image.annotation ? await flattenAnnotations(payload.image.annotation) : payload.image;
      images.push({ mimeType: image.mimeType, data: image.data, reference: object.number });
    } else if (payload.kind === 'stored-image') {
      const bytes = await readThreadMedia(api, { ...payload.identity, holder: payload.holder, partIndex: payload.partIndex }, payload.media);
      images.push({ mimeType: payload.media.media_type, data: base64(bytes), reference: object.number });
    } else if (payload.kind === 'file-image') {
      const image = payload.file.annotation ? await flattenAnnotations(payload.file.annotation) : { mimeType: payload.file.mimeType, data: base64(new Uint8Array(await payload.file.data.arrayBuffer())) };
      images.push({ mimeType: image.mimeType, data: image.data, reference: object.number });
    }
  }
  if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing queued images');
  return images;
}

/** Queue edits can retain existing attachment descriptors, but this API does not import a
 * new file attachment. Reject such clipboard objects before changing editor state. */
export function queuedMarkerPasteError(input: QueuedInput, objects: readonly ComposerMarkerObject[]): string | undefined {
  const attachments = new Set(inputParts(input.content).flatMap(part => part.kind === 'attachment' ? [part.attachment.ref] : []));
  for (const object of objects) {
    if (object.payload.kind === 'attachment-image' && !attachments.has(object.payload.attachment.ref)) return 'This queued input cannot import another file attachment. Add it to the main composer instead.';
    const reference = object.payload.kind === 'quote' ? object.payload.reference : object.payload.contentReference;
    if (reference?.attachmentRef && !attachments.has(reference.attachmentRef) || reference?.attachment && (!('ref' in reference.attachment) || !reference.attachment.ref || !attachments.has(reference.attachment.ref))) {
      return 'This queued input cannot import another file attachment. Add it to the main composer instead.';
    }
  }
  return undefined;
}
