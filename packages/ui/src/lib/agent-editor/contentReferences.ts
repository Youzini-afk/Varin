import { ChangeSet, EditorState, Transaction } from '@codemirror/state';
import { getRuntimeEndpointGeneration, type ContentReference, type ContentReferenceInput, type ContentReferenceOccurrence } from '@varin/application-client';
import { createComposerMarkerState, insertComposerMarker, composerMarkerObjects, setComposerMarkerObjects, replaceComposerMarkerObjects, type ComposerMarkerObject } from '@/components/chat/composer/editor/markers';
import { composerReferences, setComposerReferences, composerMarkerObjectId, isComposerMarker, mapComposerReferences, type ComposerReference } from '@/components/chat/composer/editor/references';
import { interactionRanges, setInteractionRanges, ComposerClosedError, mapInteractionRanges, type InteractionRange } from '@/components/chat/composer/editor/interactionRanges';
import { findMarkerComposer } from '@/components/chat/composer/editor/markerComposerRegistry';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore, type ThreadDraft, type DraftSelectedAttachment } from '@/stores/useThreadDraftStore';
import { formatMessage, useI18nStore } from '@/lib/i18n';

export const contentMarkerLabel = (number: number) => `[${formatMessage(useI18nStore.getState().dictionary, 'ui.content.reference', { number })}]`;
export const imageMarkerLabel = (number: number) => formatMessage(useI18nStore.getState().dictionary, 'chat.imageReference.token', { number });
export function contentReferenceLabel(reference: ContentReference): string {
  if (reference.label) return reference.label;
  const source = reference.source;
  if (source.kind === 'chat') return source.role === 'user' ? 'User' : source.role === 'tool' ? 'Tool' : 'Varin';
  return reference.title;
}
export function referenceMarkerObject(reference: ContentReference): ComposerMarkerObject {
  const host = getRuntimeEndpointGeneration();
  return reference.image ? { id: reference.ref, kind: 'image', number: reference.imageReference ?? 1, label: imageMarkerLabel(reference.imageReference ?? 1), host,
    sourceLabel: contentReferenceLabel(reference), excerpt: reference.text, payload: { kind: 'image', image: { ...reference.image, reference: reference.imageReference }, contentReference: reference } }
    : { id: reference.ref, kind: 'quote', number: reference.number ?? 1, label: contentMarkerLabel(reference.number ?? 1), host,
      sourceLabel: contentReferenceLabel(reference), excerpt: reference.text, payload: { kind: 'quote', reference } };
}
/** Only the editor transaction owns marker payloads; ordinary non-marker files remain untouched. */
export function composerDraftChange(draft: ThreadDraft, text: string, references?: readonly ComposerReference[], interactions?: readonly InteractionRange[], markerObjects?: readonly ComposerMarkerObject[]): Partial<ThreadDraft> {
  if (!markerObjects) return { text, references, interactions };
  const before = draft.markerObjects ?? [];
  const imageObjects = markerObjects.filter(object => object.payload.kind === 'image');
  const nextImages = imageObjects.flatMap(object => object.payload.kind === 'image' ? [object.payload.image] : []);
  const seenImages = new Set<typeof nextImages[number]>();
  const images = draft.images.flatMap(image => {
    const old = before.find(object => object.payload.kind === 'image' && (object.payload.image === image || image.draftId && object.id === image.draftId));
    const current = imageObjects.find(object => object.payload.kind === 'image' && (object.payload.image === image || object.id === (old?.id ?? image.draftId)));
    if (current?.payload.kind === 'image') { seenImages.add(current.payload.image); return [current.payload.image]; }
    return old ? [] : [image];
  });
  images.push(...nextImages.filter(image => !seenImages.has(image)));
  const nextFiles = markerObjects.flatMap(object => object.payload.kind === 'file-image' ? [object.payload.file] : []);
  const previousFileIds = new Set(before.flatMap(object => object.payload.kind === 'file-image' ? [object.payload.file.id] : []));
  const files = (draft.files ?? []).flatMap(file => { const current = nextFiles.find(next => next.id === file.id); return current ? [current] : previousFileIds.has(file.id) ? [] : [file]; });
  files.push(...nextFiles.filter(file => !files.some(current => current.id === file.id)));
  const nextAttachments = markerObjects.flatMap(object => object.payload.kind === 'attachment-image' ? [{ id: object.id, host: object.host, filename: object.payload.attachment.filename, selection: { ref: object.payload.attachment.ref }, attachment: object.payload.attachment }] : []);
  const previousAttachmentRefs = new Set(before.flatMap(object => object.payload.kind === 'attachment-image' ? [object.payload.attachment.ref] : []));
  const selectedAttachments = (draft.selectedAttachments ?? []).flatMap<DraftSelectedAttachment>(file => { const current = nextAttachments.find(next => next.selection.ref === file.selection.ref); return current ? [current] : previousAttachmentRefs.has(file.selection.ref!) ? [] : [file]; });
  selectedAttachments.push(...nextAttachments.filter(file => !selectedAttachments.some(current => current.selection.ref === file.selection.ref)));
  return { text, references, interactions, markerObjects, images, files, selectedAttachments };
}
export function saveComposerState(key: string, state: EditorState) {
  useThreadDraftStore.getState().patch(key, draft => draft.text === state.doc.toString() && draft.references === state.field(composerReferences) && draft.interactions === state.field(interactionRanges) && draft.markerObjects === state.field(composerMarkerObjects)
    ? { editorState: state } : { ...composerDraftChange(draft, state.doc.toString(), state.field(composerReferences), state.field(interactionRanges), state.field(composerMarkerObjects)), editorState: state });
}
export function draftMarkerState(draft: ThreadDraft): EditorState {
  const state = draft.editorState;
  if (!state) return createComposerMarkerState({ text: draft.text, references: draft.references, interactions: draft.interactions, markerObjects: draft.markerObjects });
  const before = state.doc.toString();
  if (before === draft.text && state.field(composerReferences) === draft.references && state.field(composerMarkerObjects) === draft.markerObjects && state.field(interactionRanges) === draft.interactions) return state;
  let from = 0, to = before.length, end = draft.text.length;
  while (from < to && from < end && before[from] === draft.text[from]) from++;
  while (to > from && end > from && before[to - 1] === draft.text[end - 1]) { to--; end--; }
  return state.update({ changes: before === draft.text ? [] : { from, to, insert: draft.text.slice(from, end) },
    effects: [setComposerReferences.of(draft.references ?? []), setComposerMarkerObjects.of(draft.markerObjects ?? []), setInteractionRanges.of(draft.interactions ?? [])],
    annotations: Transaction.addToHistory.of(before !== draft.text), filter: false }).state;
}
export async function insertDraftMarker(key: string, object: ComposerMarkerObject): Promise<void> {
  const editor = findMarkerComposer(key);
  try { if (editor) { await editor.insertMarker(object); return; } }
  catch (error) {
    if (!(error instanceof ComposerClosedError)) throw error;
    const draft = useThreadDraftStore.getState().drafts[key];
    if (!draft) return;
    saveComposerState(key, draftMarkerState(draft).update(insertComposerMarker(draftMarkerState(draft), object, error.cursor)).state); return;
  }
  const draft = useThreadDraftStore.getState().drafts[key] ?? EMPTY_THREAD_DRAFT;
  const state = draftMarkerState(draft);
  saveComposerState(key, state.update(insertComposerMarker(state, object, state.doc.length)).state);
}
export function removeDraftMarker(key: string, id: string) {
  const editor = findMarkerComposer(key);
  if (editor) { editor.removeMarkerObject(id); return; }
  const draft = useThreadDraftStore.getState().drafts[key]; if (!draft) return;
  const state = draftMarkerState(draft), spec = replaceComposerMarkerObjects(state, (draft.markerObjects ?? []).filter(object => object.id !== id));
  if (spec) saveComposerState(key, state.update(spec).state);
}
/** Freeze explicit relations before any async preparation; never infer identity from label text. */
export function freezeDraftContentReferences(draft: Pick<ThreadDraft, 'text' | 'references' | 'markerObjects'>): ContentReferenceInput {
  const objects = draft.markerObjects ?? [], byId = new Map(objects.map(object => [object.id, object]));
  const contentReferences = objects.flatMap<ContentReference>(object => {
    if (object.host !== getRuntimeEndpointGeneration()) throw new Error('The referenced content belongs to a different Host. Select it again.');
    if (object.payload.kind === 'quote') return [{ ...object.payload.reference, number: object.number }];
    if (object.payload.contentReference) {
      const { image: _capturedImage, ...reference } = object.payload.contentReference;
      // An edited image's source stays navigable, but its unredacted file is not another sent material.
      const edited = object.payload.kind === 'image' ? object.payload.image.annotation : object.payload.kind === 'file-image' ? object.payload.file.annotation : undefined;
      if (edited) { delete reference.attachment; delete reference.attachmentRef; }
      return [{ ...reference, imageReference: object.number }];
    }
    if (object.payload.kind === 'attachment-image' && object.payload.identity) return [{ ref: object.id, title: object.payload.attachment.filename, imageReference: object.number,
      attachment: { ref: object.payload.attachment.ref }, source: { kind: 'chat', thread: object.payload.identity, passages: [] } }];
    return [];
  });
  const contentReferenceOccurrences: ContentReferenceOccurrence[] = [];
  for (const occurrence of draft.references ?? []) {
    if (!isComposerMarker(occurrence) || draft.text.slice(occurrence.from, occurrence.to) !== occurrence.text) continue;
    const object = byId.get(composerMarkerObjectId(occurrence)!);
    if (!object) throw new Error('The referenced content is missing. Remove this marker or select the content again.');
    if (occurrence.host !== object.host) throw new Error('The referenced content belongs to another Host. Select it again.');
    contentReferenceOccurrences.push(object.kind === 'quote' ? { kind: 'content', ref: object.id, start: occurrence.from, end: occurrence.to } : { kind: 'image', reference: object.number, start: occurrence.from, end: occurrence.to });
  }
  return { contentReferences, contentReferenceOccurrences };
}
/** Success only consumes frozen objects. Newly inserted content survives receipt races. */
export function acknowledgeDraftMarkers(draft: ThreadDraft, editorText: string, ids: readonly string[] = [], occurrences: readonly string[] = [], receipt?: { images?: readonly import('@varin/protocol').ImageAttachment[]; fileIds?: readonly string[]; selectedAttachmentIds?: readonly string[] }): Partial<ThreadDraft> {
  const consumed = new Set(ids), received = new Set(occurrences);
  const complete = draft.text === editorText && (draft.references ?? []).filter(isComposerMarker).every(reference => received.has(reference.id));
  const edits = complete ? [{ from: 0, to: draft.text.length, insert: '' }] : (draft.references ?? []).filter(reference => received.has(reference.id) && isComposerMarker(reference) && draft.text.slice(reference.from, reference.to) === reference.text).map(reference => ({ from: reference.from, to: reference.to, insert: '' }));
  const changes = ChangeSet.of(edits, draft.text.length);
  const references = complete ? [] : mapComposerReferences(draft.references ?? [], changes);
  const remaining = new Set(references.filter(isComposerMarker).map(composerMarkerObjectId));
  const markerObjects = (draft.markerObjects ?? []).filter(object => !consumed.has(object.id) || remaining.has(object.id));
  return { text: changes.apply(EditorState.create({ doc: draft.text }).doc).toString(), references, markerObjects,
    interactions: complete ? [] : mapInteractionRanges(draft.interactions ?? [], changes), editorState: undefined,
    retainedContentReferences: markerObjects.flatMap(object => { const reference = object.payload.kind === 'quote' ? object.payload.reference : object.payload.contentReference; return reference ? [reference] : []; }),
    ...(receipt?.images ? { images: draft.images.filter(image => !receipt.images!.includes(image) || markerObjects.some(object => object.payload.kind === 'image' && object.payload.image === image)) } : {}),
    ...(receipt?.fileIds ? { files: draft.files?.filter(file => !receipt.fileIds!.includes(file.id) || markerObjects.some(object => object.payload.kind === 'file-image' && object.payload.file.id === file.id)) } : {}),
    ...(receipt?.selectedAttachmentIds ? { selectedAttachments: draft.selectedAttachments?.filter(file => !receipt.selectedAttachmentIds!.includes(file.id) || markerObjects.some(object => object.payload.kind === 'attachment-image' && object.payload.attachment.ref === file.selection.ref)) } : {}) };
}

