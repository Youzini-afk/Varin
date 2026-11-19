import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { botGroupRequest, downloadBotGroupFile, uploadBotGroupFile, createScheduledTasksHttpAPI, getRuntimeEndpointGeneration, getThreadObservationBus, type BotGroupMember, type BotGroupPage, type BotGroupPost, type BotGroupSummary, type BotSummary, type GroupChange, type GroupChatFile, type GroupDelivery, type ScheduledTask, type ThreadIdentity, type ThreadsAPI, type ThreadSnapshot } from '@varin/application-client';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { CollaborationConversation } from '@/components/thread/CollaborationConversation';
import { ThreadPermission } from '@/components/thread/ThreadPermission';
import { ThreadQuestions } from '@/components/thread/ThreadQuestions';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import type { Followup } from '@varin/protocol';
import { followupStatus, followupTrigger, pendingFollowup } from '@/lib/followupPresentation';
import { formatSchedule } from '@/components/session/scheduleFormat';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useOptionalDrawer } from '@/contexts/drawer-context-value';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { springTransition } from '@/lib/motion/tokens';
import { BotFigure } from './BotFigure';
import { GroupAvatar, GroupAvatarStack } from './GroupAvatar';
import { BotGroupComposer } from './BotGroupComposer';
import { useSegmentKnob } from './segmentKnob';
import { groupLabel as L, groupChatError as messageError, groupMemberCount, emptyGroupDraft, groupDraftRecipients, placeGroupMention, type GroupDraftFile, type GroupQuote } from './botGroupChatModel';
import './bot-group-chat.css';

const pathFor = (id: string) => '/' + encodeURIComponent(id);
const working = (delivery: GroupDelivery) => delivery.state === 'queued' || delivery.state === 'running';
const troubled = (delivery: GroupDelivery) => ['asleep', 'failed', 'execution-failed'].includes(delivery.state);
const clock = (ms: number) => new Date(ms).toLocaleTimeString(getCurrentIntlLocale(), { hour: '2-digit', minute: '2-digit' });

export function GroupFaces({ group, bots, size = 22 }: { group: BotGroupSummary; bots: BotSummary[]; size?: number }) {
  return <GroupAvatarStack ids={group.members.slice(0, 2).map(member => member.botId)} bots={bots}
    displayName={id => group.members.find(member => member.botId === id)?.name ?? ''} size={size} />;
}

