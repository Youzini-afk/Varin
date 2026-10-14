import { describe, expect, it } from 'vitest';
import { createMaterialCollections, materialMutationOperationId } from './material-collections.js';
import { createMaterialStoreFixture } from './web-materials.test-helper.js';
import type { MaterialCollectionContext } from './material-collections.js';
import type { WorkspaceWorkingStateRootAccess, WorkingStateRootContext } from './working-state/types.js';
import type { KernelRecordContext } from './kernel-records.js';
const context = (threadId = 'a', origin?: string): MaterialCollectionContext => ({
  authority: { kind: 'thread', owningWorkspaceId: 'ws', threadId },
  ...(origin ? { origin } : {}), threadsRelated: async () => true,
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const snapshot = (f: ReturnType<typeof createMaterialStoreFixture>, text = 'needle original') => f.materials.put('ws', {
  sourceUrl: 'https://example.test/', finalUrl: 'https://example.test/', representation: 'text',
}, Buffer.from(text), context().authority);
function intercept(f: ReturnType<typeof createMaterialStoreFixture>, hook: (context: WorkingStateRootContext) => WorkingStateRootContext): WorkspaceWorkingStateRootAccess {
  return { withBranchStore: (workspace, purpose, consume, mode, actor) => f.workingStates.withBranchStore(workspace, purpose,
    (store, ctx) => consume(store, hook(ctx!)), mode, actor) };
}

describe('original material domain', () => {
  it('retains PDF source records and bytes through persisted collection cleanup, without retaining an unrelated empty PDF', async () => {
    const f = createMaterialStoreFixture(); const collections = createMaterialCollections(f.workingStates, { materials: f.materials });
    const pdf = (name: string) => f.materials.put('ws', { sourceUrl: `file:///${name}.pdf`, finalUrl: `file:///${name}.pdf`,
      representation: 'pdf-source-v1', document: { kind: 'pdf', parser: 'native' } }, Buffer.alloc(0), context().authority,
    { source: { bytes: Buffer.from(`%PDF-${name}`), contentType: 'application/pdf' } });
    const [kept, unrelated] = await Promise.all([pdf('kept'), pdf('other')]);
    const created = await collections.execute({ action: 'create', persist: true }, context());
    const added = await collections.execute({ action: 'add', collectionId: created.result.collection!.collectionId, member: { kind: 'snapshot', snapshotId: kept.snapshotId } }, context());
    await f.lifecycle.releaseThreadMaterials('ws', 'a');
    expect((await f.reopen().read('ws', kept.snapshotId, context('b').authority, { includeSource: true }))?.source?.bytes.toString()).toBe('%PDF-kept');
    expect(await f.materials.read('ws', unrelated.snapshotId, context('b').authority)).toBeNull();
    expect((await collections.execute({ action: 'remove', collectionId: created.result.collection!.collectionId,
      memberId: added.result.member!.memberId }, context('b'))).result.status).toBe('denied');
  });

  it('uses explicit sender-envelope grants for resharing, and grants neither family-wide reads nor forged sender records', async () => {
    const f = createMaterialStoreFixture(); const collections = createMaterialCollections(f.workingStates, { materials: f.materials });
    const ref = await snapshot(f);
    await collections.execute({ action: 'share', snapshotId: ref.snapshotId, targetThreadId: 'b' }, context());
    await collections.execute({ action: 'share', snapshotId: ref.snapshotId, targetThreadId: 'c' }, context('b'));
    expect((await f.materials.read('ws', ref.snapshotId, context('c').authority))?.body.toString()).toBe('needle original');
    expect(await f.materials.read('ws', ref.snapshotId, context('d').authority)).toBeNull();
    const shared = [...f.records.values()].find(record => record.recordType === 'material.grant' && record.threadId === 'b')!;
    const payload = JSON.parse(shared.payloadJson); payload.fromThreadId = 'pretend-owner'; shared.payloadJson = JSON.stringify(payload);
    expect(await f.materials.read('ws', ref.snapshotId, context('c').authority)).toBeNull();
  });

  it('never converts an original storage failure into successful empty search', async () => {
    const f = createMaterialStoreFixture(); const collections = createMaterialCollections(f.workingStates, { materials: f.materials });
    const ref = await snapshot(f);
    const created = await collections.execute({ action: 'create' }, context());
    const id = created.result.collection!.collectionId;
    await collections.execute({ action: 'add', collectionId: id, member: { kind: 'snapshot', snapshotId: ref.snapshotId } }, context());
    f.materials.read = async () => { throw new Error('original storage unavailable'); };
    await expect(collections.execute({ action: 'search', collectionId: id, query: 'needle' }, context())).rejects.toThrow('original storage unavailable');
  });

  it('keeps a held URL fetch outside the shared commit queue and stops a cancelled add before its CAS', async () => {
    const f = createMaterialStoreFixture(); const collections = createMaterialCollections(f.workingStates, { materials: f.materials });
    const ref = await snapshot(f), started = deferred(), release = deferred();
    const id = (await collections.execute({ action: 'create' }, context())).result.collection!.collectionId;
    const controller = new AbortController();
    const pending = collections.execute({ action: 'add', collectionId: id, member: { kind: 'url', url: 'https://example.test/' } }, {
      ...context(), signal: controller.signal, fetchUrl: async () => { started.resolve(); await release.promise; return { status: 'ok', snapshot: ref }; },
    });
    const rejected = expect(pending).rejects.toThrow('cancel original');
    await started.promise;
    try {
      const available = await Promise.race([collections.execute({ action: 'list' }, context('b')), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('list blocked behind URL fetch')), 200))]);
      expect(available.result.status).toBe('ok'); controller.abort(new Error('cancel original'));
    } finally { release.resolve(); }
    await rejected;
    expect((await collections.execute({ action: 'list' }, context())).result.collections![0]!.memberCount).toBe(0);
  });

  it('reconstructs the original atomic mutation after a lost reply and later edits, without another put', async () => {
    const f = createMaterialStoreFixture({ operationReceipts: true }); let drop = true, puts = 0;
    const access = intercept(f, ctx => ({ ...ctx, records: { ...ctx.records!, put: async (input: Parameters<KernelRecordContext['records']['put']>[0]) => {
      puts++; const saved = await (ctx.records as KernelRecordContext['records']).put(input);
      if (drop) { drop = false; throw new Error('lost mutation reply'); }
      return saved;
    } } }));
    const collections = createMaterialCollections(access, { materials: f.materials });
    const params = { action: 'create' as const, name: 'original' }, original = context('a', 'tool:original');
    const first = await collections.execute(params, original);
    expect(first).toMatchObject({ effect: 'confirmed', result: { collection: { name: 'original', members: [] } } });
    const id = first.result.collection!.collectionId;
    await collections.execute({ action: 'add', collectionId: id, member: { kind: 'paper', paper: { provider: 'openalex', id: 'W1' } } }, context('a', 'tool:later'));
    const reopened = createMaterialCollections(access, { materials: f.reopen() });
    expect(await reopened.receipt(params, original)).toEqual(first);
    expect(await reopened.execute(params, original)).toEqual(first);
    expect(puts).toBe(2);
    await expect(reopened.execute({ action: 'create', name: 'changed' }, original)).rejects.toThrow('differs');
    expect(f.operations.has(materialMutationOperationId('tool:original'))).toBe(true);
  });

  it('waits for the admitted CAS, preserves its confirmed result after cancellation, and does not repeat it', async () => {
    const f = createMaterialStoreFixture({ operationReceipts: true }), started = deferred(), release = deferred();
    const access = intercept(f, ctx => ({ ...ctx, records: { ...ctx.records!, put: async (input: Parameters<KernelRecordContext['records']['put']>[0]) => {
      started.resolve(); await release.promise; return (ctx.records as KernelRecordContext['records']).put(input);
    } } }));
    const collections = createMaterialCollections(access, { materials: f.materials }); const controller = new AbortController();
    let settled = false;
    const params = { action: 'create' as const }, original = { ...context('a', 'tool:cancel'), signal: controller.signal };
    const work = collections.execute(params, original).finally(() => { settled = true; });
    await started.promise; controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
    release.resolve(); const receipt = await work;
    expect(receipt.effect).toBe('confirmed'); expect(await collections.receipt(params, context('a', 'tool:cancel'))).toEqual(receipt);
  });
});

