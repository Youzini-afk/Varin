import { operationPresentation } from './toolPresentation';
import type { ThreadSnapshot } from '@varin/application-client';

/** Read-only presentation intent. Never a scheduler, permission decision or execution receipt. */
export interface CompanionIntent { state: string | null; reason: string }
export type ObservationHealth = 'unselected' | 'synchronizing' | 'current' | 'unknown';
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Shared gate for a real unresolved permission, not any control-shaped result. */
export function unresolvedPermissionId(operation: ThreadSnapshot['operations'][number]): string | null {
  const permission = record(record(operation.result?.kind === 'control' ? operation.result.value : undefined)?.permission);
  return operation.phase === 'waiting' && !operation.cancel_requested && permission?.decision === null
    && typeof permission.id === 'string' && record(permission.call) && record(permission.scope) ? permission.id : null;
}

export function projectCompanionIntent(snapshot: ThreadSnapshot | undefined, health: ObservationHealth): CompanionIntent {
  if (health === 'unknown') return { state: 'E04', reason: 'Current Host facts unavailable; last snapshot is not current evidence' };
  if (health === 'synchronizing') return { state: 'E05', reason: 'Synchronizing the selected branch' };
  if (health === 'unselected' || !snapshot) return { state: 'L07', reason: 'No branch observed' };
  const run = snapshot.activeRun;
  if (run && snapshot.identity && (run.thread_id !== snapshot.identity.threadId || run.branch_id !== snapshot.identity.branchId)) return { state: 'E04', reason: 'Run identity does not match the observed branch' };
  const activeChildren = Object.values(snapshot.childActivity ?? {}).some(child => child.state !== 'preparation_failed');
  const pending = snapshot.operations.filter(operation => operation.phase !== 'terminal');
  if (snapshot.operations.some(operation => operation.effect === 'unknown')) return { state: 'E06', reason: 'An operation effect requires reconciliation' };
  if (run?.cancel_requested || pending.some(operation => operation.cancel_requested)) {
    // Cancellation is a request, not proof that tools or child work stopped.
    if (pending.length || activeChildren || (run && !['cancelled', 'completed', 'failed'].includes(run.state))) return { state: 'E02', reason: 'Cancellation requested; work has not fully settled' };
  }
  const focusedPending = run ? pending.filter(operation => operation.run_id === run.id) : pending;
  if (focusedPending.some(operation => unresolvedPermissionId(operation) !== null)) return { state: 'W02', reason: 'An unresolved Host permission decision is waiting' };
  if (focusedPending.some(operation => operation.executor === 'ask_user')) return { state: 'W03', reason: 'An existing ask_user operation is unresolved' };
  // Only exact admitted identities may classify activity; no generated prose/arguments.
  const classified = focusedPending.map(operationPresentation).filter(value => value !== null);
  const kinds = new Set(classified.map(value => value.state));
  if (kinds.size === 1) return { state: classified[0]!.state, reason: `Active admitted tool: ${classified.map(value => value.tool).join(', ')}` };
  if (kinds.size > 1) return { state: null, reason: 'Multiple admitted activity categories are concurrently active' };
  if (pending.some(operation => operation.phase === 'running' || operation.phase === 'settling') || run?.state === 'executing') return { state: null, reason: 'Observing active execution; specific activity is not classified' };
  if (pending.some(operation => operation.phase === 'queued')) return { state: 'W01', reason: 'An operation is queued' };
  if (pending.length || run?.state === 'waiting') return { state: 'W04', reason: 'Host work is waiting or preparing an external operation' };
  if (activeChildren) return { state: 'T08', reason: 'Child activity remains active in the observed branch' };
  switch (run?.state) {
    case 'accepted': return { state: 'C02', reason: 'Run accepted' };
    case 'preparing': case 'runnable': return { state: 'C03', reason: 'Run preparing' };
    case 'generating': return { state: 'C04', reason: 'Inference active; output kind not yet classified' };
    case 'completed': return { state: 'C06', reason: 'Selected branch run completed' };
    case 'failed': return { state: 'E01', reason: 'Selected branch run failed' };
    case 'cancelled': return { state: null, reason: 'Selected round cancelled; executor stop has not been independently confirmed' };
    default: return { state: 'C01', reason: 'No active work in the observed branch' };
  }
}

/** A clarification receipt, not a permission or an inferred tool completion. */
export function newlyAnsweredQuestion(previousPending: ReadonlySet<string>, snapshot: ThreadSnapshot): string | null {
  const answer = snapshot.operations.find(operation => previousPending.has(operation.id)
    && operation.executor === 'ask_user' && operation.phase === 'terminal' && operation.outcome === 'succeeded'
    && operation.result?.kind === 'control' && record(operation.result.value)?.answer_ref != null);
  return answer?.id ?? null;
}
