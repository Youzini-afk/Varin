import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'vitest';
import { KernelClient, KernelClientError, type KernelGrantHandle } from './kernel-client.js';
import { openExperimentInputTransfer } from '../harness/experiment-workspace.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const hash = `sha256-${'1'.repeat(64)}`;
const branchRoot = `sha256-${'2'.repeat(64)}`;
interface Frame { kind: string; id: string; method?: string; grantId?: string; params?: Record<string, unknown> }

/** Real public client, scoped grant and original input transfer. Only the wire peer is a fixture. */
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-blob-consumer-'));
  roots.push(root);
  const client = new KernelClient({ hostId: 'blob-consumer', storageRoot: root, buildVersion: 'fixture' });
  const owner = client as unknown as {
    epoch: string | null; handshakeResult: unknown; started: boolean; startPromise: Promise<unknown>;
    grantFromResponse(value: Record<string, unknown>): KernelGrantHandle;
    transport: { send(frame: Frame, lane: string): Promise<void>; cancelRequest(id: string, discard: boolean): void; close(): Promise<void> };
    consumeFrame(frame: unknown): void;
    pending: Map<string, unknown>;
  };
  owner.epoch = 'original-epoch';
  owner.handshakeResult = { storageRoot: root };
  owner.started = true;
  owner.startPromise = Promise.resolve(owner.handshakeResult);
  const frames: Array<{ frame: Frame; lane: string }> = [];
  const cancellations: Array<{ id: string; discard: boolean }> = [];
  let readEntered!: (frame: Frame) => void;
  const entered = new Promise<Frame>(resolve => { readEntered = resolve; });
  const reply = (frame: Frame, result: unknown) => owner.consumeFrame({ v: 1, kind: 'response', id: frame.id, ok: true, result });
  const fail = (frame: Frame, code: string) => owner.consumeFrame({ v: 1, kind: 'response', id: frame.id, ok: false, error: { code, message: code } });
  owner.transport = {
    async send(frame, lane) {
      frames.push({ frame, lane });
      if (frame.kind === 'cancel') return;
      switch (frame.method) {
        case 'storage.getBlob': readEntered(frame); break;
        case 'authority.grant.issue':
          reply(frame, { grant_id: frame.params!.grantId, kernel_epoch: owner.epoch, owning_workspace: frame.params!.owningWorkspace, execution_workspace: frame.params!.executionWorkspace });
          break;
        case 'authority.grant.retire':
          reply(frame, { grantIds: [(frame.params!.target as { grantId: string }).grantId] });
          break;
        case 'branch.read':
          reply(frame, { workspaceId: 'owning-workspace', root: branchRoot, currentRoot: branchRoot, entries: [{ path: 'input.txt', state: { kind: 'regular-file', objectHash: hash, byteLength: 3, mode: 420 } }], nextCursor: null });
          break;
        default: throw new Error(`Unexpected wire request: ${frame.method}`);
      }
    },
    cancelRequest(id, discard) { cancellations.push({ id, discard }); },
    async close() {},
  };
  const grant = owner.grantFromResponse({ grant_id: 'original-blob-grant', kernel_epoch: owner.epoch, owning_workspace: 'owning-workspace', execution_workspace: 'execution-workspace' });
  return { client, owner, scoped: client.scoped(grant), frames, cancellations, entered, fail };
}

it('public getBlob retains its original pending request until the actual cancelled response', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let settled = false;
  const reading = f.scoped.getBlob(hash, { ownerId: 'original-object-owner' }, { offset: 1, length: 1, signal: controller.signal })
    .then(value => { settled = true; return value; }, (error: unknown) => { settled = true; return error; });
  const request = await f.entered;
  assert.equal(request.grantId, 'original-blob-grant');
  assert.equal(request.params!.hash, hash);
  assert.equal(request.params!.ownerId, 'original-object-owner');
  controller.abort(); await tick(); await tick();
  assert.equal(settled, false);
  assert.equal(f.owner.pending.has(request.id), true);
  assert.deepEqual(f.cancellations, [{ id: request.id, discard: false }]);
  assert.deepEqual(f.frames.filter(value => value.frame.kind === 'cancel').map(value => [value.frame.id, value.lane]), [[request.id, 'control']]);
  f.fail(request, 'cancelled');
  const outcome = await reading;
  assert.ok(outcome instanceof KernelClientError);
  assert.equal(outcome.code, 'cancelled');
});

it('the original input transfer waits for the read response before closing and retiring its grant once', async () => {
  const f = await fixture();
  const input = {
    schemaVersion: 2 as const,
    source: { kind: 'fixed-branch' as const, branchId: 'original-input', revision: 0, root: branchRoot },
    branchId: 'original-input', root: branchRoot, sourceRoot: null,
    workspaceId: 'owning-workspace', executionWorkspaceId: 'execution-workspace',
    captureScopes: [], capturedPathCount: 1, inventoryFingerprint: null, captureSemantics: null,
  };
  const transfer = await openExperimentInputTransfer(f.client, { workspaceId: input.workspaceId, executionWorkspaceId: input.executionWorkspaceId }, input);
  const controller = new AbortController();
  const iterator = transfer.readObject(hash, 3, controller.signal)[Symbol.asyncIterator]();
  let readSettled = false;
  let closeSettled = false;
  const reading = iterator.next().then(value => { readSettled = true; return value; }, (error: unknown) => { readSettled = true; return error; });
  const request = await f.entered;
  assert.equal(request.params!.branchId, input.branchId);
  assert.equal(request.params!.path, 'input.txt');
  const closing = transfer.close().then(() => { closeSettled = true; });
  controller.abort(); await tick(); await tick();
  assert.equal(readSettled, false);
  assert.equal(closeSettled, false);
  assert.equal(f.frames.some(value => value.frame.method === 'authority.grant.retire'), false);
  assert.equal(f.owner.pending.has(request.id), true);
  f.fail(request, 'cancelled');
  const outcome = await reading;
  await closing;
  await transfer.close();
  const retireCalls = f.frames.filter(value => value.frame.method === 'authority.grant.retire');
  assert.equal(closeSettled, true);
  assert.equal(retireCalls.length, 1);
  const retire = retireCalls[0];
  assert.ok(retire);
  assert.equal((retire.frame.params!.target as { grantId: string }).grantId, request.grantId);
  assert.ok(outcome instanceof KernelClientError);
  assert.equal(outcome.code, 'cancelled');
  await assert.rejects(async () => { for await (const _ of transfer.readObject(hash, 3)) void _; }, /closed/);
});
