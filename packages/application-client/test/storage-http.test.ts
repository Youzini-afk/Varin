import "./network-fixture.js";
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createStorageHttpAPI, StorageRequestError } from '../src/storage.js';
import { switchRuntimeEndpoint } from '../src/transport/runtime-switch.js';

it('binds cleanup confirmation to the preview Host and sends no filesystem path', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => { calls.push({ path: String(input), body: JSON.parse(String(init?.body ?? '{}')) }); return Response.json({ previewId: 'preview' }); };
  try {
    const api = createStorageHttpAPI();
    await api.cleanup('preview', ['candidate']);
    assert.deepEqual(calls[0], { path: '/api/storage/cleanup', body: { previewId: 'preview', candidateIds: ['candidate'] } });
    const target = { id: 'connection:resource-b', hostId: 'host-b', endpointIdentity: `sha256-${'b'.repeat(64)}` };
    await api.inventory({ kind: 'workspace', workspaceId: 'b-project' }, undefined, target);
    assert.deepEqual(calls[1], { path: '/api/storage/inventory', body: { scope: { kind: 'workspace', workspaceId: 'b-project' }, target } });
    switchRuntimeEndpoint({ apiBaseUrl: 'http://new-storage-host.test', runtimeKey: 'next' });
    await assert.rejects(api.cleanup('preview', ['candidate']), error => error instanceof StorageRequestError && error.code === 'host-changed');
    assert.equal(calls.filter(call => call.path.endsWith('/storage/cleanup')).length, 1);
  } finally { globalThis.fetch = original; }
});
