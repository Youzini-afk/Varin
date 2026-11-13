import type { ThreadIdentity, ThreadSnapshot } from '@varin/application-client';

/** A supplied native projection, not a second implementation of Catalog reads. */
export function nativeThreadView(identity: ThreadIdentity, fields: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return { identity, eventCursor: 5,
    thread: { thread_id: identity.threadId, parent_thread_id: null, main_branch_id: identity.branchId,
      title: '', revision: 1, created_at_ms: 0, updated_at_ms: 0, pinned: false, archived: false,
      deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, bot_id: null,
      observer_project_ids: [], branches: [{ branch_id: identity.branchId, active_run_id: null, head: null, latest_run: null }] },
    activeRun: null, runFailure: null, history: [], historyPage: { head: null, previous: null },
    inputs: [], operations: [], followups: [], goals: [], launch: null,
    modelSelection: { desired: null, active: null }, policySelection: null, context: { checkpoint: null, jobs: [] }, ...fields };
}
