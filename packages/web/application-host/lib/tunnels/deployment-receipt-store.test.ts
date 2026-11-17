import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDeploymentReceiptStore,
  type DeploymentReceiptBinding, type DeploymentReceiptCompletion, type DeploymentReceiptEffectContext,
  type DeploymentReceiptRequest,
} from './deployment-receipt-store.js';

// Real temporary files and real sync/rename calls. Only individual sync failures are injected.
const faults = vi.hoisted(() => ({ failure: null as null | { directory: string; kind: 'file-sync' | 'directory-after-rename' | 'directory-sync'; minRevision?: number; repeat?: boolean } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      const failure = faults.failure;
      const filename = String(args[0]);
      if (failure && ((failure.kind === 'file-sync' && filename.startsWith(`${failure.directory}${path.sep}`) && filename.endsWith('.tmp'))
        || (failure.kind === 'directory-sync' && filename === failure.directory)
        || (failure.kind === 'directory-after-rename' && filename === failure.directory
          && await (async () => {
            const files = (await actual.readdir(filename)).filter((entry) => entry.endsWith('.json'));
            for (const entry of files) {
              const ledger = JSON.parse(await actual.readFile(path.join(filename, entry), 'utf8')) as { revision: number };
              if (ledger.revision >= (failure.minRevision ?? 0)) return true;
            }
            return false;
          })()))) {
        if (!failure.repeat) faults.failure = null;
        throw new Error('injected private filesystem sync error');
      }
      await originalSync();
    };
    return handle;
  } };
});

