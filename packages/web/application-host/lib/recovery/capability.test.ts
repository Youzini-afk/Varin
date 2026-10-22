import { expect, it, vi } from 'vitest';
import { parseWorkspaceRecoveryCheckpointListResult } from '@varin/extension-contract';
import type { HostCapabilityCallContext } from '@varin/extension-host';
import { createWorkspaceRecoveryCapabilityHandler } from './capability.js';

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

it('validates capability input before forwarding and preserves the selected owner result', async () => {
  const page = { status: 'ready', page: { checkpoints: [], nextCursor: null } };
  const unavailable = { status: 'failed', failure: { code: 'unavailable', message: 'Selected owner has no storage relocation', retryable: false } };
  const inventory = { status: 'ready', workspaces: [] };
  const engine = {
    listCheckpoints: vi.fn(async () => page),
    setDefaultStorageLocation: vi.fn(async () => unavailable),
    clearStorageLocationOverride: vi.fn(async () => unavailable),
    listStorageWorkspaces: vi.fn(async () => inventory),
    createCheckpoint: vi.fn(),
    prepareCombinedRecovery: vi.fn(),
  };
  const capability = createWorkspaceRecoveryCapabilityHandler(engine as never);
  expect(parseWorkspaceRecoveryCheckpointListResult(await capability(
    'listCheckpoints', { workspaceId: 'workspace', cursor: 3, limit: 10 }, context,
  ))).toEqual(page);
  expect(engine.listCheckpoints).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', cursor: 3, limit: 10 });

  expect(await capability('setDefaultStorageLocation', { mode: 'workspace-adjacent' }, context)).toEqual(unavailable);
  expect(engine.setDefaultStorageLocation).toHaveBeenCalledExactlyOnceWith({ mode: 'workspace-adjacent' });
  expect(await capability('clearStorageLocationOverride', { workspaceId: 'workspace' }, context)).toEqual(unavailable);
  expect(engine.clearStorageLocationOverride).toHaveBeenCalledExactlyOnceWith('workspace');
  expect(await capability('listStorageWorkspaces', {}, context)).toEqual(inventory);
  expect(engine.listStorageWorkspaces).toHaveBeenCalledExactlyOnceWith();

  await expect(capability('listCheckpoints', { workspaceId: 'workspace', limit: 0 }, context)).rejects.toThrow();
  expect(engine.listCheckpoints).toHaveBeenCalledTimes(1);
  await expect(capability('createCheckpoint', { name: 'x', workspaceId: 'workspace' }, context)).rejects.toThrow(/does not implement/);
  expect(engine.createCheckpoint).not.toHaveBeenCalled();
  await expect(capability('prepareCombinedRecovery', {}, context)).rejects.toThrow(/entryId/);
  expect(engine.prepareCombinedRecovery).not.toHaveBeenCalled();
});

it('keeps native journal anchors and mutations behind their original runtime owner', async () => {
  const engine = { recordTurnStart: vi.fn(), recordTurnSettled: vi.fn(), recordMutationBefore: vi.fn(), recordMutationAfter: vi.fn() };
  const handler = createWorkspaceRecoveryCapabilityHandler(engine as never);
  for (const method of Object.keys(engine)) {
    await expect(handler(method, { conversation: { kind: 'thread', threadId: 'thread', branchId: 'branch' } }, {} as never)).rejects.toThrow(/original runtime owner/);
  }
  for (const method of Object.values(engine)) expect(method).not.toHaveBeenCalled();
});
