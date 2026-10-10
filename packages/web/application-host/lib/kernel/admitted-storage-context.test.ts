import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KernelStorageAdapter, type KernelAdmittedStorageContextInput } from './storage-adapter.js';
import type { KernelClient, KernelGrantHandle } from './kernel-client.js';
import type { RecoveryFileStore } from '../recovery/journal-files.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admitted-storage-'));
  roots.push(root);
  const source = await fs.realpath(await fs.mkdir(path.join(root, 'source')).then(() => path.join(root, 'source')));
  const other = await fs.realpath(await fs.mkdir(path.join(root, 'other')).then(() => path.join(root, 'other')));
  const grant: KernelGrantHandle = { grantId: 'bounded', kernelEpoch: 'epoch', hostGeneration: 'generation', authorityInstanceId: null,
    workerId: null, workerGeneration: null, sessionId: null, threadId: 'thread', runId: 'run', owningWorkspace: 'owner', executionWorkspace: 'execution',
    capabilities: ['storage.read', 'storage.write'], pathScopes: ['allowed'], storageIdentity: 'storage' };
  const client = { fileRootRegister: vi.fn(async () => ({ rootId: 'registered', canonicalRoot: source, pendingOperations: 0 })),
    fileOperationList: vi.fn(async () => ({ operations: [{ operationId: 'interrupted', kind: 'file.apply', rootId: 'registered',
      paths: ['allowed/file'], disposition: 'reconcile', reason: 'interrupted', createdAt: 1, updatedAt: 2 }], nextCursor: null })),
    fileOperationReconcile: vi.fn(async () => ({ state: 'completed' })),
    getRecord: vi.fn(async () => null) };
  const host = { scoped: vi.fn((_grant: KernelGrantHandle) => client), issueGrant: vi.fn(async () => { throw new Error('Grant broadening is forbidden in this path'); }) };
  const fileStore = { captureState: vi.fn(), applyState: vi.fn(), hashFile: vi.fn(), relativePathFor: vi.fn(), verifyObject: vi.fn() } satisfies RecoveryFileStore;
  const resourceOperationGate = { run: async <T>(_resources: readonly unknown[], action: () => Promise<T>) => action() };
  const input: KernelAdmittedStorageContextInput = { grant, owningWorkspaceId: 'owner', executionWorkspaceId: 'execution',
    canonicalRoot: source, rootId: 'registered', fileStore, resourceOperationGate };
  const adapter = new KernelStorageAdapter({ client: host as unknown as KernelClient, hostId: 'host', storageRoot: root,
    resolveWorkspaceRoot: async () => { throw new Error('Mutable workspace selection must not be consulted'); } });
  return { adapter, input, host, client, source, other, fileStore, resourceOperationGate };
}

describe('explicit scoped WorkingState context', () => {
  it('uses the original grant and scoped effect ports without creating maintenance authority', async () => {
    const f = await fixture();
    const context = await f.adapter.contextFromGrant(f.input);
    expect(context.fileStore).toBe(f.fileStore);
    expect(context.resourceOperationGate).toBe(f.resourceOperationGate);
    expect(context.actor).toMatchObject({ threadId: 'thread', runId: 'run', pathScopes: ['allowed'] });
    expect(await context.resolveFileRoot(f.source)).toMatchObject({ rootId: 'registered', executionWorkspaceId: 'execution', basePath: '' });
    await context.records.get('record');
    expect(f.client.getRecord).toHaveBeenCalledWith('owner', 'record');
    expect(f.host.scoped.mock.calls.every(([grant]) => grant === f.input.grant)).toBe(true);
    expect(f.host.issueGrant).not.toHaveBeenCalled();
    expect(context.collectUnreachableObjects).toBeUndefined();
    await expect(context.resolveFileRoot(f.other)).rejects.toThrow('outside the admitted source');
    await expect(context.resolveMaterializationRoot(f.other)).rejects.toThrow('separately admitted');
  });

  it('rejects another execution workspace or a changed root registration', async () => {
    const f = await fixture();
    await expect(f.adapter.contextFromGrant({ ...f.input, executionWorkspaceId: 'foreign' })).rejects.toThrow('different workspace');
    f.client.fileRootRegister.mockResolvedValue({ rootId: 'replaced', canonicalRoot: f.source, pendingOperations: 0 });
    await expect(f.adapter.contextFromGrant(f.input)).rejects.toThrow('resource root changed');
    expect(f.host.issueGrant).not.toHaveBeenCalled();
  });

  it('keeps a fixed-source branch context independent of physical file authority', async () => {
    const f = await fixture();
    const context = await f.adapter.contextFromBranchGrant(f.input);
    await context.records.get('source-record');
    expect(f.client.fileRootRegister).not.toHaveBeenCalled();
    expect(f.host.issueGrant).not.toHaveBeenCalled();
    await expect(context.resolveFileRoot(f.source)).rejects.toThrow('no physical file authority');
    await expect(context.fileStore.hashFile(f.source)).rejects.toThrow('no physical file authority');
    await expect(context.resolveMaterializationRoot(f.source)).rejects.toThrow('separately admitted');
    expect(context.fileResources).toBeUndefined();
    expect(context.durableRecoveryStore).toBeUndefined();
    expect(context.collectUnreachableObjects).toBeUndefined();
  });

  it('reopens real pending file operations and reconciliation using the admitted grant', async () => {
    const f = await fixture();
    f.client.fileRootRegister.mockResolvedValue({ rootId: 'registered', canonicalRoot: f.source, pendingOperations: 1 });
    const context = await f.adapter.fileAuthorityContextFromGrant(f.input);
    expect(context.pendingFileOperations).toMatchObject([{ operationId: 'interrupted', paths: ['allowed/file'] }]);
    await context.reconcilePendingFileOperation('interrupted');
    expect(f.client.fileOperationReconcile).toHaveBeenCalledWith({ workspaceId: 'owner', rootId: 'registered', operationId: 'interrupted' });
    expect(f.host.issueGrant).not.toHaveBeenCalled();
  });
});
