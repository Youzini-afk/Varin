import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentRegistry } from '@varin/ui/lib/documents/registry';
import type { DocumentsAPI } from '@varin/application-client';
import { createDocumentAuthority, type DocumentAuthority } from '../application-host/lib/documents/authority.js';
import { createNativeAuthorityTestRuntime } from '../application-host/lib/kernel/native-authority.test-helper.js';
import { IntegrationCoordinator } from '../application-host/lib/harness/working-state/integration-coordinator.js';

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
  releaseAgentInputSnapshot: async ({ sessionId, context }) => authority.releaseAgentInputSnapshot(sessionId, context),
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
    const native = await createNativeAuthorityTestRuntime({ documents: authority, hostId: 'surface-vertical-host', dataDir });
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
    } finally {
      await registry.flushRecoveryJournals();
      await registry.dispose();
      await authority.dispose();
      await native.dispose();
    }
  });
});
