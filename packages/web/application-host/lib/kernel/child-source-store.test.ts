import { describe, expect, it, vi } from 'vitest';
import { captureContinuationStage, prepareContinuationSourceStore, prepareDispatchSourceStore } from './child-source-store.js';
import type { ChildSourceStoreOwners } from './child-source-store.js';
import type { DelegatedExecution, LaunchSource, KernelTextPolicy } from './protocol.generated.js';
import type { WorkingStateRootStore } from '../harness/working-state/types.js';

const source: LaunchSource = { resource_owner: { kind: 'local' }, mode: 'fixed_branch', live_root: null,
  workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'previous', revision: 2 };
const format = { encoding: 'gbk', bom: false, lineEnding: 'none', defaultLineEnding: 'lf', source: 'explicit' };
const signal = new AbortController().signal;
function fixture() {
  // Owner observations for source-policy routing only. Codec/byte behavior is native-tested.
  const original = { root: 'original', provenance: { consistency: 'fixed-root', root: 'original',
    textEncoding: { root: '/original', defaultEncoding: 'utf-8', files: { 'keep.txt': 'utf-16le' } } as KernelTextPolicy } };
  const pin = { root: 'selected', release: vi.fn(async () => undefined) };
  const store = {
    readOriginalSource: vi.fn(async () => original),
    readSourcePreparation: vi.fn(async () => null),
    getResult: vi.fn(async () => ({ branchId: 'previous', resultRevision: 2, root: 'selected',
      changedPaths: [], baseStates: {}, pathStates: {}, textFormats: { 'ascii.txt': { child: format } } })),
    pinBranch: vi.fn(async () => pin), openBranchHandoffPin: vi.fn(async () => pin),
    createBranchFromPin: vi.fn(async () => ({ baseRoot: 'selected' })),
    pinBranchHandoff: vi.fn(async () => ({ pinId: 'retained', root: 'selected' })),
  };
  const owners = { store: store as unknown as WorkingStateRootStore,
    capture: { documents: { resolveWorkspace: vi.fn(async () => ({ workspaceId: 'native-documents' })),
      resolveTextEncodingPolicy: vi.fn(async () => ({ files: { 'actual.txt': 'gbk' } })) } }, physical: vi.fn() } as unknown as ChildSourceStoreOwners;
  return { store, owners, original, pin };
}

