import React from 'react';
import type { ThreadBranch } from '@varin/protocol';
import { useThreadStore, threadIdentityKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useProjectsStore } from '@/stores/useProjectsStore';

export interface SidebarConversation {
  id: string;
  name: string;
  firstMessage: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  parentId?: string;
  pinned: boolean;
  busy: boolean;
  unread: boolean;
  projectIds: string[];
  branchId: string;
  branches: ThreadBranch[];
}
export interface ConversationSessionAttentionState { kind: 'complete' | 'error'; updatedAt: number }

/** Catalog-derived display data; pinning, retention and navigation use ThreadsAPI. */
export function useSidebarCatalog() {
  const threads = useThreadStore(state => state.threads);
  const host = useThreadStore(state => state.hostKey);
  const projects = useProjectsStore(state => state.projects);
  const drafts = useThreadDraftStore(state => state.drafts);
  return React.useMemo(() => {
    const attentionBySession: Record<string, ConversationSessionAttentionState> = {};
    const summaries: SidebarConversation[] = threads.filter(thread => !thread.bot_id && thread.deleted_at_ms === null).map(thread => {
      const branch = thread.branches.find(branch => branch.branch_id === thread.main_branch_id);
      const projectIds = thread.observer_project_ids.filter((id): id is string => id !== null);
      const draft = drafts[threadIdentityKey(host, { runtime: 'agent', threadId: thread.thread_id, branchId: thread.main_branch_id })];
      const busy = thread.branches.some(branch => branch.active_run_id !== null);
      if (thread.unread && !busy) attentionBySession[thread.thread_id] = { kind: branch?.latest_run?.state === 'failed' ? 'error' : 'complete', updatedAt: thread.updated_at_ms };
      return { id: thread.thread_id, name: thread.title, firstMessage: thread.title,
        cwd: draft?.preparedSource?.path ?? draft?.workspacePath ?? projects.find(project => projectIds.includes(project.id))?.path ?? '',
        createdAt: new Date(thread.created_at_ms).toISOString(), updatedAt: new Date(thread.updated_at_ms).toISOString(),
        ...(thread.archived ? { archivedAt: new Date(thread.updated_at_ms).toISOString() } : {}),
        ...(thread.parent_thread_id ? { parentId: thread.parent_thread_id } : {}),
        busy, unread: thread.unread, pinned: thread.pinned, projectIds, branchId: thread.main_branch_id, branches: thread.branches };
    });
    return { summaries, activeSessions: summaries.filter(summary => !summary.archivedAt), attentionBySession };
  }, [threads, host, projects, drafts]);
}
