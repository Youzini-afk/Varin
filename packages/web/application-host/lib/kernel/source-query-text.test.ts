import { expect, it, vi } from 'vitest';
import { createSourceQueryOwner, type SourceQueryAccess } from './source-query.js';
import type { KernelClient } from './kernel-client.js';
import type { KernelComputeRecord, KernelComputeStartParams, KernelTextPolicy } from './protocol.generated.js';

function fixture(mode: 'live_root' | 'fixed_branch', records: KernelComputeRecord[], policy: KernelTextPolicy | undefined = { files: { 'legacy.txt': 'gbk' } }) {
  const root = { hostId: 'host', rootId: 'root', canonicalRoot: '/repo' };
  const query: SourceQueryAccess = { runId: 'run', threadId: 'thread', grantId: 'grant',
    ...(policy ? { textEncoding: policy } : {}), physicalRoot: mode === 'live_root' ? root : null,
    source: { mode, resource_owner: { kind: 'local' }, workspace_id: 'workspace', execution_workspace_id: 'workspace',
      live_root: mode === 'live_root' ? root : null, branch_id: mode === 'fixed_branch' ? 'branch' : null, revision: mode === 'fixed_branch' ? 3 : null } };
  const actor = { getOperation: vi.fn(async () => null), workingResultGet: vi.fn(async () => null), readBranch: vi.fn(async () => ({ workspaceId: 'workspace', branchId: 'branch', view: 'revision', revision: 3 })),
    fileReadCheck: vi.fn(async () => ({ resourceKey: 'same-file' })),
    computeStart: vi.fn(async (input: KernelComputeStartParams) => ({ workspaceId: input.workspaceId, jobId: input.jobId,
      kernelEpoch: 'epoch', root: 'root-hash', status: 'ready', nextCursor: records.length, endCursor: records.length, scannedFiles: 1, records })),
    computeRelease: vi.fn(async () => ({})), computeCancel: vi.fn(async () => ({})) };
  const textEncodingPolicy = vi.fn(async () => ({ files: { 'legacy.txt': 'utf-16le' } }));
  const readSnapshot = vi.fn(async () => { throw new Error('Source read must retain its original native reader and format receipts'); });
  const owner = createSourceQueryOwner({ kernel: { sourceGrant: () => ({}), scoped: () => actor, textEncodingPolicy } as unknown as KernelClient,
    documents: { readSnapshot, admitWorkspaceRegistration: async () => ({ canonicalPath: '/repo' }) } as unknown as Parameters<typeof createSourceQueryOwner>[0]['documents'],
    validateLiveSource: async () => {} });
  return { owner, actor, query, textEncodingPolicy, readSnapshot };
}
const text = (body: string, offset = 0, final = true): KernelComputeRecord => ({ kind: 'text', path: 'legacy.txt', revision: 'raw-revision',
  data: { text: body, offset, final, format: { encoding: 'utf-8', bom: false }, byteLength: 7 } });

it.each(['live_root', 'fixed_branch'] as const)('uses one native text interpretation for %s reads and preserves multibyte page offsets', async mode => {
  const f = fixture(mode, [text('中文', 0, false), text('!', 6)]);
  expect(await f.owner.read(f.query, 'legacy.txt', new AbortController().signal)).toEqual({ status: 'ready', content: '中文!', revision: 'raw-revision',
    source: mode === 'live_root' ? 'disk' : 'working-branch' });
  const input = f.actor.computeStart.mock.calls[0]![0];
  expect(input).toMatchObject({ operation: 'read', textEncoding: { files: { 'legacy.txt': 'gbk' } } });
  // Frozen file policy stays below exact successful conversion evidence in Rust.
  expect(input).not.toHaveProperty('encoding');
  expect(f.readSnapshot).not.toHaveBeenCalled();
  expect(f.textEncodingPolicy).not.toHaveBeenCalled();
  expect(f.actor.computeRelease).toHaveBeenCalledOnce();
});

it('keeps frozen empty policy as Auto and forwards an explicit one-call override', async () => {
  const f = fixture('fixed_branch', [text('中文!')], {});
  await f.owner.read({ ...f.query, encoding: 'gbk' }, 'legacy.txt', new AbortController().signal);
  expect(f.textEncodingPolicy).not.toHaveBeenCalled();
  expect(f.actor.computeStart.mock.calls[0]![0]).toMatchObject({ encoding: 'gbk' });
  expect(f.actor.computeStart.mock.calls[0]![0]).not.toHaveProperty('textEncoding');
});

it('uses original source provenance for a rootless source without reading current live settings or files', async () => {
  const f = fixture('fixed_branch', [text('中文!')]);
  delete f.query.textEncoding;
  await f.owner.read(f.query, 'legacy.txt', new AbortController().signal);
  expect(f.textEncodingPolicy).not.toHaveBeenCalled();
  expect(f.actor.getOperation).not.toHaveBeenCalled();
  expect(f.actor.workingResultGet).not.toHaveBeenCalled();
  expect(f.actor.readBranch).toHaveBeenCalledWith({ branchId: 'branch', revision: 3, includeEntries: false }, expect.any(AbortSignal));
  expect(f.actor.computeStart.mock.calls[0]![0]).not.toHaveProperty('textEncoding');
  expect(f.actor.fileReadCheck).not.toHaveBeenCalled();
  expect(f.readSnapshot).not.toHaveBeenCalled();
});

it('preserves native decoding errors rather than returning partial or guessed text', async () => {
  const f = fixture('fixed_branch', [{ kind: 'error', path: 'legacy.txt', revision: 'raw-revision', data: { status: 'unsupported-encoding', message: 'Invalid GBK sequence' } }]);
  expect(await f.owner.read(f.query, 'legacy.txt', new AbortController().signal)).toEqual({ status: 'unavailable', message: 'Invalid GBK sequence' });
  expect(f.actor.computeRelease).toHaveBeenCalledOnce();
});
