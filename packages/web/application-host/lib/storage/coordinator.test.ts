import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import type { StorageCleanupPreview, StorageInventory, StorageTarget } from '@varin/application-client';
import { FULL_CONTROL_CAPABILITIES } from '../client-auth/remote-clients.js';
import { createManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import { registerManagedRemoteRoutes } from '../harness/managed-remote-routes.js';
import { createSemanticIndexManagement } from '../knowledge/semantic/index-management.js';
import { createStorageService } from './service.js';
import { createStorageCoordinator } from './coordinator.js';
import { registerStorageRoutes } from './routes.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const write = async (file: string, text: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-storage-two-hosts-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const make = async (id: string) => {
    const data = path.join(root, id); await mkdir(data);
    const previous = createSemanticIndexManagement(data, id); await previous.load(); const old = previous.activeDirectory();
    await write(path.join(old, 'workspace', `${id}-workspace`, 'cache'), `${id} disposable`);
    await previous.save({ storageDirectory: path.join(root, `${id}-active`) }, (await previous.read()).revision);
    const indexes = createSemanticIndexManagement(data, id); await indexes.load();
    await write(path.join(indexes.activeDirectory(), 'workspace', `${id}-workspace`, 'cache'), `${id} ACTIVE`);
    const service = createStorageService({ hostId: id, name: id, dataDirectory: data, speechModelsDirectory: path.join(data, 'models'), indexes,
      workspaces: async () => [{ workspaceId: `${id}-workspace`, canonicalPath: `/original/${id}` }], devices: async () => [],
      kernel: { health: vi.fn(async () => ({ storageRoot: path.join(data, 'kernel'), gcPreview: { objects: [], retainedObjects: 0 } })), collectStorageObjects: vi.fn() } });
    return { data, old, indexes, service };
  };
  const a = await make('host-a'), b = await make('host-b');
  let capabilities: string[] = [...FULL_CONTROL_CAPABILITIES], allowedDirectories: string[] = [], hostId = 'host-b', storageSupported = true, disconnected = false, dropReceipt = false, denied = false, invalidIdentity = false;
  const authB: RequestHandler = (request, response, next) => {
    if (denied || request.headers.authorization !== 'Bearer fixture-b-only') { response.status(403).json({ error: 'fixture auth missing' }); return; }
    request.varinAuth = { type: 'client', clientId: 'connection-a', client: { id: 'connection-a', capabilities, allowedDirectories } }; next();
  };
  const appB = express();
  registerManagedRemoteRoutes(appB, { service: { get hostId() { return hostId; }, identity: async () => ({ protocolVersion: 1, hostId, capabilities: storageSupported ? ['storage'] : [], machine: { machineId: `managed:${hostId}`, kind: 'managed-remote', state: 'available' } }) } as never,
    requireAuth: authB, resolveAuthContext: async request => request.varinAuth ?? null });
  registerStorageRoutes(appB, b.service, authB);
  const serverB = appB.listen(0); await once(serverB, 'listening'); cleanups.push(() => new Promise<void>(resolve => serverB.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;
  let settings = { desktopHosts: [{ id: 'b', label: 'Resource B', apiUrl: endpoint, clientToken: 'fixture-b-only' }] };
  const remoteCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const registry = createManagedRemoteTargetRegistry({ coordinatorHostId: 'host-a', kernel: {} as never, resources: new Proxy({}, { get() { throw new Error('Storage must not register machines or change the Agent Catalog'); } }) as never,
    readSettings: async () => settings, fetch: async (input, init) => {
      if (disconnected) throw new TypeError('Fixture transport offline');
      const url = String(input); remoteCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      if (invalidIdentity && url.endsWith('/identity')) return Response.json({ error: 'Invalid target identity' });
      const response = await fetch(input, init);
      if (dropReceipt && url.endsWith('/storage/cleanup')) { dropReceipt = false; await response.text(); throw new TypeError('Lost target completion response'); }
      return response;
    } });
  const appA = express();
  registerStorageRoutes(appA, a.service, (request, _response, next) => {
    const principal = String(request.headers['x-fixture-principal'] ?? 'owner-a');
    request.varinAuth = principal === 'readonly-a' ? { type: 'client', clientId: principal, client: { id: principal, capabilities: ['instance:read', 'config:read', 'filesystem:read'] } } : { type: 'session', token: principal }; next();
  }, createStorageCoordinator(a.service, registry));
  const serverA = appA.listen(0); await once(serverA, 'listening'); cleanups.push(() => new Promise<void>(resolve => serverA.close(() => resolve())));
  const base = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}/api/storage`;
  const post = async (action: string, body: object, principal = 'owner-a') => fetch(`${base}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-principal': principal }, body: JSON.stringify(body) });
  const catalog = await (await post('inventory', { scope: { kind: 'all' } })).json() as StorageInventory;
  const target = catalog.devices.find(item => !item.current)?.target as StorageTarget;
  return { a, b, post, target, remoteCalls, registry, endpoint, setReadOnly: () => { capabilities = ['instance:read', 'config:read', 'filesystem:read']; }, restrict: () => { allowedDirectories = ['/one-directory']; },
    changeEndpoint: () => { settings = { desktopHosts: [{ ...settings.desktopHosts[0]!, apiUrl: `${endpoint}/new-mount` }] }; }, changeHost: () => { hostId = 'replacement'; },
    offline: () => { disconnected = true; }, deny: () => { denied = true; }, unsupported: () => { storageSupported = false; }, loseReceipt: () => { dropReceipt = true; }, corruptIdentity: () => { invalidIdentity = true; } };
}
const bScope = { kind: 'workspace' as const, workspaceId: 'host-b-workspace' };
const previewFor = async (f: Awaited<ReturnType<typeof fixture>>) => (await (await f.post('preview', { scope: bScope, target: f.target })).json()) as StorageCleanupPreview;
const confirmation = (preview: StorageCleanupPreview) => ({ previewId: preview.id, candidateIds: preview.candidates.map(item => item.id) });
it('measures and cleans only the independently selected resource Host and its workspace over authenticated HTTP', async () => {
  const f = await fixture(); expect(f.target).toMatchObject({ id: 'connection:b', hostId: 'host-b' });
  const inventory = await (await f.post('inventory', { scope: bScope, target: f.target })).json() as StorageInventory;
  expect(inventory.device.id).toBe('connection:b'); expect(inventory.device.current).toBe(false);
  expect(inventory.root).toBe(f.b.data); expect(inventory.bytes).toBe(Buffer.byteLength('host-b disposablehost-b ACTIVE'));
  expect(inventory.workspaces.map(item => item.id)).toEqual(['host-b-workspace']);
  const preview = await previewFor(f); expect(preview.deviceId).toBe('connection:b'); expect(preview.candidates).toHaveLength(1);
  const body = confirmation(preview); expect((await f.post('cleanup', body, 'other-principal')).status).toBe(403);
  expect(await (await f.post('cleanup', body)).json()).toMatchObject({ previewId: preview.id, state: 'complete', bytesReclaimed: Buffer.byteLength('host-b disposable') });
  expect(await readFile(path.join(f.a.old, 'workspace/host-a-workspace/cache'), 'utf8')).toBe('host-a disposable');
  expect(await readFile(path.join(f.b.indexes.activeDirectory(), 'workspace/host-b-workspace/cache'), 'utf8')).toBe('host-b ACTIVE');
  await expect(readFile(path.join(f.b.old, 'workspace/host-b-workspace/cache'))).rejects.toMatchObject({ code: 'ENOENT' });
  const forwarded = f.remoteCalls.find(item => item.url.endsWith('/storage/cleanup'))!;
  expect(forwarded.body).toEqual({ previewId: expect.any(String), candidateIds: body.candidateIds }); expect(forwarded.body.previewId).not.toBe(preview.id);
});
it('replays the original target preview after a lost completion response without deleting twice', async () => {
  const f = await fixture(), remove = vi.spyOn(f.b.indexes, 'removeRetainedScope'); const body = confirmation(await previewFor(f));
  f.loseReceipt(); expect((await f.post('cleanup', body)).status).toBe(503);
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now); now += 11 * 60_000;
  // Both coordinators prune previews here, but B's receipt and A's unresolved
  // accepted confirmation must survive the ten-minute admission deadline.
  await previewFor(f);
  expect(await (await f.post('cleanup', body)).json()).toMatchObject({ state: 'complete', bytesReclaimed: Buffer.byteLength('host-b disposable') }); expect(remove).toHaveBeenCalledTimes(1);
  const calls = f.remoteCalls.filter(item => item.url.endsWith('/storage/cleanup')); expect(calls).toHaveLength(2); expect(calls[0]!.body).toEqual(calls[1]!.body);
});
it('refuses endpoint or Host identity substitution, arbitrary URLs, and recursive target forwarding', async () => {
  const f = await fixture(), body = confirmation(await previewFor(f)); f.changeEndpoint();
  expect((await f.post('cleanup', body)).status).toBe(503); expect(f.remoteCalls.filter(item => item.url.endsWith('/storage/cleanup'))).toHaveLength(0);
  expect((await f.post('inventory', { scope: { kind: 'all' }, target: { ...f.target, apiUrl: 'http://unconfigured.invalid' } })).status).toBe(400);
  expect(await readFile(path.join(f.b.old, 'workspace/host-b-workspace/cache'), 'utf8')).toBe('host-b disposable');
  const recursive = await fetch(`${f.endpoint}/api/harness/managed-execution/v1/storage/inventory`, { method: 'POST', headers: { authorization: 'Bearer fixture-b-only', 'content-type': 'application/json' }, body: JSON.stringify({ scope: { kind: 'all' }, target: f.target }) }); expect(recursive.status).toBe(400);
  const g = await fixture(); g.changeHost(); expect((await g.post('preview', { scope: { kind: 'all' }, target: g.target })).status).toBe(503);
  expect(g.remoteCalls.filter(item => item.url.endsWith('/storage/preview'))).toHaveLength(0);
});
it('preserves remote read-only and directory restrictions and exposes observed offline or unsupported targets', async () => {
  const f = await fixture(); f.setReadOnly();
  const response = await f.post('inventory', { scope: bScope, target: f.target }); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ canCleanup: false });
  expect((await f.post('cleanup', confirmation(await previewFor(f)))).status).toBe(403);
  f.restrict(); expect((await f.post('inventory', { scope: bScope, target: f.target })).status).toBe(403);
  f.unsupported(); expect((await f.registry.storageTargets())[0]?.state).toBe('unsupported'); f.deny(); expect((await f.registry.storageTargets())[0]?.state).toBe('restricted'); f.offline(); expect((await f.registry.storageTargets())[0]?.state).toBe('offline');
});
it('does not turn an HTTP-successful malformed identity into a successful inventory response', async () => {
  const f = await fixture(); f.corruptIdentity();
  const response = await f.post('inventory', { scope: { kind: 'all' }, target: f.target });
  expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ code: 'target-probe-failed' });
  expect(f.remoteCalls.filter(item => item.url.endsWith('/storage/inventory'))).toHaveLength(0);
});
it('does not elevate a read-only caller through the coordinator trusted remote credential', async () => {
  const f = await fixture();
  const response = await f.post('inventory', { scope: bScope, target: f.target }, 'readonly-a');
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ canCleanup: false });
  const preview = await (await f.post('preview', { scope: bScope, target: f.target }, 'readonly-a')).json() as StorageCleanupPreview;
  expect((await f.post('cleanup', confirmation(preview), 'readonly-a')).status).toBe(403);
  expect(f.remoteCalls.filter(item => item.url.endsWith('/storage/cleanup'))).toHaveLength(0);
});
