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
import { createRecoveryJournalFixture } from './journal-fixture.test-helper.js';

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
    const before = (await fileStore.captureState(recoveryIdentity, recoveryIdentity.canonicalRoot, 'note.txt')).state;
    await fs.promises.writeFile(notePath, 'after service');
    const after = (await fileStore.captureState(recoveryIdentity, recoveryIdentity.canonicalRoot, 'note.txt')).state;
    const engine = createWorkspaceRecoveryEngine({
      authorityId: activeRuntime.services.hostId,
      dataDir: runtimeDataDir,
      documents: activeHarness.authority,
      durableRecoveryStore: createRecoveryJournalFixture({
        // Storage already selected the original turn. This test owns the public
        // service -> capability -> Host path, not native mutation bookkeeping.
        listChanges: async () => ({
          turns: [{ checkpointId: 'checkpoint', executionId: 'execution', sequence: 1,
            status: 'ready', activeWriterScopes: [], unrecordedResourceIds: [] }],
          changes: [{ before, after, path: 'note.txt', sequence: 1, checkpointId: 'checkpoint',
            executionId: 'execution', mutationId: 'mutation', toolName: 'write' }],
        }),
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
      status: 'ready', capabilities: { combined: true, journal: true },
    });
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
