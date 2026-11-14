import './network-fixture.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { browserResources, BrowserResourceRequestError } from '../src/browser-resources-http.js';

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
  } finally { globalThis.fetch = original; }
});
