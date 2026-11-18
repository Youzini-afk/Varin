import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, expect, it as test, vi } from 'vitest';
import { createPrincipalStore } from '../ui-auth/principals.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createDocumentAuthority } from '../documents/authority.js';
import { createManagedResourceTarget } from '../harness/managed-resource-target.js';
import { createKernelClient } from './kernel-client.js';
import { createHostResourceStorage, createHostResourceExecution } from './host-resource-owners.js';

const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repo, 'kernel/target/release',
  process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const available = await fs.stat(kernelPath).then(() => true, () => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1') throw new Error('Resource role acceptance requires a release kernel');
const it = test.skipIf(!available);
const buildVersion: string = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8')).version;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.unstubAllEnvs(); } });

it('serves only paired resources, retains the storage identity across restart, and never creates an Agent Catalog', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-resource-role-'));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  vi.stubEnv('VARIN_DATA_DIR', dir);
  const hostId = 'paired-test-device';
  const workspace = path.join(dir, 'selected');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'status.txt'), 'resource owner only\n');
  const storageRoot = path.join(dir, 'kernel', hostId);
  const principals = createPrincipalStore(path.join(dir, 'principals.json'));
  const openClients = () => createRemoteClientAuthRuntime({ crypto, fsPromises: fs, path,
    storePath: path.join(dir, 'clients.json'), principals });
  const issuer = openClients();
  const reader = await issuer.createClient({ label: 'Local fixture', capabilities: ['filesystem:read'], allowedDirectories: [workspace] });
  await issuer.dispose();
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');

  const start = async () => {
    const teardown: (() => Promise<unknown> | void)[] = [];
    const close = async () => { for (const stop of teardown.splice(0).reverse()) await stop(); };
    cleanup.push(close);
    const clients = openClients();
    const auth = createUiAuth({ principals, clientAuthController: clients, requireClientAuth: true, getServerId: async () => hostId });
    teardown.push(() => clients.dispose(), auth.dispose);
    const kernel = createKernelClient({ role: 'resources', hostId, storageRoot, buildVersion, kernelPath, allowCargoDevRunner: false });
    teardown.push(() => kernel.close());
    const handshake = await kernel.start();
    expect(handshake.capabilities).toContain('resourcesOnly');
    const documents = createDocumentAuthority({ hostId, dataDir: dir, isAllowedRoot: async root => root === workspace,
      isTrusted: async root => root === workspace });
    const storage = createHostResourceStorage({ kernel, documents: () => documents,
      resolveWorkspaceRoot: async id => (await documents.admitWorkspaceRegistration(id)).canonicalPath });
    teardown.push(() => storage.kernelStorageAdapter.dispose(), () => documents.dispose());
    documents.bindDurableMutationStorage(async (id, operation) => operation(await storage.kernelRecoveryStore.workspaceStorageContext(id)));
    const { kernelCompute, kernelProcesses } = createHostResourceExecution(kernel, documents, error => { throw error; });
    teardown.push(() => kernelCompute.dispose(), () => kernelProcesses.dispose());
    const errors: Error[] = [];
    const target = createManagedResourceTarget({ kernel, storageAvailable: false, onError: e => errors.push(e) });
    teardown.push(() => target.dispose());
    const app = express();
    app.use(express.json());
    target.mount(app, { documents, requireAuth: auth.requireAuth, resolveAuthContext: auth.resolveAuthContext, isDraining: () => false });
    const server = await new Promise<import('node:http').Server>((resolve, reject) => {
      const value = app.listen(0, '127.0.0.1', () => resolve(value)); value.once('error', reject);
    });
    teardown.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const send = (route: string, body?: unknown, token: string | null = reader.token, extra: Record<string, string> = {}) =>
      fetch(origin + '/api/harness/managed-execution/v1' + route, {
        method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
          'Content-Type': 'application/json', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { kernel, kernelCompute, close, send, errors, clients };
  };
  const accept = async (response: Response) => {
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected an object reply');
    return body as Record<string, unknown>;
  };
  const first = await start();
  expect([401, 403]).toContain((await first.send('/identity', undefined, null)).status);
  const identity = await accept(await first.send('/identity'));
  expect(identity.hostId).toBe(hostId);
  expect(identity.capabilities).not.toContain('storage'); // no separate Storage routes in this mount
  expect((await first.send('/documents/workspace/resolve', { path: workspace }, reader.token, { 'x-varin-managed-target': 'other-device' })).status).toBe(409);
  expect((await first.send('/documents/workspace/resolve', { path: dir })).status).toBe(403);
  expect((await first.send('/shell/exec', {})).status).toBe(403);
  const registration = await accept(await first.send('/documents/workspace/resolve', { path: workspace }));
  expect(registration.workspaceId).toBeTruthy();
  await expect(first.kernel.agentRuntimeRequest('runtime.principals.initialize', { ownerPrincipalId: 'fixture', claimLegacy: false }))
    .rejects.toThrow(/Agent service is not running/);
  await expect(first.kernel.publishModelAdapters({ expectedRevision: 0, adapters: [] })).rejects.toThrow(/Agent service is not running/);
  const read = await first.kernelCompute.directory(workspace, { operation: 'read', lane: 'foreground', paths: ['status.txt'] });
  expect(read.records.map(r => r.data)).toContainEqual(expect.objectContaining({ text: 'resource owner only\n' }));
  expect(first.errors).toEqual([]);
  await first.close();

  const second = await start();
  expect((await accept(await second.send('/identity'))).hostId).toBe(hostId);
  expect((await accept(await second.send('/documents/workspace/resolve', { path: workspace }))).workspaceId).toBe(registration.workspaceId);
  await second.clients.revokeClient(reader.client.id);
  expect([401, 403]).toContain((await second.send('/identity')).status);
  expect(second.errors).toEqual([]);
  await second.close();
  expect(await fs.readdir(storageRoot)).toContain('catalog.sqlite'); // Native Storage, not conversations
  await expect(fs.stat(path.join(storageRoot, 'agent-runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
});