const roots: string[] = [];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const input = (overrides: Partial<DeploymentReceiptRequest> = {}): DeploymentReceiptRequest => ({
  deploymentId: 'home-vps', reviewedRevision: 0, operationId: 'deployment-operation-1', planDigest: 'a'.repeat(64),
  target: { sshTargetId: 'vps', hostKeyFingerprint: `SHA256:${'a'.repeat(43)}` },
  steps: [{ id: 'configure', stage: 'configure-proxy' }, { id: 'verify', stage: 'verify-entrypoint' }],
  resources: [{ id: 'proxy-config', kind: 'file', action: 'create', ownership: 'owned' }], ...overrides,
});
const completion = (): DeploymentReceiptCompletion => ({
  state: 'completed', stopped: true,
  steps: [{ id: 'configure', state: 'completed' }, { id: 'verify', state: 'completed' }],
  resources: [{ id: 'proxy-config', result: 'created' }],
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-deployment-receipts-'));
  roots.push(root);
  const directory = path.join(root, 'receipts');
  const store = createDeploymentReceiptStore(directory);
  const filename = (deploymentId = 'home-vps') => path.join(directory, `${createHash('sha256').update(deploymentId).digest('hex')}.json`);
  const lock = (deploymentId = 'home-vps') => filename(deploymentId).replace(/\.json$/, '.lock');
  return { root, directory, store, filename, lock, reopen: () => createDeploymentReceiptStore(directory) };
}
async function durableWrite(filename: string, content: string) {
  const handle = await open(filename, 'w', 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
afterEach(async () => {
  faults.failure = null;
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// Directory fsync and permission assertions are the server's POSIX contract, not portable Windows claims.
describe.skipIf(process.platform === 'win32')('durable server deployment receipt store', () => {
  it('keeps empty-state reconciliation strictly read-only', async () => {
    const f = await fixture();
    expect(await f.store.snapshot('home-vps')).toEqual({ deploymentId: 'home-vps', revision: 0, target: null, activeOperationId: null });
    expect(await f.store.reconcile(input())).toBeNull();
    expect(await readdir(f.root)).toEqual([]);
  });

  it('returns durable completion after a proxy-like effect loses its caller acknowledgment, without replay', async () => {
    const f = await fixture();
    const live = path.join(f.root, 'proxy.conf');
    const reloads = path.join(f.root, 'proxy-reloads');
    const effect = vi.fn(async () => {
      await durableWrite(`${live}.candidate`, 'reverse_proxy 127.0.0.1:45819\n');
      await rename(`${live}.candidate`, live);
      await durableWrite(reloads, 'reload\n');
      return completion();
    });
    // The caller loses the response after the remote owner durably committed it.
    await expect((async () => { await f.store.execute(input(), effect); throw new Error('caller disconnected'); })()).rejects.toThrow('caller disconnected');
    const reopened = f.reopen();
    const replay = vi.fn(async () => { await writeFile(reloads, 'UNSAFE SECOND RELOAD'); return completion(); });
    const result = await reopened.execute(input(), replay);
    expect(result).toMatchObject({ revision: 2, reviewedRevision: 0, outcome: 'terminal', receipt: { state: 'completed', stopped: true, sequence: 1 } });
    expect(await reopened.reconcile(input())).toEqual(result);
    expect(effect).toHaveBeenCalledOnce();
    expect(replay).not.toHaveBeenCalled();
    expect(await readFile(live, 'utf8')).toBe('reverse_proxy 127.0.0.1:45819\n');
    expect(await readFile(reloads, 'utf8')).toBe('reload\n');
    expect((await stat(f.filename())).mode & 0o777).toBe(0o600);
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    expect(await readdir(f.directory)).toEqual([path.basename(f.filename())]);
  });

  it('retains unknown effects across reopen; a missing/unloaded transient unit proves neither cancellation nor completion', async () => {
    const f = await fixture();
    const live = path.join(f.root, 'proxy.conf');
    await f.store.execute(input(), async () => {
      await durableWrite(live, 'effect happened, receipt did not finish');
      throw new Error('SSH stderr contains a secret');
    });
    const before = await readFile(f.filename(), 'utf8');
    const inspectTransientUnit = vi.fn(async () => ({ loadState: 'not-found', activeState: 'inactive', mainPid: null }));
    expect(await inspectTransientUnit()).toMatchObject({ loadState: 'not-found' });
    const reopened = f.reopen();
    const observed = await reopened.reconcile(input());
    expect(observed).toMatchObject({ outcome: 'unknown', receipt: { state: 'running', stopped: false } });
    expect(await readFile(f.filename(), 'utf8')).toBe(before);
    const replay = vi.fn(async () => completion());
    expect(await reopened.execute(input(), replay)).toEqual(observed);
    await expect(reopened.execute(input({ operationId: 'later-operation', reviewedRevision: observed!.revision }), replay))
      .rejects.toMatchObject({ code: 'operation_in_progress' });
    await expect(reopened.preventStart(input())).rejects.toMatchObject({ code: 'operation_in_progress' });
    expect(replay).not.toHaveBeenCalled();
    expect(await readFile(live, 'utf8')).toBe('effect happened, receipt did not finish');
    expect(before).not.toContain('secret');
  });

  it('keeps per-deployment ownership exclusive while allowing an independent deployment', async () => {
    const f = await fixture();
    const entered = deferred<void>();
    const finish = deferred<DeploymentReceiptCompletion>();
    const first = f.store.execute(input(), async () => { entered.resolve(); return finish.promise; });
    await entered.promise;
    const otherOwner = f.reopen();
    const duplicate = vi.fn(async () => completion());
    expect(await otherOwner.execute(input(), duplicate)).toMatchObject({ outcome: 'unknown' });
    const snapshot = await otherOwner.snapshot('home-vps');
    await expect(otherOwner.execute(input({ operationId: 'competing-operation', reviewedRevision: snapshot.revision }), duplicate))
      .rejects.toMatchObject({ code: 'operation_in_progress' });
    expect(await otherOwner.execute(input({ deploymentId: 'independent-vps' }), async () => completion())).toMatchObject({ outcome: 'terminal' });
    expect(duplicate).not.toHaveBeenCalled();
    finish.resolve(completion());
    expect(await first).toMatchObject({ outcome: 'terminal' });
  });

  it('uses atomic filesystem exclusion when two owners submit simultaneously', async () => {
    const f = await fixture();
    const gate = deferred<DeploymentReceiptCompletion>();
    const entered = deferred<void>();
    const effect = vi.fn(async () => { entered.resolve(); return gate.promise; });
    const calls = [f.store.execute(input(), effect), f.reopen().execute(input(), effect)];
    // Attach rejection handlers before awaiting the winning writer.
    const both = Promise.allSettled(calls);
    await entered.promise;
    gate.resolve(completion());
    const results = await both;
    expect(effect).toHaveBeenCalledOnce();
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'storage_locked' });
    expect(await f.reopen().execute(input(), effect)).toMatchObject({ outcome: 'terminal' });
    expect(effect).toHaveBeenCalledOnce();
  });

  it('fences delayed duplicates with permanent terminal tombstones, including a never-started operation', async () => {
    const f = await fixture();
    const tombstone = await f.store.preventStart(input());
    expect(tombstone).toMatchObject({ revision: 1, outcome: 'terminal', receipt: { state: 'stopped', stopped: true } });
    const effect = vi.fn(async () => completion());
    expect(await f.reopen().execute(input(), effect)).toEqual(tombstone);
    expect(effect).not.toHaveBeenCalled();
    const next = input({ reviewedRevision: 1, operationId: 'replacement-operation', planDigest: 'b'.repeat(64) });
    expect(await f.store.execute(next, effect)).toMatchObject({ revision: 3, outcome: 'terminal' });
    expect(await f.reopen().execute(input(), effect)).toMatchObject({ revision: 3, receipt: { operationId: input().operationId, state: 'stopped' } });
    expect(effect).toHaveBeenCalledOnce();
  });

  it('binds operation IDs to the exact reviewed revision, target, digest, and step/resource schema', async () => {
    const f = await fixture();
    await f.store.preventStart(input());
    const effect = vi.fn(async () => completion());
    const changes: Partial<DeploymentReceiptRequest>[] = [
      { reviewedRevision: 1 }, { planDigest: 'b'.repeat(64) },
      { target: { ...input().target, hostKeyFingerprint: `SHA256:${'b'.repeat(43)}` } },
      { steps: [{ id: 'unreviewed', stage: 'configure-proxy' }] }, { resources: [] },
    ];
    for (const change of changes) await expect(f.store.execute(input(change), effect)).rejects.toMatchObject({ code: 'binding_mismatch' });
    await expect(f.store.reconcile(input({ reviewedRevision: 1 }))).rejects.toMatchObject({ code: 'binding_mismatch' });
    await expect(f.store.execute(input({ operationId: 'new-operation' }), effect)).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(f.store.execute(input({ operationId: 'new-operation', reviewedRevision: 1,
      target: { ...input().target, sshTargetId: 'different-vps' } }), effect)).rejects.toMatchObject({ code: 'binding_mismatch' });
    expect(effect).not.toHaveBeenCalled();
  });

  it('drains accepted checkpoints before completion and closes the writer capability afterward', async () => {
    const f = await fixture();
    let context!: DeploymentReceiptEffectContext;
    const result = await f.store.execute(input(), async (writer) => {
      context = writer;
      void writer.checkpoint({ steps: [{ id: 'configure', state: 'running' }, { id: 'verify', state: 'pending' }], resources: [] });
      void writer.checkpoint({ steps: [{ id: 'configure', state: 'completed' }, { id: 'verify', state: 'running' }],
        resources: [{ id: 'proxy-config', result: 'created' }] });
      return { ...completion(), privateOutput: 'must never be persisted' };
    });
    expect(result).toMatchObject({ revision: 4, receipt: { sequence: 3, state: 'completed' } });
    await expect(context.checkpoint(completion())).rejects.toMatchObject({ code: 'writer_closed' });
    expect(await readFile(f.filename(), 'utf8')).not.toContain('privateOutput');
    expect(JSON.stringify(result)).not.toContain('must never');
  });

  it('records a proved partial stop without erasing completed effects', async () => {
    const f = await fixture();
    const stopped = await f.store.execute(input(), async (writer) => {
      const progress = { steps: [{ id: 'configure', state: 'completed' as const }, { id: 'verify', state: 'pending' as const }],
        resources: [{ id: 'proxy-config', result: 'created' as const }] };
      await writer.checkpoint(progress);
      return { ...progress, state: 'stopped', stopped: true };
    });
    expect(stopped).toMatchObject({ outcome: 'terminal', receipt: { state: 'stopped', resources: [{ id: 'proxy-config', result: 'created' }] } });
    expect((await f.store.snapshot('home-vps')).activeOperationId).toBeNull();
  });

  it.each(['stop', 'step', 'resource', 'incomplete'] as const)('does not release ownership on invalid %s proof', async (kind) => {
    const f = await fixture();
    const proof = completion();
    if (kind === 'stop') (proof as { stopped: boolean }).stopped = false;
    if (kind === 'step') proof.steps[0]!.id = 'not-reviewed';
    if (kind === 'resource') proof.resources[0]!.result = 'removed';
    if (kind === 'incomplete') proof.steps[1]!.state = 'pending';
    await expect(f.store.execute(input(), async () => proof)).rejects.toMatchObject({ code: 'invalid_receipt' });
    expect(await f.reopen().reconcile(input())).toMatchObject({ outcome: 'unknown', receipt: { stopped: false } });
    expect((await f.store.snapshot('home-vps')).activeOperationId).toBe(input().operationId);
  });

  it('never regresses confirmed step/resource results or turns a thrown checkpoint into failure proof', async () => {
    const f = await fixture();
    const result = await f.store.execute(input(), async (writer) => {
      await writer.checkpoint({ ...completion(), steps: [{ id: 'configure', state: 'completed' }, { id: 'verify', state: 'running' }] });
      await writer.checkpoint({ steps: [{ id: 'configure', state: 'pending' }, { id: 'verify', state: 'running' }], resources: [] });
      return completion();
    });
    expect(result).toMatchObject({ outcome: 'unknown', receipt: { sequence: 1, state: 'running',
      resources: [{ id: 'proxy-config', result: 'created' }] } });
  });

  it('preserves the previous valid generation when syncing a candidate file fails', async () => {
    const f = await fixture();
    await f.store.preventStart(input());
    const before = await readFile(f.filename(), 'utf8');
    faults.failure = { directory: f.directory, kind: 'file-sync' };
    const effect = vi.fn(async () => completion());
    const next = input({ reviewedRevision: 1, operationId: 'new-operation' });
    await expect(f.store.execute(next, effect)).rejects.toMatchObject({ code: 'storage_failed' });
    expect(effect).not.toHaveBeenCalled();
    expect(await readFile(f.filename(), 'utf8')).toBe(before);
    expect(await f.store.reconcile(next)).toBeNull();
    expect(await readdir(f.directory)).toEqual([path.basename(f.filename())]);
  });

  it('never acknowledges durability or dispatches effects when directory sync fails after rename', async () => {
    const f = await fixture();
    faults.failure = { directory: f.directory, kind: 'directory-after-rename' };
    const effect = vi.fn(async () => completion());
    await expect(f.store.execute(input(), effect)).rejects.toMatchObject({ code: 'storage_failed' });
    expect(effect).not.toHaveBeenCalled();
    // The rename may have taken effect. The visible queued evidence is not authority to retry the effect.
    expect(await f.reopen().execute(input(), effect)).toMatchObject({ outcome: 'unknown', receipt: { stopped: false } });
    expect(effect).not.toHaveBeenCalled();
  });

  it('requires parent-directory sync even when a prior failed creation left the store directory visible', async () => {
    const f = await fixture();
    faults.failure = { directory: f.root, kind: 'directory-sync', repeat: true };
    const effect = vi.fn(async () => completion());
    await expect(f.store.execute(input(), effect)).rejects.toMatchObject({ code: 'storage_failed' });
    expect((await stat(f.directory)).isDirectory()).toBe(true);
    await expect(f.reopen().execute(input(), effect)).rejects.toMatchObject({ code: 'storage_failed' });
    expect(effect).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual([]);
    faults.failure = null;
    expect(await f.reopen().execute(input(), effect)).toMatchObject({ outcome: 'terminal' });
    expect(effect).toHaveBeenCalledOnce();
  });

  it('seals visible terminal evidence before acknowledging it after repeated post-rename directory-sync failure', async () => {
    const f = await fixture();
    const effect = vi.fn(async () => {
      faults.failure = { directory: f.directory, kind: 'directory-after-rename', minRevision: 2, repeat: true };
      return completion();
    });
    await expect(f.store.execute(input(), effect)).rejects.toMatchObject({ code: 'storage_failed' });
    // The completed file is visible, but neither commit nor cleanup could seal the directory entry.
    expect(JSON.parse(await readFile(f.filename(), 'utf8'))).toMatchObject({ revision: 2 });
    const replay = vi.fn(async () => completion());
    await expect(f.reopen().reconcile(input())).rejects.toMatchObject({ code: 'storage_failed' });
    await expect(f.reopen().execute(input(), replay)).rejects.toMatchObject({ code: 'storage_failed' });
    faults.failure = null;
    // Reading now seals the already-synced file's directory entry, without repeating the effect.
    expect(await f.reopen().execute(input(), replay)).toMatchObject({ outcome: 'terminal', receipt: { state: 'completed' } });
    expect(effect).toHaveBeenCalledOnce();
    expect(replay).not.toHaveBeenCalled();
  });

  it('never steals stale writer locks, but exact duplicates and reconciliation can still read durable evidence', async () => {
    const f = await fixture();
    await f.store.preventStart(input());
    await mkdir(f.lock(), { mode: 0o700 });
    const before = await readFile(f.filename(), 'utf8');
    const effect = vi.fn(async () => completion());
    expect(await f.reopen().execute(input(), effect)).toMatchObject({ outcome: 'terminal' });
    expect(await f.reopen().reconcile(input())).toMatchObject({ outcome: 'terminal' });
    await expect(f.store.execute(input({ operationId: 'new-operation', reviewedRevision: 1 }), effect)).rejects.toMatchObject({ code: 'storage_locked' });
    expect((await stat(f.lock())).isDirectory()).toBe(true);
    expect(await readFile(f.filename(), 'utf8')).toBe(before);
    expect(effect).not.toHaveBeenCalled();
  });

  it('fails closed on malformed or unsupported ledgers instead of overwriting history', async () => {
    const f = await fixture();
    await f.store.preventStart(input());
    const original = JSON.parse(await readFile(f.filename(), 'utf8')) as Record<string, unknown>;
    const effect = vi.fn(async () => completion());
    for (const corrupt of ['{truncated', JSON.stringify({ ...original, schemaVersion: 2 }), JSON.stringify({ ...original, activeOperationId: 'missing-operation' })]) {
      await writeFile(f.filename(), corrupt, { mode: 0o600 });
      await expect(f.reopen().reconcile(input())).rejects.toMatchObject({ code: 'storage_failed' });
      await expect(f.reopen().execute(input(), effect)).rejects.toMatchObject({ code: 'storage_failed' });
      expect(await readFile(f.filename(), 'utf8')).toBe(corrupt);
    }
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects sparse operation schemas before persisting or dispatching any effect', async () => {
    const f = await fixture();
    const effect = vi.fn(async () => completion());
    await expect(f.store.execute(input({ steps: Array(1) as DeploymentReceiptRequest['steps'] }), effect)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.store.execute(input({ resources: Array(1) as DeploymentReceiptRequest['resources'] }), effect)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(effect).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual([]);
  });

  it('rejects symlink receipts and unsafe identifiers without reading or changing the destination', async () => {
    const f = await fixture();
    await mkdir(f.directory, { mode: 0o700 });
    const outside = path.join(f.root, 'unrelated');
    await writeFile(outside, 'unrelated private data', { mode: 0o600 });
    await symlink(outside, f.filename());
    await expect(f.store.snapshot('home-vps')).rejects.toMatchObject({ code: 'storage_failed' });
    await expect(f.store.execute(input({ deploymentId: '../../escape' }), async () => completion())).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await readFile(outside, 'utf8')).toBe('unrelated private data');
    await expect(f.store.reconcile({ ...input(), target: { ...input().target, hostKeyFingerprint: 'password' } } as DeploymentReceiptBinding))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });
});
