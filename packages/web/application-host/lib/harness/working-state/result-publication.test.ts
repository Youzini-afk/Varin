import { describe, expect, it, vi } from 'vitest';
import { KernelWorkingStateRootStore, type KernelStorageContext } from '../../kernel/storage-adapter.js';
import type { KernelBranchReadResult, KernelWorkingResultCandidate } from '../../kernel/protocol.generated.js';
import type { RecoveryState } from './types.js';

const original = { kind: 'regular-file' as const, objectHash: `sha256-${'1'.repeat(64)}`, byteLength: 3, mode: 0o644 };
const modified = { kind: 'regular-file' as const, objectHash: `sha256-${'2'.repeat(64)}`, byteLength: 3, mode: 0o644 };
function fixture() {
  const candidate: KernelWorkingResultCandidate = { publicationId: 'publication', candidateOperationId: 'result-prepare:publication', workspaceId: 'workspace', branchId: 'branch', root: 'result-root', baseRoot: 'original-base', writeRevision: 2, pinId: 'result-pin', basePinId: 'base-pin' };
  const operations = new Map<string, Record<string, unknown>>();
  let record: Record<string, unknown> | null = null;
  let baseRoot = 'original-base';
  let liveRoot = 'initial-head';
  const prepare = vi.fn(async () => {
    operations.set(candidate.candidateOperationId, { kind: 'working.result.prepare', state: 'committed', result: candidate });
    return candidate;
  });
  const publish = vi.fn(async () => {
    const receipt = { publicationId: 'publication', workspaceId: 'workspace', branchId: 'branch', resultRevision: 1,
      root: 'result-root', baseRoot: 'original-base', recordId: 'working-result:branch@1', createdAt: '2026-10-10T00:00:00.000Z' };
    record = { record: { ...receipt, changedPaths: ['file.txt'], baseStates: { 'file.txt': original }, pathStates: { 'file.txt': modified }, diffStats: { files: 1, insertions: 0, deletions: 0 } } };
    operations.set('publication', { kind: 'working.result.publish', state: 'committed', result: receipt });
    return receipt;
  });
  const readBranch = vi.fn(async (input: { branchId: string; revision?: number; paths?: string[] }): Promise<KernelBranchReadResult> => ({
    branchId: input.branchId, workspaceId: 'workspace', root: input.revision === 0 ? baseRoot : input.revision === 1 ? 'result-root' : liveRoot,
    revision: input.revision ?? 0, view: input.revision === undefined ? 'current' : 'revision', currentRoot: liveRoot,
    writeRevision: 1, headRevision: 0, parentRef: 'parent', captureScopes: [], draftBasePaths: [], createdAt: 1, updatedAt: 1,
    entries: (input.paths ?? ['file.txt']).map(path => ({ path, state: input.revision === 1 ? modified : original })), nextCursor: null,
  }));
  const client = { getOperation: vi.fn(async (id: string) => operations.get(id) ?? null), readBranch,
    prepareResultCandidate: prepare, publishResultCandidate: publish, releaseResultCandidate: vi.fn(async () => ({ released: true })) };
  const context = { identity: { workspaceId: 'workspace' }, client, working: { resultGet: vi.fn(async () => record) } } as unknown as KernelStorageContext;
  const store = new KernelWorkingStateRootStore(context);
  return { candidate, operations, client, context, store, prepare, publish, readBranch,
    rebase: () => { baseRoot = 'later-base'; liveRoot = 'later-root'; },
    corruptRecord: () => { if (record) delete (record.record as Record<string, unknown>).baseStates; } };
}