describe('child source encoding ownership', () => {
  it('forks the exact published encoding choices even when ASCII bytes have no raw diff', async () => {
    const f = fixture();
    const child = { execution_id: 'continued', selected_profile: { work_mode: 'read_only' }, source_basis: {
      kind: 'working_result', source, root: 'selected', provenance: f.original.provenance,
    } } as unknown as DelegatedExecution;
    const prepared = await prepareContinuationSourceStore(child, f.owners.store, signal);
    expect(prepared.provenance).toMatchObject({ root: 'selected', textEncoding: {
      root: '/original', defaultEncoding: 'utf-8', files: { 'keep.txt': 'utf-16le', 'ascii.txt': 'gbk' },
    } });
    expect(f.store.getResult).toHaveBeenCalledWith('previous', 2, { signal });
    expect(f.store.createBranchFromPin).toHaveBeenCalledWith('workspace', 'child-source:continued', f.pin, 'previous@2', undefined, [],
      { sourceProvenance: prepared.provenance });
    expect(f.pin.release).toHaveBeenCalledOnce();
  });

  it('retains selected result choices in both a fixed dispatch and a fixed incoming stage', async () => {
    const f = fixture();
    const child = { execution_id: 'dispatch', selected_profile: { work_mode: 'read_only' }, source: {
      kind: 'pending', handoff: { source, source_path: null,
        root: { kind: 'fixed', pin: { source, root: 'selected', pin_id: 'accepted' } } },
    } } as unknown as DelegatedExecution;
    expect((await prepareDispatchSourceStore(child, { store: f.owners.store, capture: f.owners.capture, physical: f.owners.physical }, signal)).provenance).toMatchObject({ textEncoding: { files: { 'ascii.txt': 'gbk' } } });
    await captureContinuationStage({ execution_id: 'incoming' } as DelegatedExecution, f.owners, source, undefined, signal);
    expect(f.store.createBranchFromPin).toHaveBeenLastCalledWith('workspace', 'child-incoming:incoming', f.pin,
      'previous@2', undefined, [], expect.objectContaining({ sourceProvenance: expect.objectContaining({ textEncoding: expect.objectContaining({ files: expect.objectContaining({ 'ascii.txt': 'gbk' }) }) }) }));
  });

  it.each([0, 2])('rebases an already pinned fixed subtree exactly once at revision %i', async revision => {
    const f = fixture();
    f.original.provenance.textEncoding.files = { 'sub/': 'gbk', 'sub/a.c': 'gbk', 'other.c': 'utf-16le' };
    f.store.getResult.mockResolvedValue({ branchId: 'previous', resultRevision: revision, root: 'selected', changedPaths: [],
      baseStates: {}, pathStates: {}, textFormats: { 'sub/a.c': { child: { ...format, encoding: 'utf-16be' } } } } as never);
    const scopedPin = { ...f.pin, root: 'subtree' };
    f.store.openBranchHandoffPin.mockResolvedValue(scopedPin);
    f.store.createBranchFromPin.mockResolvedValue({ baseRoot: 'subtree' });
    f.store.pinBranchHandoff.mockResolvedValue({ pinId: 'retained-subtree', root: 'subtree' });
    const selected = { ...source, revision };
    const child = { execution_id: 'scoped', selected_profile: { work_mode: 'read_only' }, source: { kind: 'pending',
      handoff: { source: selected, source_path: 'sub', root: { kind: 'fixed', pin: { source: selected, root: 'subtree', pin_id: 'subtree-pin' } } },
    } } as unknown as DelegatedExecution;
    const result = await prepareDispatchSourceStore(child, { store: f.owners.store, capture: f.owners.capture, physical: f.owners.physical }, signal);
    expect(result.provenance.textEncoding).toEqual({ root: '/original/sub', defaultEncoding: 'utf-8',
      files: { './': 'gbk', 'a.c': revision === 0 ? 'gbk' : 'utf-16be' } });
    expect(f.store.createBranchFromPin).toHaveBeenCalledWith('workspace', 'child-source:scoped', scopedPin, `previous@${revision}`,
      undefined, [], { sourceProvenance: result.provenance });
  });

  it('does not scope a native handoff again after its snapshot already rebased the paths', async () => {
    const f = fixture();
    f.original.provenance.textEncoding = { root: '/original/sub', defaultEncoding: 'utf-8', files: { 'a.c': 'gbk' } };
    const selected = { ...source, revision: 0 };
    const child = { execution_id: 'native-scoped', selected_profile: { work_mode: 'read_only' }, source: { kind: 'pending',
      handoff: { source: selected, source_path: 'sub', root: { kind: 'native', pin: { source: selected, root: 'selected', pin_id: 'accepted' } } },
    } } as unknown as DelegatedExecution;
    const result = await prepareDispatchSourceStore(child, { store: f.owners.store, capture: f.owners.capture, physical: f.owners.physical }, signal);
    expect(result.provenance.textEncoding).toEqual(f.original.provenance.textEncoding);
  });

  it('captures native workspace interpretation through its admitted Documents identity', async () => {
    const f = fixture();
    const grant = { grantId: 'original-native-owner' };
    const open = vi.fn(async () => ({ grant }));
    const acquire = vi.fn(async () => ({ path: '/owned-native-view' }));
    const snapshot = vi.fn(async () => undefined);
    f.owners.nativeWorkspaces = { open, acquire, snapshot } as unknown as NonNullable<ChildSourceStoreOwners['nativeWorkspaces']>;
    const native = { ...source, mode: 'native_workspace', revision: null, execution_workspace_id: 'native-execution' } as LaunchSource;
    await captureContinuationStage({ execution_id: 'native-incoming' } as DelegatedExecution, f.owners, native, undefined, signal);
    expect(open).toHaveBeenCalledWith(native, signal);
    expect(acquire).toHaveBeenCalledWith(native, grant, signal);
    expect(f.owners.capture.documents.resolveWorkspace).toHaveBeenCalledWith({ path: '/owned-native-view' });
    expect(f.owners.capture.documents.resolveTextEncodingPolicy).toHaveBeenCalledWith('native-documents');
    expect(snapshot).toHaveBeenCalledWith(native, 'child-incoming:native-incoming', 'child-incoming-snapshot:native-incoming', signal, undefined,
      { textEncoding: { files: { 'actual.txt': 'gbk' } } });
  });
});
