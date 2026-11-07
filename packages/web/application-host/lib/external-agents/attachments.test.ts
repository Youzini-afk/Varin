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
