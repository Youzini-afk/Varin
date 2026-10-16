import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentRegistry } from '@varin/ui/lib/documents/registry';
import type { DocumentsAPI } from '@varin/application-client';
// Type-check the Host through its emitted declarations; Vitest loads its source.
import { createDocumentAuthority, type DocumentAuthority } from '#application-host/lib/documents/authority.js';
import { createAuthorityTestRuntime } from '#application-host/lib/kernel/authority.test-helper.js';
import { IntegrationCoordinator } from '#application-host/lib/harness/working-state/integration-coordinator.js';

import { parseDocumentWatchEvent } from '../src/api/documents';

const roots: string[] = [];
// The direct test transport applies the public client's required epoch shape.
async function publicEpoch<T extends { status: string }>(work: Promise<T>): Promise<Exclude<T, { status: 'stale-epoch' }> | { status: 'stale-epoch'; currentEpoch: number }> {
  const value = await work;
  if (value.status === 'stale-epoch') {
    const epoch = (value as { currentEpoch?: unknown }).currentEpoch;
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch)) throw new Error('Missing current workspace epoch');
    return { status: 'stale-epoch', currentEpoch: epoch };
  }
  return value as Exclude<T, { status: 'stale-epoch' }>;
}

const documentsClient = (authority: DocumentAuthority): DocumentsAPI => ({
  prepareWorkspaceEdit: request => authority.prepareWorkspaceEdit(request),
  discardWorkspaceEdit: request => authority.discardWorkspaceEdit(request),
  applyWorkspaceEdit: request => authority.applyWorkspaceEdit(request),
  readWorkspaceEdit: request => authority.readWorkspaceEdit(request),
  readWorkspaceEditRecovery: request => authority.readWorkspaceEditRecovery(request),
  undoWorkspaceEdit: request => authority.undoWorkspaceEdit(request),
  listWorkspaceEdits: request => authority.listWorkspaceEdits(request.workspaceId),
  resolveWorkspace: authority.resolveWorkspace,
  resolveResourceIdentity: authority.resolveResourceIdentity,
  read: authority.read,
  write: (request) => publicEpoch(authority.write(request)),
  move: (request) => publicEpoch(authority.move(request)),
  delete: (request) => publicEpoch(authority.delete(request)),
  publishDirtyBuffers: authority.publishDirtyBuffers,
  clearDirtyBuffers: authority.clearDirtyBuffers,
  ackDirtyStateBarrier: authority.acknowledgeDirtyStateBarrier,
  captureAgentInputSnapshot: authority.captureAgentInputSnapshot,
  releaseAgentInputSnapshot: async ({ consumer, context }) => authority.releaseAgentInputSnapshot(consumer, context),
  listRecoveryJournals: authority.listRecoveryJournals,
  readRecoveryJournal: authority.readRecoveryJournal,
  writeRecoveryJournal: (request) => publicEpoch(authority.writeRecoveryJournal(request)),
  deleteRecoveryJournal: (request) => publicEpoch(authority.deleteRecoveryJournal(request)),
  readSurfaceOperation: authority.readSurfaceOperation,
  completeSurfaceOperation: authority.completeSurfaceOperation,
  watch(...[workspaceId, listener, options]: Parameters<DocumentsAPI["watch"]>) {
    const files = authority.watch(workspaceId, (event) => listener(parseDocumentWatchEvent(event)));
    const surface = options?.dirtyOwner
      ? authority.registerDirtySurface({ ...options.dirtyOwner, workspaceId }, (event) => listener(parseDocumentWatchEvent(event)))
      : null;
    return {
      close() {
        surface?.close();
        files.close();
      },
    };
  },
});

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