describe('WorkingResult publication owner adapter', () => {
  it('resumes the original prepared candidate after checkpoint loss without recapturing a newer directory', async () => {
    const f = fixture();
    const first = await f.store.prepareResultCandidate({ publicationId: 'publication', branchId: 'branch', source: { kind: 'head' } });
    f.rebase();
    const capture = vi.spyOn(f.store, 'captureDirectory');
    const resumed = await f.store.prepareResultCandidate({ publicationId: 'publication', branchId: 'branch', source: { kind: 'directory', directory: '/changed-copy' } });
    expect(resumed).toEqual(first);
    expect(capture).not.toHaveBeenCalled();
    expect(f.prepare).toHaveBeenCalledOnce();
  });

  it('recovers a committed publication after the reply is lost, retaining its original base after rebase', async () => {
    const f = fixture();
    const candidate = await f.store.prepareResultCandidate({ publicationId: 'publication', branchId: 'branch', source: { kind: 'head' } });
    const commit = f.publish.getMockImplementation()!;
    f.publish.mockImplementationOnce(async () => { await commit(); throw new Error('reply lost'); });
    await expect(f.store.publishPreparedResult('publication', candidate)).rejects.toThrow('reply lost');
    f.rebase();
    f.readBranch.mockClear();
    const capture = vi.spyOn(f.store, 'captureDirectory');
    const result = await f.store.publishDirectoryResult('branch', '/newer-copy', undefined, { publicationId: 'publication' });
    expect(result.baseRoot).toBe('original-base');
    expect(result.baseStates['file.txt']).toEqual(original);
    expect(result.pathStates['file.txt']).toEqual(modified);
    expect(result.resultRevision).toBe(1);
    expect(f.publish).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(f.readBranch.mock.calls.every(([input]) => input.revision === 1)).toBe(true);
    expect(f.client.releaseResultCandidate).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'result-candidate-release:publication' }));
  });

  it('rejects a changed candidate for an existing publication identity', async () => {
    const f = fixture();
    const candidate = await f.store.prepareResultCandidate({ publicationId: 'publication', branchId: 'branch', source: { kind: 'head' } });
    await expect(f.store.publishPreparedResult('publication', { ...candidate, root: 'forged-root' })).rejects.toThrow('original preparation receipt');
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each(['started', 'failed'])('does not treat a %s publication as missing or recapture', async state => {
    const f = fixture();
    f.operations.set('publication', { kind: 'working.result.publish', state });
    const capture = vi.spyOn(f.store, 'captureDirectory');
    await expect(f.store.publishDirectoryResult('branch', '/copy', undefined, { publicationId: 'publication' })).rejects.toThrow('not committed');
    expect(capture).not.toHaveBeenCalled();
  });

  it('does not reconstruct malformed fixed result states from a newer revision zero', async () => {
    const f = fixture();
    await f.publish();
    f.corruptRecord();
    await expect(f.store.resumeResultPublication('branch', 'publication')).rejects.toThrow('no fixed baseStates');
    expect(f.readBranch).not.toHaveBeenCalled();
  });

  it('includes deletion of an unchanged base file in a full physical candidate', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'captureDirectory').mockResolvedValue({});
    vi.spyOn(f.store, 'releaseCapturedStates').mockResolvedValue();
    // Inventory is delegated to the real native compute owner in production.
    // Override the private transport seam only for this adapter behavior test.
    const internals = f.store as unknown as { kernelScanPaths(): Promise<string[]> };
    vi.spyOn(internals, 'kernelScanPaths').mockResolvedValue([]);
    await f.store.prepareResultCandidate({ publicationId: 'publication', branchId: 'branch', source: { kind: 'directory', directory: '/copy' } });
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ changes: [{ path: 'file.txt', state: { kind: 'missing' } satisfies RecoveryState }] }), undefined);
  });
});

describe('source preparation receipt recovery', () => {
  it('hydrates the original provenance blob through its original record reference', async () => {
    const f = fixture();
    const body = Buffer.from(JSON.stringify({ consistency: 'stable-capture', contentMode: 'saved-files', captureScopes: [], omittedDraftPaths: ['dirty.txt'] }));
    f.operations.set('branch-create:branch', { kind: 'branch.create', state: 'committed', result: {
      branchId: 'branch', workspaceId: 'workspace', root: 'fixed', writeRevision: 0, headRevision: 0,
      sourceProvenance: { objectHash: 'body-hash', recordId: 'working-source:branch', slot: 'source-provenance' },
    } });
    vi.spyOn(f.store, 'getBranchRoot').mockResolvedValue({ branchId: 'branch', workspaceId: 'workspace', root: 'fixed', baseRoot: 'fixed',
      writeRevision: 0, headRevision: 0, captureScopes: [], draftBasePaths: [], createdAt: 1, updatedAt: 1 });
    const getBlob = vi.fn(async (_hash: string, _source: unknown, input: { offset: number }) => ({
      bytesBase64: body.subarray(input.offset, input.offset ? undefined : 20).toString('base64'),
      nextOffset: input.offset ? body.length : 20, eof: input.offset !== 0,
    }));
    Object.assign(f.client, { getBlob });
    const recovered = await f.store.readSourcePreparation('branch');
    expect(recovered?.provenance).toMatchObject({ omittedDraftPaths: ['dirty.txt'] });
    expect(getBlob).toHaveBeenCalledTimes(2);
    expect(getBlob.mock.calls.every(([, source]) => JSON.stringify(source) === JSON.stringify({ recordId: 'working-source:branch', slot: 'source-provenance' }))).toBe(true);
    f.operations.set('branch-create:branch', { kind: 'branch.create', state: 'committed', result: { branchId: 'branch' } });
    await expect(f.store.readSourcePreparation('branch')).rejects.toThrow('inconsistent provenance');
    f.operations.delete('branch-create:branch');
    await expect(f.store.readSourcePreparation('branch')).rejects.toThrow('no preparation receipt');
  });
});
