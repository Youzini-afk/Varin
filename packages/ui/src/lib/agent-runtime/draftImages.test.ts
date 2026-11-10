import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { undo } from '@codemirror/commands';
import type { QueuedInput, StoredMedia, MediaReadChunk } from '@varin/protocol';
import type { RuntimeAPIs, ThreadsAPI } from '@varin/application-client';
import { queuedQuoteDraft } from '@/components/thread/queuedQuoteDraft';
import { insertDraftMarker, freezeDraftContentReferences, saveComposerState } from '@/lib/agent-editor/contentReferences';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { useThreadDraftStore, type ThreadFirstSend } from '@/stores/useThreadDraftStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { sendThreadDraft } from './sendThreadDraft';
import { prepareDraftMarkerImages, hasDraftInlineImages, convertDraftMarkerImagesToFiles } from './draftImages';

const endpoint = vi.hoisted(() => ({ generation: 1 }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => endpoint.generation }));
const owner = { runtime: 'agent' as const, threadId: 'original-owner', branchId: 'original-branch' };
const target = { runtime: 'agent' as const, threadId: 'target-thread', branchId: 'target-branch' };
const media: StoredMedia = { media_type: 'image/png', content_ref: { content_object: 'retained-original' }, source: { kind: 'operation', operation_id: 'original-capture' } };
const queue = { id: 'queued-input', revision: 7, thread_id: owner.threadId, branch_id: owner.branchId, run_id: 'run', state: 'queued', mode: 'boundary', cursor: 1,
  content: { text: '[Image 9]', imageReferences: [9], attachments: [media], contentReferenceOccurrences: [{ kind: 'image', reference: 9, start: 0, end: 9 }] } } as unknown as QueuedInput;
const key = 'destination-draft';
function reader() {
  return vi.fn<ThreadsAPI['mediaRead']>(async input => ({ media, partIndex: input.partIndex, chunkIndex: input.chunkIndex, chunkCount: 1, totalBytes: 3, bytesBase64: 'AQID' }));
}
async function copyQueuedImage() {
  const restored = queuedQuoteDraft(queue, owner);
  useThreadDraftStore.getState().patch(key, { text: 'Discuss 🧭 ' });
  // Internal paste imports this exact retained object and creates a new local occurrence.
  await insertDraftMarker(key, restored.markerObjects[0]!);
  return useThreadDraftStore.getState().drafts[key];
}
beforeEach(() => { endpoint.generation = 1; useThreadDraftStore.setState({ drafts: {} }); });
afterEach(() => { vi.restoreAllMocks(); registerRuntimeAPIs(null); });
it('sends a queued image copied into a first-message draft through its exact original holder', async () => {
  const draft = await copyQueuedImage(), mediaRead = reader();
  const submit = vi.fn(async () => ({ run_id: 'accepted-run', input_id: 'accepted-input' }));
  const api = { mediaRead, submit, attachments: {} } as unknown as ThreadsAPI;
  vi.spyOn(useThreadStore.getState(), 'materializeDraft').mockResolvedValue(target);
  const request: ThreadFirstSend = { key: 'first-stored-image', status: 'sending', text: draft.text, editorText: draft.text,
    images: draft.images, imageObjects: draft.markerObjects, files: [], markerObjectIds: draft.markerObjects?.map(object => object.id), markerOccurrenceIds: draft.references?.map(reference => reference.id),
    ...freezeDraftContentReferences(draft), model: { providerId: 'provider', modelId: 'model', thinkingLevel: 'off' }, editorContext: [], inlineContext: [] };
  expect(hasDraftInlineImages(draft)).toBe(true); expect(draft.images).toEqual([]);
  await sendThreadDraft(api, key, request);
  expect(mediaRead).toHaveBeenCalledWith({ ...owner, holder: { kind: 'input', inputId: queue.id, expectedRevision: 7 }, partIndex: 0, chunkIndex: 0, expectedContentRef: 'retained-original' }, expect.any(AbortSignal));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ ...target, images: [{ mimeType: 'image/png', data: 'AQID', reference: 1 }],
    contentReferenceOccurrences: [{ kind: 'image', reference: 1, start: 'Discuss 🧭 '.length, end: draft.text.length }] }));
  expect(useThreadDraftStore.getState().drafts[key].firstMessageReceipt?.images).toEqual([{ mimeType: 'image/png', data: 'AQID', reference: 1 }]);
  expect(useThreadDraftStore.getState().drafts[key].markerObjects).toEqual([]);
});
it('uses the registered native reader for an external draft, never the target conversation as media owner', async () => {
  const draft = await copyQueuedImage(), mediaRead = reader();
  registerRuntimeAPIs({ threads: { mediaRead } } as unknown as RuntimeAPIs);
  const images = await prepareDraftMarkerImages(draft);
  expect(images).toEqual([{ mimeType: 'image/png', data: 'AQID', reference: 1 }]);
  expect(mediaRead.mock.calls[0]![0].threadId).toBe(owner.threadId);
  expect(mediaRead.mock.calls[0]![0].holder).toEqual({ kind: 'input', inputId: queue.id, expectedRevision: 7 });
  expect(useThreadDraftStore.getState().drafts[key]).toBe(draft);
});
it('rejects a changed original holder or Host without dropping the copied image', async () => {
  const draft = await copyQueuedImage();
  const failed = vi.fn<ThreadsAPI['mediaRead']>().mockRejectedValue(new Error('Original input revision changed'));
  await expect(prepareDraftMarkerImages(draft, { mediaRead: failed })).rejects.toThrow('Original input revision changed');
  expect(useThreadDraftStore.getState().drafts[key]).toBe(draft);
  let resolve!: (chunk: MediaReadChunk) => void;
  const mediaRead = vi.fn<ThreadsAPI['mediaRead']>(() => new Promise(yes => { resolve = yes; }));
  const pending = prepareDraftMarkerImages(draft, { mediaRead });
  await vi.waitFor(() => expect(mediaRead).toHaveBeenCalledOnce());
  const rejected = expect(pending).rejects.toThrow('Host changed');
  endpoint.generation = 2;
  resolve({ media, partIndex: 0, chunkIndex: 0, chunkCount: 1, totalBytes: 3, bytesBase64: 'AQID' });
  await rejected;
  expect(useThreadDraftStore.getState().drafts[key]).toBe(draft);
});
it('converts retained queued media to an ordinary readable file with one reversible marker transaction', async () => {
  const draft = await copyQueuedImage();
  await convertDraftMarkerImagesToFiles(key, 1, { mediaRead: reader() });
  const converted = useThreadDraftStore.getState().drafts[key];
  expect(hasDraftInlineImages(converted)).toBe(false); expect(converted.text).toBe(draft.text);
  expect(converted.markerObjects?.[0]?.payload.kind).toBe('file-image');
  expect([...new Uint8Array(await converted.files![0]!.data.arrayBuffer())]).toEqual([1, 2, 3]);
  let state = converted.editorState!;
  expect(undo({ state, dispatch: transaction => { state = transaction.state; } })).toBe(true);
  saveComposerState(key, state);
  expect(useThreadDraftStore.getState().drafts[key].markerObjects?.[0]?.payload.kind).toBe('stored-image');
  expect(useThreadDraftStore.getState().drafts[key].files).toEqual([]);
});
