import { useConversationOrganization, refreshConversationOrganization } from '@/stores/useConversationOrganizationStore';
import { ConversationOrganizationTree, type OrganizationNavigationHandle } from '@/components/conversation/ConversationOrganizationTree';
import { OrganizationCreateMenu } from '@/components/conversation/OrganizationCreateMenu';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import React from 'react';
import type { BotSummary, ThreadIdentity } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkbenchProfileSwitcher } from '@/components/layout/WorkbenchProfileSwitcher';
import { BotMenu, type BotMenuAction } from '@/components/sections/bots/BotMenu';
import { useHoverPill, useSelectionGlide } from '@/components/conversation/sidebarHighlights';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { formatSessionCompactDateLabel } from '@/lib/sessionDateLabels';
import { cn } from '@/lib/utils';
import { BotFigure } from './BotFigure';
import { BotSessionMenu, type BotSessionAction } from './BotSessionMenu';
import { isWaitingStatus, liveRun, runStatus, shortState, type BotFigureState, type BotSessionView } from './botPresentation';
import { useBotLayout } from './botLayout';
import { BotOrganizationList } from './BotOrganizationList';
import { BotOrganizationDialog, type BotOrganizationDialogState } from './BotOrganizationDialog';
import type { BotOrganizationController } from './useBotOrganization';
import { useThreadStore } from '@/stores/useThreadStore';

const rowId = (identity: ThreadIdentity) => `session:${identity.threadId}:${identity.branchId}`;

function SessionMark({ waiting, running, unread }: { waiting: boolean; running: boolean; unread: boolean }) {
  const { t } = useI18n();
  if (waiting) return <span className="bot-dot ml-auto" data-tone="warn" role="img" aria-label={t('bot.session.waiting')} />;
  if (running) return <span className="bot-ring ml-auto" role="img" aria-label={t('bot.session.running')} />;
  if (unread) return <span className="bot-dot ml-auto" data-arrive="" role="img" aria-label={t('bot.session.unread')} />;
  return null;
}

/**
 * Bot → conversation → branch, the same structure as the workbench's project → session (§3).
 * Only the selected Bot lists its conversations; the others stay folded until chosen.
 */