it('retains a reshared collection and later source members until the last explicit sender grant is removed and the original owner releases its remaining references', async () => {
  const f = createMaterialStoreFixture(), collections = createMaterialCollections(f.workingStates, { materials: f.materials });
  const initial = await snapshot(f);
  const id = (await collections.execute({ action: 'create' }, context())).result.collection!.collectionId;
  await collections.execute({ action: 'add', collectionId: id, member: { kind: 'snapshot', snapshotId: initial.snapshotId } }, context());
  await collections.execute({ action: 'share', collectionId: id, targetThreadId: 'b' }, context());
  await collections.execute({ action: 'share', collectionId: id, targetThreadId: 'c' }, context('b'));
  // The collection is a live set, so a later member belongs to the same explicit share.
  const later = await f.materials.put('ws', { sourceUrl: 'file:///later.pdf', finalUrl: 'file:///later.pdf',
    representation: 'pdf-source-v1', document: { kind: 'pdf', parser: 'native' } }, Buffer.alloc(0), context().authority,
  { source: { bytes: Buffer.from('%PDF-later'), contentType: 'application/pdf' } });
  await collections.execute({ action: 'add', collectionId: id, member: { kind: 'snapshot', snapshotId: later.snapshotId } }, context());
  await f.lifecycle.releaseThreadMaterials('ws', 'a');
  expect((await collections.execute({ action: 'list' }, context('c'))).result.collections).toMatchObject([{ collectionId: id, memberCount: 2 }]);
  expect((await f.reopen().read('ws', initial.snapshotId, context('c').authority))?.body.toString()).toBe('needle original');
  expect((await f.reopen().read('ws', later.snapshotId, context('c').authority, { includeSource: true }))?.source?.bytes.toString()).toBe('%PDF-later');
  expect([...f.records.values()].filter(record => record.recordType === 'material.grant').map(record => record.threadId)).toEqual(['b']);
  await f.lifecycle.releaseThreadMaterials('ws', 'b');
  expect(await f.materials.read('ws', initial.snapshotId, context('c').authority)).toBeNull();
  await f.lifecycle.releaseThreadMaterials('ws', 'a');
  expect([...f.records.values()].filter(record => ['material.collection', 'material.grant', 'web.snapshot'].includes(record.recordType))).toEqual([]);
});

it('checks every snapshot edge before a persisted paper member can make it readable', async () => {
  const f = createMaterialStoreFixture(), collections = createMaterialCollections(f.workingStates, { materials: f.materials });
  const foreign = await f.materials.put('ws', { sourceUrl: 'https://private.test', finalUrl: 'https://private.test', representation: 'text' }, Buffer.from('private'), context('b').authority);
  const id = (await collections.execute({ action: 'create', persist: true }, context())).result.collection!.collectionId;
  const params = { action: 'add' as const, collectionId: id, member: { kind: 'paper' as const, paper: { provider: 'openalex', id: 'W1' }, snapshotId: foreign.snapshotId } };
  expect((await collections.execute(params, context())).result.status).toBe('denied');
  expect(await f.materials.read('ws', foreign.snapshotId, context().authority)).toBeNull();
  await collections.execute({ action: 'share', snapshotId: foreign.snapshotId, targetThreadId: 'a' }, context('b'));
  expect((await collections.execute(params, context())).result.status).toBe('ok');
  expect((await f.materials.read('ws', foreign.snapshotId, context('c').authority))?.body.toString()).toBe('private');
});
