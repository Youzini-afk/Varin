import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'vitest';
import type { AgentInputSnapshotConsumer } from '@varin/protocol';
import type { ThreadPrepareSource } from '@varin/application-client';
import { createDocumentAuthority } from '../documents/authority.js';
import { createSurfaceSnapshotStore } from '../documents/surface-snapshot-store.js';
import type { RecoveryState, WorkingSourcePreparation, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import { createThreadSourcePreparer } from './thread-sources.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Real Documents publications/snapshots and physical bytes; this scoped tree fixture is not Rust evidence. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-source-preparation-'));
  const directory = path.join(root, 'workspace'); await mkdir(directory);
  await writeFile(path.join(directory, 'Z.txt'), 'DISK Z'); await writeFile(path.join(directory, 'a.txt'), 'DISK a');
  let trusted = true;
  const documents = createDocumentAuthority({ hostId: 'source-review', dataDir: path.join(root, 'documents'),
    isAllowedRoot: async () => true, isTrusted: async () => trusted });
  const workspaceId = (await documents.resolveWorkspace({ path: directory })).workspaceId;
  const objects = new Map<string, Buffer>(), leases = new Map<string, number>();
  const branches = new Map<string, WorkingSourcePreparation & { states: Record<string, RecoveryState> }>();
  let scans = 0, releases = 0, createCalls = 0;
  let captureHook: (() => Promise<void>) | undefined;
  const store: WorkingStateRootStore = {
    async readSourcePreparation(id: string) { return branches.get(id) ?? null; },
    async readOriginalSource(id: string) { const value = branches.get(id); return value ? { root: value.branch.baseRoot, provenance: value.provenance } : null; },
    async getBranchRoot(id: string) { return branches.get(id)?.branch ?? null; },
    async listWorkspaceBaselinePaths() { return (await readdir(directory)).sort(); },
    async listCaptureScopePaths() { return []; },
    async captureDirectory(_directory: string, paths: string[] = [], options?: { store?: boolean }) {
      scans += 1; await captureHook?.();
      const states: Record<string, RecoveryState> = {};
      for (const file of paths) {
        try {
          const info = await lstat(path.join(directory, file));
          if (info.isDirectory()) { states[file] = { kind: 'directory', mode: info.mode & 0o7777 }; continue; }
          const bytes = await readFile(path.join(directory, file)); const hash = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
          if (options?.store !== false) objects.set(hash, bytes);
          states[file] = { kind: 'regular-file', objectHash: hash, byteLength: bytes.length, mode: info.mode & 0o7777 };
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; states[file] = { kind: 'missing' }; }
      }
      return states;
    },
    async releaseCapturedStates() {},
    async putObject(bytes: Buffer) {
      const hash = `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
      objects.set(hash, bytes); leases.set(hash, (leases.get(hash) ?? 0) + 1);
      let owned = true;
      return { hash, byteLength: bytes.length, release: async () => { if (!owned) return; owned = false;
        if (leases.has(hash)) { leases.delete(hash); releases += 1; } } };
    },
    async createBranch(_workspace: string, branchId: string, states: Record<string, RecoveryState>, baseRef: string, drafts: string[], scopes: string[], options: { sourceProvenance: WorkingSourcePreparation['provenance'] }) {
      createCalls += 1;
      const root = createHash('sha256').update(JSON.stringify(states)).digest('hex');
      const branch = { branchId, workspaceId, root, baseRoot: root, headRevision: 0, writeRevision: 0,
        baseRef, draftBasePaths: drafts, captureScopes: scopes, createdAt: 1, updatedAt: 1 };
      for (const state of Object.values(states)) if (state.kind === 'regular-file') leases.delete(state.objectHash);
      branches.set(branchId, { branch, states: structuredClone(states), provenance: structuredClone(options.sourceProvenance) }); return branch;
    },
    async pinBranch(id: string) { const value = branches.get(id)!; return { ...value.branch, root: value.branch.baseRoot,
      branch: value.branch, pinId: `pin:${id}`, view: 'revision', revision: 0, release: async () => undefined }; },
  } as unknown as WorkingStateRootStore;
  const workingStates: WorkspaceWorkingStateRootAccess = { async withBranchStore(_workspace, _purpose, callback) { return callback(store); } };
  const options = { documents, workingStates, inspectInventory: async () => ({ kind: 'directory' as const }), sourceTools: async () => ['file_read'] };
  const prepare = createThreadSourcePreparer(options);
  const input: ThreadPrepareSource = { resourceOwner: { kind: 'local' }, runtime: 'agent', threadId: 'thread:source-review', branchId: 'branch:source-review', key: 'source', workspaceId,
    mode: 'fixed_branch', content: { mode: 'saved-files' }, captureScopes: [] };
  const consumer: AgentInputSnapshotConsumer = { kind: 'thread', threadId: input.threadId, branchId: input.branchId };
  const snapshot = async () => {
    const resources = ['Z.txt', 'a.txt'].map(resourceId => ({ resource: { workspaceId, resourceId }, baseRevision: null,
      localEditRevision: 3, documentInstanceId: `document:${resourceId}`, encoding: 'utf-8', bom: true, lineEnding: 'crlf' as const }));
    await documents.publishDirtyBuffers({ ownerId: 'original-editor', generation: 2, workspaceId, resources });
    return documents.captureAgentInputSnapshot({ ownerId: 'original-editor', generation: 2, consumer,
      resources: resources.map(resource => ({ ...resource, content: `DRAFT ${resource.resource.resourceId}\r\n` })) });
  };
  return { root, directory, documents, workspaceId, store, branches, objects, leases, prepare, options, input, consumer, snapshot,
    scans: () => scans, releases: () => releases, creates: () => createCalls,
    capture: (hook?: () => Promise<void>) => { captureHook = hook; }, trust: (value: boolean) => { trusted = value; },
    close: async () => { await documents.dispose(); await rm(root, { recursive: true, force: true }); } };
}

it('pins selected original Documents bytes/format/identity and reopens the receipt before expired snapshots or changed disk', async () => {
  const f = await fixture();
  try {
    const context = await f.snapshot();
    const input: ThreadPrepareSource = { ...f.input, content: { mode: 'surface-drafts', context } };
    const selected = await f.prepare(input);
    assert.equal(selected.provenance?.consistency, 'stable-capture');
    assert(selected.source.mode !== 'live_root');
    const stored = f.branches.get(selected.source.branchId)!;
    for (const file of ['Z.txt', 'a.txt']) {
      const state = stored.states[file]!; assert.equal(state.kind, 'regular-file');
      if (state.kind === 'regular-file') assert.equal(f.objects.get(state.objectHash)?.toString(), `\uFEFFDRAFT ${file}\r\n`);
    }
    assert(stored.provenance.consistency === 'stable-capture');
    assert.deepEqual(stored.provenance.drafts?.resources.map(resource => resource.resourceId), ['Z.txt', 'a.txt']);
    assert.equal(stored.provenance.drafts?.ownerId, 'original-editor');
    assert.equal(stored.provenance.drafts?.resources[0]?.documentInstanceId, 'document:Z.txt');
    assert.equal(f.leases.size, 0);
    f.documents.releaseAgentInputSnapshot(f.consumer, context);
    await writeFile(path.join(f.directory, 'Z.txt'), 'LATER USER DISK');
    const originalScans = f.scans();
    const reopened = createThreadSourcePreparer(f.options);
    assert.deepEqual(await reopened(input), selected);
    assert.equal(f.scans(), originalScans);
    await assert.rejects(reopened({ ...input, content: { mode: 'saved-files' } }), /different selection/);
    await assert.rejects(reopened({ ...input, captureScopes: ['ignored'] }), /different selection/);
    f.trust(false); await assert.rejects(reopened(input));
    assert.equal(await readFile(path.join(f.directory, 'Z.txt'), 'utf8'), 'LATER USER DISK');
  } finally { await f.close(); }
});

it('keeps native captures isolated by original Thread and branch without sharing mutable copies', () => {
  const snapshots = createSurfaceSnapshotStore();
  const thread = { kind: 'thread' as const, threadId: 'same', branchId: 'branch' };
  const resources = [{ resource: { workspaceId: 'workspace', resourceId: 'file' }, baseRevision: 'disk', localEditRevision: 1,
    content: 'ORIGINAL', encoding: 'utf-8', bom: false }];
  const fixed = snapshots.capture({ ownerId: 'editor', consumer: thread, resources });
  resources[0]!.content = 'LATER USER EDIT';
  const next = snapshots.capture({ ownerId: 'editor', consumer: thread, resources });
  assert.equal(snapshots.clone({ ...thread, threadId: 'other' }, fixed).status, 'unavailable');
  assert.equal(snapshots.clone({ ...thread, branchId: 'other' }, fixed).status, 'unavailable');
  assert.equal(snapshots.release({ ...thread, branchId: 'different' }, fixed).released, false);
  const cloned = snapshots.clone(thread, fixed);
  assert.equal(cloned.status, 'ready');
  assert.equal(cloned.resources[0]!.content, 'ORIGINAL');
  cloned.resources[0]!.resource.resourceId = 'changed-copy';
  const repeated = snapshots.clone(thread, fixed);
  assert.equal(repeated.status, 'ready');
  assert.equal(repeated.resources[0]!.resource.resourceId, 'file');
  assert.equal(snapshots.release(thread, fixed).released, true);
  assert.equal(snapshots.clone(thread, fixed).status, 'unavailable');
  const latest = snapshots.clone(thread, next);
  assert.equal(latest.status, 'ready');
  assert.equal(latest.resources[0]!.content, 'LATER USER EDIT');
  snapshots.dispose();
  assert.equal(snapshots.clone(thread, next).status, 'unavailable');
});

it('does not cancel shared preparation for one observer and drains the last cancelled capture before retry', async () => {
  const f = await fixture();
  try {
    const started = deferred(), drain = deferred(); let held = true;
    f.capture(async () => { if (!held) return; started.resolve(); await drain.promise; held = false; });
    const a = new AbortController(), b = new AbortController();
    const first = f.prepare(f.input, a.signal), second = f.prepare(f.input, b.signal);
    const firstRejected = assert.rejects(first, { name: 'AbortError' });
    const secondRejected = assert.rejects(second, { name: 'AbortError' });
    await started.promise; a.abort(); await firstRejected;
    assert.equal(f.scans(), 1);
    let settled = false; void second.finally(() => { settled = true; }).catch(() => undefined);
    b.abort(); const retry = f.prepare(f.input); await tick();
    assert.equal(settled, false); assert.equal(f.scans(), 1); assert.equal(f.creates(), 0);
    drain.resolve(); await secondRejected; await retry;
    assert.equal(f.creates(), 1); assert.equal(f.leases.size, 0);
  } finally { await f.close(); }
});

it('releases draft upload leases on a changed capture without committing and rejects wrong consumer/root/live draft requests', async () => {
  const f = await fixture();
  try {
    const context = await f.snapshot();
    const input: ThreadPrepareSource = { ...f.input, content: { mode: 'surface-drafts', context } };
    await assert.rejects(f.prepare({ ...input, threadId: 'thread:other' }), /unavailable/);
    await assert.rejects(f.prepare({ ...input, mode: 'live_root' }), /Live workspace/);
    assert(context.source === 'surface');
    await assert.rejects(f.prepare({ ...input, content: { mode: 'surface-drafts', context: { ...context,
      roots: [...context.roots, { workspaceId: 'outside', dirtyPaths: ['private'] }] } } }), /explicitly selected/);
    const complete = f.documents.completeCapture;
    f.documents.completeCapture = async (...args) => ({ ...await complete(...args), stable: false, reasons: ['writer-activity'] });
    await assert.rejects(f.prepare(input), /writer-activity/);
    assert.equal(f.creates(), 0); assert.equal(f.leases.size, 0); assert.equal(f.releases(), 2);
    f.documents.completeCapture = complete;
    await f.prepare(input); assert.equal(f.creates(), 1);
  } finally { await f.close(); }
});
