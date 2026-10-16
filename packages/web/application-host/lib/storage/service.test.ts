import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createSemanticIndexManagement } from '../knowledge/semantic/index-management.js';
import { createStorageService } from './service.js';
import { registerStorageRoutes } from './routes.js';
import { measureDirectory } from './measure.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const write = async (filename: string, value: string) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, value); };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-storage-settings-')); roots.push(root);
  const data = path.join(root, 'data'), models = path.join(root, 'models');
  const original = createSemanticIndexManagement(data, 'host');
  await original.load();
  const old = original.activeDirectory();
  await write(path.join(old, 'workspace', 'workspace-a', 'index.tdb'), 'old-a');
  await write(path.join(old, 'workspace', 'workspace-b', 'index.tdb'), 'old-b-longer');
  await original.save({ storageDirectory: path.join(root, 'custom') }, (await original.read()).revision);
  const indexes = createSemanticIndexManagement(data, 'host'); await indexes.load();
  const active = indexes.activeDirectory();
  await write(path.join(active, 'workspace', 'workspace-a', 'index.tdb'), 'active-a');
  await write(path.join(data, 'kernel', 'host', 'objects', 'body'), 'shared-object');
  await write(path.join(data, 'kernel', 'host', 'agent-runtime', 'catalog.sqlite'), 'conversation');
  await write(path.join(data, 'kernel', 'host', 'managed', 'source'), 'copy');
  await write(path.join(models, 'model.bin'), 'model');
  await write(path.join(root, 'original-project', 'keep.txt'), 'ORIGINAL USER PROJECT');
  const collect = vi.fn(async () => ({ byteLengthReclaimed: 17, deletedBlobs: 1, cleanupFailures: [] }));
  const kernel = { health: vi.fn(async () => ({ storageRoot: path.join(data, 'kernel', 'host'), gcPreview: { objects: [{ hash: 'sha256-fixture-only', byteLength: 17 }], retainedObjects: 4 } })), collectStorageObjects: collect };
  const service = createStorageService({ hostId: 'host', name: 'Fixture Host', dataDirectory: data, speechModelsDirectory: models, indexes, kernel,
    workspaces: async () => ['workspace-a', 'workspace-b'].map(workspaceId => ({ workspaceId, canonicalPath: path.join(root, 'original-project', workspaceId) })),
    devices: async () => [{ id: 'remote', name: 'Remote fixture', current: false, state: 'unsupported' }],
  });
  return { root, data, models, old, active, indexes, kernel, service };
}

