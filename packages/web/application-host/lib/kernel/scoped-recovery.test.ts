import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScopedKernelRecoveryBindings, createKernelRecoveryDirectFacade } from './kernel-recovery-store.js';
import type { KernelFileAuthorityContext, KernelStorageAdapter } from './storage-adapter.js';
import type { KernelScopedClient } from './kernel-client.js';
import type { HostResourceOperationGate } from '../recovery/durable-file-operation.js';
import { createWorkspaceRecoveryEngine } from '../recovery/journal-engine.js';
import { createInMemoryRecoveryDurablePort } from '../recovery/recovery-durable-port.test-helper.js';
import type { RecoveryIdentity } from '../recovery/journal-files.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-scoped-recovery-'));
  roots.push(root);
  const state = { kind: 'missing' };
  const client = {
    fileLeaseAcquire: vi.fn(async () => ({ status: 'acquired' })),
    fileLeaseCheck: vi.fn(async () => ({})),
    fileLeaseRelease: vi.fn(async () => ({})),
    fileCapture: vi.fn(async () => ({ path: 'a.txt', stateJson: JSON.stringify(state) })),
    fileApply: vi.fn(async () => ({ status: 'applied', stateJson: JSON.stringify(state) })),
    recoveryOperationCreate: vi.fn(async (input: Record<string, unknown>) => ({ operationId: input.operationId, state: input.state, revision: 1, files: input.files })),
    recoveryOperationConflicts: vi.fn(async () => ({ operations: [] })),
    recoveryOperationGet: vi.fn(async () => ({ operationId: 'operation', state: 'complete', revision: 2 })),
  };
  const adapter = { context: vi.fn(async () => { throw new Error('Unexpected broader storage grant'); }),
    fileAuthorityContext: vi.fn(async () => { throw new Error('Unexpected broader file grant'); }) };
  const authority: KernelFileAuthorityContext = {
    client: client as unknown as KernelScopedClient, rootId: 'admitted-root', owningWorkspaceId: 'owning',
    executionWorkspaceId: 'execution', canonicalRoot: root, pendingFileOperations: [],
    reconcilePendingFileOperation: async () => ({}),
  };
  const entered = vi.fn();
  const gate: HostResourceOperationGate = { run: async (resources, operation) => { entered(resources); return operation(); } };
  const bindings = createScopedKernelRecoveryBindings(adapter as unknown as KernelStorageAdapter,
    { authority, threadId: 'parent-thread', runId: 'parent-run', storageRoot: path.join(root, 'objects'), resourceOperationGate: gate });
  const identity: RecoveryIdentity = { workspaceId: 'owning', canonicalRoot: root, authorityId: 'host', filesystemProfile: 'test' };
  return { ...bindings, client, adapter, identity, root, gate, entered };
};

it('keeps file capture, apply and original journal receipt on the admitted actor', async () => {
  const h = await fixture();
  await h.resourceOperationGate.run([{ resourceId: 'a.txt', scope: 'exact' }], async () => {
    await h.fileStore.captureState(h.identity, h.root, 'a.txt', { store: true });
    await h.fileStore.applyState(h.identity, h.root, 'a.txt', { kind: 'missing' });
  });
  expect(h.entered).toHaveBeenCalledOnce();
  expect(h.client.fileLeaseAcquire).toHaveBeenCalledOnce();
  expect(h.client.fileCapture).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'owning', rootId: 'admitted-root', path: 'a.txt' }));
  expect(h.client.fileApply).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'owning', rootId: 'admitted-root', expectedJson: '{"kind":"missing"}' }));
  await h.durableRecoveryStore.createOperation({ operationId: 'operation', workspaceId: 'owning', kind: 'integration', state: 'planned', data: {}, targets: {} });
  expect(h.client.recoveryOperationCreate).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'parent-thread', runId: 'parent-run' }));
  expect(await h.durableRecoveryStore.getOperation('owning', 'operation')).toMatchObject({ state: 'complete', revision: 2 });
  expect(await h.durableRecoveryStore.listOperationConflicts({ workspaceId: "owning", canonicalRoot: h.root, paths: ["a.txt"] })).toEqual([]);
  expect(h.client.recoveryOperationConflicts).toHaveBeenCalledWith({ workspaceId: "owning", rootId: "admitted-root", paths: ["a.txt"] });
  expect(h.adapter.context).not.toHaveBeenCalled();
  expect(h.adapter.fileAuthorityContext).not.toHaveBeenCalled();
});

