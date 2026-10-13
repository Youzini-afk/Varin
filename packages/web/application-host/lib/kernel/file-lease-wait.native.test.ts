import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient, type KernelScopedClient } from './kernel-client.js';
import { TransportFixture } from './tests/transport-fixture.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  await fs.access(kernelPath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-lease-wait-'));
  const workspace = path.join(directory, 'work');
  await fs.mkdir(workspace);
  const probe = new TransportFixture();
  const host = createKernelClient({ hostId: 'lease-wait', storageRoot: path.join(directory, 'store'), kernelPath,
    buildVersion, allowCargoDevRunner: false, transportFactory: probe.create });
  cleanups.push(async () => { await host.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await host.start();
  const actor = async (grantId: string) => host.scoped(await host.issueGrant({ grantId,
    owningWorkspace: 'workspace', executionWorkspace: 'workspace', pathScopes: [''], capabilities: ['storage.read', 'storage.write'] }));
  const owner = await actor('owner');
  const registered = await owner.fileRootRegister({ workspaceId: 'workspace', executionWorkspaceId: 'workspace', canonicalRoot: workspace });
  const address = { workspaceId: 'workspace', rootId: String(registered.rootId) };
  const params = (leaseId: string, paths: string[]) => ({ ...address, leaseId, resources: paths.map(item => ({ path: item, scope: 'exact' as const })) });
  const release = (client: KernelScopedClient, leaseId: string) => client.fileLeaseRelease({ ...address, leaseId });
  const accepted = async (leaseId: string) => {
    await expect.poll(() => {
      const request = probe.sent.find(frame => frame.kind === 'request' && frame.method === 'file.lease.wait'
        && (frame.params as { leaseId?: string } | undefined)?.leaseId === leaseId);
      return Boolean(request && probe.received.some(frame => frame.kind === 'request-credit-released' && frame.id === request.id));
    }).toBe(true);
  };
  return { host, owner, actor, address, params, release, accepted, probe };
}

function outcome<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  void result.catch(() => undefined);
  return { result, settled: () => settled };
}

it('waits in overlap order, lets unrelated resources pass, and leaves control and metadata usable', async () => {
  const f = await fixture();
  expect(await f.owner.fileLeaseAcquire(f.params('held-a', ['a']))).toMatchObject({ status: 'acquired' });
  const first = outcome(f.owner.fileLeaseWait(f.params('first-a-b', ['a', 'b'])));
  await f.accepted('first-a-b');
  const second = outcome(f.owner.fileLeaseWait(f.params('second-b', ['b'])));
  await f.accepted('second-b');

  expect(await f.owner.fileLeaseWait(f.params('unrelated-c', ['c']))).toMatchObject({ status: 'acquired' });
  expect(await f.owner.fileLeaseAcquire(f.params('cannot-jump-b', ['b']))).toMatchObject({ status: 'busy' });
  expect((await f.owner.health()).integrity).toBe('ok');
  expect((await f.host.agentRuntimeRequest<{ epoch: number }, 'runtime.status'>('runtime.status', {})).epoch).toBeGreaterThan(0);
  expect(first.settled()).toBe(false);
  expect(second.settled()).toBe(false);

  await f.release(f.owner, 'held-a');
  expect(await first.result).toMatchObject({ leaseId: 'first-a-b', status: 'acquired', reused: false });
  expect(second.settled()).toBe(false);
  await f.release(f.owner, 'first-a-b');
  expect(await second.result).toMatchObject({ leaseId: 'second-b', status: 'acquired' });
  const waits = f.probe.sent.filter(frame => frame.kind === 'request' && frame.method === 'file.lease.wait');
  expect(waits).toHaveLength(3);
  expect(f.probe.sent.filter(frame => frame.kind === 'request' && frame.method === 'file.lease.acquire')).toHaveLength(2);
}, 30_000);

it('cancels only the original waiter and never treats a late abort as release of an acquired lease', async () => {
  const f = await fixture();
  await f.owner.fileLeaseAcquire(f.params('holder', ['shared']));
  const controller = new AbortController();
  const cancelled = outcome(f.owner.fileLeaseWait(f.params('cancelled-waiter', ['shared']), controller.signal));
  const rejected = expect(cancelled.result).rejects.toThrow(/cancelled/i);
  await f.accepted('cancelled-waiter');
  const survivor = outcome(f.owner.fileLeaseWait(f.params('surviving-waiter', ['shared'])));
  await f.accepted('surviving-waiter');
  controller.abort();
  await rejected;
  expect(survivor.settled()).toBe(false);
  expect((await f.owner.health()).integrity).toBe('ok');
  await f.release(f.owner, 'holder');
  expect(await survivor.result).toMatchObject({ leaseId: 'surviving-waiter', status: 'acquired' });
  expect(await f.release(f.owner, 'cancelled-waiter')).toMatchObject({ released: false });
  await f.release(f.owner, 'surviving-waiter');

  const after = new AbortController();
  f.probe.hold = frame => (frame.result as { leaseId?: string } | undefined)?.leaseId === 'already-acquired';
  const acquired = outcome(f.owner.fileLeaseWait(f.params('already-acquired', ['shared']), after.signal));
  try {
    await expect.poll(() => f.probe.held.length).toBe(1);
    after.abort();
    // Rust has granted this lease. Cancelling an observer cannot erase that fact or
    // release its exclusion before the original caller receives and settles it.
    expect(await f.owner.fileLeaseAcquire(f.params('still-blocked', ['shared']))).toMatchObject({ status: 'busy' });
    expect(acquired.settled()).toBe(false);
  } finally { f.probe.release(); }
  expect(await acquired.result).toMatchObject({ status: 'acquired', leaseId: 'already-acquired' });
  await f.release(f.owner, 'already-acquired');
  expect(await f.owner.fileLeaseAcquire(f.params('still-blocked', ['shared']))).toMatchObject({ status: 'acquired' });
}, 30_000);

it('withdraws a revoked grant waiter without poisoning another grant or leaving its reservation behind', async () => {
  const f = await fixture();
  const revoked = await f.actor('revoked');
  const live = await f.actor('live');
  await f.owner.fileLeaseAcquire(f.params('holder', ['shared']));
  const cancelled = outcome(revoked.fileLeaseWait(f.params('revoked-waiter', ['shared'])));
  const rejected = expect(cancelled.result).rejects.toThrow(/cancel|grant|authoriz|revok/i);
  await f.accepted('revoked-waiter');
  const survivor = outcome(live.fileLeaseWait(f.params('live-waiter', ['shared'])));
  await f.accepted('live-waiter');
  await f.host.revokeGrant('revoked');
  await rejected;
  expect(survivor.settled()).toBe(false);
  await f.release(f.owner, 'holder');
  expect(await survivor.result).toMatchObject({ status: 'acquired', leaseId: 'live-waiter' });
  expect((await live.health()).integrity).toBe('ok');

  const replacement = outcome(f.owner.fileLeaseWait(f.params('after-owner-revocation', ['shared'])));
  await f.accepted('after-owner-revocation');
  expect(replacement.settled()).toBe(false);
  await f.host.revokeGrant('live');
  expect(await replacement.result).toMatchObject({ status: 'acquired', leaseId: 'after-owner-revocation' });
}, 30_000);
