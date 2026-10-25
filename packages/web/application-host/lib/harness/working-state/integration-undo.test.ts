import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IntegrationCoordinator } from './integration-coordinator.js';
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from './types.js';
import type { DocumentSurfaceOperationRequest } from '../../documents/authority.js';
import { createRecoveryJournalFixture } from '../../recovery/journal-fixture.test-helper.js';
import { createRecoveryFileStore } from '../../recovery/file-store.test-helper.js';
import { applyDurableFileOperation, finalizeDurableExternalOperation, markDurableExternalDispatched, undoDurableIntegrationOperation } from '../../recovery/durable-file-operation.js';

/** Coordinator owner behavior only: real durable-operation helpers with the explicit
 * in-memory metadata port and a controlled Surface. Native storage has separate tests. */
async function fixture(paths = ['draft.txt']) {
  const durable = createRecoveryJournalFixture();
  const context = {
    identity: { authorityId: 'host', canonicalRoot: '/fixture', filesystemProfile: 'test', workspaceId: 'workspace' },
    root: '/fixture/objects', durableRecoveryStore: durable,
    resourceOperationGate: { run: async (_resources, operation) => operation() },
    fileStore: {},
  } as WorkingStateRootContext & { durableRecoveryStore: typeof durable };
  const workingStates: WorkspaceWorkingStateRootAccess = {
    withBranchStore: async (_workspaceId, _purpose, operation) => operation({} as WorkingStateRootStore, context),
  };
  const beforeHash = `sha256-${'1'.repeat(64)}`;
  const afterHash = `sha256-${'2'.repeat(64)}`;
  const state = (objectHash: string) => ({ kind: 'regular-file' as const, objectHash, byteLength: 4 });
  const operationId = 'original-integration';
  await applyDurableFileOperation(context, {
    id: operationId, workspaceId: 'workspace', threadId: 'child', resultRevision: 1,
    targets: {}, externalTargets: Object.fromEntries(paths.map(file => [file, { expected: state(beforeHash), target: state(afterHash) }])),
    externalBindings: Object.fromEntries(paths.map((file, index) => [file, { ownerId: 'original-editor', ownerGeneration: 1,
      ownerRegistrationId: `registration-${index}`, documentInstanceId: `document-${index}`, baseRevision: 'disk',
      beforeLocalEditRevision: 2, beforeHash, encoding: 'utf-8', bom: false, lineEnding: 'lf' as const }])),
    conflictPaths: [], diffStats: { files: 1, insertions: 1, deletions: 1 },
  });
  await markDurableExternalDispatched(context, operationId, paths);
  await finalizeDurableExternalOperation(context, { operationId, results: Object.fromEntries(paths.map(file => [file, 'applied' as const])),
    receipts: Object.fromEntries(paths.map(file => [file, { afterLocalEditRevision: 3, afterHash }])), executorStopped: true });
  const requestSurfaceOperation = vi.fn(async (request: DocumentSurfaceOperationRequest) => request.targets.map(target => ({
    resource: target.resource, documentInstanceId: target.documentInstanceId, status: 'undone' as const,
    afterLocalEditRevision: 4, afterHash: beforeHash,
  })));
  const input = { workspaceId: 'workspace', threadId: 'child', operationId,
    sourceOwner: { ownerId: 'original-editor', generation: 1 } };
  const snapshot = () => durable.snapshot(input.workspaceId, operationId);
  return { workingStates, requestSurfaceOperation, input, snapshot };
}

it('rejects another Surface owner before reserving undo and keeps the original owner able to undo', async () => {
  const f = await fixture();
  const coordinator = new IntegrationCoordinator(f);
  const before = f.snapshot();
  await expect(coordinator.undoIntegration({ ...f.input, sourceOwner: { ownerId: 'another-editor', generation: 2 } }))
    .rejects.toThrow('another document surface');
  expect(f.snapshot()).toEqual(before);
  expect(f.requestSurfaceOperation).not.toHaveBeenCalled();
  expect((await coordinator.undoIntegration(f.input)).status).toBe('compensated');
  expect(f.snapshot()?.state).toBe('undone');
  expect(f.snapshot()?.result).toMatchObject({ compensatedPaths: ['draft.txt'], effect: 'confirmed', executorStopped: true });
});

