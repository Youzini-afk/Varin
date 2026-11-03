import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import type { Attachment } from '@varin/protocol';
import { createKernelClient } from '../kernel/kernel-client.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelObjectSlice } from '../kernel/protocol.generated.js';
import type { FileContentReadOptions } from '../kernel/file-content-transfer.js';
import { prepareManagedAttachmentPath } from '../kernel/managed-attachment-path.js';
import { resourceSource } from '../kernel/thread-context.js';
import { createManagedSourceService } from './managed-source-service.js';
import { createManagedRemoteExecutionService } from './managed-remote-service.js';
import { registerManagedRemoteRoutes } from './managed-remote-routes.js';
import { createManagedRemoteTargetRegistry, managedEndpointIdentity } from './managed-remote-client.js';
import type { ManagedSourcePrincipal } from './managed-remote-types.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (bytes: Uint8Array) => `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
const principal: ManagedSourcePrincipal = { principalId: 'authenticated-coordinator', capabilities: ['filesystem:read'] };
const stream = async function* (bytes: Uint8Array) { yield bytes; };

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-managed-attachment-'));
  const workspace = path.join(directory, 'execution'); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'untouched'), 'original execution source');
  const kernel = createKernelClient({ hostId: 'target', storageRoot: path.join(directory, 'storage'), kernelPath, buildVersion, allowCargoDevRunner: false });
  cleanup.push(async () => { await kernel.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await kernel.start();
  const actor = kernel.scoped(await kernel.issueGrant({ grantId: 'fixture-worker', threadId: 'recipient', runId: 'actual-coordinator-run',
    owningWorkspace: 'project', executionWorkspace: 'project', pathScopes: [''], capabilities: ['storage.read', 'storage.write', 'process', 'process.maintenance'] }));
  const root = await actor.fileRootRegister({ workspaceId: 'project', executionWorkspaceId: 'project', canonicalRoot: workspace });
  const createSources = () => createManagedSourceService({ kernel, hostId: 'target',
    documents: { admitWorkspaceRegistration: async () => ({ workspaceId: 'project', hostId: 'target', canonicalPath: workspace }) } as never,
    validateLiveSource: async () => ({ rootId: root.rootId, canonicalRoot: workspace }) as never,
    prepareSource: async () => { throw new Error('Attachment access must never prepare a Source'); },
  });
  let sources = createSources();
  const app = express(); app.use(express.json({ limit: '4kb' }));
  const service = createManagedRemoteExecutionService({ hostId: 'target', client: kernel, sourceOwner: sources,
    resources: { getMachine: async () => ({ machineId: 'local', kind: 'local', state: 'available' }) } as never });
  // Reopen only the stateless Source service; all import and view facts remain
  // in the real native Storage, never in this transport or the coordinator.
  const exposed = { ...service, sources: () => sources };
  registerManagedRemoteRoutes(app, { service: exposed, resolveAuthContext: async request => request.headers.authorization === 'Bearer fixture'
    ? { type: 'client', clientId: principal.principalId, client: { id: principal.principalId, capabilities: [...principal.capabilities] } } : null });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const resourceOwner = { kind: 'managed_host' as const, hostId: 'target', connectionId: 'remote', endpointIdentity: managedEndpointIdentity({ apiUrl }) };
  let losePathResponse = false;
  const registry = createManagedRemoteTargetRegistry({ coordinatorHostId: 'coordinator', kernel: {} as never, resources: {} as never,
    readSettings: async () => ({ desktopHosts: [{ id: 'remote', apiUrl, clientToken: 'fixture' }] }),
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith('/sources/attachmentPath') && losePathResponse) {
        losePathResponse = false; await response.arrayBuffer(); throw new Error('Lost committed path response');
      }
      return response;
    } });
  const client = await registry.source(resourceOwner);
  const selected = { resourceOwner, mode: 'live_root' as const, workspaceId: 'project', executionWorkspaceId: 'project',
    liveRoot: { hostId: 'target', rootId: String(root.rootId), canonicalRoot: String(root.canonicalRoot) }, tools: [] };
  const binding = await client.bind({ coordinatorHostId: 'coordinator', source: selected,
    scope: { kind: 'run', threadId: 'recipient', runId: 'actual-coordinator-run', epoch: 1 }, purpose: 'source', retention: 'run' });
  const source = resourceSource(selected)!;
  const runtime = { coordinatorHostId: 'coordinator', withManagedSourceAuthority: async (_run: string, _source: unknown, consume: (value: unknown) => Promise<unknown>) => consume({ client, binding }) } as AgentRuntimeClient;
  const request = { coordinatorHostId: 'coordinator', authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
  return { directory, workspace, kernel, actor, root, client, request, source, runtime, apiUrl,
    loseResponse() { losePathResponse = true; }, reopen() { sources = createSources(); } };
}

