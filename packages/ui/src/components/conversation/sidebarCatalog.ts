import React from 'react';
import type { ThreadBranch } from '@varin/protocol';
import { projectContainsPath, type ExternalHarness } from '@varin/application-client';
import { useThreadStore, threadComposerKey } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useExternalAgents, useExternalAgentStore } from '@/stores/useExternalAgentStore';
import { isLeadThread } from '@/lib/agent-runtime/threadRole';

export interface SidebarConversation {
  harness?: ExternalHarness;
  avatar?: string;
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
  /** Work a Bot delegated. Its parent is a Bot conversation, which the ordinary sidebar does not list. */
  botId?: string;
  /** Leads a task: a top-level task, or work a Bot conversation handed over directly. */
  lead: boolean;
}
export interface ConversationSessionAttentionState { kind: 'complete' | 'error'; updatedAt: number }

/** Catalog-derived display data; pinning, retention and navigation use ThreadsAPI. */
export function useSidebarCatalog() {
  useExternalAgents();
  const external = useExternalAgentStore(state => state.conversations);
  const threads = useThreadStore(state => state.threads);
  const host = useThreadStore(state => state.hostKey);
  const projects = useProjectsStore(state => state.projects);
  const drafts = useThreadDraftStore(state => state.drafts);
  return React.useMemo(() => {
    const attentionBySession: Record<string, ConversationSessionAttentionState> = {};
    const byId = new Map(threads.map(thread => [thread.thread_id, thread]));
    // A Bot's own conversations belong to the Bot workbench; the work it delegated is ordinary
    // execution and is listed with its project like any other (docs/design/bot-ui.md §6).
    const summaries: SidebarConversation[] = threads.filter(thread => (!thread.bot_id || thread.parent_thread_id) && thread.deleted_at_ms === null).map(thread => {
      const branch = thread.branches.find(branch => branch.branch_id === thread.main_branch_id);
      const projectIds = thread.observer_project_ids.filter((id): id is string => id !== null);
      const draft = drafts[threadComposerKey(host, { runtime: 'agent', threadId: thread.thread_id, branchId: thread.main_branch_id })];
      const busy = thread.branches.some(branch => branch.active_run_id !== null);
      if (!thread.parent_thread_id && thread.unread && !busy) attentionBySession[thread.thread_id] = { kind: branch?.latest_run?.state === 'failed' ? 'error' : 'complete', updatedAt: thread.updated_at_ms };
      return { id: thread.thread_id, name: thread.title, firstMessage: thread.title,
        ...(thread.avatar ? { avatar: thread.avatar } : {}),
        cwd: draft?.preparedSource?.path ?? draft?.workspacePath ?? projects.find(project => projectIds.includes(project.id))?.path ?? '',
        createdAt: new Date(thread.created_at_ms).toISOString(), updatedAt: new Date(thread.updated_at_ms).toISOString(),
        ...(thread.archived ? { archivedAt: new Date(thread.updated_at_ms).toISOString() } : {}),
        ...(thread.parent_thread_id ? { parentId: thread.parent_thread_id } : {}),
        ...(thread.bot_id ? { botId: thread.bot_id } : {}), lead: isLeadThread(thread, byId),
        busy, unread: thread.unread, pinned: thread.pinned, projectIds, branchId: thread.main_branch_id, branches: thread.branches };
    });
    for (const c of external) summaries.push({ id: c.id, harness: c.harness, name: c.title, firstMessage: c.title, cwd: c.cwd,
      createdAt: new Date(c.createdAt).toISOString(), updatedAt: new Date(c.updatedAt).toISOString(),
      ...(c.archived ? { archivedAt: new Date(c.updatedAt).toISOString() } : {}), ...(c.parent ? { parentId: c.parent.threadId } : {}),
      pinned: c.pinned, busy: Boolean(c.activeTurn), unread: false, lead: !c.parent, projectIds: projects.filter(p => projectContainsPath(p, c.cwd)).map(p => p.id), branchId: '', branches: [] });
    return { summaries, activeSessions: summaries.filter(summary => !summary.archivedAt), attentionBySession };
  }, [threads, host, projects, drafts, external]);
}
