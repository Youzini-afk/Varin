import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspaceRecoveryCheckpointListResult } from '@varin/extension-contract';
import type { HostCapabilityCallContext } from '@varin/extension-host';
import {
  createDocumentAuthorityHarness,
  type DocumentAuthorityHarness,
} from '../documents/contract-fixtures.js';
import { createWorkspaceRecoveryCapabilityHandler } from './capability.js';
import { createWorkspaceRecoveryEngine, type RecoverySessionNavigation } from './journal-engine.js';
import { createRecoveryFileStore } from './file-store.test-helper.js';
import { createInMemoryRecoveryDurablePort } from './recovery-durable-port.test-helper.js';

let harness: DocumentAuthorityHarness | undefined;

const context: HostCapabilityCallContext = {
  owner: {
    entrypointId: 'builtin-recovery',
    instanceKey: 'recovery-capability-fixture',
    extensionId: 'varin.builtin.recovery',
    extensionVersion: '0.3.0',
    generation: 1,
  },
  signal: new AbortController().signal,
};

const navigation: RecoverySessionNavigation = {
  commit: async () => ({}),
  commitLeaf: async () => ({}),
  prepare: async (input) => ({
    expectedLeafId: input.entryId,
    removedEntryIds: [],
    targetLeafId: input.entryId,
  }),
  prepareLeaf: async (input) => ({
    expectedLeafId: input.targetLeafId,
    removedEntryIds: [],
    targetLeafId: input.targetLeafId,
  }),
};

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('workspace.recovery-primitives Web Host capability', () => {
  it('validates JSON input across journal, checkpoint, combined, and storage primitives', async () => {
    harness = await createDocumentAuthorityHarness();
    await fs.promises.writeFile(`${harness.workspaceRoot}/note.txt`, 'content');
    const engine = createWorkspaceRecoveryEngine({
      authorityId: harness.authority.hostId,
      dataDir: harness.dataDir,
      documents: harness.authority,
      durableRecoveryStore: createInMemoryRecoveryDurablePort(),
      fileStore: createRecoveryFileStore(),
      sessionNavigation: navigation,
    });
    const capability = createWorkspaceRecoveryCapabilityHandler(engine as never);
    const created = await engine.createCheckpoint({
      name: 'Before refactor',
      workspaceId: harness.identity.workspaceId,
    });
    expect(created).toMatchObject({ status: 'ready', checkpoint: { source: 'named' } });
    const listed = parseWorkspaceRecoveryCheckpointListResult(await capability(
      'listCheckpoints',
      { workspaceId: harness.identity.workspaceId },
      context,
    ));
    expect(listed.status).toBe('ready');
    if (listed.status !== 'ready') throw new Error('Expected checkpoint list');
    expect(listed.page.checkpoints).toHaveLength(1);
    // Storage location is owned by the Rust kernel: overrides are unavailable.
    const global = await capability('setDefaultStorageLocation', { mode: 'workspace-adjacent' }, context);
    expect(global).toMatchObject({ status: 'failed', failure: { code: 'unavailable' } });
    expect(await capability('listStorageWorkspaces', {}, context)).toMatchObject({
      status: 'ready',
      workspaces: [expect.objectContaining({ workspaceId: harness.identity.workspaceId })],
    });
    const inherited = await capability('clearStorageLocationOverride', {
      workspaceId: harness.identity.workspaceId,
    }, context);
    expect(inherited).toMatchObject({ status: 'failed', failure: { code: 'unavailable' } });
    await expect(capability('createCheckpoint', { name: 'x', workspaceId: harness.identity.workspaceId }, context)).rejects.toThrow();
    await expect(capability('recordMutationBefore', {}, context)).rejects.toThrow(/original runtime owner/);
    await expect(capability('prepareCombinedRecovery', {}, context)).rejects.toThrow(/entryId/);
  });
});

it('keeps native journal anchors and mutations behind their original runtime owner', async () => {
  const engine = { recordTurnStart: vi.fn(), recordTurnSettled: vi.fn(), recordMutationBefore: vi.fn(), recordMutationAfter: vi.fn() };
  const handler = createWorkspaceRecoveryCapabilityHandler(engine as never);
  for (const method of Object.keys(engine)) {
    await expect(handler(method, { conversation: { kind: 'thread', threadId: 'thread', branchId: 'branch' } }, {} as never)).rejects.toThrow(/original runtime owner/);
  }
  for (const method of Object.values(engine)) expect(method).not.toHaveBeenCalled();
});