it('captures a selected nested root through Documents while an unrelated dirty root is offline', async () => {
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'varin-scoped-source-')));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const nested = path.join(workspace, 'nested');
  const other = path.join(root, 'other');
  await fs.promises.mkdir(nested, { recursive: true });
  await fs.promises.mkdir(other);
  await fs.promises.writeFile(path.join(nested, 'draft.txt'), 'selected saved');
  await fs.promises.writeFile(path.join(other, 'private.txt'), 'private saved');
  let trusted = true;
  const authority = createDocumentAuthority({
    hostId: 'scoped-source-host', dataDir: path.join(root, 'data'),
    isAllowedRoot: async () => true, isTrusted: async () => trusted,
  });
  const parent = await authority.resolveWorkspace({ path: workspace });
  const unrelated = await authority.resolveWorkspace({ path: other });
  const parentRef = { workspaceId: parent.workspaceId, resourceId: 'nested/draft.txt' };
  const unrelatedRef = { workspaceId: unrelated.workspaceId, resourceId: 'private.txt' };
  const registry = new DocumentRegistry({ documents: documentsClient(authority), getGeneration: () => 1 });
  const consumer = { kind: 'thread' as const, threadId: 'selected-thread', branchId: 'selected-branch' };
  try {
    await registry.open(parentRef); await registry.open(unrelatedRef);
    registry.applyTransaction(parentRef, 'selected draft', { origin: 'editor' });
    registry.applyTransaction(unrelatedRef, 'private draft', { origin: 'editor' });
    const selected = await authority.resolveWorkspace({ path: nested });
    await fs.promises.rename(other, `${other}-offline`);
    const context = await registry.captureAgentInputContext(consumer, selected.workspaceId);
    assert.equal(context.source, 'surface');
    assert.equal(context.snapshot.status, 'ready');
    assert.deepEqual(context.roots, [{ workspaceId: selected.workspaceId, dirtyPaths: ['draft.txt'] }]);
    const frozen = authority.cloneInputSnapshot(consumer, context);
    if (frozen.status !== 'ready') throw new Error('Selected draft snapshot was unavailable');
    assert.deepEqual(frozen.resources.map((entry) => [entry.resource.workspaceId, entry.resource.resourceId, entry.content]),
      [[selected.workspaceId, 'draft.txt', 'selected draft']]);
    assert.equal(registry.get(unrelatedRef)?.buffer, 'private draft');
    await registry.releaseAgentInputContext(consumer, context);
    await fs.promises.rename(nested, `${nested}-offline`);
    const unavailable = await registry.captureAgentInputContext(consumer, selected.workspaceId);
    assert.equal(unavailable.source, 'surface');
    assert.equal(unavailable.snapshot.status, 'unavailable');
    trusted = false;
    await assert.rejects(authority.resolveResourceIdentity(unrelatedRef, { withinWorkspaceId: selected.workspaceId }), { code: 'untrusted' });
  } finally {
    await registry.dispose();
    await authority.dispose();
  }
});

