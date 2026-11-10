import { describe, expect, it, vi } from 'vitest';
import { captureContinuationStage, prepareContinuationSourceStore, prepareDispatchSourceStore } from './child-source-store.js';
import type { ChildSourceStoreOwners } from './child-source-store.js';
import type { DelegatedExecution, LaunchSource, KernelTextPolicy } from './protocol.generated.js';
import type { WorkingStateRootStore } from '../harness/working-state/types.js';
import { KernelStorageAdapter, KernelWorkingStateRootStore } from './storage-adapter.js';
import type { KernelClient, KernelGrantHandle, KernelScopedClient } from './kernel-client.js';

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
    readTextEncoding: vi.fn(async (_branchId: string, revision: number): Promise<KernelTextPolicy> => ({ ...original.provenance.textEncoding,
      files: { ...original.provenance.textEncoding.files, ...(revision ? { 'ascii.txt': 'gbk' } : {}) } })),
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
    const provenance = { consistency: 'fixed-root' as const, root: 'selected' };
    const child = { execution_id: 'continued', selected_profile: { work_mode: 'read_only' }, source_basis: {
      kind: 'working_result', source, root: 'selected', provenance,
    } } as unknown as DelegatedExecution;
    const prepared = await prepareContinuationSourceStore(child, f.owners.store, signal);
    expect(prepared.provenance).toEqual(provenance);
    expect(f.store.readTextEncoding).toHaveBeenCalledWith('previous', 2, { signal, root: 'selected' });
    expect(f.store.getResult).not.toHaveBeenCalled();
    expect(f.store.createBranchFromPin).toHaveBeenCalledWith('workspace', 'child-source:continued', f.pin, 'previous@2', undefined, [],
      { sourceProvenance: provenance, textEncoding: {
        root: '/original', defaultEncoding: 'utf-8', files: { 'keep.txt': 'utf-16le', 'ascii.txt': 'gbk' },
      } });
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
    f.original.provenance.textEncoding.choiceRevisions = { './': 1, 'sub/': 2, 'sub/a.c': 7, 'sub/reset.c': 0, 'other.c': 9 };
    f.store.readTextEncoding.mockImplementation(async () => ({ ...f.original.provenance.textEncoding,
      files: { ...f.original.provenance.textEncoding.files, 'sub/a.c': revision ? 'utf-16be' : 'gbk' } }));
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
      files: { './': 'gbk', 'a.c': revision === 0 ? 'gbk' : 'utf-16be' },
      choiceRevisions: { './': 2, 'a.c': 7, 'reset.c': 0 } });
    expect(f.store.createBranchFromPin).toHaveBeenCalledWith('workspace', 'child-source:scoped', scopedPin, `previous@${revision}`,
      undefined, [], { sourceProvenance: result.provenance });
  });

  it('does not scope a native handoff again after its snapshot already rebased the paths', async () => {
    const f = fixture();
    f.original.provenance.textEncoding = { root: '/original/sub', defaultEncoding: 'utf-8', files: { 'a.c': 'gbk' }, choiceRevisions: { 'a.c': 11 } };
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

  it('dispatches a fixed subtree using only the claimed branch metadata, never a private working result', async () => {
    const childId = 'child-source:claimed';
    const policy: KernelTextPolicy = { root: '/original', files: { 'sub/a.c': 'gbk' }, choiceRevisions: { 'sub/a.c': 9 } };
    const grant: KernelGrantHandle = { operationId: null, grantId: 'claimed-handoff', kernelEpoch: 'epoch', hostGeneration: 'generation',
      authorityInstanceId: null, workerId: null, workerGeneration: null, sessionId: null, threadId: 'child-thread', runId: null,
      owningWorkspace: 'workspace', executionWorkspace: 'workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''], storageIdentity: 'storage' };
    const branches = new Map([['previous', { branchId: 'previous', workspaceId: 'workspace', root: 'newer-head', baseRoot: 'original',
      writeRevision: 3, headRevision: 2, parentRef: 'older@1', captureScopes: [] as string[], draftBasePaths: [] as string[], createdAt: 1, updatedAt: 2 }]]);
    // Real Host storage adapter and preparation consumer; only the native ports
    // are controlled. The accepted claim excludes working.result.get.
    const scoped = {
      getOperation: vi.fn(async () => null),
      workingResultGet: vi.fn(async () => { throw new Error('working.result.get exceeds the accepted child source handoff'); }),
      readBranch: vi.fn(async (input: Parameters<KernelScopedClient['readBranch']>[0]) => {
        const branch = branches.get(input.branchId);
        if (!branch) throw new Error('Unexpected branch');
        return { ...branch, view: input.revision === undefined ? 'current' : 'revision', revision: input.revision ?? branch.headRevision,
          root: input.branchId === 'previous' && input.revision === 2 ? 'selected-full-root' : branch.root,
          entries: [], nextCursor: null, ...(input.branchId === 'previous' && input.revision === 2 ? { textEncoding: policy } : {}) };
      }),
      readPin: vi.fn(async () => ({ pinId: 'accepted-subtree', branchId: 'previous', workspaceId: 'workspace', view: 'revision',
        revision: 2, writeRevision: 2, root: 'selected-subtree' })),
      putBlob: vi.fn(async (bytes: Buffer) => ({ hash: 'provenance-object', byteLength: bytes.length, ownerId: 'provenance-upload' })),
      forkBranch: vi.fn(async (input: Parameters<KernelScopedClient['forkBranch']>[0]) => {
        branches.set(input.branchId, { branchId: input.branchId, workspaceId: input.workspaceId, root: 'selected-subtree', baseRoot: 'selected-subtree',
          writeRevision: 0, headRevision: 0, parentRef: input.parentRef!, captureScopes: input.captureScopes!, draftBasePaths: input.draftBasePaths!, createdAt: 3, updatedAt: 3 });
        return { created: true, branchId: input.branchId, root: 'selected-subtree', writeRevision: 0, headRevision: 0 };
      }),
      pinBranch: vi.fn(async (input: Parameters<KernelScopedClient['pinBranch']>[0]) => ({ pinId: input.pinId, branchId: childId,
        workspaceId: 'workspace', view: 'revision', revision: 0, writeRevision: 0, root: 'selected-subtree' })),
    };
    const kernel = { subscribeExit: () => () => {}, claimChildSource: vi.fn(async () => grant), scoped: vi.fn(() => scoped),
      issueGrant: vi.fn(async () => { throw new Error('Grant expansion is forbidden'); }) };
    const adapter = new KernelStorageAdapter({ client: kernel as unknown as KernelClient, hostId: 'host', storageRoot: '/unused',
      resolveWorkspaceRoot: async () => { throw new Error('Fixed source has no physical root'); } });
    const claimed = await kernel.claimChildSource();
    const store = new KernelWorkingStateRootStore(await adapter.contextFromBranchGrant({ grant: claimed,
      owningWorkspaceId: 'workspace', executionWorkspaceId: 'workspace' }));
    const f = fixture();
    const result = await prepareDispatchSourceStore({ execution_id: 'claimed', selected_profile: { work_mode: 'read_only' }, source: {
      kind: 'pending', handoff: { source, source_path: 'sub', root: { kind: 'fixed', pin: { source, root: 'selected-subtree', pin_id: 'accepted-subtree' } } },
    } } as unknown as DelegatedExecution, { store, capture: f.owners.capture, physical: f.owners.physical }, signal);
    expect(result.provenance.textEncoding).toEqual({ root: '/original/sub', files: { 'a.c': 'gbk' }, choiceRevisions: { 'a.c': 9 } });
    expect(scoped.forkBranch).toHaveBeenCalledWith(expect.objectContaining({ branchId: childId, sourcePinId: 'accepted-subtree',
      textEncoding: result.provenance.textEncoding }), undefined);
    expect(scoped.readBranch).toHaveBeenCalledWith({ branchId: 'previous', revision: 2, includeEntries: false }, signal);
    expect(scoped.workingResultGet).not.toHaveBeenCalled();
    expect(kernel.issueGrant).not.toHaveBeenCalled();
    expect(kernel.scoped).toHaveBeenCalledWith(grant);
    await expect(store.readTextEncoding('previous', 2, { root: 'wrong-root', signal })).rejects.toThrow('selected branch revision');
  });
});
