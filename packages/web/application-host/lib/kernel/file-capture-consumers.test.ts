import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'vitest';
import { KernelClient, KernelClientError, type KernelGrantHandle } from './kernel-client.js';
import { KernelRequestWindow } from './request-window.js';
import { KERNEL_PROTOCOL_VERSION, KERNEL_REQUEST_WINDOW } from './protocol.generated.js';
import { KernelFileResourceBackend } from './file-resource-backend.js';
import type { KernelFileAuthorityContext, KernelStorageAdapter } from './storage-adapter.js';
import type { RecoveryIdentity } from '../recovery/journal-files.js';
import { createLocalExperimentBackend } from '../harness/experiment-backend.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
interface Frame { kind: string; id: string; method?: string; grantId?: string; params?: Record<string, unknown> }
/** Real client, scoped grant, file gate and Experiment backend. Only the wire peer is a fixture. */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-single-capture-'));
  roots.push(root);
  const client = new KernelClient({ hostId: 'capture-consumer', storageRoot: root, buildVersion: 'fixture' });
  const owner = client as unknown as {
    epoch: string | null; handshakeResult: unknown; window: KernelRequestWindow; controlWindow: KernelRequestWindow;
    grantFromResponse(value: Record<string, unknown>): KernelGrantHandle;
    transport: { send(frame: Frame, lane: string): Promise<void>; cancelRequest(id: string, discard: boolean): void; close(): Promise<void> };
    consumeFrame(frame: unknown): void;
    failAll(error: Error): void;
    pending: Map<string, unknown>;
  };
  owner.epoch = 'original-epoch';
  owner.handshakeResult = { storageRoot: root };
  const frames: Array<{ frame: Frame; lane: string }> = [];
  const cancellations: Array<{ id: string; discard: boolean }> = [];
  let captureEntered!: (frame: Frame) => void;
  const entered = new Promise<Frame>(resolve => { captureEntered = resolve; });
  const reply = (frame: Frame, result: unknown) => owner.consumeFrame({ v: KERNEL_PROTOCOL_VERSION, kind: 'response', id: frame.id, ok: true, result });
  const fail = (frame: Frame, code: string) => owner.consumeFrame({ v: KERNEL_PROTOCOL_VERSION, kind: 'response', id: frame.id, ok: false, error: { code, message: code } });
  owner.transport = {
    async send(frame, lane) {
      frames.push({ frame, lane });
      if (frame.kind === 'cancel') return;
      switch (frame.method) {
        case 'file.capture': captureEntered(frame); break;
        case 'file.lease.wait': reply(frame, { status: 'acquired' }); break;
        case 'file.lease.check': reply(frame, { checked: true }); break;
        case 'file.lease.release': reply(frame, { released: true }); break;
        case 'process.release': reply(frame, { released: true }); break;
        case 'authority.grant.retire': reply(frame, { state: 'retired' }); break;
        default: throw new Error(`Unexpected wire request: ${frame.method}`);
      }
    },
    cancelRequest(id, discard) { cancellations.push({ id, discard }); },
    async close() {},
  };
  const grant = owner.grantFromResponse({ grant_id: 'original-grant', kernel_epoch: 'original-epoch', owning_workspace: 'workspace', execution_workspace: 'workspace' });
  const scoped = client.scoped(grant);
  const authority: KernelFileAuthorityContext = {
    client: scoped, rootId: 'original-root', owningWorkspaceId: 'workspace', executionWorkspaceId: 'workspace', canonicalRoot: root,
    pendingFileOperations: [], reconcilePendingFileOperation: async () => ({}),
  };
  const identity: RecoveryIdentity = { workspaceId: 'workspace', canonicalRoot: root, authorityId: 'host', filesystemProfile: 'fixture' };
  const backend = new KernelFileResourceBackend({} as KernelStorageAdapter, { authority });
  const site = { workspaceId: 'workspace', rootId: 'original-root', canonicalRoot: root, transport: scoped };
  const state = { kind: 'regular-file', objectHash: `sha256-${'1'.repeat(64)}`, byteLength: 3, mode: 420 };
  return { client, owner, scoped, backend, identity, site, state, frames, cancellations, entered, reply, fail };
}

it('captureDetailed keeps its original gate lease and signal until the actual cancelled response', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let settled = false;
  const reading = f.backend.gateFor(f.identity).run([{ resourceId: 'output', scope: 'exact' }],
    () => f.backend.captureDetailed(f.identity, 'output', { store: false }, 'original-capture'), { signal: controller.signal })
    .catch(error => { settled = true; return error; });
  const capture = await f.entered;
  const acquire = f.frames.find(value => value.frame.method === 'file.lease.wait')!.frame;
  assert.equal(capture.grantId, 'original-grant');
  assert.equal(capture.params!.leaseId, acquire.params!.leaseId);
  assert.equal(capture.params!.rootId, 'original-root');
  assert.equal(capture.params!.store, false);
  controller.abort(); await tick();
  assert.equal(settled, false);
  assert.deepEqual(f.cancellations, [{ id: capture.id, discard: false }]);
  assert.deepEqual(f.frames.filter(value => value.frame.kind === 'cancel').map(value => [value.frame.id, value.lane]), [[capture.id, 'control']]);
  assert.equal(f.frames.some(value => value.frame.method === 'file.lease.release'), false);
  f.fail(capture, 'cancelled');
  assert.ok(await reading instanceof KernelClientError);
  const release = f.frames.find(value => value.frame.method === 'file.lease.release')!.frame;
  assert.equal(release.grantId, capture.grantId);
  assert.equal(release.params!.leaseId, capture.params!.leaseId);
});

