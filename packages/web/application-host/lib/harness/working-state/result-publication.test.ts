import { describe, expect, it, vi } from 'vitest';
import { KernelWorkingStateRootStore, type KernelStorageContext } from '../../kernel/storage-adapter.js';
import type { KernelBranchReadResult, KernelWorkingResultCandidate } from '../../kernel/protocol.generated.js';
import type { RecoveryState } from './types.js';

const original = { kind: 'regular-file' as const, objectHash: `sha256-${'1'.repeat(64)}`, byteLength: 3, mode: 0o644 };
const modified = { kind: 'regular-file' as const, objectHash: `sha256-${'2'.repeat(64)}`, byteLength: 3, mode: 0o644 };
const candidate: KernelWorkingResultCandidate = { publicationId: 'publication', candidateOperationId: 'result-prepare:publication', workspaceId: 'workspace', branchId: 'branch', root: 'result-root', baseRoot: 'original-base', writeRevision: 2, pinId: 'result-pin', basePinId: 'base-pin' };
const prepared = { kind: 'working.result.prepare', state: 'committed', result: candidate };
const receipt = { publicationId: 'publication', workspaceId: 'workspace', branchId: 'branch', resultRevision: 1,
  root: 'result-root', baseRoot: 'original-base', recordId: 'working-result:branch@1', createdAt: '2026-10-10T00:00:00.000Z' };
const committed = { kind: 'working.result.publish', state: 'committed', result: receipt };
const resultRecord = { record: { ...receipt, changedPaths: ['file.txt'], baseStates: { 'file.txt': original }, pathStates: { 'file.txt': modified }, diffStats: { files: 1, insertions: 0, deletions: 0 } } };

function fixture() {
  // These are original owner observations, not a second branch/publication writer.
  // Real commit, reopen and retained-root behavior belongs to the native suite.
  const readBranch = vi.fn(async (input: { branchId: string; revision?: number; paths?: string[] }): Promise<KernelBranchReadResult> => ({
    branchId: input.branchId, workspaceId: 'workspace', root: input.revision === 1 ? 'result-root' : 'later-root',
    revision: input.revision ?? 0, view: input.revision === undefined ? 'current' : 'revision', currentRoot: 'later-root',
    writeRevision: 1, headRevision: 0, parentRef: 'parent', captureScopes: [], draftBasePaths: [], createdAt: 1, updatedAt: 1,
    entries: (input.paths ?? ['file.txt']).map(path => ({ path, state: input.revision === 1 ? modified : original })), nextCursor: null,
  }));
  const client = {
    getOperation: vi.fn<(id: string) => Promise<Record<string, unknown> | null>>().mockResolvedValue(null),
    readBranch,
    prepareResultCandidate: vi.fn().mockResolvedValue(candidate),
    publishResultCandidate: vi.fn().mockResolvedValue(receipt),
    releaseResultCandidate: vi.fn().mockResolvedValue({ released: true }),
  };
  const resultGet = vi.fn().mockResolvedValue(resultRecord);
  const context = { identity: { workspaceId: 'workspace' }, client, working: { resultGet } } as unknown as KernelStorageContext;
  const store = new KernelWorkingStateRootStore(context);
  return { client, context, store, resultGet, readBranch };
}

