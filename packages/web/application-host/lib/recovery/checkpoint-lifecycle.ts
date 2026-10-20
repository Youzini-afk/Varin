import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelRecoveryStore } from '../kernel/kernel-recovery-store.js';
import type { RecoveryRangeTurn } from '../kernel/protocol.generated.js';

/** Catalog decides when work ends; Storage retains the affected-file journal.
 * Existing event discovery and visible reads drive settlement, without polling
 * or scanning workspace files. No checkpoint is created for an unchanged Run. */
export function createCheckpointLifecycle(options: {
  runtime: Pick<AgentRuntimeClient, 'run' | 'recoveryRun'>;
  store: Pick<KernelRecoveryStore, 'getTurn' | 'listCheckpoints' | 'recordTurnSettled'>;
  workspaces(): Promise<Array<{ workspaceId: string }>>;
  settleManaged?(turns: RecoveryRangeTurn[], signal?: AbortSignal): Promise<void>;
  changed?(workspaceId: string): void;
  onError(runId: string | undefined, error: unknown): void;
}) {
  const runs = new Map<string, Promise<void>>();
  const workspaces = new Map<string, Promise<void>>();
  const settle = (runId: string, signal?: AbortSignal): Promise<void> => {
    const previous = runs.get(runId);
    if (previous) return previous;
    const work = (async () => {
      const run = await options.runtime.run(runId, signal);
      if (!['completed', 'cancelled', 'failed'].includes(run.state)) return;
      const turns = await options.runtime.recoveryRun(runId, signal);
      const managed = turns.filter(turn => turn.source?.resource_owner.kind === 'managed_host');
      if (managed.length) await options.settleManaged?.(managed, signal);
      for (const turn of turns) {
        signal?.throwIfAborted();
        if (!turn.source || turn.source.resource_owner.kind !== 'local') continue;
        const workspaceId = turn.source.workspace_id;
        const original = await options.store.getTurn(workspaceId, turn.anchor.executionId);
        if (!original || original.settledAt && original.failure?.message !== 'Original input work is not settled') continue;
        await options.store.recordTurnSettled({
          workspaceId, executionId: turn.anchor.executionId,
          ...(turn.entryIds.at(-1) ? { assistantEntryId: turn.entryIds.at(-1)! } : {}), activeWriterScopes: turn.uncovered ? ['process/or-external'] : [],
          mutationObserved: turn.uncovered, observationComplete: !turn.uncovered,
          observedResourceIds: [], provenance: 'caused-by',
          ...(turn.uncovered ? { failure: { code: 'checkpoint-incomplete' as const,
            message: 'External tool effects are outside the recorded file changes.', retryable: false } } : {}),
        });
        options.changed?.(workspaceId);
      }
    })().finally(() => { if (runs.get(runId) === work) runs.delete(runId); });
    runs.set(runId, work);
    return work;
  };
  const refresh = (workspaceId: string): Promise<void> => {
    const previous = workspaces.get(workspaceId);
    if (previous) return previous;
    const work = (async () => {
      const checkpoints = await options.store.listCheckpoints(workspaceId, false);
      const ids = new Set<string>();
      for (const checkpoint of checkpoints) {
        if (checkpoint.source !== 'turn' || checkpoint.state === 'ready' || !checkpoint.executionId) continue;
        const turn = await options.store.getTurn(workspaceId, checkpoint.executionId);
        if (turn?.runId && (!turn.settledAt || turn.failure?.message === 'Original input work is not settled')) ids.add(turn.runId);
      }
      await Promise.all([...ids].map(runId => settle(runId).catch(error => options.onError(runId, error))));
    })().finally(() => { if (workspaces.get(workspaceId) === work) workspaces.delete(workspaceId); });
    workspaces.set(workspaceId, work);
    return work;
  };
  return {
    settle, refresh,
    async recover(signal: AbortSignal) {
      for (const workspace of await options.workspaces()) {
        signal.throwIfAborted();
        await refresh(workspace.workspaceId).catch(error => options.onError(undefined, error));
      }
    },
  };
}
