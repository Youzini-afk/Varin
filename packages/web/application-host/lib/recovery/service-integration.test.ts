import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceRecoveryAPI } from '@varin/extension-contract';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import {
  createDocumentAuthorityHarness,
  type DocumentAuthorityHarness,
} from '../documents/contract-fixtures.js';
import { createWorkspaceRecoveryCapabilityHandler } from './capability.js';
import { createWorkspaceRecoveryEngine } from './journal-engine.js';
import { createRecoveryFileStore } from './file-store.test-helper.js';
import { createInMemoryRecoveryDurablePort } from './recovery-durable-port.test-helper.js';

let runtime: ApplicationExtensionRuntime | undefined;
let harness: DocumentAuthorityHarness | undefined;
let runtimeDataDir: string | undefined;

afterEach(async () => {
  await runtime?.stop().catch(() => undefined);
  await harness?.cleanup();
  if (runtimeDataDir) await fs.promises.rm(runtimeDataDir, { force: true, recursive: true });
  runtime = undefined;
  harness = undefined;
  runtimeDataDir = undefined;
});

describe('Web Application Host workspace recovery service', () => {
  it('invokes the built-in provider through the generic extension service path', async () => {
    runtimeDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'varin-recovery-service-'));
    const activeRuntime = await ApplicationExtensionRuntime.create({
      brokerScript: fileURLToPath(new URL('../../../../extension-host/broker/broker-child.mjs', import.meta.url)),
      dataDir: runtimeDataDir,
      varinVersion: '1.2.3',
    });
    runtime = activeRuntime;
    const activeHarness = await createDocumentAuthorityHarness({ hostId: activeRuntime.services.hostId });
    harness = activeHarness;
    const notePath = `${activeHarness.workspaceRoot}/note.txt`;
    await fs.promises.writeFile(notePath, 'before service');
    const fileStore = createRecoveryFileStore();
    const recoveryIdentity = {
      authorityId: activeRuntime.services.hostId,
      canonicalRoot: activeHarness.workspaceRoot,
      filesystemProfile: 'test',
      workspaceId: activeHarness.identity.workspaceId,
    };
    const engine = createWorkspaceRecoveryEngine({
      authorityId: activeRuntime.services.hostId,
      dataDir: runtimeDataDir,
      documents: activeHarness.authority,
      durableRecoveryStore: createInMemoryRecoveryDurablePort({
        captureState: async ({ path: inputPath }) => (
          await fileStore.captureState(recoveryIdentity, recoveryIdentity.canonicalRoot, inputPath, { store: true })
        ).state,
        relativePathFor: async ({ path: inputPath }) => (
          await fileStore.relativePathFor(recoveryIdentity, inputPath)
        ).relative,
      }),
      fileStore,
      sessionNavigation: {
        commit: async () => ({ alreadyApplied: false, markerId: 'service-marker', snapshot: {} }),
        commitLeaf: async () => ({ alreadyApplied: false, markerId: 'service-undo', snapshot: {} }),
        prepare: async () => ({
          currentLeafId: 'service-current-leaf',
          expectedLeafId: 'service-current-leaf',
          removedEntryIds: ['service-user-1', 'service-assistant-1'],
          targetId: 'service-assistant-1',
          targetLeafId: 'service-before-leaf',
        }),
        prepareLeaf: async ({ targetLeafId }) => ({
          currentLeafId: 'service-before-leaf',
          expectedLeafId: 'service-before-leaf',
          removedEntryIds: [],
          targetLeafId,
        }),
      },
    });
    activeRuntime.capabilities.register(
      'workspace.recovery-primitives',
      createWorkspaceRecoveryCapabilityHandler(engine as never),
    );
    await activeRuntime.start();

    const api = createWorkspaceRecoveryAPI((request) => activeRuntime.invokeService(request));
    expect(await api.status(activeHarness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      capabilities: {
        bindings: true,
        catalogLifecycle: true,
        checkpoints: true,
        combined: true,
        conflictConfirmation: true,
        dirtyStateBarrier: true,
        journal: true,
        redo: true,
        retention: false,
        storageManagement: false,
        workspaceLease: false,
      },
    });
    const turn = await engine.recordTurnStart({
      activeWriterScopes: ['native-runtime:worker-1'],
      executionId: 'service-execution-1',
      provenance: 'caused-by',
      runtimeGeneration: 1,
      conversation: { kind: 'thread', threadId: 'service-session-1', branchId: 'branch-1' },
      userEntryId: 'service-user-1',
      workerId: 'worker-1',
      workspaceId: activeHarness.identity.workspaceId,
    });
    expect(turn).toMatchObject({ status: 'ready', binding: { status: 'pending' } });
    const mutation = {
      executionId: 'service-execution-1',
      mutationId: 'service-mutation-1',
      path: notePath,
      toolCallId: 'service-tool-1',
      toolName: 'write' as const,
      workspaceId: activeHarness.identity.workspaceId,
    };
    expect(await engine.recordMutationBefore(mutation)).toMatchObject({ recorded: true, status: 'ready' });
    await fs.promises.writeFile(notePath, 'after service');
    expect(await engine.recordMutationAfter({ ...mutation, succeeded: true }))
      .toMatchObject({ recorded: true, status: 'ready' });
    const settled = await engine.recordTurnSettled({
      activeWriterScopes: ['native-runtime:worker-1'],
      assistantEntryId: 'service-assistant-1',
      executionId: 'service-execution-1',
      mutationObserved: true,
      observationComplete: true,
      observedResourceIds: ['note.txt'],
      provenance: 'caused-by',
      workspaceId: activeHarness.identity.workspaceId,
    });
    expect(settled).toMatchObject({ status: 'ready', binding: { status: 'ready' } });
    expect(await api.resolveEntry({
      entryId: 'service-assistant-1',
      conversation: { kind: 'thread', threadId: 'service-session-1', branchId: 'branch-1' },
      workspaceId: activeHarness.identity.workspaceId,
    })).toMatchObject({ position: 'after', status: 'ready' });
    const checkpoint = await api.createCheckpoint({
      name: 'Service checkpoint',
      workspaceId: activeHarness.identity.workspaceId,
    });
    expect(checkpoint).toMatchObject({ status: 'ready', checkpoint: { label: 'Service checkpoint' } });
    expect(await api.listCheckpoints({ workspaceId: activeHarness.identity.workspaceId }))
      .toMatchObject({ status: 'ready', page: { checkpoints: expect.any(Array) } });
    expect(await api.setRetentionPolicy({
      policy: {
        maxAgeDays: null,
        maxByteLength: null,
        maxCheckpointCount: 10,
        maxOperationCount: 10,
      },
      workspaceId: activeHarness.identity.workspaceId,
    })).toMatchObject({
      status: 'failed',
      failure: { code: 'unavailable' },
    });
    expect(await api.retentionStatus(activeHarness.identity.workspaceId))
      .toMatchObject({ status: 'ready', retention: { workspaceId: activeHarness.identity.workspaceId } });
    const combined = await api.prepareCombinedRecovery({
      entryId: 'service-user-1',
      conversation: { kind: 'thread', threadId: 'service-session-1', branchId: 'branch-1' },
      workspaceId: activeHarness.identity.workspaceId,
    });
    expect(combined).toMatchObject({
      status: 'ready',
      plan: {
        expectedLeafId: 'service-current-leaf',
        affectedPaths: ['note.txt'],
        targetLeafId: 'service-before-leaf',
      },
    });
    if (combined.status !== 'ready') throw new Error('Expected combined recovery plan');
    const applied = await api.applyCombinedRecovery({
      confirmedConflicts: [],
      conflictPolicy: 'abort',
      expectedRevision: combined.plan.revision,
      operationId: combined.plan.id,
    });
    expect(applied).toMatchObject({ status: 'ready', operation: { state: 'complete' } });
    expect(await fs.promises.readFile(notePath, 'utf8')).toBe('before service');
    expect(await api.listCombinedOperations(activeHarness.identity.workspaceId)).toMatchObject({
      status: 'ready',
      operations: [expect.objectContaining({ id: combined.plan.id, state: 'complete' })],
    });
  });
});
