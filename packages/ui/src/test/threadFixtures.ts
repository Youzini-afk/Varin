import type { ThreadSummary } from '@varin/protocol';
export const threadSummary = (id: string, patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  thread_id: id, main_branch_id: `${id}:main`, title: id, revision: 1, created_at_ms: 1, updated_at_ms: 1,
  pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false,
  bot_id: null, branches: [{ branch_id: `${id}:main`, head: null, active_run_id: null, latest_run: null }], observer_project_ids: [], ...patch,
});