export function insertDraftMarkerAt(key: string, object: ComposerMarkerObject, cursor: number) {
  const draft = useThreadDraftStore.getState().drafts[key]; if (!draft) return;
  const state = draftMarkerState(draft);
  saveComposerState(key, state.update(insertComposerMarker(state, object, cursor)).state);
}

/** Restore only the accepted fixed content, never reinterpret current source paths. */
export function restoreDraftReferences(input: { identity?: import('@varin/application-client').ThreadIdentity; editorText?: string; editorImages?: import('@varin/protocol').ImageAttachment[]; editorContentReferences?: ContentReference[]; editorContentReferenceOccurrences?: ContentReferenceOccurrence[]; editorAttachments?: import('@varin/protocol').Attachment[]; editorAttachmentImageReferences?: Record<string, number> }): Partial<ThreadDraft> {
  if (input.editorText === undefined) return {};
  const text = input.editorText, host = getRuntimeEndpointGeneration();
  const objects: ComposerMarkerObject[] = [];
  const content = (input.editorContentReferences ?? []).map(reference => reference.attachmentRef ? { ...reference, attachment: { ref: reference.attachmentRef } } : reference);
  for (const reference of content.filter(reference => reference.imageReference === undefined)) objects.push({ ...referenceMarkerObject(reference), attachmentOwner: reference.attachment ? input.identity : undefined });
  for (const [index, image] of (input.editorImages ?? []).entries()) {
    const number = image.reference ?? index + 1, reference = content.find(reference => reference.imageReference === number);
    objects.push({ id: reference?.ref ?? crypto.randomUUID(), kind: 'image', number, label: imageMarkerLabel(number), host, sourceLabel: reference && contentReferenceLabel(reference), payload: { kind: 'image', image, contentReference: reference } });
  }
  for (const reference of content.filter(reference => reference.imageReference !== undefined)) {
    if (objects.some(object => object.id === reference.ref)) continue;
    const attachment = input.editorAttachments?.find(attachment => attachment.ref === reference.attachmentRef || reference.attachment && 'ref' in reference.attachment && attachment.ref === reference.attachment.ref);
    if (attachment) objects.push({ id: reference.ref, kind: 'image', number: reference.imageReference!, label: imageMarkerLabel(reference.imageReference!), host,
      sourceLabel: contentReferenceLabel(reference), payload: { kind: 'attachment-image', attachment, identity: input.identity, contentReference: reference } });
  }
  for (const attachment of input.editorAttachments ?? []) {
    const number = input.editorAttachmentImageReferences?.[attachment.ref];
    if (number === undefined || objects.some(object => object.kind === 'image' && object.number === number)) continue;
    objects.push({ id: attachment.ref, kind: 'image', number, label: imageMarkerLabel(number), host, sourceLabel: attachment.filename, payload: { kind: 'attachment-image', attachment, identity: input.identity } });
  }
  const references = (input.editorContentReferenceOccurrences ?? []).flatMap(occurrence => {
    const object = occurrence.kind === 'content' ? objects.find(object => object.id === occurrence.ref) : objects.find(object => object.kind === 'image' && object.number === occurrence.reference);
    if (!object || occurrence.start < 0 || occurrence.end > text.length || occurrence.end <= occurrence.start) return [];
    return [{ id: crypto.randomUUID(), host, from: occurrence.start, to: occurrence.end, text: text.slice(occurrence.start, occurrence.end), target: object.kind === 'quote' ? { kind: 'quote' as const, quoteId: object.id } : { kind: 'image' as const, imageId: object.id } }];
  });
  return { text, images: input.editorImages ?? [], markerObjects: objects.map(object => ({ ...object, attachmentOwner: object.attachmentOwner ?? (object.payload.kind === 'attachment-image' || (object.payload.kind === 'quote' ? object.payload.reference.attachment : object.payload.contentReference?.attachment) ? input.identity : undefined) })), references, interactions: [], editorState: undefined, retainedContentReferences: content,
    selectedAttachments: input.editorAttachments?.map(attachment => ({ id: crypto.randomUUID(), host, filename: attachment.filename, selection: { ref: attachment.ref }, attachment })) };
}

/** Retained original file images keep their accepted number when restored or pasted. */
export function draftAttachmentImageReferences(draft: Pick<ThreadDraft, 'markerObjects'>): Record<string, number> {
  return Object.fromEntries((draft.markerObjects ?? []).flatMap(object => object.payload.kind === 'attachment-image' ? [[object.payload.attachment.ref, object.number]] : []));
}