it('retains the first Surface undo receipt when a later Surface response is lost', async () => {
  const f = await fixture(['a.txt', 'b.txt']);
  const request = f.requestSurfaceOperation.getMockImplementation()!;
  f.requestSurfaceOperation.mockImplementation(async input => {
    if (input.targets[0]?.resource.resourceId === 'b.txt') throw new Error('response lost');
    return request(input);
  });
  expect((await new IntegrationCoordinator(f).undoIntegration(f.input)).status).toBe('needs-attention');
  expect(f.snapshot()?.result).toMatchObject({ compensatedPaths: ['a.txt'], needsAttentionPaths: ['b.txt'], executorStopped: false });
  expect(f.snapshot()?.files.find(file => file.path === 'a.txt')?.phase).toBe('external-safety-observed');
});

it('does not accept another workspace acknowledgement as proof of Surface undo', async () => {
  const f = await fixture();
  const request = f.requestSurfaceOperation.getMockImplementation()!;
  f.requestSurfaceOperation.mockImplementation(async input => (await request(input)).map(result => ({
    ...result, resource: { ...result.resource, workspaceId: 'another-workspace' },
  })));
  expect((await new IntegrationCoordinator(f).undoIntegration(f.input)).status).toBe('needs-attention');
  expect(f.snapshot()?.result).toMatchObject({ compensatedPaths: [], executorStopped: false });
});

it('leaves a completed Integration retryable when the Surface channel is unavailable', async () => {
  const f = await fixture();
  const before = f.snapshot();
  await expect(new IntegrationCoordinator({ workingStates: f.workingStates }).undoIntegration(f.input))
    .rejects.toThrow('surface operation channel is unavailable');
  expect(f.snapshot()).toEqual(before);
  expect((await new IntegrationCoordinator(f).undoIntegration(f.input)).status).toBe('compensated');
});

it('does not reserve undo when fresh dirty-state inspection fails or the caller already cancelled', async () => {
  const f = await fixture();
  const before = f.snapshot();
  const beginDirtyStateBarrier = vi.fn(async () => { throw new Error('editor disconnected'); });
  await expect(new IntegrationCoordinator({ ...f, beginDirtyStateBarrier }).undoIntegration(f.input))
    .rejects.toThrow('editor disconnected');
  expect(f.snapshot()).toEqual(before);
  await expect(new IntegrationCoordinator(f).undoIntegration({ ...f.input, signal: AbortSignal.abort(new Error('cancelled')) }))
    .rejects.toThrow('cancelled');
  expect(f.snapshot()).toEqual(before);
  expect(f.requestSurfaceOperation).not.toHaveBeenCalled();
});

it('undo removes integrated descendants before restoring an original parent file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-undo-tree-order-'));
  try {
    const workspace = path.join(root, 'workspace');
    const child = path.join(root, 'child');
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(child, 'node'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'node'), 'original parent file');
    await fs.writeFile(path.join(child, 'node', 'child.txt'), 'integrated child');
    const fileStore = createRecoveryFileStore();
    const identity = { authorityId: 'fixture', canonicalRoot: workspace, filesystemProfile: 'test', workspaceId: 'workspace' };
    const contentRoot = path.join(root, 'objects');
    const before = (await fileStore.captureState(identity, contentRoot, 'node', { store: true })).state;
    const directory = (await fileStore.captureState({ ...identity, canonicalRoot: child }, contentRoot, 'node', { store: true })).state;
    const after = (await fileStore.captureState({ ...identity, canonicalRoot: child }, contentRoot, 'node/child.txt', { store: true })).state;
    const context = { identity, root: contentRoot, fileStore, durableRecoveryStore: createRecoveryJournalFixture(),
      resourceOperationGate: { run: async <T>(_resources: unknown, operation: () => Promise<T>) => operation() } };
    const applied = await applyDurableFileOperation(context, { id: 'file-to-directory', workspaceId: 'workspace', threadId: 'child',
      resultRevision: 1, targets: { node: { expected: before, target: directory },
        'node/child.txt': { expected: { kind: 'missing' }, target: after } }, conflictPaths: [],
      diffStats: { files: 2, insertions: 1, deletions: 1 } });
    expect(applied.status).toBe('applied');
    expect(await fs.readFile(path.join(workspace, 'node', 'child.txt'), 'utf8')).toBe('integrated child');
    expect((await undoDurableIntegrationOperation(context, { operationId: applied.operationId, surfaceUndonePaths: [] })).status)
      .toBe('compensated');
    expect(await fs.readFile(path.join(workspace, 'node'), 'utf8')).toBe('original parent file');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
