import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadsAPI, ThreadIdentity } from '@varin/application-client';
import type { StoredMedia, MediaReadChunk } from '@varin/protocol';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { ThreadContent } from './ThreadContent';
import { ThreadMedia } from './ThreadMedia';

const endpoint = vi.hoisted(() => ({ generation: 1, listeners: new Set<() => void>() }));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => endpoint.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { endpoint.listeners.add(listener); return () => endpoint.listeners.delete(listener); },
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
const identity: ThreadIdentity = { runtime: 'agent', threadId: 'thread', branchId: 'branch' };
const media: StoredMedia = { media_type: 'image/png', source: { kind: 'operation', operation_id: 'original-capture' }, content_ref: { content_object: 'sha256-original' } };
const response = (input: Parameters<ThreadsAPI['mediaRead']>[0], selected = media): MediaReadChunk => ({ media: selected, partIndex: input.partIndex, chunkIndex: input.chunkIndex, chunkCount: 2, totalBytes: 5, bytesBase64: input.chunkIndex === 0 ? 'AQID' : 'BAU=' });
let root: Root; let container: HTMLDivElement; let blobs: Blob[];
beforeEach(() => {
  endpoint.generation = 1; blobs = [];
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { blobs.push(blob as Blob); return `blob:media-${blobs.length}`; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const click = async (text: string) => { await act(async () => [...container.querySelectorAll('button')].find(value => value.textContent === text)!.click()); };
const render = async (api: Pick<ThreadsAPI, 'mediaRead'>, selected = identity) => { await act(async () => root.render(<ThreadMedia api={api} identity={selected} holder={{ kind: 'history', itemId: 'item' }} media={media} partIndex={1} />)); };

it('renders declared text/media in order and lazily reads the exact original output part, while opaque lookalikes remain data', async () => {
  const api = { mediaRead: vi.fn<ThreadsAPI['mediaRead']>(async input => response(input)) };
  const parts = historyParts({ id: 'item', provenance: { kind: 'tool_data', call_id: 'call' }, content: { kind: 'tool_result', result: {
    completion: { kind: 'result', outcome: 'failed', effect: 'partial', content: {
      data: { kind: 'media', media, parts: [{ kind: 'media', media }], data_base64: 'opaque-unchanged' },
      parts: [{ kind: 'text', text: 'Before image' }, { kind: 'media', media }, { kind: 'text', text: 'After image' }],
    } },
  } } }, 'tool');
  await act(async () => root.render(<ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: 'item' }} parts={parts} messageId="item" />));
  expect(container.querySelectorAll('figure')).toHaveLength(1);
  const content = container.querySelector('[aria-label="Typed output"]')!;
  expect([...content.children].map(value => value.tagName)).toEqual(['P', 'FIGURE', 'P', 'DETAILS']);
  expect(container.textContent).toContain('opaque-unchanged');
  expect(container.textContent).toContain('failed'); expect(container.textContent).toContain('partial');
  expect(api.mediaRead).not.toHaveBeenCalled();
  await click('View image');
  expect(api.mediaRead.mock.calls.map(([input]) => input)).toEqual([0, 1].map(chunkIndex => ({ ...identity, holder: { kind: 'history', itemId: 'item' }, partIndex: 1, chunkIndex, expectedContentRef: 'sha256-original' })));
  expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:media-1');
  await click('Close media');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media-1');
  expect(container.querySelector('img')).toBeNull();
});

it('cancels pending reads and discards late bytes on cancel, Thread switch and Host switch', async () => {
  const pending: Array<{ resolve(value: MediaReadChunk): void; input: Parameters<ThreadsAPI['mediaRead']>[0]; signal?: AbortSignal }> = [];
  const api = { mediaRead: vi.fn<ThreadsAPI['mediaRead']>((input, signal) => new Promise(resolve => pending.push({ resolve, input, signal }))) };
  await render(api); await click('View image');
  await click('Cancel media read'); expect(pending[0]!.signal!.aborted).toBe(true);
  await act(async () => pending[0]!.resolve(response(pending[0]!.input)));
  expect(blobs).toHaveLength(0);
  await click('View image'); await render(api, { ...identity, threadId: 'next-thread' });
  expect(pending[1]!.signal!.aborted).toBe(true);
  await act(async () => pending[1]!.resolve(response(pending[1]!.input)));
  expect(blobs).toHaveLength(0);
  await click('View image');
  await act(async () => { endpoint.generation += 1; endpoint.listeners.forEach(listener => listener()); });
  expect(pending[2]!.signal!.aborted).toBe(true);
  await act(async () => pending[2]!.resolve(response(pending[2]!.input)));
  expect(blobs).toHaveLength(0); expect(container.querySelector('img')).toBeNull();
  expect(api.mediaRead).toHaveBeenCalledTimes(3);
});

it('shows a retriable original-read failure and an explicit unsupported media download', async () => {
  const api = { mediaRead: vi.fn<ThreadsAPI['mediaRead']>().mockRejectedValueOnce(new Error('Original holder no longer available')).mockImplementation(async input => response(input)) };
  await render(api); await click('View image');
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Original holder no longer available');
  await click('Retry media'); expect(container.querySelector('img')).not.toBeNull();
  const other = { ...media, media_type: 'application/octet-stream' };
  api.mediaRead.mockImplementation(async input => response(input, other));
  await act(async () => root.render(<ThreadMedia api={api} identity={identity} holder={{ kind: 'operation', operationId: 'operation', output: 'external_receipt' }} media={other} partIndex={0} />));
  expect(container.textContent).toContain('cannot display application/octet-stream');
  await click('Read original media');
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('a[download]')?.getAttribute('href')).toBe('blob:media-2');
  expect(api.mediaRead.mock.calls.at(-1)![0].holder).toEqual({ kind: 'operation', operationId: 'operation', output: 'external_receipt' });
});

