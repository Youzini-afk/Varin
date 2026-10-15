import React from 'react';
import { useThreadStore } from '@/stores/useThreadStore';
import { openThreadFromNavigation, startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { invokeDesktop, isDesktopShell } from '@/lib/desktop';
import type { ThreadSummary } from '@varin/protocol';

export const sortThreads = (threads: readonly ThreadSummary[]) => [...threads].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at_ms - a.updated_at_ms || a.thread_id.localeCompare(b.thread_id));
export function ThreadSidebar({ isVisible = true, archived = false }: { isVisible?: boolean; mobileVariant?: boolean; archived?: boolean }) {
  const { t } = useI18n();
  const threads = useThreadStore(state => state.threads);
  const selected = useThreadStore(state => state.selectedIdentity);
  const loading = useThreadStore(state => state.catalogLoading);
  const error = useThreadStore(state => state.catalogError);
  const [query, setQuery] = React.useState('');
  const [rename, setRename] = React.useState<ThreadSummary | null>(null);
  const [title, setTitle] = React.useState('');
  const [deleting, setDeleting] = React.useState<ThreadSummary | null>(null);
  const [pending, setPending] = React.useState(false);
  const hostKey = useThreadStore(state => state.hostKey);
  React.useEffect(() => { setRename(null); setDeleting(null); setQuery(''); }, [hostKey]);
  const act = async (work: () => Promise<unknown>) => { setPending(true); try { await work(); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setPending(false); } };
  const visible = React.useMemo(() => sortThreads(threads.filter(thread => !thread.bot_id && thread.deleted_at_ms === null && thread.archived === archived
    && `${thread.title} ${thread.thread_id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))), [threads, query, archived]);
  if (!isVisible) return null;
  return <nav aria-label={t(archived ? 'sessions.archivePage.title' : 'sessions.sidebar.header.actions.newSession')} className="flex h-full min-h-0 flex-col gap-2 p-3">
    <div className="flex gap-2">
      <Button className="flex-1" size="sm" disabled={pending} onClick={() => void act(() => startThreadFromNavigation())}>{t('sessions.sidebar.header.actions.newSession')}</Button>
      {!archived && <Button variant="ghost" size="sm" onClick={() => useUIStore.getState().setArchivePageOpen(true)} aria-label={t('sessions.archivePage.title')}><Icon name="inbox-archive" className="size-4" /></Button>}
    </div>
    <Input aria-label={t('sessions.archivePage.searchPlaceholder')} placeholder={t('commandPalette.input.placeholder')} value={query} onChange={event => setQuery(event.target.value)} />
    {error && <div role="alert" className="text-xs text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => void act(() => useThreadStore.getState().loadCatalog())}>{t('research-workbench.retry')}</Button></div>}
    {loading && !threads.length && <span role="status">{t('common.loading')}</span>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {!visible.length && !loading && <p className="p-2 text-sm text-muted-foreground">{t(archived ? 'sessions.archivePage.empty.noArchived' : 'sessions.sidebar.empty.noSessions.title')}</p>}
      {visible.map(thread => <div key={thread.thread_id} className={`mb-1 flex items-center gap-1 rounded-md ${selected?.threadId === thread.thread_id ? 'bg-interactive-active' : 'hover:bg-interactive-hover'}`}>
        <button className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm" aria-current={selected?.threadId === thread.thread_id ? 'page' : undefined}
          onClick={() => void act(() => openThreadFromNavigation({ threadId: thread.thread_id }))}>
          <Icon name={thread.pinned ? 'pushpin' : 'chat-4'} className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{thread.title || t('sessions.sidebar.session.untitled')}</span>
          {thread.unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label={t('sessions.sidebar.session.status.unread')} />}
        </button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t('header.sessionActions.openAria')}><Icon name="more" className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            {isDesktopShell() && <DropdownMenuItem onClick={() => void act(() => invokeDesktop('desktop_open_thread_mini_chat_window', { threadId: thread.thread_id, branchId: selected?.threadId === thread.thread_id ? selected.branchId : thread.main_branch_id }))}>{t('sessions.sidebar.session.menu.openMiniChatWindow')}</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => { setRename(thread); setTitle(thread.title); }}>{t('sessions.sidebar.session.menu.rename')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void act(() => useThreadStore.getState().updateThread(thread.thread_id, { pinned: !thread.pinned }))}>{t(thread.pinned ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void act(() => useThreadStore.getState().updateThread(thread.thread_id, { archived: !thread.archived }))}>{t(thread.archived ? 'sessions.sidebar.session.menu.restore' : 'sessions.sidebar.bulkActions.archive')}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDeleting(thread)}>{t('sessions.sidebar.bulkActions.delete')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>)}
    </div>
    <Dialog open={Boolean(rename)} onOpenChange={open => { if (!open) setRename(null); }}><DialogContent><DialogHeader><DialogTitle>{t('sessions.sidebar.session.menu.rename')}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); if (rename && title.trim()) void act(async () => { await useThreadStore.getState().updateThread(rename.thread_id, { title: title.trim() }); setRename(null); }); }}>
        <Input value={title} onChange={event => setTitle(event.target.value)} autoFocus /><DialogFooter><Button type="submit" disabled={pending || !title.trim()}>{t('inlineComment.actions.save')}</Button></DialogFooter>
      </form></DialogContent></Dialog>
    <Dialog open={Boolean(deleting)} onOpenChange={open => { if (!open) setDeleting(null); }}><DialogContent><DialogHeader><DialogTitle>{t('sessions.sidebar.bulkActions.delete')}</DialogTitle><DialogDescription>{t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: deleting?.title ?? '' })}</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="destructive" disabled={pending} onClick={() => { if (deleting) void act(async () => { await useThreadStore.getState().deleteThread(deleting.thread_id); setDeleting(null); }); }}>{t('sessions.sidebar.bulkActions.delete')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </nav>;
}
