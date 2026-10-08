import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { KernelStorageAdapter, KernelWorkingStateRootStore } from './storage-adapter.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
type Request = { id: string; method: string; grantId?: string; params: Record<string, unknown> };
async function fixture() {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-capture-review-'));
  const workspace = path.join(root, 'workspace');
  const storageRoot = path.join(root, 'storage');
  await fs.mkdir(workspace);
  const requests: Request[] = [];
  const replies: string[] = [];
  let captureSent!: (request: Request) => void;
  const captureRequest = new Promise<Request>(resolve => { captureSent = resolve; });
  const host = createKernelClient({ hostId: 'capture-review', storageRoot, kernelPath, buildVersion, allowCargoDevRunner: false,
    spawnProcess: ((command, args, options) => {
      const child = spawn(command, args ?? [], options ?? {}) as ChildProcessWithoutNullStreams;
      const write = child.stdin.write;
      child.stdin.write = ((...values: unknown[]) => {
        const bytes = values[0];
        if (Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes.readUInt32BE(0) === bytes.length - 4) {
          const request = JSON.parse(bytes.subarray(4).toString()) as Request;
          requests.push(request);
          if (request.method === 'file.captureBatch') captureSent(request);
        }
        return Reflect.apply(write, child.stdin, values);
      }) as typeof child.stdin.write;
      let buffer = Buffer.alloc(0);
      child.stdout.on('data', (bytes: Buffer) => {
        buffer = Buffer.concat([buffer, bytes]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
          const end = 4 + buffer.readUInt32BE(0);
          const response = JSON.parse(buffer.subarray(4, end).toString()) as { id: string };
          replies.push(response.id);
          buffer = buffer.subarray(end);
        }
      });
      return child;
    }) as typeof spawn,
  });
  const adapter = new KernelStorageAdapter({ client: host, hostId: 'capture-review', storageRoot, resolveWorkspaceRoot: async () => workspace });
  cleanups.push(async () => { await adapter.dispose(); await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  await host.start();
  const context = await adapter.context('workspace', 'capture-review');
  const store = new KernelWorkingStateRootStore(context);
  return { root, workspace, storageRoot, host, context, store, requests, replies, captureRequest };
}

it('real captureDirectory batches files through native capture and retains publishable object owners', async () => {
  const f = await fixture();
  const bodies = { 'one.txt': 'first fixture', 'two.txt': 'second fixture', 'same.txt': 'first fixture' };
  for (const [file, body] of Object.entries(bodies)) await fs.writeFile(path.join(f.workspace, file), body);
  const progress: number[] = [];
  const states = await f.store.captureDirectory(f.workspace, Object.keys(bodies), { onProgress: done => progress.push(done) });
  expect(f.requests.some(request => request.method === 'file.captureBatch')).toBe(true);
  expect(f.requests.filter(request => request.method === 'file.capture')).toHaveLength(0);
  for (const [file, body] of Object.entries(bodies)) expect(states[file]).toMatchObject({ kind: 'regular-file', objectHash: `sha256-${createHash('sha256').update(body).digest('hex')}`, byteLength: Buffer.byteLength(body) });
  expect(progress.at(-1)).toBe(3);
  await f.store.createBranch('workspace', 'captured-branch', states, 'fixture-base');
  for (const [file, body] of Object.entries(bodies)) {
    const state = states[file]!;
    if (state.kind !== 'regular-file') throw new Error('expected regular file capture');
    const content = await f.context.client.getBlob(state.objectHash, { branchId: 'captured-branch', path: file }, { offset: 0, length: 1024 });
    expect(Buffer.from(content.bytesBase64, 'base64').toString()).toBe(body);
  }
}, 30_000);

it('captureDirectory copy/hash work allows the Storage health request to finish before capture receipt', async () => {
  const f = await fixture();
  // Sparse fixture keeps setup cheap; the production capture still reads and hashes all bytes.
  const file = await fs.open(path.join(f.workspace, 'large.bin'), 'w');
  await file.truncate(256 * 1024 * 1024);
  await file.close();
  const capture = f.store.captureDirectory(f.workspace, ['large.bin'], { store: false });
  const request = await f.captureRequest;
  const health = f.host.health();
  expect((await health).integrity).toBe('ok');
  const healthRequest = f.requests.findLast(value => value.method === 'storage.health')!;
  const states = await capture;
  expect(states['large.bin']).toMatchObject({ kind: 'regular-file', byteLength: 256 * 1024 * 1024 });
  expect(f.replies.indexOf(healthRequest.id)).toBeLessThan(f.replies.indexOf(request.id));
}, 30_000);

it.each(['cancel', 'revoke'] as const)('in-flight capture retains its physical lease through %s until native completion', async action => {
  const f = await fixture();
  const file = await fs.open(path.join(f.workspace, 'retained.bin'), 'w');
  await file.truncate(512 * 1024 * 1024);
  await file.close();
  const registered = await f.context.client.fileRootRegister({ workspaceId: 'workspace', executionWorkspaceId: 'workspace', canonicalRoot: f.workspace });
  const address = { workspaceId: 'workspace', rootId: String(registered.rootId) };
  const resources = [{ path: 'retained.bin', scope: 'exact' as const }];
  expect((await f.context.client.fileLeaseAcquire({ ...address, leaseId: 'capture-owner', resources })).status).toBe('acquired');
  const contender = f.host.scoped(await f.host.issueGrant({ grantId: 'capture-contender', owningWorkspace: 'workspace', executionWorkspace: 'workspace', pathScopes: [''], capabilities: ['storage.read', 'storage.write'] }));
  const controller = new AbortController();
  const capture = f.context.client.fileCaptureBatch({ ...address, operationId: `capture-${action}`, paths: ['retained.bin'], store: true, leaseId: 'capture-owner' }, controller.signal);
  const completion = capture.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const request = await f.captureRequest;
  await expect.poll(async () => {
    const entries = await fs.readdir(path.join(f.storageRoot, 'staging')).catch(() => [] as string[]);
    for (const entry of entries.filter(name => name.startsWith('file-capture-'))) {
      if ((await fs.stat(path.join(f.storageRoot, 'staging', entry)).catch(() => null))?.size) return true;
    }
    return false;
  }, { interval: 5, timeout: 8_000 }).toBe(true);
  if (action === 'cancel') {
    const released = await f.context.client.fileLeaseRelease({ ...address, leaseId: 'capture-owner' });
    expect(released).toMatchObject({ released: true, deferred: true });
  }
  expect((await contender.fileLeaseAcquire({ ...address, leaseId: 'contender', resources })).status).toBe('busy');
  if (action === 'cancel') controller.abort();
  else await f.host.revokeGrant(request.grantId!);
  const settled = await completion;
  expect(settled.ok).toBe(false);
  if (!settled.ok) expect(String(settled.error)).toMatch(/cancel|revok|forbidden/i);
  expect((await contender.fileLeaseAcquire({ ...address, leaseId: 'contender', resources })).status).toBe('acquired');
  await contender.fileLeaseRelease({ ...address, leaseId: 'contender' });
  expect((await f.host.health({ deep: true })).integrity).toBe('ok');
}, 30_000);
