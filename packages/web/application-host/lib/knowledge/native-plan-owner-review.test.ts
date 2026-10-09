import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { NativePlanView, NativePlanMutationInput, NativePlanOrigin, NativePlanChanged, NativePlanForkCapture, NativePlanForkInput, NativePlanSelection } from '@varin/protocol';
import { parseTodoPlan, renderTodoPlan } from '@varin/protocol';
import { openKnowledgeStoreEngine } from './store-engine.js';
import { openWorkspaceKnowledge, type KnowledgeStore } from './store.js';

const require = createRequire(import.meta.url);
const { TriviumDB } = require('triviumdb') as typeof import('triviumdb');
const roots: string[] = [];
const stores: KnowledgeStore[] = [];
async function fixture(pipe = false) {
  const root = await mkdtemp(join(tmpdir(), 'varin-native-plan-review-'));
  roots.push(root);
  const changes: NativePlanChanged[] = [];
  const options = { dataDir: root, hostId: 'host', workspaceId: 'user', embedding: null, onNativePlanChanged: (change: NativePlanChanged) => { changes.push(change); } } as const;
  const open = async () => { const s = await (pipe ? openWorkspaceKnowledge : openKnowledgeStoreEngine)(options); stores.push(s); return s; };
  return { store: await open(), open, changes, options };
}
afterEach(async () => {
  vi.restoreAllMocks();
  fixtureHistory.clear();
  await Promise.allSettled(stores.splice(0).map(s => s.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});
// Fixture history is a trusted TEST resolver only, not a substitute for real Catalog membership IPC.
const fixtureHistory = new Map<string, readonly string[]>();
const historyKey = (v: Pick<NativePlanView, 'threadId' | 'headId'>) => JSON.stringify([v.threadId, v.headId]);
const view = (branchId = 'a', ancestry: string[] = ['h1'], inheritedRef: string | null = null, threadId = 'thread'): NativePlanView => {
  const v: NativePlanView = { threadId, branchId, headId: ancestry.at(-1) ?? null, inheritedRef, forkBasis: null };
  fixtureHistory.set(historyKey(v), ancestry);
  return v;
};
const forkView = (capture: NativePlanForkCapture, ancestry: string[]): NativePlanView => ({
  ...view(capture.targetBranchId, ancestry, capture.capturedRef, capture.sourceThreadId),
  forkBasis: { sourceBranchId: capture.sourceBranchId, headId: capture.headId, sourceInheritedRef: capture.inheritedRef },
});
async function selectionFor(store: KnowledgeStore, v: NativePlanView): Promise<NativePlanSelection> {
  let page = await store.readNativePlanCandidate(v);
  const ancestry = fixtureHistory.get(historyKey(v));
  if (!ancestry) throw new Error('Test fixture has no trusted history for this cut');
  const latestRef = page.latestRef;
  let newerTimestamp = Number.POSITIVE_INFINITY;
  while (page.candidate) {
    const candidate = page.candidate;
    if (candidate.updatedAt >= newerTimestamp) throw new Error('Non-decreasing plan lineage');
    newerTimestamp = candidate.updatedAt;
    if (candidate.sourceHeadId === null || ancestry.includes(candidate.sourceHeadId)) {
      return { latestRef, selectedRef: candidate.ref };
    }
    page = await store.readNativePlanCandidate(v, candidate.previousRef);
    if (page.latestRef !== latestRef) throw new Error('Test selection changed during resolution');
  }
  return { latestRef, selectedRef: null };
}
const readPlan = async (store: KnowledgeStore, v: NativePlanView) => store.readNativePlan(v, await selectionFor(store, v));
const mutatePlan = async (store: KnowledgeStore, command: NativePlanMutationInput) => store.mutateNativePlan({
  ...command, selection: command.selection ?? await selectionFor(store, command.view),
});
const captureFork = async (store: KnowledgeStore, command: NativePlanForkInput) => store.captureNativePlanFork({
  ...command, selection: command.selection ?? await selectionFor(store, command.source),
});
const input = (v: NativePlanView, key: string, expectedRef: string | null, content = key): NativePlanMutationInput =>
  ({ view: v, origin: { kind: 'user', key }, expectedRef, content });
const tool = (): NativePlanOrigin => ({ kind: 'tool', operationId: 'req:tool:call', runId: 'run', requestId: 'req', callId: 'call', epoch: 1 });
const write = (s: KnowledgeStore, v: NativePlanView, key: string, expectedRef: string | null, content = key) => mutatePlan(s, input(v, key, expectedRef, content));

describe('native plan independent owner review, real TriviumDB', () => {
  it('isolates same-head siblings and fixes a fork against later same-head source edits', async () => {
    const { store } = await fixture();
    const a = view(); const p1 = await write(store, a, 'p1', null);
    const capture = await captureFork(store, { source: a, targetBranchId: 'b' });
    const b = forkView(capture, ['h1']);
    await write(store, a, 'p2', p1.plan!.ref);
    expect((await readPlan(store, b))?.content).toBe('p1');
    const b1 = await write(store, b, 'b1', p1.plan!.ref);
    expect(b1.receipt.status).toBe('applied');
    expect((await readPlan(store, a))?.content).toBe('p2');
    expect((await readPlan(store, b))?.content).toBe('b1');
  });
  it('resolves a nested fork at an older head through the fixed version lineage', async () => {
    const { store } = await fixture();
    const p1 = await write(store, view(), 'p1', null);
    const a2 = view('a', ['h1', 'h2']);
    const p2 = await write(store, a2, 'p2', p1.plan!.ref);
    const bCapture = await captureFork(store, { source: a2, targetBranchId: 'b' });
    expect(bCapture.capturedRef).toBe(p2.plan!.ref);
    const cCapture = await captureFork(store, { source: forkView(bCapture, ['h1']), targetBranchId: 'c' });
    expect(cCapture.capturedRef).toBe(p1.plan!.ref);
    expect((await readPlan(store, forkView(cCapture, ['h1'])))?.content).toBe('p1');
  });
  it('keeps a null capture null across source writes, owner reopen and capture retry', async () => {
    const f = await fixture(); const a = view();
    const capture = await captureFork(f.store, { source: a, targetBranchId: 'b' });
    expect(capture.capturedRef).toBeNull();
    await write(f.store, a, 'later', null);
    await f.store.close(); const reopened = await f.open();
    expect(await reopened.captureNativePlanFork({ source: a, targetBranchId: 'b' })).toEqual(capture);
    expect(await captureFork(reopened, { source: a, targetBranchId: 'b' })).toEqual(capture);
    expect(await readPlan(reopened, forkView(capture, ['h1']))).toBeNull();
  });
  it('replays the original operation receipt after a later user edit and owner reopen', async () => {
    const f = await fixture(); const v = view();
    const command = { ...input(v, 'unused', null, 'tool p1'), origin: tool() };
    const committed = await mutatePlan(f.store, command);
    await write(f.store, v, 'user p2', committed.plan!.ref);
    await f.store.close(); const s = await f.open();
    expect(await s.readNativePlanMutation(command)).toEqual(committed);
    expect(await s.mutateNativePlan(command)).toEqual(committed);
    expect(await mutatePlan(s, command)).toEqual(committed);
    expect((await readPlan(s, v))?.content).toBe('user p2');
  });
  it('rejects changed content or expectedRef for one operation', async () => {
    const { store } = await fixture(); const command = { ...input(view(), 'unused', null), origin: tool() };
    const first = await mutatePlan(store, command);
    await expect(mutatePlan(store, { ...command, content: 'changed' })).rejects.toThrow(/intent/);
    await expect(mutatePlan(store, { ...command, expectedRef: first.plan!.ref })).rejects.toThrow(/intent/);
  });
  it('rejects moving the same operation to another branch or Thread', async () => {
    const { store } = await fixture(); const command = { ...input(view(), 'unused', null), origin: tool() };
    await mutatePlan(store, command);
    await expect(mutatePlan(store, { ...command, view: view('b') })).rejects.toThrow(/intent|owner|Thread|branch/);
    await expect(mutatePlan(store, { ...command, view: view('a', ['h1'], null, 'other') })).rejects.toThrow(/intent|owner|Thread|branch/);
    expect(await readPlan(store, view('b'))).toBeNull();
  });
  it('does not create a second effect when the original operation epoch changes', async () => {
    const { store } = await fixture(); const command = { ...input(view(), 'unused', null), origin: tool() };
    const first = await mutatePlan(store, command);
    // A changed admission is not a fresh Operation. It must be rejected, not receive a new durable conflict receipt.
    for (const origin of [{ ...tool(), epoch: 2 }, { ...tool(), runId: 'different-run' }] as NativePlanOrigin[]) {
      await expect(mutatePlan(store, { ...command, origin })).rejects.toThrow(/intent|origin|epoch/);
    }
    expect((await readPlan(store, view()))?.ref).toBe(first.plan!.ref);
  });
  it('rejects an inherited reference from another Thread', async () => {
    const { store } = await fixture(); const p = await write(store, view(), 'p', null);
    const capture = await captureFork(store, { source: view(), targetBranchId: 'b' });
    const foreign = { ...forkView(capture, ['h1']), threadId: 'other' };
    await expect(readPlan(store, foreign)).rejects.toThrow(/another Thread|capture/);
    await expect(write(store, foreign, 'bad', p.plan!.ref)).rejects.toThrow(/another Thread|capture/);
  });
  it('serializes racing CAS writers and preserves the original conflict receipt', async () => {
    const { store } = await fixture(); const v = view();
    const commands = [input(v, 'one', null), input(v, 'two', null)];
    const results = await Promise.all(commands.map(c => mutatePlan(store, c)));
    expect(results.map(r => r.receipt.status).sort()).toEqual(['applied', 'conflict']);
    const winner = results.find(r => r.receipt.status === 'applied')!;
    const loser = results.findIndex(r => r.receipt.status === 'conflict');
    await write(store, v, 'newer', winner.plan!.ref);
    expect(await mutatePlan(store, commands[loser]!)).toEqual(results[loser]);
    expect((await readPlan(store, v))?.content).toBe('newer');
  });
  it('rejects a fork target reused with changed source branch, Thread or cut', async () => {
    const { store } = await fixture(); const source = view();
    await captureFork(store, { source, targetBranchId: 'target' });
    for (const changed of [view('b'), view('a', ['h1', 'h2']), view('a', ['h1'], null, 'other')]) {
      await expect(captureFork(store, { source: changed, targetBranchId: 'target' })).rejects.toThrow(/different input/);
    }
  });
  it('precommit failure publishes neither version nor receipt; postcommit lost reply recovers both', async () => {
    const { store } = await fixture(); const command = input(view(), 'atomic', null);
    const original = TriviumDB.prototype.commitTransaction;
    const fault = vi.spyOn(TriviumDB.prototype, 'commitTransaction').mockImplementationOnce(() => { throw new Error('before commit'); });
    await expect(mutatePlan(store, command)).rejects.toThrow('before commit');
    expect(await readPlan(store, view())).toBeNull();
    expect(await store.readNativePlanMutation(command)).toBeNull();
    fault.mockImplementationOnce(function (this: InstanceType<typeof TriviumDB>, ...args) { Reflect.apply(original, this, args); throw new Error('after commit reply lost'); });
    await expect(mutatePlan(store, command)).rejects.toThrow('after commit reply lost');
    fault.mockRestore();
    const durable = await store.readNativePlanMutation(command);
    expect(durable?.receipt.status).toBe('applied');
    expect((await readPlan(store, view()))?.ref).toBe(durable?.receipt.ref);
    expect(await mutatePlan(store, command)).toEqual(durable);
  });
  it('distinguishes absent and explicitly empty plans and roundtrips canonical status content', async () => {
    const { store } = await fixture(); const v = view();
    expect(await readPlan(store, v)).toBeNull();
    const items = [ { text: 'pending item', status: 'pending' }, { text: 'working item', status: 'in_progress' },
      { text: 'finished item', status: 'completed' }, { text: 'blocked item', status: 'blocked' } ] as const;
    const saved = await write(store, v, 'statuses', null, renderTodoPlan(items));
    expect(parseTodoPlan((await readPlan(store, v))!.content)).toEqual(items);
    const empty = await write(store, v, 'empty', saved.plan!.ref, '');
    expect(await readPlan(store, v)).toMatchObject({ ref: empty.plan!.ref, content: '' });
    expect(empty.plan!.ref).not.toBe(saved.plan!.ref);
    expect(() => renderTodoPlan([{ text: 'invalid', status: 'invalid' as never }])).toThrow();
  });
  it('does not let a stale history view overwrite a later branch plan', async () => {
    const { store } = await fixture(); const p1 = await write(store, view(), 'p1', null);
    const p2 = await write(store, view('a', ['h1', 'h2']), 'p2', p1.plan!.ref);
    const stale = await write(store, view(), 'stale', p1.plan!.ref);
    expect(stale.receipt.status).toBe('conflict');
    expect(stale.receipt.ref).toBe(p2.plan!.ref);
    expect((await readPlan(store, view('a', ['h1', 'h2'])))?.content).toBe('p2');
  });
  it('passes an actual conflict and original receipt through the private worker pipe', async () => {
    const { store, changes } = await fixture(true); const v = view();
    const first = await write(store, v, 'pipe-first', null);
    const conflict = await write(store, v, 'pipe-conflict', null);
    expect(conflict).toMatchObject({ receipt: { status: 'conflict', ref: first.plan!.ref }, plan: { content: 'pipe-first' } });
    expect(await store.readNativePlanMutation(input(v, 'pipe-conflict', null))).toEqual(conflict);
    expect(changes).toEqual([{ threadId: v.threadId, branchId: v.branchId, ref: first.plan!.ref }]);
    await expect(mutatePlan(store, input(v, 'pipe-conflict', null, 'altered'))).rejects.toThrow(/intent/);
  });
  it('keeps native plans out of legacy blocks and global knowledge views', async () => {
    const { store } = await fixture();
    await write(store, view(), 'private-plan', null, 'thread private content');
    expect(await store.getBlocks('thread')).toEqual([]);
    expect(await store.getBlocks('a')).toEqual([]);
    expect(await store.listKnowledge({ scope: 'user', activeOnly: true })).toEqual([]);
    expect(await store.recall('thread private content', 5)).toEqual([]);
  });

  it('scopes user command keys to their admitted branch while keeping immutable references distinct', async () => {
    const { store } = await fixture();
    const a = await write(store, view(), 'shared-user-key', null, 'a content');
    const b = await write(store, view('b'), 'shared-user-key', null, 'b content');
    expect(a.receipt.status).toBe('applied');
    expect(b.receipt.status).toBe('applied');
    expect(a.plan!.ref).not.toBe(b.plan!.ref);
    expect((await readPlan(store, view()))?.content).toBe('a content');
    expect((await readPlan(store, view('b')))?.content).toBe('b content');
  });
  it('reports an unavailable immutable reference instead of succeeding with an empty plan', async () => {
    const f = await fixture();
    const p = await write(f.store, view(), 'missing-after-capture', null);
    const capture = await captureFork(f.store, { source: view(), targetBranchId: 'b' });
    const inherited = forkView(capture, ['h1']);
    const dim = f.store.dim;
    await f.store.close();
    // Corrupt only the referenced version in the real closed database; the valid capture remains.
    const db = new TriviumDB(join(f.options.dataDir, 'knowledge', f.options.hostId, 'user.tdb'), { dim, syncMode: 'full' });
    try {
      const ids = db.indexedLookup({ type: 'native_plan_version', dedupeKey: p.plan!.ref }, 10);
      expect(ids).toHaveLength(1);
      db.delete(ids[0]!);
    } finally { db.close(); }
    const store = await f.open();
    await expect(readPlan(store, inherited)).rejects.toThrow(/unavailable/);
    await expect(captureFork(store, { source: inherited, targetBranchId: 'c' })).rejects.toThrow(/unavailable/);
  });

  it('requires a genuine target capture rather than an arbitrary same-Thread inherited ref', async () => {
    const { store } = await fixture(); const a = view();
    const p1 = await write(store, a, 'capture-p1', null);
    const capture = await captureFork(store, { source: a, targetBranchId: 'b' });
    const forkBasis = { sourceBranchId: a.branchId, headId: a.headId, sourceInheritedRef: a.inheritedRef };
    const genuine = { ...forkView(capture, ['h1']), forkBasis } as NativePlanView;
    expect((await readPlan(store, genuine))?.ref).toBe(p1.plan!.ref);
    const p2 = await write(store, a, 'capture-p2', p1.plan!.ref);
    await expect(readPlan(store, { ...genuine, inheritedRef: p2.plan!.ref })).rejects.toThrow(/capture|fork|basis|reference/);
    // A caller cannot graft even a valid immutable version onto another target.
    await expect(readPlan(store, { ...genuine, branchId: 'uncaptured' })).rejects.toThrow(/capture|fork|basis|reference/);
    await expect(readPlan(store, { ...genuine, forkBasis: null } as NativePlanView)).rejects.toThrow(/capture|fork|basis|reference/);
  });
  it('rejects a new null-plan fork when its required capture is missing', async () => {
    const { store } = await fixture();
    const missing = { ...view('missing-null-fork'), forkBasis: { sourceBranchId: 'a', headId: 'h1', sourceInheritedRef: null } } as NativePlanView;
    await expect(readPlan(store, missing)).rejects.toThrow(/capture|fork|basis/);
    await expect(write(store, missing, 'must-not-create', null)).rejects.toThrow(/capture|fork|basis/);
  });
  it('rejects source, head and sourceInheritedRef tampering even when the captured plan is null', async () => {
    const { store } = await fixture(); const a = view();
    const capture = await captureFork(store, { source: a, targetBranchId: 'b' });
    expect(capture.capturedRef).toBeNull();
    const basis = { sourceBranchId: a.branchId, headId: a.headId, sourceInheritedRef: a.inheritedRef };
    const genuine = { ...view('b'), forkBasis: basis } as NativePlanView;
    expect(await readPlan(store, genuine)).toBeNull();
    for (const forkBasis of [{ ...basis, sourceBranchId: 'other' }, { ...basis, headId: null }, { ...basis, sourceInheritedRef: 'wrong-ref' }]) {
      await expect(readPlan(store, { ...genuine, forkBasis } as NativePlanView)).rejects.toThrow(/capture|fork|basis/);
    }
  });
  it('does not let an orphan capture poison a real root branch whose Catalog creation already existed', async () => {
    const { store } = await fixture();
    const root = { ...view('existing-root'), forkBasis: null } as NativePlanView;
    // Knowledge capture succeeded, but Catalog will reject the occupied target identity.
    await captureFork(store, { source: view('source'), targetBranchId: root.branchId });
    expect(await readPlan(store, root)).toBeNull();
    const first = await write(store, root, 'root-after-orphan', null);
    expect(first.receipt.status).toBe('applied');
    expect((await readPlan(store, root))?.content).toBe('root-after-orphan');
  });

  it('rejects stale selection without any commit and allows a pure reselection before mutation or capture', async () => {
    const { store } = await fixture(); const v = view();
    const stale = await selectionFor(store, v);
    const p1 = await write(store, v, 'after-selection', null);
    const command = { ...input(v, 'selected-write', p1.plan!.ref), selection: stale };
    const commit = vi.spyOn(TriviumDB.prototype, 'commitTransaction');
    const noCommitStale = { code: 'conflict', message: 'Native plan selection is stale' };
    await expect(store.readNativePlan(v, stale)).rejects.toMatchObject(noCommitStale);
    await expect(store.mutateNativePlan(command)).rejects.toMatchObject(noCommitStale);
    await expect(store.captureNativePlanFork({ source: v, targetBranchId: 'selected-fork', selection: stale })).rejects.toMatchObject(noCommitStale);
    expect(commit).not.toHaveBeenCalled();
    expect(await store.readNativePlanMutation(command)).toBeNull();
    const fresh = await selectionFor(store, v);
    const applied = await store.mutateNativePlan({ ...command, selection: fresh });
    expect(applied.receipt.status).toBe('applied');
    expect(await store.readNativePlanMutation(input(v, 'selected-write', p1.plan!.ref))).toEqual(applied);
    const capture = await captureFork(store, { source: v, targetBranchId: 'selected-fork' });
    expect(capture.capturedRef).toBe(applied.plan!.ref);
    commit.mockRestore();
  });

});
