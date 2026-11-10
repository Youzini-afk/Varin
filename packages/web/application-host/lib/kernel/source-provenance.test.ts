import { sourceTextEncodingChoiceId } from '../projects/text-encoding.js';
import { expect, it, vi } from 'vitest';
import { readFixedSourceTextEncoding, resolveSourceTextPolicy, parseSourceProvenance, overlayResultTextEncoding, originalSourceTextEncoding } from './source-provenance.js';
import type { KernelScopedClient } from './kernel-client.js';
import type { KernelTextPolicy, LaunchSource, ChildSourceProvenance } from './protocol.generated.js';

const format = (encoding: string) => ({ encoding, bom: false, lineEnding: 'none', defaultLineEnding: 'lf', source: 'explicit' });
function fixture(policy: KernelTextPolicy = { root: '/original', files: { 'legacy.txt': 'gbk' } }) {
  const privateRead = vi.fn(async () => { throw new Error('Another Run\'s private source/result body is not authorized'); });
  const readBranch = vi.fn(async (input: { branchId: string; revision?: number }) => ({ workspaceId: 'workspace', branchId: input.branchId,
    view: 'revision', revision: input.revision ?? 0, root: input.revision ? 'result-root' : 'base-root', textEncoding: policy }));
  const actor = { getOperation: privateRead, getBlob: privateRead, workingResultGet: privateRead, readBranch };
  return { ...actor, privateRead, actor: actor as unknown as KernelScopedClient };
}
const source: LaunchSource = { mode: 'fixed_branch', workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'branch', revision: 0, live_root: null, resource_owner: { kind: 'local' } };

it.each([{ root: '/original', files: { 'legacy.txt': 'gbk' } }, {}])('freezes captured policy, including Auto, using only branch read authority', async policy => {
  const f = fixture(policy);
  const textEncodingPolicy = vi.fn(async () => { throw new Error('Former physical directory is offline'); });
  expect(await resolveSourceTextPolicy({ textEncodingPolicy }, f.actor, source, null)).toEqual(policy);
  expect(textEncodingPolicy).not.toHaveBeenCalled();
  expect(f.privateRead).not.toHaveBeenCalled();
  expect(f.readBranch).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch', revision: 0, includeEntries: false }, undefined);
});

it('requests only the selected published revision rather than latest or another Run private result', async () => {
  const f = fixture();
  f.readBranch.mockImplementation(async input => ({ workspaceId: 'workspace', branchId: input.branchId, view: 'revision', revision: input.revision ?? 0,
    root: input.revision ? 'result-root' : 'base-root', textEncoding: { root: '/original', files: { 'legacy.txt': input.revision === 1 ? 'utf-8' : 'gbk' } } }));
  expect(await readFixedSourceTextEncoding(f.actor, 'workspace', 'branch', 1)).toEqual({ root: '/original', files: { 'legacy.txt': 'utf-8' } });
  expect(f.readBranch).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch', revision: 1, includeEntries: false }, undefined);
  expect(await readFixedSourceTextEncoding(f.actor, 'workspace', 'branch', 0)).toEqual({ root: '/original', files: { 'legacy.txt': 'gbk' } });
  expect(f.privateRead).not.toHaveBeenCalled();
});

it('rejects mismatched selected root and malformed captured policy instead of falling back', async () => {
  const f = fixture();
  await expect(readFixedSourceTextEncoding(f.actor, 'workspace', 'branch', 1, undefined, 'another-root')).rejects.toThrow('selected branch revision');
  expect(() => parseSourceProvenance({ consistency: 'fixed-root', root: 'root', textEncoding: { files: [] } })).toThrow();
});

it('passes the captured baseline to a materialized copy overlay without changing its fixed branch policy', async () => {
  const f = fixture();
  const textEncodingPolicy = vi.fn(async (_workspace: string, physical?: import('../projects/text-encoding.js').TextEncodingSource | null) => {
    expect(physical?.frozenPolicy).toEqual({ root: '/original', files: { 'legacy.txt': 'gbk' } });
    return { ...physical?.frozenPolicy, files: { 'legacy.txt': 'utf-8' } };
  });
  const physical = { rootId: 'copy-root', canonicalRoot: '/temporary/copy' };
  expect(await resolveSourceTextPolicy({ textEncodingPolicy }, f.actor, { ...source, mode: 'materialized' }, physical)).toMatchObject({ files: { 'legacy.txt': 'utf-8' } });
  expect(await resolveSourceTextPolicy({ textEncodingPolicy }, f.actor, source, null)).toMatchObject({ files: { 'legacy.txt': 'gbk' } });
  expect(textEncodingPolicy).toHaveBeenCalledOnce();
});

it('keeps draft bytes and later published codec-only format choices above captured disk rules', () => {
  const draft = { threadId: 'thread', branchId: 'history', snapshotRef: 'snapshot', ownerId: 'owner', ownerGeneration: 1,
    resources: [{ workspaceId: 'workspace', resourceId: 'legacy.txt', baseRevision: null, localEditRevision: 1, revision: 'draft-revision', encoding: 'gbk', bom: false }] };
  const policy = { root: '/original', files: { 'legacy.txt': 'utf-8' } };
  const captured: ChildSourceProvenance = { consistency: 'fixed-root', root: 'base-root', textEncoding: policy,
    selection: { captureIdentity: 'a'.repeat(64), contentMode: 'fixed-draft-baseline', captureScopes: [], omittedDraftPaths: [], drafts: draft } };
  const actual = originalSourceTextEncoding(captured);
  expect(actual.files?.['legacy.txt']).toBe('gbk');
  expect(overlayResultTextEncoding(actual, { 'legacy.txt': { child: format('utf-8') } }).files?.['legacy.txt']).toBe('utf-8');
  expect(policy.files['legacy.txt']).toBe('utf-8');
});


it('uses the same native branch manual-choice namespace for the next Run as Documents', async () => {
  const f = fixture({ root: '/original', files: { 'src/a.c': 'gbk' } });
  const textEncodingPolicy = vi.fn(async (_workspace: string, physical?: import('../projects/text-encoding.js').TextEncodingSource | null) => {
    expect(physical).toMatchObject({ frozenPolicy: { root: '/original', files: { 'src/a.c': 'gbk' } }, sourcePath: 'src',
      choiceId: sourceTextEncodingChoiceId('workspace', 'branch') });
    return { root: '/original/src', files: { 'a.c': 'utf-8' }, choiceRevisions: { 'a.c': 1 } };
  });
  expect(await resolveSourceTextPolicy({ textEncodingPolicy }, f.actor, { ...source, mode: 'native_workspace', native_scope: 'src', revision: null },
    { rootId: 'native-root', canonicalRoot: '/mounted/src' })).toMatchObject({ files: { 'a.c': 'utf-8' } });
});
