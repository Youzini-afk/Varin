import { beforeEach, expect, it, vi } from 'vitest';
import { selectThreadFiles, prepareDraftFiles, updateDraftFileAnnotation, removeDraftFile, convertDraftImagesToFiles, attachmentImageReferences } from './fileAttachments';
import { undo, redo } from '@codemirror/commands';
import { insertDraftMarker, referenceMarkerObject, freezeDraftContentReferences, saveComposerState } from '@/lib/agent-editor/contentReferences';
import { flattenAnnotations, type ImageAnnotationDocument } from '@/lib/images/annotations';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import type { Attachment } from '@varin/protocol';
const endpoint = vi.hoisted(() => ({ generation: 1 }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => endpoint.generation }));
vi.mock('@/lib/images/annotations', async original => ({ ...await original<typeof import('@/lib/images/annotations')>(), flattenAnnotations: vi.fn() }));
beforeEach(() => { endpoint.generation = 1; useThreadDraftStore.setState({ drafts: {} }); });
const descriptor = (ref: string): Attachment => ({ ref: `attachment:${ref}`, filename: 'same.bin', mimeType: 'application/octet-stream', byteLength: 3 });
it('renumbers file and inline images together after removing an attachment', () => {
  useThreadDraftStore.getState().patch('draft', { text: 'Keep [Image 1]', images: [{ data: 'YQ==', mimeType: 'image/png', reference: 1 }] });
  const selected = selectThreadFiles('draft', [new File(['a'], 'one.PNG'), new File(['pdf'], 'report.pdf'), new File(['b'], 'two.png')]);
  expect(selected.map(file => file.imageReference)).toEqual([2, undefined, 3]);
  removeDraftFile('draft', selected[0]!.id);
  expect(useThreadDraftStore.getState().drafts.draft.text).toBe('Keep [Image 1][Image 2]');
  expect(selectThreadFiles('draft', [new File(['c'], 'three.png')])[0]!.imageReference).toBe(3);
});
it('uploads flattened edited pixels under a fresh upload key and reuses that exact upload on retry', async () => {
  const [original] = selectThreadFiles('draft', [new File(['private original'], 'photo.jpg', { type: 'image/jpeg' })]);
  const upload = vi.fn(async () => descriptor('fixed'));
  await prepareDraftFiles('draft', [original!], 'owner', upload);
  const doc: ImageAnnotationDocument = { source: { data: 'cHJpdmF0ZQ==', mimeType: 'image/jpeg' }, width: 5, height: 5, marks: [], past: [], future: [] };
  updateDraftFileAnnotation('draft', original!.id, doc);
  const edited = useThreadDraftStore.getState().drafts.draft.files![0]!;
  expect(edited.uploadKey).not.toBe(original!.id); expect(edited.attachment).toBeUndefined();
  vi.mocked(flattenAnnotations).mockResolvedValueOnce({ data: btoa('visible pixels'), mimeType: 'image/png' });
  await prepareDraftFiles('draft', [edited], 'owner', upload);
  const sent = (upload.mock.calls[1] as unknown as [typeof edited])[0];
  expect(sent.filename).toBe('photo.png'); expect(await sent.data.text()).toBe('visible pixels');
  expect(await useThreadDraftStore.getState().drafts.draft.files![0]!.data.text()).toBe('visible pixels');
  expect(sent.uploadKey).toBe(edited.uploadKey); expect(sent.imageReference).toBe(1);
  await prepareDraftFiles('draft', [edited], 'owner', upload);
  expect(upload).toHaveBeenCalledTimes(2);
});
it('keeps original binary Blobs and distinct selections for same-named files without reading on selection', async () => {
  const first = new File([new Uint8Array([0, 255, 3])], 'same.bin');
  const second = new File([new Uint8Array([5, 0, 6])], 'same.bin');
  const selected = selectThreadFiles('draft', [first, second]);
  expect(selected[0]!.id).not.toBe(selected[1]!.id);
  const upload = vi.fn(async file => {
    expect(file.data).toBe(file.id === selected[0]!.id ? first : second);
    return descriptor(file.id);
  });
  const result = await prepareDraftFiles('draft', selected, 'owner', upload);
  expect(result.map(file => file.ref)).toEqual(selected.map(file => `attachment:${file.id}`));
  expect(upload).toHaveBeenCalledTimes(2);
  await prepareDraftFiles('draft', selected, 'owner', upload);
  expect(upload).toHaveBeenCalledTimes(2);
});
it('joins concurrent preparation and exposes preparing rather than accepted status', async () => {
  const files = selectThreadFiles('draft', [new File(['abc'], 'same.bin')]);
  let finish!: (value: Attachment) => void;
  const upload = vi.fn(() => new Promise<Attachment>(resolve => { finish = resolve; }));
  const first = prepareDraftFiles('draft', files, 'owner', upload), second = prepareDraftFiles('draft', files, 'owner', upload);
  await Promise.resolve();
  expect(upload).toHaveBeenCalledOnce();
  expect(useThreadDraftStore.getState().drafts.draft.files?.[0]?.status).toBe('preparing');
  finish(descriptor('original'));
  expect(await first).toEqual(await second);
  expect(useThreadDraftStore.getState().drafts.draft.files?.[0]?.status).toBe('ready');
});
it('retains failed selection and original upload key while reusing earlier successful files', async () => {
  const files = selectThreadFiles('draft', [new File(['one'], 'a.zip'), new File(['two'], 'b.zip')]);
  const upload = vi.fn().mockResolvedValueOnce(descriptor('first')).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(descriptor('second'));
  await expect(prepareDraftFiles('draft', files, 'owner', upload)).rejects.toThrow('b.zip: offline');
  expect(useThreadDraftStore.getState().drafts.draft.files?.map(file => file.status)).toEqual(['ready', 'failed']);
  await prepareDraftFiles('draft', files, 'owner', upload);
  expect(upload.mock.calls.map(([file]) => file.id)).toEqual([files[0]!.id, files[1]!.id, files[1]!.id]);
});
it('does not reuse another conversation or Host attachment authority', async () => {
  const files = selectThreadFiles('draft', [new File(['abc'], 'same.bin')]);
  const upload = vi.fn().mockResolvedValue(descriptor('fixed'));
  await prepareDraftFiles('draft', files, 'native', upload);
  await prepareDraftFiles('draft', files, 'external', upload);
  endpoint.generation++;
  await prepareDraftFiles('draft', files, 'external', upload);
  expect(upload).toHaveBeenCalledTimes(3);
});
it('does not mark a malformed upload receipt ready or discard the original file', async () => {
  const files = selectThreadFiles('draft', [new File(['abc'], 'same.bin')]);
  await expect(prepareDraftFiles('draft', files, 'owner', vi.fn().mockResolvedValue({ filename: 'same.bin' }))).rejects.toThrow('was not retained');
  const selected = useThreadDraftStore.getState().drafts.draft.files![0]!;
  expect(selected.status).toBe('failed'); expect(selected.data).toBe(files[0]!.data); expect(selected.attachment).toBeUndefined();
});

