import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FilesAPI, ThreadsAPI } from '@varin/application-client';
import { captureFileQuote } from './captureFileQuote';
const state = vi.hoisted(() => ({ runtime: 'source-host' }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeKey: () => state.runtime }));
const identity = { runtime: 'agent' as const, threadId: 'original', branchId: 'branch' };
beforeEach(() => { state.runtime = 'source-host'; });
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const blob = new Blob([new Uint8Array([0, 255, 3])], { type: 'application/pdf' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => blob })));
  const statFile = vi.fn(async () => ({ path: '/source/report.pdf', isFile: true, size: 3, mtimeMs: 9 }));
  const readFileBinary = vi.fn(async () => ({ dataUrl: 'data:application/pdf;base64,AP8D', path: '/source/report.pdf' }));
  const upload = vi.fn(async () => ({ ref: 'attachment:fixed', filename: 'report.pdf', mimeType: 'application/pdf', byteLength: 3 }));
  const target = { path: 'report.pdf', runtimeKey: state.runtime, open() {}, resolve: vi.fn(async () => ({ path: '/source/report.pdf', directory: '/source' })) };
  return { statFile, readFileBinary, upload, target, files: { statFile, readFileBinary } as unknown as FilesAPI,
    attachments: { upload } as unknown as ThreadsAPI['attachments'] };
}
it('captures original owner bytes and returns a fixed attachment selection without expanding a file into text', async () => {
  const f = fixture();
  const captured = await captureFileQuote(f.target, identity, f.files, f.attachments);
  expect(f.readFileBinary).toHaveBeenCalledWith('/source/report.pdf', { directory: '/source' });
  expect(f.upload).toHaveBeenCalledWith(identity, expect.objectContaining({ filename: 'report.pdf', mimeType: 'application/pdf' }));
  const upload = f.upload.mock.calls[0] as unknown as [unknown, { data: Blob }];
  expect([...new Uint8Array(await upload[1].data.arrayBuffer())]).toEqual([0, 255, 3]);
  expect(captured).toMatchObject({ title: 'report.pdf', attachment: { ref: 'attachment:fixed' }, source: { kind: 'file', thread: identity, path: '/source/report.pdf' } });
  expect(captured.text).toBeUndefined();
});
it('reports a changed file rather than silently quoting the new generation', async () => {
  const f = fixture();
  f.statFile.mockResolvedValueOnce({ path: '/source/report.pdf', isFile: true, size: 3, mtimeMs: 8 });
  await expect(captureFileQuote(f.target, identity, f.files, f.attachments)).rejects.toThrow('changed');
  expect(f.upload).not.toHaveBeenCalled();
});
it('does not upload original Host bytes after switching Hosts during capture', async () => {
  const f = fixture();
  f.readFileBinary.mockImplementationOnce(async () => { state.runtime = 'different'; return { dataUrl: '', path: '/source/report.pdf' }; });
  await expect(captureFileQuote(f.target, identity, f.files, f.attachments)).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.upload).not.toHaveBeenCalled();
});