describe('surface Integration vertical path', () => {
  it('applies and undoes disk and editor targets together after the editor becomes clean', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'varin-surface-vertical-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    const child = path.join(root, 'child');
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.mkdir(child, { recursive: true });
    await fs.promises.writeFile(path.join(workspace, 'draft.txt'), 'saved\n');
    await fs.promises.writeFile(path.join(child, 'draft.txt'), 'saved\n');
    await fs.promises.writeFile(path.join(workspace, 'disk.txt'), 'disk base\n');
    await fs.promises.writeFile(path.join(child, 'disk.txt'), 'disk child\n');

    const authority = createDocumentAuthority({
      hostId: 'surface-vertical-host',
      dataDir,
      isAllowedRoot: async () => true,
      isTrusted: async () => true,
    });
    const identity = await authority.resolveWorkspace({ path: workspace });
    const registry = new DocumentRegistry({
      documents: documentsClient(authority),
      getGeneration: () => 1,
      recoverySessionId: 'surface-vertical-editor',
      journalDebounceMs: 0,
    });
    const native = await createAuthorityTestRuntime({ documents: authority, hostId: 'surface-vertical-host', dataDir });
    const { workingStates } = native;
    try {
      const resource = { workspaceId: identity.workspaceId, resourceId: 'draft.txt' };
      await registry.open(resource);
      registry.applyTransaction(resource, 'draft\n', { origin: 'editor' });
      await expect.poll(async () => (await authority.inspectDirtyBuffers(identity.workspaceId))[0]?.resources.length)
        .toBe(1);

      await workingStates.withBranchStore(identity.workspaceId, 'surface-vertical-baseline', async (store) => {
        const disk = await store.captureDirectory(workspace);
        const draft = await store.putObject(Buffer.from('draft\n'));
        const saved = disk['draft.txt'];
        if (!saved || saved.kind !== 'regular-file') throw new Error('expected saved draft file');
        await store.createBranch(identity.workspaceId, 'thread-surface-vertical', {
          ...disk,
          'draft.txt': {
            kind: 'regular-file',
            objectHash: draft.hash,
            byteLength: draft.byteLength,
            ...(saved.mode !== undefined ? { mode: saved.mode } : {}),
          },
        }, 'base', ['draft.txt']);
      });
      const execution = await authority.resolveWorkspace({ path: child });
      const result = await workingStates.withBranchStore(identity.workspaceId, 'surface-vertical-result',
        (store) => store.publishDirectoryResult('thread-surface-vertical', child),
        'exclusive', { executionWorkspace: execution.workspaceId });
      const coordinator = new IntegrationCoordinator({
        workingStates,
        inspectDirtyBuffers: authority.inspectDirtyBuffers,
        beginDirtyStateBarrier: (workspaceId, paths) => authority.beginDirtyStateBarrier(workspaceId, paths),
        requestSurfaceOperation: (request, options) => authority.requestSurfaceOperation(request, options),
      });

      const merged = await coordinator.mergeResult({
        workspaceId: identity.workspaceId,
        threadId: 'thread-surface-vertical',
        branchId: 'thread-surface-vertical',
        resultRevision: result.resultRevision,
        sourceOwner: registry.surfaceOwner(),
      });
      expect(merged.status).toBe('applied');
      expect(registry.get(resource)).toMatchObject({ buffer: 'saved\n', dirty: false });
      expect(await fs.promises.readFile(path.join(workspace, 'draft.txt'), 'utf8')).toBe('saved\n');
      expect(await fs.promises.readFile(path.join(workspace, 'disk.txt'), 'utf8')).toBe('disk child\n');
      expect([...merged.appliedPaths].sort()).toEqual(['disk.txt', 'draft.txt']);

      const originalJournal = await native.recovery.getOperation(identity.workspaceId, merged.operationId);
      await expect(coordinator.undoIntegration({
        workspaceId: identity.workspaceId,
        threadId: 'thread-surface-vertical',
        operationId: merged.operationId,
        sourceOwner: { ownerId: 'another-editor', generation: 1 },
      })).rejects.toThrow('another document surface');
      expect(await native.recovery.getOperation(identity.workspaceId, merged.operationId)).toEqual(originalJournal);
      expect(registry.get(resource)?.buffer).toBe('saved\n');
      expect(await fs.promises.readFile(path.join(workspace, 'disk.txt'), 'utf8')).toBe('disk child\n');

      const undone = await coordinator.undoIntegration({
        workspaceId: identity.workspaceId,
        threadId: 'thread-surface-vertical',
        operationId: merged.operationId,
        sourceOwner: registry.surfaceOwner(),
      });
      expect(undone.status).toBe('compensated');
      expect(registry.get(resource)).toMatchObject({ buffer: 'draft\n', dirty: true });
      expect(await fs.promises.readFile(path.join(workspace, 'draft.txt'), 'utf8')).toBe('saved\n');
      expect(await fs.promises.readFile(path.join(workspace, 'disk.txt'), 'utf8')).toBe('disk base\n');
      const undoneJournal = await native.recovery.getOperation(identity.workspaceId, merged.operationId);
      expect(undoneJournal?.result).toMatchObject({ compensatedPaths: expect.arrayContaining(['disk.txt', 'draft.txt']),
        effect: 'confirmed', executorStopped: true });
    } finally {
      await registry.flushRecoveryJournals();
      await registry.dispose();
      await authority.dispose();
      await native.dispose();
    }
  });

  it('retains a confirmed Surface undo when a second real Registry reply is lost', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'varin-surface-undo-receipts-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    await fs.promises.mkdir(workspace);
    for (const file of ['a.txt', 'b.txt']) await fs.promises.writeFile(path.join(workspace, file), 'saved\n');
    const authority = createDocumentAuthority({ hostId: 'surface-undo-receipts', dataDir,
      isAllowedRoot: async () => true, isTrusted: async () => true });
    const identity = await authority.resolveWorkspace({ path: workspace });
    const native = await createAuthorityTestRuntime({ documents: authority, hostId: 'surface-undo-receipts', dataDir });
    const registries = ['a', 'b'].map(name => new DocumentRegistry({ documents: documentsClient(authority),
      getGeneration: () => 1, recoverySessionId: `surface-undo-${name}`, journalDebounceMs: 0 }));
    try {
      for (const [index, file] of ['a.txt', 'b.txt'].entries()) {
        const resource = { workspaceId: identity.workspaceId, resourceId: file };
        await registries[index]!.open(resource);
        registries[index]!.applyTransaction(resource, 'draft\n', { origin: 'editor' });
      }
      await expect.poll(async () => (await authority.inspectDirtyBuffers(identity.workspaceId))
        .flatMap(publication => publication.resources).length).toBe(2);
      const result = await native.workingStates.withBranchStore(identity.workspaceId, 'surface-undo-result', async store => {
        const base = await store.captureDirectory(workspace);
        const draft = await store.putObject(Buffer.from('draft\n'));
        const child = await store.putObject(Buffer.from('child\n'));
        const state = (hash: string, byteLength: number) => ({ kind: 'regular-file' as const, objectHash: hash, byteLength, mode: 0o644 });
        for (const file of ['a.txt', 'b.txt']) base[file] = state(draft.hash, draft.byteLength);
        await store.createBranch(identity.workspaceId, 'surface-undo-child', base, 'base', ['a.txt', 'b.txt']);
        await store.commitVirtualWrites('surface-undo-child', 0, Object.fromEntries(['a.txt', 'b.txt']
          .map(file => [file, state(child.hash, child.byteLength)])));
        return store.publishHeadResult('surface-undo-child');
      });
      const coordinator = new IntegrationCoordinator({ workingStates: native.workingStates,
        inspectDirtyBuffers: authority.inspectDirtyBuffers,
        beginDirtyStateBarrier: (workspaceId, paths) => authority.beginDirtyStateBarrier(workspaceId, paths),
        requestSurfaceOperation: async (request, options) => {
          const response = await authority.requestSurfaceOperation(request, options);
          if (request.action === 'undo' && request.targets.some(target => target.resource.resourceId === 'b.txt')) {
            throw new Error('Controlled loss after the original Registry performed undo');
          }
          return response;
        },
      });
      const merged = await coordinator.mergeResult({ workspaceId: identity.workspaceId, threadId: 'surface-undo-thread',
        branchId: 'surface-undo-child', resultRevision: result.resultRevision });
      expect(merged.status).toBe('applied');
      for (const [index, file] of ['a.txt', 'b.txt'].entries()) {
        expect(registries[index]!.get({ workspaceId: identity.workspaceId, resourceId: file })?.buffer).toBe('child\n');
      }
      const undone = await coordinator.undoIntegration({ workspaceId: identity.workspaceId, threadId: 'surface-undo-thread',
        operationId: merged.operationId });
      expect(undone.status).toBe('needs-attention');
      const journal = await native.recovery.getOperation(identity.workspaceId, merged.operationId);
      expect(journal?.result).toMatchObject({ compensatedPaths: ['a.txt'], needsAttentionPaths: ['b.txt'], executorStopped: false });
      const files = journal?.files as Array<{ path: string; phase: string }>;
      expect(files.find(file => file.path === 'a.txt')?.phase).toBe('external-safety-observed');
      expect(files.find(file => file.path === 'b.txt')?.phase).toBe('needs-attention');
      for (const [index, file] of ['a.txt', 'b.txt'].entries()) {
        expect(registries[index]!.get({ workspaceId: identity.workspaceId, resourceId: file })?.buffer).toBe('draft\n');
        expect(await fs.promises.readFile(path.join(workspace, file), 'utf8')).toBe('saved\n');
      }
    } finally {
      for (const registry of registries) { await registry.flushRecoveryJournals(); await registry.dispose(); }
      await authority.dispose();
      await native.dispose();
    }
  });
});