it('does not reinterpret obsolete inline attachments or malformed declared media as silent success', async () => {
  const api = { mediaRead: vi.fn<ThreadsAPI['mediaRead']>() };
  await act(async () => root.render(<ThreadContent api={api} identity={identity} holder={{ kind: 'history', itemId: 'item' }} messageId="item"
    parts={historyParts({ attachments: [{ media_type: 'image/png', content_ref: 'data:image/png;base64,AQID', source: 'old' }] }, 'user')} />));
  expect(container.textContent).toContain('Input media is unavailable');
  expect(container.querySelector('img')).toBeNull(); expect(api.mediaRead).not.toHaveBeenCalled();
});

it('saves retained image bytes through the workspace file owner, gates repeated clicks and preserves the image after save failure', async () => {
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  let rejectSave!: (reason: Error) => void;
  const upload = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSave = reject; }))
    .mockResolvedValueOnce({ success: true, entries: [{ type: 'file', path: '/workspace/image-1.png' }] });
  const api = { mediaRead: vi.fn<ThreadsAPI['mediaRead']>(async input => response(input)) };
  await act(async () => root.render(<RuntimeAPIContext.Provider value={{ workspace: { upload } } as unknown as import('@varin/application-client').RuntimeAPIs}>
    <ThreadMedia api={api} identity={identity} holder={{ kind: 'history', itemId: 'item' }} media={media} partIndex={1} />
  </RuntimeAPIContext.Provider>));
  await click('View image');
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Save image')!;
  await act(async () => { button.click(); button.click(); });
  expect(upload).toHaveBeenCalledTimes(1);
  const file = upload.mock.calls[0]![1][0] as File;
  expect(file.name).toBe('image-1.png');
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
  await act(async () => rejectSave(new Error('File write rejected')));
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:media-1');
  expect(container.textContent).toContain('original image is still available');
  await click('Save image');
  expect(container.textContent).toContain('Image saved to /workspace/image-1.png');
  expect(api.mediaRead).toHaveBeenCalledTimes(2);
});
