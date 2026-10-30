import { ConversationSidebar } from '../conversation/ConversationSidebar';
import React from 'react';
import { useThreadStore } from '@/stores/useThreadStore';
import { openThreadFromNavigation, startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { toast } from '@/components/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { isLeadThread } from '@/lib/agent-runtime/threadRole';
import { invokeDesktop, isDesktopShell } from '@/lib/desktop';
import type { ThreadSummary } from '@varin/protocol';
import { ThreadSidebarList } from './ThreadSidebarList';
import { threadSubtreeIds } from '@/lib/agent-runtime/thread-tree';
import { useExternalAgents, useExternalAgentStore, openConversationFromNavigation } from '@/stores/useExternalAgentStore';
import { HarnessIcon } from './HarnessIcon';

function ArchiveThreadSidebar({ isVisible = true, archived = false, mobileVariant = false, onNavigate }: { isVisible?: boolean; mobileVariant?: boolean; archived?: boolean; onNavigate?(): void }) {
  const { t } = useI18n();
  const threads = useThreadStore(state => state.threads);
  const threadsById = React.useMemo(() => new Map(threads.map(thread => [thread.thread_id, thread])), [threads]);
  useExternalAgents();
  const external = useExternalAgentStore(state => state.conversations);
  const selected = useThreadStore(state => state.selectedIdentity);
  const loading = useThreadStore(state => state.catalogLoading);
  const error = useThreadStore(state => state.catalogError);
  const projects = useProjectsStore(state => state.projects);
  const confirmDelete = useUIStore(state => state.showDeletionDialog);
  const [query, setQuery] = React.useState('');
  const externalVisible = external.filter(c => c.archived === archived && c.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const [rename, setRename] = React.useState<ThreadSummary | null>(null);
  const [title, setTitle] = React.useState('');
  const [deleting, setDeleting] = React.useState<ThreadSummary | null>(null);
  const [deletingExternal, setDeletingExternal] = React.useState<{id: string; title: string} | null>(null);
  const [pending, setPending] = React.useState(false);
  const hostKey = useThreadStore(state => state.hostKey);
  React.useEffect(() => { setRename(null); setDeleting(null); setDeletingExternal(null); setQuery(''); }, [hostKey]);
  const act = async (work: () => Promise<unknown>) => { setPending(true); try { await work(); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setPending(false); } };
  const visible = React.useMemo(() => threads.filter(thread => !thread.bot_id && thread.deleted_at_ms === null && thread.archived === archived), [threads, archived]);
  const navigate = async (threadId?: string, branchId?: string, directory?: string) => {
    if (threadId) await openThreadFromNavigation({ threadId, branchId }); else await startThreadFromNavigation({ directory });
    if (mobileVariant) useUIStore.getState().setSessionSwitcherOpen(false);
    onNavigate?.();
  };
  const retainTree = async (threadId: string, action: 'delete' | 'archive' | 'restore') => {
    const store = useThreadStore.getState();
    const results = await Promise.allSettled(threadSubtreeIds(store.threads, threadId).map(id => action === 'delete' ? store.deleteThread(id) : store.updateThread(id, { archived: action === 'archive' })));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };
  const deleteCount = deleting ? threadSubtreeIds(threads, deleting.thread_id).length - 1 : 0;
  const actions = (thread: ThreadSummary) => [
    ...(isDesktopShell() ? [{ label: t('sessions.sidebar.session.menu.openMiniChatWindow'), run: () => void act(() => invokeDesktop('desktop_open_thread_mini_chat_window', { threadId: thread.thread_id, branchId: selected?.threadId === thread.thread_id ? selected.branchId : thread.main_branch_id })) }] : []),
    { label: t('sessions.sidebar.session.menu.rename'), run: () => { setRename(thread); setTitle(thread.title); } },
    { label: t(thread.pinned ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin'), run: () => void act(() => useThreadStore.getState().updateThread(thread.thread_id, { pinned: !thread.pinned })) },
    { label: t(thread.archived ? 'sessions.sidebar.session.menu.restore' : 'sessions.sidebar.bulkActions.archive'), run: () => void act(() => retainTree(thread.thread_id, thread.archived ? 'restore' : 'archive')) },
    { label: t('sessions.sidebar.bulkActions.delete'), run: () => { if (confirmDelete) setDeleting(thread); else void act(() => retainTree(thread.thread_id, 'delete')); } },
  ];
  if (!isVisible) return null;
  return <nav aria-label={t(archived ? 'sessions.archivePage.title' : 'sessions.sidebar.header.actions.newSession')} className="flex h-full min-h-0 flex-col gap-2 p-3">
    {!archived && <div className="flex gap-2">
      <Button className="flex-1 justify-start gap-2" variant="ghost" size="sm" disabled={pending} onClick={() => void act(() => navigate())}><Icon name="add" className="size-4" />{t('sessions.sidebar.header.actions.newSession')}</Button>
      {!archived && <Button variant="ghost" size="sm" onClick={() => useUIStore.getState().setArchivePageOpen(true)} aria-label={t('sessions.archivePage.title')}><Icon name="inbox-archive" className="size-4" /></Button>}
    </div>}
    <Input aria-label={t(archived ? 'sessions.archivePage.searchPlaceholder' : 'sessions.sidebar.header.search.placeholder')} placeholder={t(archived ? 'sessions.archivePage.searchPlaceholder' : 'sessions.sidebar.header.search.placeholder')} value={query} onChange={event => setQuery(event.target.value)} />
    {error && <div role="alert" className="text-xs text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => void act(() => useThreadStore.getState().loadCatalog())}>{t('research-workbench.retry')}</Button></div>}
    {loading && !threads.length && <span role="status">{t('common.loading')}</span>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {externalVisible.map(c => <div key={c.id} className="mb-1 flex items-center gap-2 rounded-md px-2 py-2 hover:bg-interactive-hover"><button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left typography-meta" onClick={() => void act(async () => { await openConversationFromNavigation({threadId:c.id}); onNavigate?.(); })}><HarnessIcon harness={c.harness} /><span className="truncate">{c.title}</span></button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t('header.sessionActions.openAria')}><Icon name="more" className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onClick={() => void act(() => useExternalAgentStore.getState().update(c.id, { archived: !c.archived }))}>{t(c.archived ? 'sessions.sidebar.session.menu.restore' : 'sessions.sidebar.bulkActions.archive')}</DropdownMenuItem><DropdownMenuItem onClick={() => { if (confirmDelete) setDeletingExternal(c); else void act(() => useExternalAgentStore.getState().update(c.id, { deleted: true })); }}>{t('sessions.sidebar.bulkActions.delete')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </div>)}
      {!visible.length && !externalVisible.length && !loading && <p className="p-2 text-sm text-muted-foreground">{t(archived ? 'sessions.archivePage.empty.noArchived' : 'sessions.sidebar.empty.noSessions.title')}</p>}
      <ThreadSidebarList key={hostKey} threads={visible} query={query} selectedBranchId={selected?.branchId}
        navigate={(threadId, branchId) => void act(() => navigate(threadId, branchId))} createInProject={path => void act(() => navigate(undefined, undefined, path))}
        renderRow={(thread, disclosure) => {
        const working = thread.branches.some(branch => branch.active_run_id);
        const projectLabels = projects.filter(project => thread.observer_project_ids.includes(project.id)).map(project => project.label || project.path.split(/[\\/]/).filter(Boolean).at(-1));
        return <ContextMenu key={thread.thread_id}><ContextMenuTrigger asChild><div className={`group/thread mb-1 flex items-center gap-1 rounded-md ${selected?.threadId === thread.thread_id ? 'bg-interactive-active' : 'hover:bg-interactive-hover'}`}>
        {disclosure}
        <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm" aria-current={selected?.threadId === thread.thread_id ? 'page' : undefined}
          onClick={() => void act(() => navigate(thread.thread_id))}>
          <AgentAvatar identity={thread.thread_id} avatar={thread.avatar} size={20} {...(isLeadThread(thread, threadsById) ? { role: 'lead' as const } : {})} />
          {working || thread.pinned ? <Icon name={working ? 'loader-4' : 'pushpin'} className={`size-4 shrink-0 ${working ? 'animate-spin text-primary' : ''}`} /> : null}
          <span className="min-w-0 flex-1"><span className="block truncate">{thread.title || t('sessions.sidebar.session.untitled')}</span>
            {projectLabels.length > 0 && <span className="block truncate typography-micro text-muted-foreground">{projectLabels.join(' · ')}</span>}
          </span>
          {thread.unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label={t('sessions.sidebar.session.status.unread')} />}
        </button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t('header.sessionActions.openAria')}><Icon name="more" className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            {actions(thread).map(action => <DropdownMenuItem key={action.label} disabled={pending} onClick={action.run}>{action.label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div></ContextMenuTrigger><ContextMenuContent>{actions(thread).map(action => <ContextMenuItem key={action.label} disabled={pending} onClick={action.run}>{action.label}</ContextMenuItem>)}</ContextMenuContent></ContextMenu>;
      }} />
    </div>
    <Dialog open={Boolean(rename)} onOpenChange={open => { if (!open) setRename(null); }}><DialogContent><DialogHeader><DialogTitle>{t('sessions.sidebar.session.menu.rename')}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); if (rename && title.trim()) void act(async () => { await useThreadStore.getState().updateThread(rename.thread_id, { title: title.trim() }); setRename(null); }); }}>
        <Input value={title} onChange={event => setTitle(event.target.value)} autoFocus /><DialogFooter><Button type="submit" disabled={pending || !title.trim()}>{t('inlineComment.actions.save')}</Button></DialogFooter>
      </form></DialogContent></Dialog>
    <Dialog open={Boolean(deleting || deletingExternal)} onOpenChange={open => { if (!open) { setDeleting(null); setDeletingExternal(null); } }}><DialogContent><DialogHeader><DialogTitle>{t('sessions.sidebar.bulkActions.delete')}</DialogTitle><DialogDescription>{t(deleteCount > 1 ? 'sessions.sidebar.dialogs.deleteSession.withManySubtasks' : deleteCount ? 'sessions.sidebar.dialogs.deleteSession.withOneSubtask' : 'sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: deleting?.title ?? deletingExternal?.title ?? '', count: deleteCount })}</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="destructive" disabled={pending} onClick={() => void act(async () => { if (deleting) await retainTree(deleting.thread_id, 'delete'); else if (deletingExternal) await useExternalAgentStore.getState().update(deletingExternal.id,{deleted:true}); setDeleting(null); setDeletingExternal(null); })}>{t('sessions.sidebar.bulkActions.delete')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </nav>;
}

export function ThreadSidebar(props: { isVisible?: boolean; mobileVariant?: boolean; archived?: boolean; onNavigate?(): void }) {
  return props.archived ? <ArchiveThreadSidebar {...props} /> : <ConversationSidebar isVisible={props.isVisible} mobileVariant={props.mobileVariant} onRequestClose={props.onNavigate} />;
}
