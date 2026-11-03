import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadsHttpAPI } from '../src/threads-http.js';
import { configureRuntimeUrlResolver } from '../src/transport/runtime-url.js';
const identity = { runtime: 'agent' as const, threadId: 'thread:1', branchId: 'branch:1' };
test('exports through authenticated runtime transport into a backpressured sink', async () => {
  const previous = globalThis.fetch;
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://host.test', realtimeBaseUrl: 'https://host.test' });
  const chunks: Uint8Array[] = [];
  let called = '';
  globalThis.fetch = async (url, options) => {
    called = String(url); assert.equal(options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(options?.body)), { ...identity, headId: 'history:1', format: 'json', includeTools: false, includeAttachments: true });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"messages":')); controller.enqueue(new TextEncoder().encode('[]}')); controller.close(); } }));
  };
  try {
    await createThreadsHttpAPI().workflows!.export({ ...identity, headId: 'history:1', format: 'json', includeTools: false, includeAttachments: true }, new WritableStream({ write(chunk) { chunks.push(chunk); } }));
    assert.equal(called, 'https://host.test/api/threads/export');
    assert.equal(Buffer.concat(chunks).toString(), '{"messages":[]}');
  } finally { globalThis.fetch = previous; configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' }); }
});
test('an export rejection aborts the local file instead of committing a partial artifact', async () => {
  const previous = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Selected history no longer exists' }), { status: 409 });
  try {
    await assert.rejects(createThreadsHttpAPI().workflows!.export({ ...identity, headId: 'history:1', format: 'markdown', includeTools: false, includeAttachments: false }, new WritableStream({ abort() { aborted = true; } })), /Selected history/);
    assert.equal(aborted, true);
  } finally { globalThis.fetch = previous; }
});
