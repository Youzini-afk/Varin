import { expect, it, vi } from 'vitest';
import type { Attachment } from '@varin/protocol';
import { fileInputText, parseExternalAttachmentSelections, prepareHarnessInput, type ExternalAttachmentOwner } from './attachments.js';

const file: Attachment = { ref: 'attachment:fixed', filename: 'data.csv', mimeType: 'text/csv', byteLength: 4 };
const conversation = { id: 'external:one' };
function fixture() {
  const owner: ExternalAttachmentOwner = {
    prepareExternal: vi.fn(), uploadExternal: vi.fn(), releaseExternal: vi.fn(),
    externalPath: vi.fn(async () => ({ path: '/retained/data.csv', kernelEpoch: 'current' })),
    readExternal: vi.fn(async () => ({ attachment: file, stream: (async function* () { yield Buffer.from('data'); })() })),
  };
  return owner;
}
it('prepares only selected fixed files in the actual external host without changing the task', async () => {
  const owner = fixture();
  const input = await prepareHarnessInput({ text: 'Process this', attachments: [file] }, conversation,
    { images: false, files: 'paths', models: [], resume: true, steering: false }, owner);
  expect(owner.externalPath).toHaveBeenCalledWith(conversation, file.ref, undefined);
  expect(owner.readExternal).not.toHaveBeenCalled();
  expect(input).toEqual({ text: 'Process this', files: [{ attachment: file, path: '/retained/data.csv' }] });
  expect(fileInputText(input)).toContain('"path":"/retained/data.csv"');
  expect(fileInputText(input)).toContain('"ref":"attachment:fixed"');
});
it('keeps images as real native image blocks when the current adapter accepts them', async () => {
  const owner = fixture(), image = { ...file, filename: 'image.png', mimeType: 'image/png' };
  vi.mocked(owner.readExternal).mockImplementation(async () => ({ attachment: image, stream: (async function* () { yield Buffer.from('da'); yield Buffer.from('ta'); })() }));
  const input = await prepareHarnessInput({ text: '', attachments: [image] }, conversation,
    { images: true, files: 'paths', models: [], resume: true, steering: false }, owner);
  expect(input).toEqual({ text: '', images: [{ data: Buffer.from('data').toString('base64'), mimeType: 'image/png' }] });
  expect(owner.externalPath).not.toHaveBeenCalled();
  const numbered = await prepareHarnessInput({ text: 'Look at [图片3]', attachments: [image], attachmentImageReferences: { [image.ref]: 3 } }, conversation,
    { images: true, files: 'paths', models: [], resume: true, steering: false }, owner);
  expect(numbered.images).toEqual(input.images);
  expect(numbered.text).toContain('Attached image 1: [Image 3] / [图片3]');
  expect(numbered).not.toHaveProperty('attachmentImageReferences');
});
it('fails before dispatch instead of silently dropping unsupported files or returning stale paths', async () => {
  const owner = fixture(), caps = { images: false, models: [], resume: true, steering: false };
  await expect(prepareHarnessInput({ text: 'Task', attachments: [file] }, conversation, caps, owner))
    .rejects.toMatchObject({ code: 'attachment_unsupported' });
  expect(owner.externalPath).not.toHaveBeenCalled();
  vi.mocked(owner.externalPath).mockResolvedValue({ path: 'relative/file', kernelEpoch: 'old' });
  await expect(prepareHarnessInput({ text: '', attachments: [file] }, conversation, { ...caps, files: 'paths' }, owner))
    .rejects.toMatchObject({ code: 'attachment_path_unavailable' });
});
it('rejects mixed selectors and owner-controlled fields', () => {
  expect(parseExternalAttachmentSelections([{ ref: file.ref }, { path: 'reports/output.zip' }])).toEqual([{ ref: file.ref }, { path: 'reports/output.zip' }]);
  for (const invalid of [[{ ref: file.ref, path: 'other' }], [{ ref: file.ref, filename: 'forged' }], [{ path: '' }]])
    expect(() => parseExternalAttachmentSelections(invalid)).toThrow();
});

it('projects frozen quotes without private metadata and maps reordered native images to the same numbers', async () => {
  const text = '[引用点1] [图片9] then [图片2] and [引用点1]';
  const input = await prepareHarnessInput({ text,
    contentReferences: [{ ref: 'private-source', title: '引用点1', number: 1, label: 'Varin', text: 'fixed complete sentence', source: { kind: 'chat', thread: { runtime: 'agent', threadId: 'private-thread', branchId: 'private-branch' }, passages: [] } }],
    contentReferenceOccurrences: [{ kind: 'content', ref: 'private-source', start: 0, end: 6 }, { kind: 'image', reference: 9, start: 7, end: 12 }, { kind: 'image', reference: 2, start: 18, end: 23 }, { kind: 'content', ref: 'private-source', start: 28, end: 34 }],
    images: [{ mimeType: 'image/png', data: 'dHdv', reference: 2 }, { mimeType: 'image/png', data: 'bmluZQ==', reference: 9 }] }, conversation,
    { images: true, files: 'paths', models: [], resume: true, steering: false });
  expect(input.text.match(/fixed complete sentence/g)).toHaveLength(1);
  expect(input.images?.map(image => image.data)).toEqual(['bmluZQ==', 'dHdv']);
  expect(input.text).toContain('Attached image 1: [Image 9] / [图片9]');
  expect(input.text).not.toContain('private');
  expect(input).not.toHaveProperty('contentReferences');
  expect(input).not.toHaveProperty('contentReferenceOccurrences');
});