describe('WorkingResult publication owner adapter', () => {
  it('resumes the original prepared candidate without recapturing a newer directory', async () => {
    const f = fixture();
    f.client.getOperation.mockResolvedValue(prepared);
    const capture = vi.spyOn(f.store, 'captureDirectory');
    expect(await f.store.prepareResultCandidate({ publicationId: 'publication', branchId: 'branch', source: { kind: 'directory', directory: '/changed-copy' } })).toEqual(candidate);
    expect(capture).not.toHaveBeenCalled();
    expect(f.client.prepareResultCandidate).not.toHaveBeenCalled();
    expect(f.readBranch).not.toHaveBeenCalled();
  });

  it('recovers a lost publication reply from the original receipt without replaying or reading the new head', async () => {
    const f = fixture();
    f.client.getOperation.mockResolvedValueOnce(prepared).mockResolvedValueOnce(null).mockResolvedValueOnce(committed);
    f.client.publishResultCandidate.mockRejectedValueOnce(new Error('reply lost'));
    await expect(f.store.publishPreparedResult('publication', candidate)).rejects.toThrow('reply lost');
    const capture = vi.spyOn(f.store, 'captureDirectory');
    const result = await f.store.publishDirectoryResult('branch', '/newer-copy', undefined, { publicationId: 'publication' });
    expect(result).toMatchObject({ baseRoot: 'original-base', baseStates: { 'file.txt': original }, pathStates: { 'file.txt': modified }, resultRevision: 1 });
    expect(f.client.publishResultCandidate).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(f.readBranch.mock.calls.every(([input]) => input.revision === 1)).toBe(true);
    expect(f.client.releaseResultCandidate).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'result-candidate-release:publication' }));
  });

  it('retains immutable per-state format evidence from the original published result', async () => {
    const f = fixture();
    const format = { encoding: 'gbk', bom: false, lineEnding: 'crlf', defaultLineEnding: 'crlf', source: 'explicit' };
    f.resultGet.mockResolvedValue({ record: { ...resultRecord.record,
      textFormats: { 'file.txt': { base: format, child: { ...format, encoding: 'utf-8' } }, 'unchanged.txt': { child: format } } } });
    expect(await f.store.getResult('branch', 1)).toMatchObject({ textFormats: {
      'file.txt': { base: { encoding: 'gbk' }, child: { encoding: 'utf-8' } }, 'unchanged.txt': { child: { encoding: 'gbk' } },
    } });
    f.resultGet.mockResolvedValue({ record: { ...resultRecord.record, textFormats: { '../other.txt': { base: format } } } });
    await expect(f.store.getResult('branch', 1)).rejects.toThrow(/path/i);
  });

  it('rejects a changed candidate for an existing publication identity', async () => {
    const f = fixture();
    f.client.getOperation.mockResolvedValue(prepared);
    await expect(f.store.publishPreparedResult('publication', { ...candidate, root: 'forged-root' })).rejects.toThrow('original preparation receipt');
    expect(f.client.publishResultCandidate).not.toHaveBeenCalled();
  });

  it.each(['started', 'failed'])('does not treat a %s publication as missing or recapture', async state => {
    const f = fixture();
    f.client.getOperation.mockResolvedValue({ kind: 'working.result.publish', state });
    const capture = vi.spyOn(f.store, 'captureDirectory');
    await expect(f.store.publishDirectoryResult('branch', '/copy', undefined, { publicationId: 'publication' })).rejects.toThrow('not committed');
    expect(capture).not.toHaveBeenCalled();
  });

  it('does not reconstruct malformed fixed result states from a newer revision zero', async () => {
    const f = fixture();
    f.client.getOperation.mockResolvedValue(committed);
    f.resultGet.mockResolvedValue({ record: { ...resultRecord.record, baseStates: undefined } });
    await expect(f.store.resumeResultPublication('branch', 'publication')).rejects.toThrow('no fixed baseStates');
    expect(f.readBranch).not.toHaveBeenCalled();
  });

  it('includes deletion of an unchanged base file in a full physical candidate', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'captureDirectory').mockResolvedValue({});
    vi.spyOn(f.store, 'releaseCapturedStates').mockResolvedValue();
    Object.assign(f.context, { resolveFileRoot: async () => ({ rootId: 'root', basePath: '' }) });
    Object.assign(f.client, {
      computeStart: async ({ workspaceId, jobId }: { workspaceId: string; jobId: string }) => ({
        workspaceId, jobId, kernelEpoch: 'epoch', status: 'empty', root: 'empty-directory',
        records: [], nextCursor: 0, endCursor: 0, scannedFiles: 0,
      }),
      computeRelease: async () => ({ released: true }),
    });
    await f.store.prepareResultCandidate({ publicationId: 'publication', branchId: 'branch', source: { kind: 'directory', directory: '/copy' } });
    expect(f.client.prepareResultCandidate).toHaveBeenCalledWith(expect.objectContaining({ changes: [{ path: 'file.txt', state: { kind: 'missing' } satisfies RecoveryState }] }), undefined);
  });
});

describe('source preparation receipt recovery', () => {
  it('hydrates the original provenance blob through its original record reference', async () => {
    const f = fixture();
    const body = Buffer.from(JSON.stringify({ consistency: 'stable-capture', contentMode: 'saved-files', captureScopes: [], omittedDraftPaths: ['dirty.txt'], textEncoding: { root: '/original', files: { 'legacy.txt': 'gbk' } } }));
    f.client.getOperation.mockResolvedValue({ kind: 'branch.create', state: 'committed', result: {
      branchId: 'branch', workspaceId: 'workspace', root: 'fixed', writeRevision: 0, headRevision: 0,
      sourceProvenance: { objectHash: 'body-hash', recordId: 'working-source:branch', slot: 'source-provenance' },
    } });
    const branch = vi.spyOn(f.store, 'getBranchRoot').mockResolvedValue({ branchId: 'branch', workspaceId: 'workspace', root: 'fixed', baseRoot: 'fixed',
      writeRevision: 0, headRevision: 0, captureScopes: [], draftBasePaths: [], createdAt: 1, updatedAt: 1 });
    const getBlob = vi.fn(async (_hash: string, _source: unknown, input: { offset: number }) => ({
      bytesBase64: body.subarray(input.offset, input.offset ? undefined : 20).toString('base64'),
      nextOffset: input.offset ? body.length : 20, eof: input.offset !== 0,
    }));
    Object.assign(f.client, { getBlob });
    const recovered = await f.store.readSourcePreparation('branch');
    expect(recovered?.provenance).toMatchObject({ omittedDraftPaths: ['dirty.txt'], textEncoding: { root: '/original', files: { 'legacy.txt': 'gbk' } } });
    expect(getBlob).toHaveBeenCalledTimes(2);
    expect(getBlob.mock.calls.every(([, source]) => JSON.stringify(source) === JSON.stringify({ recordId: 'working-source:branch', slot: 'source-provenance' }))).toBe(true);
    branch.mockResolvedValue({ branchId: 'branch', workspaceId: 'workspace', root: 'later', baseRoot: 'later-base',
      writeRevision: 2, headRevision: 1, captureScopes: [], draftBasePaths: [], createdAt: 1, updatedAt: 2 });
    expect(await f.store.readOriginalSource('branch')).toMatchObject({ root: 'fixed', provenance: { omittedDraftPaths: ['dirty.txt'] } });
    await expect(f.store.readSourcePreparation('branch')).rejects.toThrow('changed after preparation');
    f.client.getOperation.mockResolvedValue({ kind: 'branch.create', state: 'committed', result: { branchId: 'branch' } });
    await expect(f.store.readSourcePreparation('branch')).rejects.toThrow('inconsistent provenance');
    f.client.getOperation.mockResolvedValue(null);
    await expect(f.store.readSourcePreparation('branch')).rejects.toThrow('no preparation receipt');
  });
});
