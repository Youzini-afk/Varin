import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { StoredMedia, MediaReadChunk } from '@varin/protocol';
import { createThreadsHttpAPI, ThreadRequestError } from '../src/threads-http.js';
import { readThreadMedia } from '../src/thread-media.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';

const media: StoredMedia = { media_type: 'image/png', content_ref: { content_object: 'sha256-original-image' }, source: { kind: 'operation', operation_id: 'capture' } };
const scope = { runtime: 'agent' as const, threadId: 'thread', branchId: 'branch', holder: { kind: 'history' as const, itemId: 'item' }, partIndex: 2 };
const chunk = (index: number): MediaReadChunk => ({ media, partIndex: 2, chunkIndex: index, chunkCount: 2, totalBytes: 5, bytesBase64: index === 0 ? 'AQID' : 'BAU=' });

it('reads original holder chunks through the real HTTP client and preserves queued edit image semantics', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path: String(url), body, signal: init?.signal });
    return Response.json(String(url).endsWith('media/read') ? chunk(body.chunkIndex as number) : {});
  };
  try {
    const api = createThreadsHttpAPI();
    assert.deepEqual(await readThreadMedia(api, scope, media), Uint8Array.of(1, 2, 3, 4, 5));
    assert.equal(calls.length, 2);
    for (const [index, call] of calls.entries()) {
      assert.equal(call.path, '/api/threads/media/read');
      assert.deepEqual(call.body, { ...scope, chunkIndex: index, expectedContentRef: media.content_ref.content_object });
      assert.ok(call.signal instanceof AbortSignal);
    }
    await api.editInput('input', 4, 'keep images');
    await api.editInput('input', 4, 'remove images', []);
    await api.editInput('input', 4, 'replace images', [{ mimeType: 'image/png', data: 'AQID' }]);
    assert.equal(Object.hasOwn(calls[2]!.body, 'images'), false);
    assert.deepEqual(calls[3]!.body.images, []);
    assert.deepEqual(calls[4]!.body.images, [{ mimeType: 'image/png', data: 'AQID' }]);
  } finally { globalThis.fetch = original; }
});

it('rejects mixed original identity, inconsistent chunk metadata and corrupt bytes without publishing a partial image', async () => {
  const changes: Array<Partial<MediaReadChunk>> = [
    { media: { ...media, content_ref: { content_object: 'other' } } },
    { media: { ...media, source: { kind: 'operation', operation_id: 'other' } } },
    { media: { ...media, media_type: 'image/jpeg' } },
    { partIndex: 3 }, { chunkIndex: 0 }, { chunkCount: 3 }, { totalBytes: 6 }, { bytesBase64: '!!!!' },
    { bytesBase64: 'BA==' }, { bytesBase64: 'BAV=' }, { bytesBase64: 'BAUG' },
  ];
  for (const change of changes) {
    await assert.rejects(readThreadMedia({ mediaRead: async input => ({ ...chunk(input.chunkIndex), ...(input.chunkIndex === 1 ? change : {}) }) }, scope, media), /inconsistent/);
  }
});

it('preserves the Host failure and rejects a late response after cancellation or endpoint replacement', async () => {
  const original = globalThis.fetch;
  let release!: (value: unknown) => void;
  globalThis.fetch = async () => Response.json({ code: 'media-holder-stale' }, { status: 409 });
  try {
    const api = createThreadsHttpAPI();
    await assert.rejects(readThreadMedia(api, scope, media), error => error instanceof ThreadRequestError && error.code === 'media-holder-stale');
    let requests = 0;
    globalThis.fetch = async url => String(url).includes('/auth/') ? Response.json({ token: 'test', expiresAt: Date.now() + 60_000 })
      : (requests++, { ok: true, json: () => new Promise(resolve => { release = resolve; }) } as Response);
    const controller = new AbortController();
    const pending = readThreadMedia(api, scope, media, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(); release(chunk(0));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(requests, 1);
    const oldHost = readThreadMedia(api, scope, media);
    await new Promise(resolve => setImmediate(resolve));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://next-media-host.test', runtimeKey: 'next-media-host' });
    release(chunk(0));
    await assert.rejects(oldHost, error => error instanceof Error && (error.name === 'AbortError' || error.message.includes('Application Host changed')));
    assert.equal(requests, 2);
  } finally { globalThis.fetch = original; }
});

it('preserves explicit admission evidence without inferring it from status, code, or malformed bodies', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, body, admission] of [
      [413, { code: 'http-body-too-large', admission: 'not_started' }, 'not_started'],
      [400, { code: 'model-images-unsupported', admission: 'not_started' }, 'not_started'],
      [409, { code: 'thread-conflict' }, undefined],
      [413, { code: 'http-body-too-large' }, undefined],
      [400, null, undefined],
      [400, { admission: true }, undefined],
    ] as const) {
      globalThis.fetch = async () => Response.json(body, { status });
      await assert.rejects(createThreadsHttpAPI().submit({ runtime: 'agent', threadId: 'thread', branchId: 'branch', key: 'input', expectedHead: null, text: 'original', model: { providerId: 'provider', modelId: 'model' } }),
        error => error instanceof ThreadRequestError && error.status === status && error.admission === admission);
    }
  } finally { globalThis.fetch = original; }
});
