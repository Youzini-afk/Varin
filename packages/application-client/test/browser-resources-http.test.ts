import './network-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { browserResources, BrowserResourceRequestError } from '../src/browser-resources-http.js';
import { BINARY_EVENT_CONTENT_TYPE, encodeBinaryEvent } from '../src/transport/binary-events.js';

it('routes reads and controls to the original resource, instance and tab without replaying an unknown effect', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; method: string | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), method: init?.method });
    if (init?.method === 'POST') return Response.json({ error: 'The outcome is unknown', code: 'outcome-unknown' }, { status: 409 });
    return Response.json({ observation: { page: { title: 'Original page' } }, usage: { controller: 'agent', waitingThreadIds: [] } });
  };
  try {
    const binding = { browserId: 'remote/browser', instanceId: 'instance?one', pageId: 'tab#1' };
    const snapshot = await browserResources.observe(binding);
    assert.equal(snapshot.observation.page.title, 'Original page');
    await assert.rejects(browserResources.control(binding, 'activate'), error => error instanceof BrowserResourceRequestError && error.code === 'outcome-unknown');
    assert.deepEqual(calls, [
      { path: '/api/browser-resources/remote%2Fbrowser/instance%3Fone/pages/tab%231?view=structure', method: 'GET' },
      { path: '/api/browser-resources/remote%2Fbrowser/instance%3Fone/pages/tab%231/activate', method: 'POST' },
    ]);
    const bytes = new Uint8Array([0, 128, 255, 13, 10]);
    const packet = encodeBinaryEvent({ observation: { page: { title: 'Original page' }, image: { mimeType: 'image/png' } }, usage: {} }, bytes);
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < packet.byteLength; offset += 7) controller.enqueue(packet.subarray(offset, offset + 7));
        controller.close();
      },
    }), { headers: { 'Content-Type': BINARY_EVENT_CONTENT_TYPE } });
    const screenshot = await browserResources.observe(binding, 'screenshot');
    assert.equal(screenshot.observation.image?.base64, Buffer.from(bytes).toString('base64'));
  } finally { globalThis.fetch = original; }
});
