import { getRuntimeEndpointGeneration, readThreadMedia, type ThreadsAPI } from '@varin/application-client';
import type { ImageAttachment } from '@varin/protocol';
import { useThreadDraftStore, type ThreadDraft } from '@/stores/useThreadDraftStore';
import { convertDraftImagesToFiles } from './fileAttachments';
import { prepareAnnotatedImages } from '@/lib/images/annotations';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';

type ImageDraft = Pick<ThreadDraft, 'images' | 'markerObjects'>;
type Reader = Pick<ThreadsAPI, 'mediaRead'>;
/** Inline media includes copied queued images, even before their bytes are materialized. */
export const hasDraftInlineImages = (draft: ImageDraft) => Boolean(draft.images.length || draft.markerObjects?.some(object => object.payload.kind === 'stored-image'));
const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
};
/** Resolve only explicitly bound original holders. No source path, active conversation or
 * displayed marker text can replace the retained holder, media digest or part identity. */
export async function prepareDraftMarkerImages(draft: ImageDraft, nativeReader?: Reader): Promise<ImageAttachment[]> {
  const host = getRuntimeEndpointGeneration();
  const originals = [...draft.images];
  const stored = (draft.markerObjects ?? []).flatMap(object => object.payload.kind === 'stored-image'
    ? [{ id: object.id, host: object.host, number: object.number, payload: structuredClone(object.payload) }] : []);
  const assertHost = () => { if (host !== getRuntimeEndpointGeneration() || stored.some(object => object.host !== host)) throw new Error('Application Host changed while preparing original images'); };
  assertHost();
  const reader = nativeReader ?? getRegisteredRuntimeAPIs()?.threads;
  if (stored.length && !reader?.mediaRead) throw new Error('The original image reader is unavailable. The draft is unchanged.');
  const images = await prepareAnnotatedImages(originals);
  for (const object of stored) {
    assertHost();
    if (images.some(image => image.reference === object.number)) throw new Error('Two different images have the same marker number. Remove and reinsert the affected image.');
    const { identity, holder, partIndex, media } = object.payload;
    const bytes = await readThreadMedia(reader!, { ...identity, holder, partIndex }, media);
    assertHost();
    images.push({ mimeType: media.media_type, data: base64(bytes), reference: object.number });
  }
  assertHost();
  return images;
}

/** The explicit file-only fallback also works for retained queued media. Preparation
 * does not alter the draft; one existing marker transaction replaces its objects. */
export async function convertDraftMarkerImagesToFiles(key: string, expectedHost = getRuntimeEndpointGeneration(), nativeReader?: Reader): Promise<void> {
  if (expectedHost !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while preparing attachments');
  const draft = useThreadDraftStore.getState().drafts[key];
  if (!draft || draft.pendingInput || draft.firstSend || draft.externalInput || draft.collaboration?.sending || draft.collaboration?.attempts) return;
  const stored = draft.markerObjects?.filter(object => object.payload.kind === 'stored-image') ?? [];
  if (!stored.length) { convertDraftImagesToFiles(key, expectedHost); return; }
  const images = await prepareDraftMarkerImages({ images: [], markerObjects: stored }, nativeReader);
  const current = useThreadDraftStore.getState().drafts[key];
  if (!current || current.markerObjects !== draft.markerObjects || current.images !== draft.images) throw new Error('The draft images changed while reading the original. Try the file conversion again.');
  convertDraftImagesToFiles(key, expectedHost, new Map(stored.map((object, index) => [object.id, images[index]!]))) ;
}
