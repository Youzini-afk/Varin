import { ChangeSet } from '@codemirror/state';
import { nextImageReference, renumberDraftImages } from '@/lib/images/references';
import type { ImageAttachment } from '@varin/protocol';
import { getRuntimeEndpointGeneration, type ContentReference } from '@varin/application-client';
import { fileToBase64 } from './fileAttachments';
import type { ComposerEditorHandle } from './editor/ComposerEditor';
import { useThreadDraftStore, EMPTY_THREAD_DRAFT } from '@/stores/useThreadDraftStore';
import { removeDraftMarker, saveComposerState, draftMarkerState, imageMarkerLabel } from '@/lib/agent-editor/contentReferences';
import { insertComposerMarker, type ComposerMarkerObject } from './editor/markers';
import { findMarkerComposer } from './editor/markerComposerRegistry';
import { ComposerClosedError } from './editor/interactionRanges';
import { draftImageMarkerObjects } from '@/lib/images/references';

export const imageAttachmentUrl = (attachment: ImageAttachment): string => `data:${attachment.mimeType};base64,${attachment.data}`;
/** Shared browser ingestion; the active conversation transport owns durable acceptance. */
export const fileToImageAttachment = async (file: File): Promise<ImageAttachment> => ({ data: await fileToBase64(file), mimeType: file.type || 'application/octet-stream' });

/** Old attachments reserve numbers, but their similarly spelled text is never guessed into a binding. */
export function ensureDraftImageMarkers(key: string, label = imageMarkerLabel) {
  const store = useThreadDraftStore.getState(), draft = store.drafts[key] ?? EMPTY_THREAD_DRAFT;
  const objects = draftImageMarkerObjects(draft, label);
  if (objects.length === (draft.markerObjects?.length ?? 0) && objects.every((object, index) => object === draft.markerObjects?.[index])) return;
  const editor = findMarkerComposer(key);
  if (editor) { editor.replaceMarkerObjects(objects, { renumber: false, addToHistory: false }); return; }
  store.patch(key, { markerObjects: objects, images: objects.flatMap(object => object.payload.kind === 'image' ? [object.payload.image] : []),
    editorState: undefined });
}

/** Retain the original insertion anchor through async reads, IME and conversation navigation. */
export function beginImageInsertion(key: string, editor: ComposerEditorHandle | null, label: (number: number) => string) {
  ensureDraftImageMarkers(key, label);
  const anchor = editor?.captureMarkerInsertion();
  const host = getRuntimeEndpointGeneration();
  let active = true;
  const initial = useThreadDraftStore.getState().drafts[key];
  let cursor = editor?.getEditorState()?.selection.main.head ?? initial?.editorState?.selection.main.head ?? initial?.text.length ?? 0;
  const unsubscribe = useThreadDraftStore.subscribe((state, previous) => {
    const before = previous.drafts[key]?.text ?? '', after = state.drafts[key]?.text ?? '';
    if (before === after) return;
    let from = 0, to = before.length, end = after.length;
    while (from < to && from < end && before[from] === after[from]) from++;
    while (to > from && end > from && before[to - 1] === after[end - 1]) { to--; end--; }
    cursor = ChangeSet.of({ from, to, insert: after.slice(from, end) }, before.length).mapPos(cursor, 1);
  });
  const pending: Promise<void>[] = [];
  return {
    dispose() { active = false; void Promise.allSettled(pending).then(() => { anchor?.dispose(); unsubscribe(); }); },
    append(image: import('@/lib/images/annotations').EditableImageAttachment, contentReference?: ContentReference) {
      if (!active) return;
      const draft = useThreadDraftStore.getState().drafts[key] ?? EMPTY_THREAD_DRAFT;
      const number = nextImageReference(draft), id = contentReference?.ref ?? crypto.randomUUID();
      const object: ComposerMarkerObject = { id, host, kind: 'image', number, label: label(number), sourceLabel: contentReference?.label ?? contentReference?.title, excerpt: contentReference?.text, payload: { kind: 'image', image: { ...image, draftId: id, reference: number }, contentReference } };
      const insertion = (async () => {
        if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing the image');
        const insertInOriginal = () => {
          const original = useThreadDraftStore.getState().drafts[key] ?? (!initial ? EMPTY_THREAD_DRAFT : undefined);
          if (!original) return;
          const state = draftMarkerState(original);
          saveComposerState(key, state.update(insertComposerMarker(state, object, cursor)).state);
        };
        if (!anchor) { insertInOriginal(); return; }
        try { await anchor.insertMarker(object); }
        catch (error) {
          if (!(error instanceof ComposerClosedError)) throw error;
          if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing the image');
          insertInOriginal();
        }
      })();
      // Original draft keeps a nearby failure if preparation outlives its view.
      pending.push(insertion.catch(error => { useThreadDraftStore.getState().patch(key, { sendError: error instanceof Error ? error.message : String(error) }); }));
      return insertion;
    },
  };
}

export function removeDraftImage(key: string, index: number) {
  ensureDraftImageMarkers(key);
  const draft = useThreadDraftStore.getState().drafts[key];
  const image = draft?.images[index];
  if (!draft || !image) return;
  const object = draft.markerObjects?.find(object => object.payload.kind === 'image' && (object.payload.image === image || object.id === image.draftId));
  if (object) removeDraftMarker(key, object.id);
  else useThreadDraftStore.getState().patch(key, renumberDraftImages(draft, { images: draft.images.filter((_, i) => i !== index), files: draft.files }));
}

export function updateDraftImage(key: string, index: number, image: import('@/lib/images/annotations').EditableImageAttachment) {
  useThreadDraftStore.getState().patch(key, draft => {
    const old = draft.images[index];
    if (draft.pendingInput || draft.firstSend || !old) return {};
    const updated = { ...image, draftId: old.draftId, reference: old.reference };
    return { images: draft.images.map((current, i) => i === index ? updated : current),
      markerObjects: draft.markerObjects?.map(object => object.payload.kind === 'image' && (object.payload.image === old || object.id === old.draftId) ? { ...object, payload: { ...object.payload, image: updated } } : object) };
  });
}