export function GroupChatCreate({ bots, open, onClose, onCreated }: { bots: BotSummary[]; open: boolean; onClose(): void; onCreated(group: BotGroupSummary): void }) {
  const [name, setName] = React.useState('');
  const [members, setMembers] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { onCreated(await botGroupRequest<BotGroupSummary>('', { name, members })); setName(''); setMembers([]); }
    catch (error) { setError(messageError(error)); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}>
    <DialogContent className="max-w-sm">
      <DialogHeader><DialogTitle>{L('create')}</DialogTitle><DialogDescription>{L('choose')}</DialogDescription></DialogHeader>
      <form onSubmit={event => void submit(event)} className="grid gap-3">
        <input autoFocus className="group-chat-field" value={name} onChange={event => setName(event.target.value)} placeholder={L('name')} aria-label={L('name')} />
        <div className="max-h-56 overflow-auto">{bots.filter(bot => !bot.archived && !bot.deletion).map(bot => <label className="group-chat-person" key={bot.id}>
          <BotFigure bot={bot} state="idle" size={23} still /> <span>{bot.name}</span>
          <input type="checkbox" checked={members.includes(bot.id)} onChange={event => setMembers(previous => event.target.checked ? [...previous, bot.id] : previous.filter(id => id !== bot.id))} />
        </label>)}</div>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <DialogFooter><Button type="submit" disabled={busy || !name.trim() || !members.length}>{L('createAction')}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function BotGroupChat({ group, bots, api, sequence, panelTarget, onOpenPanel, onRevealChat, refresh, onDelete, onDirect, onProfile, onWake }: {
  group: BotGroupSummary; bots: BotSummary[]; api: ThreadsAPI | null | undefined; sequence: number; panelTarget: HTMLDivElement | null;
  onOpenPanel(): void; onRevealChat(): void; refresh(): void; onDelete(): void; onDirect(botId: string): void; onProfile(bot: BotSummary): void; onWake(bot: BotSummary): void;
}) {
  const id = pathFor(group.id);
  const drawer = useOptionalDrawer();
  const reduced = usePrefersReducedMotion();
  const revealChat = () => { drawer?.setRightSidebarOpen(false); onRevealChat(); };
  const revealPanel = () => { if (drawer) drawer.setRightSidebarOpen(true); else onOpenPanel(); };
  const [page, setPage] = React.useState<BotGroupPage>();
  const [older, setOlder] = React.useState<BotGroupPost[]>([]);
  const [before, setBefore] = React.useState<string>();
  const [anchor, setAnchor] = React.useState<string>();
  const [spotlight, setSpotlight] = React.useState<string>();
  const [search, setSearch] = React.useState<string | null>(null);
  const [files, setFiles] = React.useState<GroupChatFile[]>();
  const [draftFiles, setDraftFiles] = React.useState<GroupDraftFile[]>([]);
  const [draft, setDraft] = React.useState(emptyGroupDraft);
  const [quote, setQuote] = React.useState<GroupQuote>();
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<'members' | 'activity' | 'schedule'>('members');
  const [memberDetail, setMemberDetail] = React.useState<string>();
  const [adding, setAdding] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [work, setWork] = React.useState<{ title: string; identity: NonNullable<GroupDelivery['identity']> }>();
  const [streaming, setStreaming] = React.useState<Record<string, Record<string, string>>>({});
  const scroller = React.useRef<HTMLDivElement>(null);
  const composer = React.useRef<ComposerEditorHandle>(null);
  const draftId = React.useRef<string | null>(null);
  const atEnd = React.useRef(true);
  const jumpTimer = React.useRef<number | undefined>(undefined);
  const members = page?.members ?? group.members;
  const setQuery = React.useCallback((value: string | null) => { setSearch(value); setOlder([]); setBefore(undefined); setAnchor(undefined); }, []);
  React.useEffect(() => {
    const controller = new AbortController();
    const query = search ? '?q=' + encodeURIComponent(search) : '';
    const path = anchor ? id + '/post/' + encodeURIComponent(anchor) : id + query;
    void botGroupRequest<BotGroupPage>(path, undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setPage(value);
    }, error => { if (!controller.signal.aborted) setError(messageError(error)); });
    return () => controller.abort();
  }, [id, sequence, search, anchor]);

  const posts = [...new Map([...older, ...(page?.posts ?? [])].map(post => [post.id, post])).values()];
  const active = posts.flatMap(post => post.delivery.filter(delivery => delivery.state === 'running' && delivery.identity && delivery.runId));
  const activeKey = JSON.stringify(active.map(value => [value.identity!.threadId, value.identity!.branchId, value.runId]));
  React.useEffect(() => {
    if (!api) return;
    const identities = JSON.parse(activeKey) as [string, string, string][];
    const remove = identities.map(([threadId, branchId, runId]) => getThreadObservationBus(api).subscribe({ threadId, branchId, kinds: ['progress'] }, frame => {
      if (!('stream' in frame) || frame.stream !== 'progress' || frame.runId !== runId) return;
      const event = frame.event as { kind?: string; events?: { kind: string; data: { kind?: string; item_id?: string; text?: string } }[] };
      if (event.kind !== 'batch') return;
      const additions = event.events?.filter(value => value.kind === 'provider' && value.data?.kind === 'text_delta' && value.data.item_id && value.data.text);
      if (!additions?.length) return;
      setStreaming(previous => {
        const next = { ...previous[runId] };
        for (const { data } of additions) next[data.item_id!] = (next[data.item_id!] ?? '') + data.text;
        return { ...previous, [runId]: next };
      });
    }));
    return () => remove.forEach(stop => stop());
  }, [activeKey, api]);

  React.useLayoutEffect(() => {
    if (anchor && scroller.current) {
      scroller.current.querySelector(`[data-post="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    if (atEnd.current && scroller.current && search === null) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [page, streaming, search, anchor]);
  React.useEffect(() => {
    const element = scroller.current;
    if (!element || !('ResizeObserver' in window)) return;
    const observer = new window.ResizeObserver(() => { if (atEnd.current && search === null && !anchor) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
  }, [search, anchor]);
  React.useEffect(() => () => window.clearTimeout(jumpTimer.current), []);

  const displayName = (botId: string) => bots.find(bot => bot.id === botId)?.name ?? members.find(member => member.botId === botId)?.name ?? (quote?.post.author.kind === 'bot' && quote.post.author.botId === botId ? quote.post.author.name : L('left'));
  const authorName = (post: BotGroupPost) => post.author.kind === 'bot' ? displayName(post.author.botId) === L('left') ? post.author.name : displayName(post.author.botId) : '';
  const openDelivery = (delivery: GroupDelivery) => {
    if (delivery.identity) openWork({ identity: delivery.identity, title: displayName(delivery.botId) });
  };
  const openWork = (value: NonNullable<BotGroupPost['work']>) => {
    setWork(value); setMemberDetail(undefined); setFiles(undefined); revealPanel();
  };
  const change = async (input: GroupChange) => {
    setError('');
    try { await botGroupRequest(id + '/change', input); if (input.kind === 'delete') onDelete(); refresh(); }
    catch (error) { setError(messageError(error)); }
  };
  const send = async () => {
    const { addressed, replyId, gone } = groupDraftRecipients(draft, members, quote);
    if ((!draft.text.trim() && !draftFiles.length) || gone.length || busy) return;
    setBusy(true); setError('');
    draftId.current ??= crypto.randomUUID();
    try {
      const uploads = await Promise.all(draftFiles.map(entry => uploadBotGroupFile(id, entry.id, entry.file)));
      await botGroupRequest(id + '/post', { id: draftId.current, text: draft.text.trim(), addressed, quoteId: quote?.post.id, reply: Boolean(replyId), files: uploads.map(file => file.id) });
      draftId.current = null; setDraft(emptyGroupDraft); setDraftFiles([]); setQuote(undefined); atEnd.current = true; refresh();
    } catch (error) { setError(messageError(error)); }
    finally { setBusy(false); composer.current?.focus(); }
  };
  const cite = (post: BotGroupPost, reply: boolean) => { if (!busy) { setQuote({ post, reply }); composer.current?.focus(); } };
  const jump = (postId: string) => {
    window.clearTimeout(jumpTimer.current);
    setSpotlight(postId);
    jumpTimer.current = window.setTimeout(() => setSpotlight(undefined), 900);
    const node = scroller.current?.querySelector<HTMLElement>(`[data-post="${CSS.escape(postId)}"]`);
    if (node) node.scrollIntoView({ block: 'center', behavior: reduced ? 'instant' : 'smooth' });
    else { setQuery(null); setAnchor(postId); }
  };
  const download = async (file: GroupChatFile) => {
    try {
      const url = URL.createObjectURL(await downloadBotGroupFile(id, file.id));
      const link = document.createElement('a');
      link.href = url; link.download = file.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) { setError(messageError(error)); }
  };

  const listeners = members.filter(member => member.listening);
  const detail = members.find(member => member.botId === memberDetail);
  const detailBot = detail && bots.find(bot => bot.id === detail.botId);
  const addable = bots.filter(bot => !bot.archived && !bot.deletion && !members.some(member => member.botId === bot.id));
  const newestFirst = [...posts].reverse();
  const deliveries = newestFirst.flatMap(post => post.delivery.filter(runningOrNotable).map(delivery => ({ post, delivery })));
  const listen = (member: BotGroupMember) => <Switch checked={member.listening} title={L('listen')}
    aria-label={displayName(member.botId) + ' · ' + L('listen')}
    onCheckedChange={enabled => void change({ kind: 'listen', botId: member.botId, enabled })} />;
  const memberState = (botId: string) => active.some(delivery => delivery.botId === botId) ? L('thinking')
    : bots.find(bot => bot.id === botId)?.activity?.state === 'asleep' ? L('asleep') : L('idle');
  const listenSource = (member: BotGroupMember) => member.listening && member.changedBy
    ? L(member.changedBy === 'bot' ? 'listeningByBot' : 'listeningByUser') : undefined;
  const openMessage = (postId: string) => { jump(postId); revealChat(); };
  const deliveryRow = ({ post, delivery }: (typeof deliveries)[number]) => <button type="button" className="bot-row group-chat-activity-row"
    key={post.id + delivery.membership} onClick={() => { if (delivery.identity && (working(delivery) || delivery.state === 'execution-failed')) openDelivery(delivery); else openMessage(post.id); }}>
    <GroupAvatar bot={bots.find(bot => bot.id === delivery.botId)} name={displayName(delivery.botId)} size={25} />
    <span className="min-w-0 flex-1"><b className="block truncate">{displayName(delivery.botId)}</b><small className="block truncate">{post.text}</small></span>
    <small data-tone={troubled(delivery) ? 'warn' : undefined}>{L(working(delivery) ? 'inProgress' : delivery.state === 'asleep' ? 'asleep' : delivery.state === 'execution-failed' ? 'workFailed' : delivery.state === 'failed' ? 'failed' : 'silent')}</small>
  </button>;
  const historyPosts = newestFirst.filter(post => post.fact || post.work || post.scheduleName || post.watchName || post.informs || (post.author.kind === 'bot' && post.addressed.length));
  const date = (at: number) => new Date(at).toLocaleDateString(getCurrentIntlLocale(), { month: 'short', day: 'numeric' });
  const historyByDate = new Map<string, BotGroupPost[]>();
  for (const post of historyPosts) {
    const key = new Date(post.at).toDateString();
    const entries = historyByDate.get(key);
    if (entries) entries.push(post); else historyByDate.set(key, [post]);
  }
  const subpage = Boolean(detail || files || work || adding);
  const paneId = `group-panel-${group.id}-pane`;
  const panelTabs = <GroupPanelTabs active={tab} paneId={paneId} needsAttention={group.needsAttention || deliveries.some(item => troubled(item.delivery))} onChange={setTab} />;
  const panelBody = work ? <div className="flex h-full min-h-0 flex-col">
    <h3 className="group-chat-panel-title truncate">{work.title}</h3>
    {api && <div className="flex min-h-0 flex-1"><CollaborationConversation identity={work.identity} api={api} host={getRuntimeEndpointGeneration()}
      onQuote={text => { if (!busy) { composer.current?.insertText(text); setWork(undefined); revealChat(); composer.current?.focus(); } }} /></div>}
  </div> : files ? <div className="group-chat-panel-section">
    <h3 className="group-chat-panel-title">{L('files')}</h3>
    {!files.length && <p className="group-chat-panel-note">{L('emptyFiles')}</p>}
    {files.map(file => <button key={file.id} className="bot-row" type="button" onClick={() => void download(file)}>
      <Icon name="file" className="size-4 shrink-0" /><span className="truncate">{file.filename}</span>
    </button>)}
  </div> : detail ? <div className="group-chat-panel-section">
    <div className="group-chat-member-stage">
      {detailBot && <><span className="bot-stage-floor" aria-hidden="true" /><BotFigure bot={detailBot} state="idle" size={154} wide label={detailBot.name} /></>}
      <h3>{displayName(detail.botId)}</h3><p>{memberState(detail.botId)}</p>
    </div>
    <div className="group-chat-listening-detail">
      <div><b>{L('listening')}</b><small>{listenSource(detail) ?? L('listeningHint')}</small></div>{listen(detail)}
    </div>
    <div className="group-chat-member-actions">
      {detailBot?.activity?.state === 'asleep' && <Button size="sm" onClick={() => onWake(detailBot)}>{L('wake')}</Button>}
      <Button variant="outline" size="sm" onClick={() => { revealChat(); onDirect(detail.botId); }}>{L('private')}</Button>
      {detailBot && <Button variant="ghost" size="sm" onClick={() => onProfile(detailBot)}>{L('profile')}</Button>}
      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void change({ kind: 'remove', botId: detail.botId })}>{L('remove')}</Button>
    </div>
  </div> : adding ? <div className="group-chat-panel-section">
    <h3 className="group-chat-panel-title">{L('add')}</h3>
    {addable.map(bot => <button className="bot-row" type="button" key={bot.id} onClick={() => void change({ kind: 'add', botId: bot.id })}>
      <GroupAvatar bot={bot} name={bot.name} size={27} /> <span className="min-w-0 flex-1 truncate">{bot.name}</span><Icon name="add" className="size-4" />
    </button>)}
  </div> : tab === 'members' ? <div className="group-chat-panel-section">
    <div className="group-chat-section-heading"><b>{L('members')}</b><span title={L('listen')}>{L('listening')}</span></div>
    {members.map(member => <div className="group-chat-member-row" key={member.membership}>
      <button className="bot-row" type="button" onClick={() => setMemberDetail(member.botId)}>
        <GroupAvatar bot={bots.find(bot => bot.id === member.botId)} name={displayName(member.botId)} size={31} />
        <span className="min-w-0 flex-1"><b className="block truncate">{displayName(member.botId)}</b>
          <small className="block truncate">{[memberState(member.botId), listenSource(member)].filter(Boolean).join(' · ')}</small>
        </span>
        <Icon name="arrow-right-s" className="size-3.5 shrink-0 text-muted-foreground" />
      </button>{listen(member)}
    </div>)}
    {addable.length > 0 && <button type="button" className="bot-row text-muted-foreground" onClick={() => setAdding(true)}><Icon name="add" className="size-4" />{L('add')}</button>}
    <p className="group-chat-panel-note">{L('listeningHint')}</p>
  </div> : tab === 'schedule' ? <GroupCalendar groupId={group.id} members={members} revealChat={revealChat} api={api} /> : <div className="group-chat-panel-section">
    {([
      ['needs', deliveries.filter(item => troubled(item.delivery))],
      ['inProgress', deliveries.filter(item => working(item.delivery))],
      ['history', deliveries.filter(item => item.delivery.state === 'silent')],
    ] as const).map(([section, rows]) => rows.length > 0 && <section key={section}>
      <div className="group-chat-section-heading"><b>{L(section)}</b></div>{rows.map(deliveryRow)}
    </section>)}
    {[...historyByDate].map(([day, entries]) => <section key={day}>
      <div className="group-chat-section-heading"><b>{date(entries[0]!.at)}</b></div>
      <div className="group-chat-activity-timeline">{entries.map(post => <button type="button" key={post.id} onClick={() => post.work ? openWork(post.work) : openMessage(post.id)}>
        <time>{clock(post.at)}</time><span className="group-chat-activity-copy"><b className="block truncate">
          {post.fact ? `${post.fact.name} · ${post.fact.enabled ? L('listening') : L('listenOff')}` : post.work?.title ?? post.scheduleName ?? post.watchName ?? authorName(post)}
        </b>{post.text && <small className="block truncate">{post.text}</small>}</span>
      </button>)}</div>
    </section>)}
    {!deliveries.length && !historyByDate.size && <p className="group-chat-panel-note">{L('emptyActivity')}</p>}
  </div>;
  const memberPane = <aside className="bot-panel-body group-chat-panel" aria-label={group.name} onKeyDown={event => {
    if (event.key === 'Escape' && drawer) drawer.setRightSidebarOpen(false);
  }}>
    {subpage ? <div className="group-chat-panel-back"><Button variant="ghost" size="sm" onClick={() => {
      setMemberDetail(undefined); setAdding(false); setFiles(undefined); setWork(undefined);
    }}><Icon name="arrow-left-s" className="size-4" />{L('back')}</Button></div> : <>
      <header className="group-chat-panel-header">
        <GroupFaces group={group} bots={bots} size={32} />
        <div className="min-w-0"><h2 className="truncate">{group.name}</h2>
          <p className="truncate" title={listeners.map(member => displayName(member.botId)).join('、')}>
            {groupMemberCount(members.length)} · {listeners.length ? `${listeners.map(member => displayName(member.botId)).join('、')} ${L('listening')}` : L('noListeners')}
          </p>
        </div>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={L('groupMenu')}><Icon name="more" className="size-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!addable.length} onSelect={() => setAdding(true)}><Icon name="add" className="size-4" />{L('add')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { void botGroupRequest<GroupChatFile[]>(id + '/files').then(setFiles, error => setError(messageError(error))); }}><Icon name="file" className="size-4" />{L('files')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { setQuery(''); revealChat(); }}><Icon name="search" className="size-4" />{L('search')}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDeleting(true)} className="text-destructive"><Icon name="delete-bin" className="size-4" />{L('delete')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {panelTabs}
    </>}
    <div className="bot-panes"><div className="bot-pane group-chat-pane" key={work ? 'work' : files ? 'files' : detail ? detail.membership : adding ? 'add' : tab}
      data-enter="" id={paneId} role={subpage ? undefined : 'tabpanel'} aria-labelledby={subpage ? undefined : `${paneId}-${tab}`}>
      {panelBody}
    </div></div>
  </aside>;

  return <div className="group-chat">
    <main className="group-chat-center" onPointerDown={onRevealChat}>
      {search !== null && <div className="group-chat-search"><Icon name="search" className="size-4 shrink-0 text-muted-foreground" />
        <input autoFocus value={search} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(null); }} placeholder={L('search')} aria-label={L('search')} className="group-chat-field" />
        <Button variant="ghost" size="icon" aria-label={L('cancel')} onClick={() => setQuery(null)}><Icon name="close" className="size-4" /></Button>
      </div>}
      <div className="group-chat-scroll" ref={scroller} onScroll={event => { const element = event.currentTarget; atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 45; }}>
        <div className="group-chat-timeline">
          {anchor && <button className="group-chat-older" onClick={() => { atEnd.current = true; setQuery(null); }}>{L('latest')}</button>}
          {(before ?? (!older.length ? page?.before : undefined)) && <button className="group-chat-older" onClick={() => {
            const params = new URLSearchParams({ before: (before ?? page?.before)! });
            if (search) params.set('q', search);
            void botGroupRequest<BotGroupPage>(id + '?' + params).then(value => { setOlder(items => [...value.posts, ...items]); setBefore(value.before); }, error => setError(messageError(error)));
          }}>{L('older')}</button>}
          {!posts.length && <div className="group-chat-empty"><GroupFaces group={group} bots={bots} size={45} /><h2>{group.name}</h2><p>{search ? L('noResults') : page ? L('empty') : L('loading')}</p>{page && !search && members[0] && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => {
            const first = members[0]!;
            if (!groupDraftRecipients(draft, members, quote).addressed.includes(first.botId)) placeGroupMention(composer.current, first.botId, displayName(first.botId));
            composer.current?.focus();
          }}>@{displayName(members[0].botId)}</Button>}</div>}
          {posts.map((post, index) => {
            const previous = posts[index - 1];
            const bot = post.author.kind === 'bot' ? bots.find(value => value.id === (post.author as { botId: string }).botId) : undefined;
            const dayBreak = !previous || new Date(previous.at).toDateString() !== new Date(post.at).toDateString();
            const consecutive = !dayBreak && post.at - previous.at < 300_000 && JSON.stringify(previous.author) === JSON.stringify(post.author);
            const showQuote = post.quoteId && previous?.id !== post.quoteId && previous?.quoteId !== post.quoteId;
            return <React.Fragment key={post.id}>
              {dayBreak && <div className="group-chat-day">{date(post.at)}</div>}
              {post.author.kind === 'system' ? <div className="group-chat-fact" data-post={post.id}>{post.fact && <>{post.fact.name} · {L(post.fact.enabled ? 'listening' : 'listenOff')} · {clock(post.at)}</>}</div>
                : <ContextMenu><ContextMenuTrigger asChild>
                <motion.article className="group-chat-line" data-user={post.author.kind === 'user'} data-consecutive={consecutive || undefined} data-post={post.id} data-spotlight={spotlight === post.id || undefined}
                  initial={reduced || search !== null || Boolean(anchor) || index !== posts.length - 1 ? false : { opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }} transition={springTransition('settle')}>
              <div className="group-chat-face">{post.author.kind === 'bot' && !consecutive && <GroupAvatar bot={bot} name={post.author.name} size={31} />}</div>
              <div className="group-chat-stack">
                {post.author.kind === 'bot' && (!consecutive || !!post.addressed.length || post.scheduleName || post.watchName) && <div className="group-chat-author">{authorName(post)}{post.addressed.length ? ' → ' + post.addressed.map(displayName).join('、') : ''}{post.informs && ' · ' + L('informed')}{post.scheduleName && ' · ' + L('schedule') + ' 「' + post.scheduleName + '」'}{post.watchName && ' · ' + L('watch') + ' 「' + post.watchName + '」'}</div>}
                <div className="group-chat-bubble">
                  {showQuote && post.quote && <button className="group-chat-quote" onClick={() => jump(post.quoteId!)}>{post.quote.author && post.quote.author + ' · '}{post.quote.text}</button>}
                  {post.text && <GroupText post={post} reduced={reduced} />}
                  {post.files?.map(file => <button key={file.id} className="group-chat-work" type="button" onClick={() => void download(file)}>
                    <Icon name="file" className="size-4 shrink-0" /><span>{file.filename}</span>
                  </button>)}
                  {post.work && <button className="group-chat-work" type="button" onClick={() => openWork(post.work!)}>
                    <Icon name="chat-3" className="size-4 shrink-0" /><span>{post.work.title}</span><small>{L('openWork')}</small>
                  </button>}
                </div>
                <div className="group-chat-meta"><time>{clock(post.at)}</time>{post.delivery.map(delivery => {
                  const recipient = bots.find(value => value.id === delivery.botId);
                  return <span key={delivery.membership} className="group-chat-receipt" data-state={delivery.state} title={displayName(delivery.botId) + (delivery.state === 'silent' ? ' · ' + L('silent') : working(delivery) ? ' · ' + L('thinking') : '')}>
                    <GroupAvatar bot={recipient} name={displayName(delivery.botId)} size={16} />
                  </span>;
                })}<div className="group-chat-message-actions"><button onClick={() => cite(post, true)}>{L('reply')}</button><button onClick={() => cite(post, false)}>{L('quote')}</button></div></div>
                {post.delivery.filter(troubled).map(delivery => <div className="group-chat-trouble" key={delivery.membership}>
                  {displayName(delivery.botId)} · {delivery.state === 'asleep' ? L('asleep') : delivery.state === 'failed' ? L('failed') : L('workFailed')}
                  {delivery.state === 'execution-failed' ? <button onClick={() => openDelivery(delivery)}>{L('openWork')}</button> : <button title={delivery.detail} onClick={() => void change({ kind: 'retry', postId: post.id, botId: delivery.botId })}>{L(delivery.state === 'asleep' ? 'wakeRetry' : 'retry')}</button>}
                </div>)}
              </div>
                </motion.article></ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => cite(post, true)}><Icon name="reply" className="size-4" />{L('reply')}</ContextMenuItem>
                  <ContextMenuItem onClick={() => cite(post, false)}><Icon name="chat-quote" className="size-4" />{L('quote')}</ContextMenuItem>
                </ContextMenuContent>
                </ContextMenu>}
            </React.Fragment>;
          })}
          {active.map(delivery => {
            const text = Object.values(streaming[delivery.runId!] ?? {}).join('\n\n');
            const bot = bots.find(value => value.id === delivery.botId);
            return <React.Fragment key={delivery.runId}>
              {text && <motion.article className="group-chat-line" initial={reduced ? false : { opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={springTransition('settle')}><div className="group-chat-face"><GroupAvatar bot={bot} name={displayName(delivery.botId)} size={31} /></div>
                <div className="group-chat-stack"><div className="group-chat-author">{displayName(delivery.botId)}</div><div className="group-chat-bubble"><MarkdownRenderer messageId={delivery.runId!} content={text} isStreaming /></div></div>
              </motion.article>}
              {api && <GroupRunInteractions api={api} delivery={delivery} name={displayName(delivery.botId)} />}
            </React.Fragment>;
          })}
        </div>
      </div>
      <div className="group-chat-compose-space">
        <AnimatePresence initial={false}>
          {!!active.length && <motion.div key="working" layout className="chat-input-column group-chat-compose-status" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="group-chat-working"><span className="bot-ring" /><span className="truncate">{[...new Set(active.map(value => displayName(value.botId)))].join('、')} · {L('thinking')}</span></div>
          </motion.div>}
        </AnimatePresence>
        {error && <div className="chat-input-column"><div role="alert" className="group-chat-trouble">{error}</div></div>}
        <BotGroupComposer groupId={group.id} editor={composer} draft={draft} onDraft={setDraft} quote={quote} onClearQuote={() => setQuote(undefined)}
          members={members} bots={bots} displayName={displayName} files={draftFiles}
          onFiles={files => { if (!busy) setDraftFiles(current => [...current, ...files.map(file => ({ file, id: crypto.randomUUID() }))]); }}
          onRemoveFile={id => setDraftFiles(current => current.filter(file => file.id !== id))} busy={busy} onSend={() => void send()} onWake={onWake} />
      </div>
    </main>
    {panelTarget && createPortal(memberPane, panelTarget)}
    <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent className="max-w-sm"><DialogHeader><DialogTitle>{L('delete')}</DialogTitle><DialogDescription>{group.name}</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" onClick={() => setDeleting(false)}>{L('cancel')}</Button><Button variant="destructive" onClick={() => void change({ kind: 'delete' })}>{L('delete')}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}

function runningOrNotable(delivery: GroupDelivery) { return working(delivery) || troubled(delivery) || delivery.state === 'silent'; }

const GROUP_TABS = [
  { id: 'members', icon: 'group' },
  { id: 'activity', icon: 'history' },
  { id: 'schedule', icon: 'calendar-schedule' },
] as const;
type GroupPanelTab = (typeof GROUP_TABS)[number]['id'];

function GroupPanelTabs({ active, paneId, needsAttention, onChange }: { active: GroupPanelTab; paneId: string; needsAttention: boolean; onChange(tab: GroupPanelTab): void }) {
  const row = React.useRef<HTMLDivElement>(null);
  const knob = React.useRef<HTMLSpanElement>(null);
  useSegmentKnob(row, knob, '[role="tab"][aria-selected="true"]', active);
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = GROUP_TABS.findIndex(tab => tab.id === active);
    const last = GROUP_TABS.length - 1;
    const step = event.key === 'ArrowLeft' ? (index + last) % GROUP_TABS.length
      : event.key === 'ArrowRight' ? (index + 1) % GROUP_TABS.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;
    if (step === undefined) return;
    event.preventDefault();
    onChange(GROUP_TABS[step]!.id);
    row.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[step]?.focus();
  };
  return <div className="bot-tabs-frame"><div ref={row} className="bot-tabs" role="tablist" onKeyDown={move}>
    <span ref={knob} className="bot-tabs-knob" aria-hidden="true" data-hidden="" />
    {GROUP_TABS.map(({ id, icon }) => <Tooltip key={id}>
      <TooltipTrigger asChild><button type="button" className="bot-tab" role="tab" id={`${paneId}-${id}`}
        aria-label={L(id)} aria-controls={paneId} aria-selected={active === id} tabIndex={active === id ? 0 : -1} onClick={() => onChange(id)}>
        <Icon name={icon} className="size-4" />
        {id === 'activity' && needsAttention && <span className="bot-dot" data-tone="warn" aria-hidden="true" />}
      </button></TooltipTrigger><TooltipContent side="bottom">{L(id)}</TooltipContent>
    </Tooltip>)}
  </div></div>;
}

const scheduleApi = createScheduledTasksHttpAPI();
const botScheduleScope = (botId: string) => `bot:${botId}`;

function GroupCalendar({ groupId, members, revealChat, api }: { groupId: string; members: BotGroupMember[]; revealChat(): void; api: ThreadsAPI | null | undefined }) {
  const { t } = useI18n();
  const [tasks, setTasks] = React.useState<{ member: BotGroupMember; task: ScheduledTask }[]>();
  const [watches, setWatches] = React.useState<{ botId: string; owner: string; task: Followup }[]>([]);
  const [error, setError] = React.useState('');
  const [expanded, setExpanded] = React.useState<string>();
  const [revision, reload] = React.useReducer((value: number) => value + 1, 0);
  const scopeKey = JSON.stringify(members.filter(member => member.calendar).map(member => [member.botId, member.name, member.calendar]));
  const watchScope = JSON.stringify(members.filter(member => member.conversation).map(member => [member.botId, member.name, member.conversation]));
  React.useEffect(() => subscribeVarinEvents(event => { if (event.type === 'scheduled-task-changed') reload(); }), []);
  React.useEffect(() => {
    const controller = new AbortController();
    const contexts = JSON.parse(scopeKey) as [string, string, ThreadIdentity][];
    void Promise.all(contexts.map(async ([botId, name, target]) => {
      const scheduled = await scheduleApi.list(botScheduleScope(botId), controller.signal);
      return scheduled.flatMap(task => task.target.kind === 'existing_work' && task.target.threadId === target.threadId && task.target.branchId === target.branchId
        ? [{ member: { botId, name, listening: false, membership: target.threadId, calendar: target }, task }] : []);
    })).then(value => { if (!controller.signal.aborted) { setTasks(value.flat()); setError(''); } },
      error => { if (!controller.signal.aborted) setError(messageError(error)); });
    return () => controller.abort();
  }, [scopeKey, revision]);
  React.useEffect(() => {
    if (!api) return;
    const targets = JSON.parse(watchScope) as [string, string, ThreadIdentity][];
    const bus = getThreadObservationBus(api);
    let pending: AbortController | undefined;
    const load = () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      void Promise.all(targets.map(async ([botId, owner, target]) => {
        const records = await api.followups.arrangements(target, botId, controller.signal);
        return records.filter(task => task.thread_id === target.threadId && task.branch_id === target.branchId && !task.external_conversation_id && pendingFollowup(task))
          .map(task => ({ botId, owner, task }));
      })).then(value => { if (!controller.signal.aborted) setWatches(value.flat()); },
        error => { if (!controller.signal.aborted) setError(messageError(error)); });
    };
    const stops = targets.map(([, , target]) => bus.subscribe({ threadId: target.threadId, branchId: target.branchId, kinds: ['followup.*'] }, load));
    load();
    return () => { pending?.abort(); stops.forEach(stop => stop()); };
  }, [api, watchScope]);
  const openSchedules = (botId?: string, focus?: { kind: 'schedule' | 'followup'; id: string }) => {
    useUIStore.getState().setScheduledTasksDialogOpen(true, { group: { id: groupId, botId, focus } });
    revealChat();
  };
  const upcoming = (tasks ?? []).filter(({ task }) => task.enabled && task.calendar?.definition.next_at_ms)
    .sort((a, b) => a.task.calendar!.definition.next_at_ms! - b.task.calendar!.definition.next_at_ms!);
  const rules = (tasks ?? []).filter(item => item.task.schedule.kind !== 'once' || !upcoming.includes(item));
  const scheduleRow = ({ member, task }: (typeof upcoming)[number], recurring: boolean) => {
    const key = JSON.stringify([recurring, member.botId, task.id]);
    const next = task.calendar?.definition.next_at_ms;
    const open = expanded === key;
    return <div className="bot-schedule" key={key} data-open={open} data-paused={!task.enabled || undefined}>
      <button type="button" className="flex w-full items-center gap-3 px-3 py-2.5 text-left" aria-expanded={open} onClick={() => setExpanded(open ? undefined : key)}>
        <span className="bot-schedule-when">{!recurring && next ? <>
          <b>{clock(next)}</b><small>{new Date(next).toLocaleDateString(getCurrentIntlLocale(), { month: 'short', day: 'numeric' })}</small>
        </> : <Icon name="history" className="size-4 text-muted-foreground" />}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <b className="truncate">{task.name}{!task.enabled && <small className="ml-2">{t('bot.schedule.paused')}</small>}</b>
          <small className="truncate">{member.name} · {formatSchedule(task, t)}</small>
        </span>
        <Icon name={open ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5 text-muted-foreground" />
      </button>
      <div className="bot-fold" data-open={open} inert={!open}><div>
        <dl className="bot-schedule-detail">
          <dt>{t('bot.schedule.rule')}</dt><dd>{formatSchedule(task, t)}</dd>
          <dt>{t('bot.schedule.missed')}</dt><dd>{(task.calendar?.definition.missed_policy ?? task.missedPolicy) === 'coalesce_once' ? t('bot.schedule.missedOnce') : t('bot.schedule.missedSkip')}</dd>
          <dd className="col-span-2"><Button variant="outline" size="sm" onClick={() => openSchedules(member.botId, { kind: 'schedule', id: task.id })}>{t('bot.schedule.edit')}</Button></dd>
        </dl>
      </div></div>
    </div>;
  };
  return <div className="group-chat-panel-section">
    {error && <div role="alert" className="group-chat-trouble">{error}</div>}
    {watches.length > 0 && <section><div className="group-chat-section-heading"><b>{L('watches')}</b></div>
      {watches.map(({ botId, owner, task }) => <button type="button" className="bot-schedule flex w-full items-center gap-3 px-3 py-2.5 text-left"
        key={JSON.stringify([botId, task.id])} onClick={() => openSchedules(botId, { kind: 'followup', id: task.id })}>
        <Icon name="time" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0"><b className="block truncate">{task.name || followupTrigger(task, t)}</b>
          <small className="block truncate">{owner} · {followupStatus(task, t)}</small></span>
      </button>)}
    </section>}
    {upcoming.length > 0 && <section><div className="group-chat-section-heading"><b>{L('upcoming')}</b></div>{upcoming.map(item => scheduleRow(item, false))}</section>}
    {rules.length > 0 && <section><div className="group-chat-section-heading"><b>{L('recurring')}</b></div>{rules.map(item => scheduleRow(item, true))}</section>}
    {!tasks ? <p className="group-chat-panel-note" role="status">{L('loading')}</p> : !tasks.length && !watches.length ? <p className="group-chat-panel-note">{L('emptySchedule')}</p> : null}
    <Button variant="outline" size="sm" className="my-2 w-full" onClick={() => openSchedules()}>
      <Icon name="calendar-schedule" className="size-4" />{t('tasksHub.title')}
    </Button>
  </div>;
}

function GroupRunInteractions({ api, delivery, name }: { api: ThreadsAPI; delivery: GroupDelivery; name: string }) {
  const [snapshot, setSnapshot] = React.useState<ThreadSnapshot>();
  const [error, setError] = React.useState('');
  const identity = delivery.identity!;
  const { threadId, branchId } = identity;
  React.useEffect(() => {
    let pending: AbortController | undefined;
    const load = () => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      void api.snapshot({ runtime: 'agent', threadId, branchId }, request.signal).then(value => {
        if (!request.signal.aborted) { setSnapshot(value); setError(''); }
      }, error => { if (!request.signal.aborted) setError(messageError(error)); });
    };
    const stop = getThreadObservationBus(api).subscribe({ threadId, branchId, kinds: ['operation.*', 'permission.*', 'question.*', 'run.changed'] }, load);
    load();
    return () => { stop(); pending?.abort(); };
  }, [api, threadId, branchId]);
  const run = snapshot?.activeRun;
  const operations = snapshot?.operations.filter(operation => operation.run_id === delivery.runId && operation.phase === 'waiting'
    && (operation.executor === 'ask_user' || (operation.result?.kind === 'control' && (operation.result.value as { permission?: unknown } | null)?.permission))) ?? [];
  if (!operations.length && !error) return null;
  return <article className="group-chat-line">
    <div className="group-chat-face" />
    <div className="group-chat-stack"><b className="group-chat-author">{name}</b>
      {error && <p role="alert" className="group-chat-trouble">{error}</p>}
      {operations.map(operation => <ThreadPermission key={operation.id} operation={operation}
        enabled={run?.id === delivery.runId && !run?.cancel_requested}
        onDecide={(permissionId, decision) => api.decidePermission({ ...identity, operationId: operation.id, permissionId, decision })} />)}
      {operations.some(operation => operation.executor === 'ask_user') && <ThreadQuestions scopeKey={threadComposerKey(threadHostKey(), identity)} operations={operations}
        enabled={operation => run?.state === 'waiting' && !run.cancel_requested && run.waiting_on === operation.waiting_on}
        onRead={operation => api.operation(operation.id)} onCancel={operation => api.cancelOperation(operation.id)}
        onAnswer={(operation, answers) => api.answerQuestion({ ...identity, operationId: operation.id, answers })} />}
    </div>
  </article>;
}

const GroupText = React.memo(function GroupText({ post, reduced }: { post: BotGroupPost; reduced: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const [height, setHeight] = React.useState<number>();
  const content = React.useRef<HTMLDivElement>(null);
  const long = post.text.length > 1400 || post.text.split('\n').length > 15;
  React.useLayoutEffect(() => {
    if (!long || !content.current) return;
    const element = content.current;
    const measure = () => setHeight(element.offsetHeight);
    measure();
    if (!('ResizeObserver' in window)) return;
    const observer = new window.ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [long, post.text]);
  const text = <MarkdownRenderer content={post.text} messageId={post.id} />;
  if (!long) return text;
  const collapsible = height !== undefined && height > 250;
  return <>
    <motion.div className="group-chat-fold" data-collapsed={collapsible && !expanded || undefined} initial={false}
      animate={{ height: collapsible && !expanded ? 250 : height ?? 'auto' }}
      transition={reduced ? { duration: 0 } : springTransition('glide')}><div ref={content} className="flow-root">{text}</div></motion.div>
    {collapsible && <button type="button" className="group-chat-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {L(expanded ? 'collapse' : 'expand')}<Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-3" />
    </button>}
  </>;
});
