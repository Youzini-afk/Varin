import type { ThreadContextState, ThreadSnapshot } from '@varin/application-client';
import type { ChatSessionEntry } from '@/components/conversation/types';
import type { I18nKey } from './i18n';

export type ContextPhase = 'preparing' | 'waiting' | 'ready' | 'applied' | 'failed' | 'cancelled' | 'superseded';
export type ContextJobRow = ThreadContextState['jobs'][number];
export type ContextView = Pick<ThreadSnapshot, 'context' | 'activeRun'> & Partial<Pick<ThreadSnapshot, 'runFailure'>>;
const failedOwner = (row: ContextJobRow, view: ContextView) => !!view.runFailure && view.runFailure.runId === row.job.request.owner_run_id
  && ['context_compaction_failed', 'context_preparation_failed', 'context_candidate_capacity'].includes(view.runFailure.code);
export const contextPhaseLabels: Record<ContextPhase, I18nKey> = {
  preparing: 'contextManager.preparing', waiting: 'contextManager.waiting', ready: 'contextManager.ready',
  applied: 'contextManager.applied', failed: 'contextManager.failed', cancelled: 'contextManager.cancelled', superseded: 'contextManager.superseded',
};
export function contextJobPhase(row: ContextJobRow, view: ContextView): ContextPhase {
  if (row.job.published_revision !== undefined || view.context.checkpoint?.id === row.job.request.key) return 'applied';
  if (failedOwner(row, view)) return 'failed';
  if (row.run.state === 'failed') return 'failed';
  if (row.run.state === 'cancelled') return 'cancelled';
  if ((view.context.checkpoint?.revision ?? 0) > row.job.request.expected_revision) return 'superseded';
  if (view.activeRun && view.activeRun.waiting_on === `context-wait:${view.activeRun.id}:${row.run.id}`) return 'waiting';
  return row.run.state === 'completed' ? 'ready' : 'preparing';
}
export function contextWaitsFor(row: ContextJobRow, view: ContextView): boolean {
  return failedOwner(row, view) || !!view.activeRun && (view.activeRun.waiting_on === `context-wait:${view.activeRun.id}:${row.run.id}`
    || view.activeRun.state === 'failed' && row.job.request.owner_run_id === view.activeRun.id && row.run.state === 'failed');
}
export function latestContextJob(view: ContextView): ContextJobRow | undefined {
  return view.context.jobs.find(row => view.activeRun && view.activeRun.waiting_on === `context-wait:${view.activeRun.id}:${row.run.id}`)
    ?? view.context.jobs.at(-1);
}
/** Preparation records retain their original history anchor and never enter a collapsed tool group. */
export function contextTimelineEntries(entries: ChatSessionEntry[], view?: ContextView): ChatSessionEntry[] {
  if (!view?.context?.jobs.length) return entries;
  const rows = new Map<string, ChatSessionEntry[]>(), tail: ChatSessionEntry[] = [];
  const visible = new Set(entries.map(entry => entry.id));
  for (const row of view.context.jobs) {
    const phase = contextJobPhase(row, view), anchor = row.job.history_anchor ?? row.job.request.through_id;
    const entry: ChatSessionEntry = { id: `context-job:${row.run.id}`, parentId: anchor, timestamp: '',
      runId: row.job.request.owner_run_id ?? undefined, type: 'custom_message', customType: 'context-compaction', display: true,
      content: '', details: { jobRunId: row.run.id, phase, blocking: contextWaitsFor(row, view) } };
    // An actual wait belongs at the current execution edge, even when preparation
    // began pages earlier. It remains the same row, never a second notification.
    if (phase === 'waiting' || contextWaitsFor(row, view)) tail.push(entry);
    else if (visible.has(anchor)) rows.set(anchor, [...(rows.get(anchor) ?? []), entry]);
    else if (row === latestContextJob(view) && phase !== 'applied' && phase !== 'superseded') tail.push(entry);
  }
  return [...entries.flatMap(entry => [entry, ...(rows.get(entry.id) ?? [])]), ...tail];
}