it('streams fixed bytes through authenticated Source routes into an independently retained native path, with retry and real process lifetime', async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(768 * 1024, 0x81), contentHash = hash(bytes);
  const attachment: Attachment = { ref: 'attachment:original', filename: 'data.bin', mimeType: 'application/octet-stream', byteLength: bytes.length };
  let sourceReads = 0;
  const prepare = (selected = attachment, hashValue = contentHash, objects = new Map([[hashValue, bytes]])) => prepareManagedAttachmentPath({ runtime: f.runtime,
    runId: 'actual-coordinator-run', source: f.source, attachment: selected, contentHash: hashValue,
    readPage: async (offset: number, length: number, view: FileContentReadOptions = {}): Promise<KernelObjectSlice> => {
      sourceReads++;
      const key = view.rangeObject ?? hashValue, value = objects.get(key)!;
      const nextOffset = Math.min(value.length, offset + length);
      return { hash: key, byteLength: value.length, offset, nextOffset, eof: nextOffset === value.length, bytesBase64: value.subarray(offset, nextOffset).toString('base64') };
    } });
  f.loseResponse();
  await expect(prepare()).rejects.toThrow('Lost committed path response');
  const initialReads = sourceReads;
  f.reopen();
  const result = await prepare();
  expect(await fs.readFile(result.path)).toEqual(bytes);
  expect(result.readOnly).toBe(true);
  expect(result.path.startsWith(path.join(f.directory, 'storage'))).toBe(true);
  expect(await fs.readFile(path.join(f.workspace, 'untouched'), 'utf8')).toBe('original execution source');
  expect(await fs.readdir(f.workspace)).toEqual(['untouched']);
  if (process.platform !== 'win32') expect((await fs.stat(result.path)).mode & 0o222).toBe(0);
  expect((await prepare()).path).toBe(result.path);
  expect(sourceReads).toBe(initialReads); // A retained root proves all range dependencies too.
  await expect(prepare({ ...attachment, filename: 'changed.bin' })).rejects.toThrow('retry changed');
  await expect(prepare(attachment, hash(Buffer.from('new')))).rejects.toThrow('retry changed');
  expect((await fetch(`${f.apiUrl}/api/harness/managed-execution/v1/sources/attachmentBegin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
  await expect(f.client.attachmentBegin({ ...f.request, authorityId: 'forged', operationId: 'forged', attachment, contentHash })).rejects.toThrow();
  await expect(f.client.attachmentPut({ ...f.request, operationId: 'unbegun', ref: attachment.ref, contentHash, objectHash: contentHash, byteLength: bytes.length }, stream(bytes))).rejects.toThrow();

  // Import a sparse range descriptor without flattening its version identity.
  const dependency = Buffer.from('0123456789'), dependencyHash = hash(dependency);
  const descriptor = Buffer.from(JSON.stringify({ format: 1, byteLength: 8, ranges: [{ offset: 2, length: 4, objectHash: dependencyHash, objectOffset: 3, objectLength: dependency.length }] }));
  const rangeHash = `ranges-${hash(descriptor)}`;
  const ranged = await prepare({ ...attachment, ref: 'attachment:ranged', filename: 'sparse.bin', byteLength: 8 }, rangeHash,
    new Map([[rangeHash, descriptor], [dependencyHash, dependency]]));
  expect(await fs.readFile(ranged.path)).toEqual(Buffer.from([0, 0, 51, 52, 53, 54, 0, 0]));
  const emptyHash = hash(Buffer.alloc(0));
  const empty = await prepare({ ...attachment, ref: 'attachment:empty', filename: 'empty.bin', byteLength: 0 }, emptyHash, new Map([[emptyHash, Buffer.alloc(0)]]));
  expect(await fs.readFile(empty.path)).toEqual(Buffer.alloc(0));
  const retained = await f.actor.listRecords({ workspaceId: 'project', recordType: 'attachment.import', runId: 'actual-coordinator-run' });
  expect(retained.records.some(record => record.references.some(reference => reference.objectHash === rangeHash))).toBe(true);
  expect(retained.records.every(record => record.runId === 'actual-coordinator-run' && record.threadId === 'recipient')).toBe(true);

  const processId = 'original-consumer';
  await f.actor.processSpawn({ workspaceId: 'project', rootId: String(f.root.rootId), processId, cwd: '', command: process.execPath,
    args: ['-e', `const fs = require('fs'); if (fs.readFileSync(process.argv[1])[0] !== 0x81) process.exit(2); console.log('attachment-readable'); setInterval(() => {}, 1000);`, result.path], env: [], mode: 'pipe' });
  try {
    await expect.poll(async () => (await f.actor.processRead({ workspaceId: 'project', rootId: String(f.root.rootId), processId, cursor: 0 })).chunks.map(chunk => Buffer.from(chunk.bytesBase64, 'base64').toString()).join('')).toContain('attachment-readable');
    await expect(f.client.release({ ...f.request, mode: 'retire' })).rejects.toThrow(/retained|executing|active/i);
    expect(await fs.readFile(result.path)).toEqual(bytes);
  } finally { await f.actor.processKill({ workspaceId: 'project', rootId: String(f.root.rootId), processId }); }
  await expect.poll(async () => (await f.actor.processInspect({ workspaceId: 'project', rootId: String(f.root.rootId), processId })).writerActive).toBe(false);
  await f.client.release({ ...f.request, mode: 'retire' });
  await expect(fs.stat(result.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.actor.listRecords({ workspaceId: 'project', recordType: 'attachment.import' })).records).toEqual([]);
}, 60_000);

it('keeps an interrupted binary import unpublished and retries the same fixed intent without widening Source authority', async () => {
  const f = await fixture(), bytes = Buffer.alloc(512 * 1024, 0xa7), contentHash = hash(bytes);
  const attachment: Attachment = { ref: 'attachment:interrupted', filename: 'interrupted.bin', mimeType: 'application/octet-stream', byteLength: bytes.length };
  const original = { ...f.request, operationId: 'same-import-operation', attachment, contentHash };
  expect(await f.client.attachmentBegin(original)).toEqual({ retained: true, complete: false });
  const object = { ...f.request, operationId: original.operationId, ref: attachment.ref, contentHash, objectHash: contentHash, byteLength: bytes.length };
  const broken = (async function* () { yield bytes.subarray(0, 4096); throw new Error('Original transport interrupted'); })();
  await expect(f.client.attachmentPut(object, broken)).rejects.toThrow();
  await expect(f.client.attachmentPath(original)).rejects.toThrow('incomplete');
  await expect(f.client.attachmentBegin({ ...original, resourceEpoch: 'obsolete-target-epoch' })).rejects.toThrow();
  await f.client.attachmentPut(object, stream(bytes));
  expect(await f.client.attachmentBegin(original)).toEqual({ retained: true, complete: true });
  const view = await f.client.attachmentPath(original);
  expect(await fs.readFile(view.path)).toEqual(bytes);
  await f.client.release({ ...f.request, mode: 'retire' });
  await expect(fs.stat(view.path)).rejects.toMatchObject({ code: 'ENOENT' });
}, 60_000);
