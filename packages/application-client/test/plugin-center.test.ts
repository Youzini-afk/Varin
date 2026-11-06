import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPluginCenterHttpAPI } from '../src/plugin-center.js';

test('discovery only reads cached catalogs and refreshing uses explicit route', async () => {
  const calls: { path: string; method: string | undefined }[] = [];
  const api = createPluginCenterHttpAPI(async (path, options) => {
    calls.push({ path, method: options.method });
    return Response.json({ hostId: 'host', entries: [], sources: [] });
  }, () => 1);
  await api.discovery(); await api.refreshDiscovery();
  assert.deepEqual(calls, [
    { path: '/api/varin/extensions/v1/discovery', method: 'GET' },
    { path: '/api/varin/extensions/v1/discovery/refresh', method: 'POST' },
  ]);
});
test('late body parsing after a Host change cannot publish discovery', async () => {
  let generation = 1;
  let resolveBody!: (value: unknown) => void;
  const api = createPluginCenterHttpAPI(async () => ({ ok: true, json: () => new Promise(resolve => { resolveBody = resolve; }) }) as Response, () => generation);
  const pending = api.discovery();
  await new Promise(resolve => setImmediate(resolve));
  generation++; resolveBody({ hostId: 'old', entries: [], sources: [] });
  await assert.rejects(pending, /Application Host changed/);
});
test('install sends the reviewed preview and revision, never resolves latest again', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const api = createPluginCenterHttpAPI(async (path, options) => {
    calls.push({ path, body: JSON.parse(String(options.body)) }); return Response.json({});
  }, () => 1);
  await api.install({ previewId: 'pinned-bytes', expectedHostId: 'host-a', expectedRevision: 7, replaceSource: true });
  assert.deepEqual(calls, [{ path: '/api/varin/extensions/v1/releases/install', body: {
    previewId: 'pinned-bytes', expectedHostId: 'host-a', expectedRevision: 7, replaceSource: true,
  } }]);
});
test('upstream failure is not represented as an empty or current update result', async () => {
  const api = createPluginCenterHttpAPI(async () => Response.json({ error: { code: 'upstream-rate-limit', message: 'Try after 12:00' } }, { status: 429 }), () => 1);
  await assert.rejects(api.checkUpdates('mail'), { code: 'upstream-rate-limit', message: 'Try after 12:00' });
});

test('installed link resolution uses only the Host catalog lookup, without release preparation', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const api = createPluginCenterHttpAPI(async (path, options) => {
    calls.push({ path, body: JSON.parse(String(options.body)) }); return Response.json({ hostId: 'host', extensionId: 'mail' });
  }, () => 1);
  const source = { kind: 'npm' as const, display: '@example/mail', specifier: '@example/mail' };
  assert.deepEqual(await api.resolveInstalled(source, 'mail'), { hostId: 'host', extensionId: 'mail' });
  assert.deepEqual(calls, [{ path: '/api/varin/extensions/v1/discovery/resolve-installed', body: { source, extensionId: 'mail' } }]);
});
