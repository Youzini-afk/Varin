import { expect, it, vi } from 'vitest';
import { createCheckpointLifecycle } from './checkpoint-lifecycle.js';
import type { RecoveryRangeTurn, Run } from '../kernel/protocol.generated.js';
import type { KernelRecoveryStore } from '../kernel/kernel-recovery-store.js';

it('settles existing input checkpoints once after the original Run ends, including history no longer at the branch head', async () => {
  const run: Run = { id: 'original-run', thread_id: 'thread', branch_id: 'branch',
    state: 'executing', revision: 1, epoch: 1, configuration: {}, cancel_requested: false, waiting_on: null };
  const turns: RecoveryRangeTurn[] = ['input-1', 'input-2', 'read-only-input'].map(entryId => ({
    anchor: { executionId: `${run.id}:${entryId}`, entryId, runId: run.id, threadId: run.thread_id, branchId: run.branch_id, epoch: 1 },
    entryIds: [entryId, `answer:${entryId}`], settled: true, uncovered: entryId === 'input-2',
    source: { resource_owner: { kind: 'local' }, mode: 'live_root', workspace_id: 'workspace',
      execution_workspace_id: 'workspace', branch_id: null, revision: null,
      live_root: { hostId: 'host', rootId: 'original-worktree', canonicalRoot: '/original/worktree' } },
  }));
  const recordTurnSettled = vi.fn(async (_input: Parameters<KernelRecoveryStore['recordTurnSettled']>[0]) => undefined);
  const runtime = { run: vi.fn(async () => run), recoveryRun: vi.fn(async () => turns) };
  const lifecycle = createCheckpointLifecycle({ runtime, workspaces: async () => [], onError: vi.fn(),
    store: { getTurn: async (_workspace: string, executionId: string) => executionId.endsWith('read-only-input') ? null : { executionId },
      recordTurnSettled, listCheckpoints: async () => [] } as unknown as KernelRecoveryStore });
  await lifecycle.settle(run.id);
  expect(runtime.recoveryRun).not.toHaveBeenCalled();
  run.state = 'completed';
  await Promise.all([lifecycle.settle(run.id), lifecycle.settle(run.id)]);
  expect(runtime.recoveryRun).toHaveBeenCalledOnce();
  expect(recordTurnSettled).toHaveBeenCalledTimes(2);
  expect(recordTurnSettled.mock.calls.map(call => call[0])).toEqual([
    expect.objectContaining({ executionId: 'original-run:input-1', observationComplete: true, activeWriterScopes: [] }),
    expect.objectContaining({ executionId: 'original-run:input-2', observationComplete: false, activeWriterScopes: ['process/or-external'] }),
  ]);
});