it('converts bound images to original readable files in one undo step, preserving positions, source and annotated upload', async () => {
  const key = 'non-vision-draft';
  useThreadDraftStore.getState().patch(key, { text: 'Literal [Image 1]. Discuss ' });
  const object = referenceMarkerObject({ ref: 'fixed-image', title: 'Original image', attachment: { ref: 'attachment:unredacted-original' }, attachmentRef: 'attachment:unredacted-original', image: { data: btoa('original pixels'), mimeType: 'image/jpeg' },
    source: { kind: 'chat', thread: { runtime: 'agent', threadId: 'source', branchId: 'main' }, itemId: 'original-message', passages: [] } });
  if (object.payload.kind !== 'image') throw new Error('Expected image capture');
  const annotation: ImageAnnotationDocument = { source: object.payload.image, width: 5, height: 5,
    marks: [{ id: 'cover', kind: 'cover', from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, color: '#101010', width: 1, fontSize: 12 }], past: [], future: [] };
  object.payload.image = { ...object.payload.image, annotation };
  await insertDraftMarker(key, object); await insertDraftMarker(key, object);
  const before = useThreadDraftStore.getState().drafts[key];
  const frozen = freezeDraftContentReferences(before);
  expect(frozen.contentReferences?.[0]).not.toHaveProperty('attachment');
  expect(frozen.contentReferences?.[0]).not.toHaveProperty('attachmentRef');
  expect(frozen.contentReferences?.[0]?.source).toEqual(object.payload.contentReference!.source);
  convertDraftImagesToFiles(key, endpoint.generation);
  const converted = useThreadDraftStore.getState().drafts[key];
  expect(converted.text).toBe(before.text);
  expect(converted.images).toHaveLength(0);
  expect(converted.files).toHaveLength(1);
  expect(converted.markerObjects?.[0]?.id).toBe(before.markerObjects?.[0]?.id);
  expect(converted.markerObjects?.[0]?.number).toBe(before.markerObjects?.[0]?.number);
  expect(freezeDraftContentReferences(converted)).toEqual(frozen);
  expect(await converted.files![0]!.data.text()).toBe('original pixels');
  const applyHistory = (command: typeof undo) => {
    const state = useThreadDraftStore.getState().drafts[key].editorState!;
    return command({ state, dispatch: transaction => saveComposerState(key, transaction.state) });
  };
  expect(applyHistory(undo)).toBe(true);
  expect(useThreadDraftStore.getState().drafts[key].images).toEqual(before.images);
  expect(useThreadDraftStore.getState().drafts[key].files).toHaveLength(0);
  expect(applyHistory(redo)).toBe(true);
  const files = useThreadDraftStore.getState().drafts[key].files!;
  const upload = vi.fn(async file => ({ ...descriptor('file-image'), mimeType: file.mimeType, filename: file.filename }));
  vi.mocked(flattenAnnotations).mockResolvedValueOnce({ data: btoa('visible annotated pixels'), mimeType: 'image/png' });
  const attachments = await prepareDraftFiles(key, files, 'original-target', upload);
  expect(await upload.mock.calls[0]![0].data.text()).toBe('visible annotated pixels');
  expect(attachmentImageReferences(files, attachments)).toEqual({ attachmentImageReferences: { 'attachment:file-image': 1 } });
  await prepareDraftFiles(key, files, 'original-target', upload);
  expect(upload).toHaveBeenCalledOnce();
});

it('refuses image conversion under a changed Host without mutating the original draft', () => {
  useThreadDraftStore.getState().patch('original', { images: [{ mimeType: 'image/png', data: 'YQ==', reference: 1 }] });
  const before = useThreadDraftStore.getState().drafts.original;
  endpoint.generation = 2;
  expect(() => convertDraftImagesToFiles('original', 1)).toThrow('Host changed');
  expect(useThreadDraftStore.getState().drafts.original).toBe(before);
});