export function BotNavigator({ bots, selectedId, sessions, current, figures, busy, showArchived, isMobile, sessionTitle, organization,
  onSelectBot, onSelectSession, onSessionAction, onNewSession, onBotAction, onCreateBot, onToggleArchived, onRefresh, onOpenSettings }: {
  bots: BotSummary[] | null;
  organization: BotOrganizationController;
  selectedId: string | null;
  sessions: BotSessionView[] | null;
  current: ThreadIdentity | null;
  figures: ReadonlyMap<string, BotFigureState>;
  busy: boolean;
  showArchived: boolean;
  isMobile: boolean;
  sessionTitle(session: BotSessionView): string;
  onSelectBot(botId: string): void;
  onSelectSession(identity: ThreadIdentity): void;
  onSessionAction(session: BotSessionView, identity: ThreadIdentity, action: BotSessionAction): void;
  onNewSession(): void;
  onBotAction(bot: BotSummary, action: BotMenuAction): void;
  onCreateBot(): void;
  onToggleArchived(): void;
  onRefresh(): void;
  onOpenSettings(event: React.MouseEvent<HTMLButtonElement>): void;
}) {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  useConversationOrganization();
  const [conversationArchived, setConversationArchived] = React.useState(false);
  const [conversationScope, setConversationScope] = React.useState<'bots' | 'current'>('bots');
  React.useEffect(() => { if (!selectedId && conversationScope === 'current') setConversationScope('bots'); }, [selectedId, conversationScope]);
  const organizationRef = React.useRef<OrganizationNavigationHandle>(null);
  const list = React.useRef<HTMLDivElement>(null);
  const [query, setQuery] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  const [searchFolded, setSearchFolded] = React.useState<{ query: string; bots: Record<string, boolean> }>({ query: '', bots: {} });
  const folded = useBotLayout(state => state.navigatorFolded), setFolded = useBotLayout(state => state.setNavigatorFolded);
  const scope = useThreadStore(state => state.hostKey);
  const [organizationDialog, setOrganizationDialog] = React.useState<BotOrganizationDialogState | null>(null);
  const selected = bots?.find(bot => bot.id === selectedId) ?? null;
  const canStart = Boolean(selected && !selected.archived && !selected.deletion && (selected.activity?.state ?? 'awake') === 'awake');
  const currentRow = current ? rowId(current) : null;
  const needle = query.trim().toLocaleLowerCase();
  const shownSessions = sessions?.filter(session => !needle || sessionTitle(session).toLocaleLowerCase().includes(needle))
    .sort((a, b) => Number(b.thread.pinned) - Number(a.thread.pinned)) ?? null;
  const archivedSessions = shownSessions?.filter(session => session.thread.archived) ?? [];
  const matchingGroups = new Set(organization.value.groups.filter(group => group.name.toLocaleLowerCase().includes(needle)).flatMap(group => group.botIds));
  const shownBots = bots?.filter(bot => bot.archived === showArchived && (!needle || bot.name.toLocaleLowerCase().includes(needle)
    || matchingGroups.has(bot.id) || bot.id === selectedId && !!shownSessions?.length)) ?? [];
  const listLayoutKey = JSON.stringify([conversationScope, selectedId, shownBots.map(bot => bot.id), shownSessions?.map(session => [rowId(session.identity), session.branches.map(rowId), session.thread.archived]), folded, searchFolded, !!needle, organization.value.revision]);
  useSelectionGlide(list, currentRow, listLayoutKey);
  useHoverPill(list);
  const titleCounts = new Map<string, number>();
  for (const session of sessions ?? []) {
    const title = sessionTitle(session);
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  const rowClass = 'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left typography-ui-label text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-50';

  const renderSession = (session: BotSessionView) => {
    const main = session.identity;
    const mainCurrent = current?.threadId === main.threadId && current.branchId === main.branchId;
    const title = sessionTitle(session);
    const updated = session.thread.updated_at_ms;
    return <React.Fragment key={main.threadId}>
      <BotSessionMenu session={session} identity={main} label={title} disabled={busy} onAction={action => onSessionAction(session, main, action)}>
      <button type="button" data-sidebar-row={rowId(main)} data-current={mainCurrent || undefined} aria-current={mainCurrent ? 'page' : undefined}
        className="bot-nav-row bot-nav-session" disabled={busy && !mainCurrent} onClick={() => onSelectSession(main)}>
        <Icon name="chat-3" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {session.thread.pinned ? <Icon name="pushpin" className="size-3 shrink-0 text-muted-foreground" /> : null}
        {(titleCounts.get(title) ?? 0) > 1 && Number.isFinite(updated) ? <time dateTime={new Date(updated).toISOString()} title={new Date(updated).toLocaleString(getCurrentIntlLocale())}
          className="shrink-0 typography-micro font-normal text-muted-foreground">{formatSessionCompactDateLabel(updated)}</time> : null}
        <SessionMark waiting={session.waiting} running={session.running} unread={session.unread && !mainCurrent} />
      </button>
      </BotSessionMenu>
      {session.branches.map((branch, index) => {
        const branchCurrent = current?.threadId === branch.threadId && current.branchId === branch.branchId;
        const status = runStatus(liveRun(session.thread, branch.branchId, null));
        return <BotSessionMenu key={branch.branchId} session={session} identity={branch} label={`${title} · ${t('bot.session.branch', { index: index + 1 })}`} disabled={busy} onAction={action => onSessionAction(session, branch, action)}>
        <button type="button" data-sidebar-row={rowId(branch)} data-current={branchCurrent || undefined} data-branch=""
          aria-current={branchCurrent ? 'page' : undefined} className="bot-nav-row bot-nav-session" disabled={busy && !branchCurrent} onClick={() => onSelectSession(branch)}>
          <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{t('bot.session.branch', { index: index + 1 })}</span>
          <SessionMark waiting={isWaitingStatus(status)} running={status !== null && !isWaitingStatus(status)} unread={false} />
        </button></BotSessionMenu>;
      })}
    </React.Fragment>;
  };

  return <nav className="flex h-full min-h-0 min-w-0 flex-col" aria-label={t('bot.sidebar.aria')}>
    <div className="bot-nav-toolbar">
      {isMobile ? <div className="bot-nav-toolbar-profile"><WorkbenchProfileSwitcher /></div> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="bot-nav-toolbar-new">
            <button type="button" disabled={!canStart || busy} onClick={() => { if (apis.conversationOrganization && conversationScope !== 'bots') organizationRef.current?.newConversation(selectedId ?? undefined); else onNewSession(); }}
              className="flex w-full items-center rounded-[9px] text-[13.5px] text-foreground transition-colors hover:bg-interactive-hover disabled:opacity-50">
              <Icon name="chat-new" className="size-4 shrink-0" /><span className="min-w-0 text-left">{t('organization.newConversation')}</span>
            </button>
          </span>
        </TooltipTrigger>
        {!canStart && selected ? <TooltipContent side="bottom">{t('bot.session.newNeedsAwake', { name: selected.name })}</TooltipContent> : null}
      </Tooltip>
      <Button variant="ghost" size="icon" className="bot-nav-toolbar-action text-muted-foreground" aria-label={t('bot.session.search')} aria-pressed={searching}
        onClick={() => { setSearching(value => !value); setQuery(''); }}>
        <Icon name="search" className="size-4" />
      </Button>
      <Button variant="ghost" size="icon" className="bot-nav-toolbar-action text-muted-foreground" disabled={busy} aria-label={t('tasksHub.refresh')} onClick={() => { onRefresh(); if (conversationScope !== 'bots') void refreshConversationOrganization(); }}>
        <Icon name="refresh" className="size-4" />
      </Button>
      {conversationScope === 'bots' && <Button variant="ghost" size="icon" className="bot-nav-toolbar-action text-muted-foreground" disabled={!organization.ready || organization.pending} aria-label={t('bot.groups.create')} title={t('bot.groups.create')} onClick={() => setOrganizationDialog({ kind: 'create' })}>
        <Icon name="folder-add" className="size-4" />
      </Button>}
    </div>
    {searching ? <div className="px-2.5 pb-2">
      <input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearching(false); setQuery(''); } }}
        placeholder={t('bot.session.search')} aria-label={t('bot.session.search')}
        className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]" />
    </div> : null}
    {apis.conversationOrganization && (conversationScope === 'bots' ? <div className="flex items-center justify-between px-4 pb-2 typography-micro text-muted-foreground"><span>{t('organization.bots')}</span><button type="button" className="organization-icon-button" disabled={!selectedId} title={t('organization.botWork')} aria-label={t('organization.botWork')} onClick={() => setConversationScope('current')}><Icon name="folder-open" className="size-3.5" /></button></div> : <div className="flex items-center gap-1 px-3 pb-1"><button type="button" className="organization-icon-button" aria-label={t('organization.backToBots')} onClick={() => setConversationScope('bots')}><Icon name="arrow-left-s" className="size-4" /></button><span className="min-w-0 flex-1 truncate typography-meta">{t('organization.botWorkNamed', { name: selected?.name ?? t('organization.currentBot') })}</span><button type="button" className="organization-icon-button" title={t(conversationArchived ? 'organization.activeConversations' : 'organization.archivedConversations')} aria-label={t(conversationArchived ? 'organization.activeConversations' : 'organization.archivedConversations')} onClick={() => setConversationArchived(value => !value)}><Icon name={conversationArchived ? 'arrow-go-back' : 'inbox-archive'} className="size-3.5" /></button><OrganizationCreateMenu onCreate={botId => organizationRef.current?.newConversation(botId)} /></div>)}
    {apis.conversationOrganization && conversationScope !== 'bots' ? <ConversationOrganizationTree ref={organizationRef} archived={conversationArchived} query={query} onSearchReset={() => setQuery('')} botId={selectedId ?? undefined} defaultBotId={selectedId ?? undefined} viewKey="bot" /> : <>
    <div ref={list} className="bot-nav-list min-h-0 flex-1 overflow-y-auto px-2.5">
      {organization.error && <p role="alert" className="px-2 py-2 typography-meta text-destructive">{organization.error} <button type="button" className="underline" onClick={() => { void organization.refresh(); }}>{t('common.retry')}</button></p>}
      <BotOrganizationList bots={shownBots} organization={organization} selectedId={selectedId} query={query} scope={scope} onDialog={setOrganizationDialog} renderBot={bot => {
        const isSelected = bot.id === selectedId;
        const foldKey = JSON.stringify([scope, 'bot', bot.id]);
        const open = isSelected && (needle ? !(searchFolded.query === needle && searchFolded.bots[bot.id]) : !folded[foldKey]);
        const figure = figures.get(bot.id) ?? 'idle';
        const short = shortState(figure);
        return <div key={bot.id} className="bot-nav-group" data-open={open}>
          <BotMenu bot={bot} disabled={busy || organization.pending} onAction={action => onBotAction(bot, action)} onMove={organization.ready ? () => setOrganizationDialog({ kind: 'move', bot }) : undefined}>
            <button type="button" data-sidebar-row={`bot:${bot.id}`} aria-expanded={isSelected ? open : undefined}
              aria-label={isSelected ? t(open ? 'bot.sidebar.collapse' : 'bot.sidebar.expand', { name: bot.name }) : bot.name}
              className="bot-nav-row bot-nav-bot min-w-0 flex-1"
              onClick={() => {
                if (!isSelected) onSelectBot(bot.id);
                else if (needle) setSearchFolded(previous => ({ query: needle, bots: { ...(previous.query === needle ? previous.bots : {}), [bot.id]: open } }));
                else setFolded(foldKey, open);
              }}>
              <Icon name="arrow-down-s" className="bot-nav-chevron size-3 shrink-0" />
              <BotFigure bot={bot} state={figure} size={22} still />
              <span className="truncate">{bot.name}</span>
              {bot.pinnedAt ? <Icon name="pushpin" className="size-3 shrink-0 text-muted-foreground" /> : null}
              <span className={cn('ml-auto shrink-0 text-[11.5px] font-normal', short?.tone === 'warn' ? 'text-[var(--status-warning)]' : 'text-muted-foreground')}>
                {bot.deletion ? t(bot.deletion.error ? 'settings.bots.deleteFailed' : 'settings.bots.deleting') : short ? t(short.key) : ''}
              </span>
            </button>
          </BotMenu>
          {isSelected ? <div className="bot-nav-sessions" inert={!open}><div>
            {shownSessions === null ? <p role="status" className="py-2 pl-9 typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
            {shownSessions?.length === 0 && needle ? <p className="py-2 pl-9 typography-meta text-muted-foreground">{t('bot.session.noMatch')}</p> : null}
            {shownSessions?.filter(session => !session.thread.archived).map(renderSession)}
            {archivedSessions.length > 0 ? <Collapsible key={needle ? 'search-archive' : 'archive'} defaultOpen={Boolean(needle)}>
              <CollapsibleTrigger className="bot-nav-archive typography-meta justify-start gap-2 text-muted-foreground [&[data-panel-open]>svg:last-child]:rotate-90">
                <Icon name="archive" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t('bot.session.archivedList')}</span>
                <span className="tabular-nums">{archivedSessions.length}</span>
                <Icon name="arrow-right-s" className="size-3 shrink-0 transition-transform" />
              </CollapsibleTrigger>
              <CollapsibleContent>{archivedSessions.map(renderSession)}</CollapsibleContent>
            </Collapsible> : null}
          </div></div> : null}
        </div>;
      }} />
      {needle && !shownBots.length && <p role="status" className="px-2 py-3 typography-meta text-muted-foreground">{t('bot.groups.noMatch')}</p>}
      {bots && !bots.some(bot => bot.archived === showArchived) ? <p className="px-2 py-3 typography-meta text-muted-foreground">{t(showArchived ? 'settings.bots.archivedEmpty' : 'settings.bots.empty')}</p> : null}
    </div>
    </>}
    <div className="border-t border-border px-2.5 py-2">
      {conversationScope === 'bots' && <><button type="button" disabled={busy || !bots} onClick={onCreateBot} className={rowClass}>
        <Icon name="add" className="size-4 shrink-0" />{t('settings.bots.create')}
      </button>
      <button type="button" onClick={onToggleArchived} className={rowClass}>
        <Icon name={showArchived ? 'robot' : 'archive'} className="size-4 shrink-0" />{t(showArchived ? 'settings.bots.activeList' : 'settings.bots.archivedList')}
      </button></>}
      <button type="button" onClick={onOpenSettings} className={rowClass}>
        <Icon name="settings-3" className="size-4 shrink-0" />{t('sessions.sidebar.footer.actions.settings')}
      </button>
    </div>
    <BotOrganizationDialog value={organizationDialog} onClose={() => setOrganizationDialog(null)} organization={organization} />
  </nav>;
}