it('captureDetailed consumes the original single reply and releases only its own gate lease', async () => {
  const f = await fixture();
  const reading = f.backend.captureDetailed(f.identity, 'output', { store: true }, 'single-owner');
  const capture = await f.entered;
  f.reply(capture, { path: 'output', stateJson: JSON.stringify(f.state), ownerId: 'original-object-owner' });
  assert.deepEqual(await reading, { path: 'output', state: f.state, ownerId: 'original-object-owner' });
  assert.equal(f.frames.filter(value => value.frame.method === 'file.capture').length, 1);
  assert.equal(f.frames.filter(value => value.frame.method === 'file.captureBatch').length, 0);
  assert.equal(f.frames.filter(value => value.frame.method === 'file.lease.release').length, 1);
});

it('the actual local Experiment backend retains collection through capture response before process and grant release', async () => {
  const f = await fixture();
  let retired = 0;
  const backend = createLocalExperimentBackend(f.scoped, async () => { retired++; });
  const reading = backend.collectFile(f.site, 'output', 'original-job');
  const capture = await f.entered;
  assert.equal(capture.params!.rootId, f.site.rootId);
  assert.equal(capture.params!.leaseId, undefined, 'the native single worker owns its implicit physical reader lease');
  let released = false;
  const releasing = backend.release(f.site, 'original-job').then(() => { released = true; });
  await tick();
  assert.equal(released, false); assert.equal(retired, 0);
  assert.equal(f.frames.some(value => value.frame.method === 'process.release'), false);
  f.reply(capture, { path: 'output', stateJson: JSON.stringify(f.state), ownerId: 'output-owner' });
  assert.deepEqual(await reading, { objectHash: f.state.objectHash, byteLength: 3, ownerId: 'output-owner' });
  await releasing;
  assert.equal(f.frames.filter(value => value.frame.method === 'process.release').length, 1);
  assert.equal(retired, 1);
});

it('transport loss cannot release the original Experiment grant or reuse old capture authority after a new epoch', async () => {
  const f = await fixture();
  let retired = 0;
  const backend = createLocalExperimentBackend(f.scoped, async () => { retired++; });
  const reading = backend.collectFile(f.site, 'output', 'original-job').catch(error => error);
  await f.entered;
  f.owner.failAll(new KernelClientError({ code: 'kernel-disconnected', message: 'no reader-drain receipt' }));
  assert.equal((await reading as KernelClientError).code, 'kernel-disconnected');
  await assert.rejects(backend.release(f.site, 'original-job'), (error: unknown) => error instanceof KernelClientError);
  assert.equal(retired, 0);
  // A new handshake does not turn an old grant into authority for a new capture or release.
  f.owner.epoch = 'replacement-epoch'; f.owner.handshakeResult = {};
  f.owner.window = new KernelRequestWindow(KERNEL_REQUEST_WINDOW);
  f.owner.controlWindow = new KernelRequestWindow(KERNEL_REQUEST_WINDOW);
  await assert.rejects(f.scoped.fileCapture({ operationId: 'late', workspaceId: 'workspace', rootId: 'original-root', path: 'output', store: true }),
    (error: unknown) => error instanceof KernelClientError && error.code === 'kernel-grant-stale');
  await assert.rejects(f.scoped.fileLeaseRelease({ workspaceId: 'workspace', rootId: 'original-root', leaseId: 'old-lease' }),
    (error: unknown) => error instanceof KernelClientError);
  assert.equal(retired, 0);
  assert.equal(f.frames.filter(value => value.frame.method === 'process.release' || value.frame.method === 'file.lease.release').length, 0);
});

it('transport loss rejects captureDetailed without emitting a physical lease-release success', async () => {
  const f = await fixture();
  const reading = f.backend.captureDetailed(f.identity, 'output').catch(error => error);
  await f.entered;
  f.owner.failAll(new KernelClientError({ code: 'kernel-disconnected', message: 'no reader-drain receipt' }));
  assert.equal((await reading as KernelClientError).code, 'kernel-disconnected');
  assert.equal(f.frames.some(value => value.frame.method === 'file.lease.release'), false);
});


it.each(['outer', 'inner'] as const)('nested capture uses the same physical lease while the %s signal reaches its actual reader', async source => {
  const f = await fixture();
  const outer = new AbortController(); const inner = new AbortController();
  const gate = f.backend.gateFor(f.identity);
  const reading = gate.run([{ resourceId: 'output', scope: 'exact' }],
    () => gate.run([{ resourceId: 'output', scope: 'exact' }],
      () => f.backend.captureDetailed(f.identity, 'output'), { signal: inner.signal }), { signal: outer.signal })
    .catch(error => error);
  const capture = await f.entered;
  (source === 'outer' ? outer : inner).abort(); await tick();
  assert.deepEqual(f.cancellations, [{ id: capture.id, discard: false }]);
  assert.equal(f.frames.filter(value => value.frame.method === 'file.lease.wait').length, 1);
  assert.equal(f.frames.filter(value => value.frame.method === 'file.lease.check').length, 1);
  assert.equal(f.frames.some(value => value.frame.method === 'file.lease.release'), false);
  f.fail(capture, 'cancelled');
  assert.equal((await reading as KernelClientError).code, 'cancelled');
  assert.equal(f.frames.filter(value => value.frame.method === 'file.lease.release').length, 1);
});