describe('managed storage inventory and scoped cleanup', () => {
  it('measures real owned files once, excludes original projects, and does not repeat shared data per workspace', async () => {
    const f = await fixture();
    const all = await f.service.inventory({ kind: 'all' });
    const a = await f.service.inventory({ kind: 'workspace', workspaceId: 'workspace-a' });
    const b = await f.service.inventory({ kind: 'workspace', workspaceId: 'workspace-b' });
    const shared = await f.service.inventory({ kind: 'shared' });
    expect(a.bytes).toBe(Buffer.byteLength('old-aactive-a'));
    expect(b.bytes).toBe(Buffer.byteLength('old-b-longer'));
    expect(all.bytes).toBe(a.bytes + b.bytes + shared.bytes);
    expect(all.categories.reduce((sum, item) => sum + item.bytes, 0)).toBe(all.bytes);
    expect(all.categories.find(item => item.id === 'models')?.bytes).toBe(5);
    expect(all.categories.find(item => item.id === 'copies')?.bytes).toBe(4);
    expect(all.categories.find(item => item.id === 'conversations')?.bytes).toBe(12);
    expect(all.volumes[0]?.totalBytes).toBeGreaterThan(all.bytes);
    expect(all.devices[1]?.state).toBe('unsupported');
    await expect(f.service.inventory({ kind: 'workspace', workspaceId: '../../original-project' })).rejects.toThrow('registration');
    expect(f.kernel.health).not.toHaveBeenCalled();
  });

  it('moves a hard-linked object used by two workspaces into the shared bucket and refuses to follow links', async () => {
    const f = await fixture();
    const first = path.join(f.active, 'workspace', 'workspace-a', 'index.tdb');
    await mkdir(path.join(f.active, 'workspace', 'workspace-b'), { recursive: true });
    await link(first, path.join(f.active, 'workspace', 'workspace-b', 'same.tdb'));
    const before = await f.service.inventory({ kind: 'all' });
    await symlink(path.join(f.root, 'original-project'), path.join(f.data, 'external-project'));
    const all = await f.service.inventory({ kind: 'all' });
    expect(all.bytes).toBe(before.bytes);
    expect(all.state).toBe('partial');
    expect(all.issues[0]).toContain('Symbolic link');
    const a = await f.service.inventory({ kind: 'workspace', workspaceId: 'workspace-a' });
    expect(a.bytes).toBe(5);
    expect((await measureDirectory(path.join(f.data, 'external-project'))).bytes).toBe(0);
  });

  it('reports a missing mandatory Host root as incomplete, even when optional model and cache roots are absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'varin-storage-missing-root-')); roots.push(root);
    const data = path.join(root, 'missing-data');
    const indexes = createSemanticIndexManagement(data, 'host'); await indexes.load();
    const service = createStorageService({ hostId: 'host', name: 'Missing root fixture', dataDirectory: data, speechModelsDirectory: path.join(root, 'absent-models'), indexes,
      workspaces: async () => [], devices: async () => [], kernel: { health: vi.fn(), collectStorageObjects: vi.fn() } });
    const result = await service.inventory({ kind: 'all' });
    expect(result.state).toBe('partial');
    expect(result.issues).toEqual([`ENOENT: managed application root ${data}`]);
    expect(result.volumes[0]).toMatchObject({ state: 'unavailable', totalBytes: null, availableBytes: null });
  });

  it('previews and removes only one workspace inactive cache, preserving active, shared, other workspace and original files', async () => {
    const f = await fixture();
    const preview = await f.service.preview({ kind: 'workspace', workspaceId: 'workspace-a' });
    expect(preview.candidates).toHaveLength(1);
    expect(preview.candidates[0]?.bytes).toBe(5);
    expect(f.kernel.health).not.toHaveBeenCalled();
    const result = await f.service.cleanup(preview.id, preview.candidates.map(item => item.id));
    expect(result).toMatchObject({ state: 'complete', bytesReclaimed: 5, objectsDeleted: 1 });
    await expect(readFile(path.join(f.old, 'workspace', 'workspace-a', 'index.tdb'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(f.old, 'workspace', 'workspace-b', 'index.tdb'), 'utf8')).toBe('old-b-longer');
    expect(await readFile(path.join(f.active, 'workspace', 'workspace-a', 'index.tdb'), 'utf8')).toBe('active-a');
    expect(await readFile(path.join(f.root, 'original-project', 'keep.txt'), 'utf8')).toBe('ORIGINAL USER PROJECT');
    expect(f.kernel.collectStorageObjects).not.toHaveBeenCalled();
    expect(await f.service.cleanup(preview.id, preview.candidates.map(item => item.id))).toEqual(result);
  });

  it('refuses changed cache contents and invalid candidates rather than expanding a confirmation', async () => {
    const f = await fixture();
    const preview = await f.service.preview({ kind: 'workspace', workspaceId: 'workspace-a' });
    await write(path.join(f.old, 'workspace', 'workspace-a', 'new.tdb'), 'NEW DATA');
    await expect(f.service.cleanup(preview.id, ['../../original-project'])).rejects.toThrow('Select only');
    const result = await f.service.cleanup(preview.id, preview.candidates.map(item => item.id));
    expect(result.state).toBe('partial');
    expect(result.bytesReclaimed).toBe(0);
    expect(result.failures[0]?.message).toContain('changed after preview');
    expect(await readFile(path.join(f.old, 'workspace', 'workspace-a', 'new.tdb'), 'utf8')).toBe('NEW DATA');
  });

  it('uses only previewed native hashes, reports physical cleanup failures, and replays one receipt', async () => {
    const f = await fixture();
    f.kernel.collectStorageObjects.mockResolvedValue({ byteLengthReclaimed: 17, deletedBlobs: 1, cleanupFailures: ['permission denied'] as never });
    const preview = await f.service.preview({ kind: 'shared' });
    expect(preview.candidates.map(item => item.kind)).toEqual(['unreferenced-objects']);
    const result = await f.service.cleanup(preview.id, preview.candidates.map(item => item.id));
    expect(result).toMatchObject({ state: 'partial', bytesReclaimed: 17, failures: [{ message: 'permission denied' }] });
    expect(f.kernel.collectStorageObjects).toHaveBeenCalledWith(`settings-storage:${preview.id}`, ['sha256-fixture-only']);
    await f.service.cleanup(preview.id, preview.candidates.map(item => item.id));
    expect(f.kernel.collectStorageObjects).toHaveBeenCalledTimes(1);
    await expect(f.service.cleanup(preview.id, preview.candidates.map(item => item.id), 'other-client')).rejects.toThrow('another authenticated');
  });

  it('retains accepted cleanup receipts after preview expiry, while unaccepted previews expire', async () => {
    const f = await fixture();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const completed = await f.service.preview({ kind: 'workspace', workspaceId: 'workspace-a' });
    const ids = completed.candidates.map(item => item.id);
    const receipt = await f.service.cleanup(completed.id, ids);
    const unaccepted = await f.service.preview({ kind: 'workspace', workspaceId: 'workspace-b' });
    now += 11 * 60_000;
    // Creating another preview triggers pruning, which must not erase receipts.
    await f.service.preview({ kind: 'shared' });
    expect(await f.service.cleanup(completed.id, ids)).toEqual(receipt);
    await expect(f.service.cleanup(unaccepted.id, unaccepted.candidates.map(item => item.id))).rejects.toThrow('expired');
    expect(await readFile(path.join(f.old, 'workspace', 'workspace-b', 'index.tdb'), 'utf8')).toBe('old-b-longer');
    now += 24 * 60 * 60_000;
    await expect(f.service.cleanup(completed.id, ids)).rejects.toThrow('replay window');
  });

  it('never expires an already running cleanup or dispatches it a second time', async () => {
    const f = await fixture();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let finish!: (value: { byteLengthReclaimed: number; deletedBlobs: number; cleanupFailures: never[] }) => void;
    f.kernel.collectStorageObjects.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const preview = await f.service.preview({ kind: 'shared' });
    const ids = preview.candidates.map(item => item.id);
    const first = f.service.cleanup(preview.id, ids);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    now += 11 * 60_000;
    await f.service.preview({ kind: 'shared' });
    const repeated = f.service.cleanup(preview.id, ids);
    finish({ byteLengthReclaimed: 17, deletedBlobs: 1, cleanupFailures: [] });
    expect(await repeated).toEqual(await first);
    expect(f.kernel.collectStorageObjects).toHaveBeenCalledTimes(1);
  });

  it('authenticates the HTTP boundary and rejects renderer paths or unsupported scope fields', async () => {
    const f = await fixture(), app = express();
    registerStorageRoutes(app, f.service, (request, response, next) => {
      if (request.header('x-fixture-auth') !== 'yes') { response.sendStatus(403); return; }
      request.varinAuth = request.header('x-fixture-readonly') ? { type: 'client', clientId: 'readonly', client: { id: 'readonly', capabilities: ['instance:read', 'config:read', 'filesystem:read'] } } : { type: 'session', token: 'fixture-only' };
      next();
    });
    const server = app.listen(0); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/storage`;
    const post = (action: string, body: unknown, authorized = true) => fetch(`${base}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-fixture-auth': 'yes' } : {}) }, body: JSON.stringify(body) });
    try {
      expect((await post('inventory', { scope: { kind: 'all' } }, false)).status).toBe(403);
      expect((await post('inventory', { scope: { kind: 'all' }, directory: f.root })).status).toBe(400);
      expect((await post('cleanup', { previewId: 'forged', candidateIds: [], path: f.root })).status).toBe(400);
      expect((await post('cleanup', { previewId: 'forged', candidateIds: ['object'] })).status).toBe(409);
      const limited = await fetch(`${base}/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-auth': 'yes', 'x-fixture-readonly': 'yes' }, body: JSON.stringify({ previewId: 'forged', candidateIds: ['object'] }) });
      expect(limited.status).toBe(403);
      expect((await post('inventory', { scope: { kind: 'all' } })).status).toBe(200);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