it('rejects another root, workspace and owner without a maintenance fallback', async () => {
  const h = await fixture();
  await expect(h.fileStore.captureState({ ...h.identity, canonicalRoot: path.dirname(h.root) }, h.root, 'a.txt')).rejects.toThrow('outside');
  await expect(h.fileStore.captureState({ ...h.identity, workspaceId: 'other' }, h.root, 'a.txt')).rejects.toThrow('admitted actor');
  await expect(h.durableRecoveryStore.createOperation({ operationId: 'operation', workspaceId: 'owning', kind: 'integration', state: 'planned', data: {}, targets: {}, threadId: 'other' })).rejects.toThrow('owner');
  await expect(h.durableRecoveryStore.listOperations('owning', 'integration')).rejects.toThrow('explicit metadata reader');
  expect(h.client.fileCapture).not.toHaveBeenCalled();
  expect(h.client.recoveryOperationCreate).not.toHaveBeenCalled();
  expect(h.adapter.context).not.toHaveBeenCalled();
  expect(h.adapter.fileAuthorityContext).not.toHaveBeenCalled();
});


it('the production facade uses the original short metadata coordinator without widening an admitted context', async () => {
  const h = await fixture();
  const base = createWorkspaceRecoveryEngine({ authorityId: 'host', dataDir: h.root, fileStore: h.fileStore,
    durableRecoveryStore: createInMemoryRecoveryDurablePort(),
    documents: { inspectWorkspace: async workspaceId => ({ workspaceId, root: h.root }),
      listWorkspaceRegistrations: async () => [], inspectDirtyBuffers: async () => [] },
    sessionNavigation: { prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
      prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }), commit: async () => ({}), commitLeaf: async () => ({}) },
  });
  const facade = createKernelRecoveryDirectFacade(base, h.durableRecoveryStore);
  let release!: () => void;
  let entered!: () => void;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = facade.coordinateWorkspaceStorage('owning', { mode: 'exclusive', purpose: 'reserve' }, async () => {
    entered(); await waiting;
  });
  await enteredGate;
  let second = false;
  const next = facade.withWorkspaceStorage('owning', { mode: 'exclusive', purpose: 'other-reserve' }, () => { second = true; });
  const shared = await facade.withWorkspaceStorage('owning', { mode: 'shared', purpose: 'read-original' }, context => context.identity.canonicalRoot);
  expect(shared).toBe(h.root);
  expect(second).toBe(false);
  release(); await first; await next;
  expect(second).toBe(true);
  await facade.dispose();
  expect(h.adapter.context).not.toHaveBeenCalled();
});

it('transfers a real candidate owner into the original journal reference without copying its bytes', async () => {
  const h = await fixture();
  const hash = `sha256-${'1'.repeat(64)}`;
  h.durableRecoveryStore.registerObjectOwner('owning', hash, 'candidate-owner');
  await h.durableRecoveryStore.createOperation({ operationId: 'candidate-operation', workspaceId: 'owning', kind: 'integration', state: 'planned', data: {},
    targets: { 'a.txt': { target: { kind: 'regular-file', objectHash: hash, byteLength: 1 } } } });
  expect(h.client.recoveryOperationCreate).toHaveBeenCalledWith(expect.objectContaining({ files: [expect.objectContaining({
    path: 'a.txt', references: [expect.objectContaining({ ownerId: 'candidate-owner', objectHash: hash })],
  })] }));
  expect(h.fileStore.ownerIdForHash('owning', hash)).toBeUndefined();
  expect(h.adapter.context).not.toHaveBeenCalled();
});
