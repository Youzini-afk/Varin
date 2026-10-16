import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { FULL_CONTROL_CAPABILITIES } from '../client-auth/remote-clients.js';
import { createKernelClient } from '../kernel/kernel-client.js';
import { createManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import { createManagedRemoteExecutionService } from '../harness/managed-remote-service.js';
import { registerManagedRemoteRoutes } from '../harness/managed-remote-routes.js';
import { createSemanticIndexManagement } from '../knowledge/semantic/index-management.js';
import { createStorageService } from './service.js';
import { createStorageCoordinator } from './coordinator.js';
import { registerStorageRoutes } from './routes.js';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const buildVersion = (JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release/varin-kernel');
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('keeps Agent Host A intact while resource Host B rechecks real Rust references for selected preview hashes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-storage-two-native-hosts-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const make = async (hostId: string) => {
    const data = path.join(root, hostId);
    const kernel = createKernelClient({ hostId, storageRoot: path.join(data, 'kernel'), buildVersion, kernelPath, allowCargoDevRunner: false });
    cleanups.push(() => kernel.close()); await kernel.start();
    const actor = kernel.scoped(await kernel.issueGrant({ grantId: 'fixture', owningWorkspace: 'workspace', executionWorkspace: 'workspace', pathScopes: [''], capabilities: ['storage.read', 'storage.write', 'storage.gc'] }));
    const indexes = createSemanticIndexManagement(data, hostId); await indexes.load();
    const service = createStorageService({ hostId, name: hostId, dataDirectory: data, speechModelsDirectory: path.join(data, 'models'), indexes, kernel, devices: async () => [], workspaces: async () => [] });
    return { hostId, data, kernel, actor, service };
  };
  const a = await make('native-agent-a'), b = await make('native-resource-b');
  const untouched = await a.actor.putBlob(Buffer.from('A unreferenced must remain'), 'a'); await a.actor.releaseBlob(untouched.ownerId);
  const selected = await b.actor.putBlob(Buffer.from('selected body'), 'selected'); await b.actor.releaseBlob(selected.ownerId);
  const protectedBody = Buffer.from('B referenced again');
  const protect = await b.actor.putBlob(protectedBody, 'protect'); await b.actor.releaseBlob(protect.ownerId);
  const app = express();
  const execution = createManagedRemoteExecutionService({ hostId: b.hostId, client: b.kernel, storageAvailable: true,
    resources: { getMachine: async () => ({ machineId: 'local', kind: 'local', state: 'available' }) } as never });
  const auth: express.RequestHandler = (request, response, next) => {
    if (request.headers.authorization !== 'Bearer isolated-fixture') { response.status(403).json({ error: 'Not authorized' }); return; }
    request.varinAuth = { type: 'client', clientId: 'fixture-a', client: { id: 'fixture-a', capabilities: [...FULL_CONTROL_CAPABILITIES] } }; next();
  };
  registerManagedRemoteRoutes(app, { service: execution, requireAuth: auth, resolveAuthContext: async request => request.varinAuth ?? null });
  registerStorageRoutes(app, b.service, auth);
  const server = app.listen(0); await once(server, 'listening'); cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const registry = createManagedRemoteTargetRegistry({ coordinatorHostId: a.hostId, kernel: a.kernel, resources: {} as never,
    readSettings: async () => ({ desktopHosts: [{ id: 'resource-b', label: 'Resource B', apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, clientToken: 'isolated-fixture' }] }) });
  const coordinator = createStorageCoordinator(a.service, registry);
  const target = (await registry.storageTargets())[0]!.target!;
  const inventory = await coordinator.inventory({ kind: 'all' }, undefined, target);
  expect(inventory.device.id).toBe('connection:resource-b'); expect(inventory.root).toBe(b.data); expect(inventory.bytes).toBeGreaterThan(0);
  const preview = await coordinator.preview({ kind: 'shared' }, 'owner-a', target);
  expect(preview.issues).toEqual([]); expect(preview.candidates[0]?.count).toBe(2);
  const retained = await b.actor.putBlob(protectedBody, 'retain-again');
  const late = await b.actor.putBlob(Buffer.from('B new unreferenced'), 'late'); await b.actor.releaseBlob(late.ownerId);
  const result = await coordinator.cleanup(preview.id, preview.candidates.map(item => item.id), 'owner-a');
  expect(result).toMatchObject({ state: 'complete', bytesReclaimed: 13, objectsDeleted: 1, failures: [] });
  expect(await coordinator.cleanup(preview.id, preview.candidates.map(item => item.id), 'owner-a')).toEqual(result);
  expect((await a.kernel.health({ gcPreview: true })).gcPreview?.objects.map(item => item.hash)).toEqual([untouched.hash]);
  expect((await b.kernel.health({ gcPreview: true })).gcPreview?.objects.map(item => item.hash)).toEqual([late.hash]);
  expect(Buffer.from((await b.actor.getBlob(retained.hash, { ownerId: retained.ownerId })).bytesBase64, 'base64')).toEqual(protectedBody);
  expect((await a.kernel.health({ deep: true })).integrity).toBe('ok'); expect((await b.kernel.health({ deep: true })).integrity).toBe('ok');
});
