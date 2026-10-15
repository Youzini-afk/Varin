import React from 'react';
import type { ThreadSummary } from '@varin/protocol';
import { buildThreadTree, type ThreadTreeNode } from '@/lib/agent-runtime/thread-tree';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

export function ThreadSidebarList({ threads, query, selectedBranchId, renderRow, navigate, createInProject }: {
  threads: ThreadSummary[]; query: string; selectedBranchId?: string;
  renderRow(thread: ThreadSummary, disclosure: React.ReactNode): React.ReactNode;
  navigate(threadId: string, branchId?: string): void; createInProject(path: string): void;
}) {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
  const toggle = (key: string) => setCollapsed(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const filter = query.trim().toLocaleLowerCase();
  const tree = buildThreadTree(threads, thread => {
    const workspace = projects.filter(project => thread.observer_project_ids.includes(project.id)).map(project => `${project.label ?? ''} ${project.path}`).join(' ');
    return `${thread.title} ${thread.thread_id} ${workspace}`.toLocaleLowerCase().includes(filter);
  });
  const groups = new Map<string, { title: string; path?: string; nodes: ThreadTreeNode[] }>();
  for (const node of tree) {
    const project = node.thread.observer_project_ids.length === 1 ? projects.find(project => project.id === node.thread.observer_project_ids[0]) : undefined;
    const key = node.thread.pinned ? 'pinned' : project?.id ?? 'recent';
    if (!groups.has(key)) groups.set(key, { title: key === 'pinned' ? t('thread.sidebar.pinned') : project?.label || project?.path.split(/[\\/]/).filter(Boolean).at(-1) || t('thread.sidebar.recent'), path: project?.path, nodes: [] });
    groups.get(key)!.nodes.push(node);
  }
  const row = (node: ThreadTreeNode): React.ReactNode => {
    const { thread, children } = node;
    const expandable = children.length > 0 || thread.branches.length > 1;
    const open = Boolean(filter) || !collapsed.has(thread.thread_id);
    const disclosure = expandable ? <button type="button" className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover"
      aria-expanded={open} aria-label={thread.title} onClick={() => toggle(thread.thread_id)}><Icon name="arrow-right-s" className={cn('size-3 transition-transform', open && 'rotate-90')} /></button> : null;
    return <div key={thread.thread_id}>{renderRow(thread, disclosure)}
      {open && expandable && <div className="ml-3 border-l border-border/60 pl-1.5">
        {thread.branches.length > 1 && thread.branches.map((branch, index) => <button key={branch.branch_id} type="button"
          className={cn('mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left typography-meta text-muted-foreground hover:bg-interactive-hover', branch.branch_id === selectedBranchId && 'bg-interactive-active text-foreground')}
          aria-current={branch.branch_id === selectedBranchId ? 'page' : undefined} onClick={() => navigate(thread.thread_id, branch.branch_id)}>
          <Icon name="git-branch" className="size-3.5" /><span>{branch.branch_id === thread.main_branch_id ? t('thread.sidebar.mainBranch') : t('thread.sidebar.branch', { number: index + 1 })}</span>
          {branch.active_run_id && <Icon name="loader-4" className="ml-auto size-3 animate-spin" />}
        </button>)}
        {children.map(row)}
      </div>}
    </div>;
  };
  return <>{[...groups].map(([key, group]) => <section key={key} className="mb-3">
    <div className="group flex items-center px-1 py-1 typography-micro text-muted-foreground">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={Boolean(filter) || !collapsed.has(`group:${key}`)} onClick={() => toggle(`group:${key}`)}>
        <Icon name="arrow-right-s" className={cn('size-3', (filter || !collapsed.has(`group:${key}`)) && 'rotate-90')} /><span className="truncate">{group.title}</span>
      </button>
      {group.path && <button type="button" className="rounded p-1 hover:bg-interactive-hover" aria-label={t('sessions.sidebar.header.actions.newSession')} onClick={() => createInProject(group.path!)}><Icon name="add" className="size-3" /></button>}
    </div>
    {(filter || !collapsed.has(`group:${key}`)) && group.nodes.map(row)}
  </section>)}</>;
}
