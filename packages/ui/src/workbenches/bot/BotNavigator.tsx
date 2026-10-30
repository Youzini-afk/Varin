import React from 'react';
import type { BotSummary, ThreadIdentity } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkbenchProfileSwitcher } from '@/components/layout/WorkbenchProfileSwitcher';
import { BotMenu, type BotMenuAction } from '@/components/sections/bots/BotMenu';
import { useHoverPill, useSelectionGlide } from '@/components/conversation/sidebarHighlights';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BotFigure } from './BotFigure';
import { isWaitingStatus, liveRun, runStatus, shortState, type BotFigureState, type BotSessionView } from './botPresentation';

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
export function BotNavigator({ bots, selectedId, sessions, current, figures, busy, showArchived, isMobile, sessionTitle,
  onSelectBot, onSelectSession, onNewSession, onBotAction, onCreateBot, onToggleArchived, onRefresh, onOpenSettings }: {
  bots: BotSummary[] | null;
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
  onNewSession(): void;
  onBotAction(bot: BotSummary, action: BotMenuAction): void;
  onCreateBot(): void;
  onToggleArchived(): void;
  onRefresh(): void;
  onOpenSettings(): void;
}) {
  const { t } = useI18n();
  const list = React.useRef<HTMLDivElement>(null);
  const [query, setQuery] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  const [folded, setFolded] = React.useState<Record<string, boolean>>({});
  const selected = bots?.find(bot => bot.id === selectedId) ?? null;
  const canStart = Boolean(selected && !selected.archived && !selected.deletion && (selected.activity?.state ?? 'awake') === 'awake');
  const currentRow = current ? rowId(current) : null;
  useSelectionGlide(list, currentRow);
  useHoverPill(list);
  const needle = query.trim().toLocaleLowerCase();
  const shownSessions = sessions?.filter(session => !needle || sessionTitle(session).toLocaleLowerCase().includes(needle)) ?? null;
  const rowClass = 'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left typography-ui-label text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground disabled:opacity-50';

  return <nav className="flex h-full min-h-0 flex-col" aria-label={t('bot.sidebar.aria')}>
    <div className="flex items-center gap-1 px-2.5 pb-2 pt-3">
      {isMobile ? <div className="flex-1"><WorkbenchProfileSwitcher /></div> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn(!isMobile && 'flex-1')}>
            <button type="button" disabled={!canStart || busy} onClick={onNewSession}
              className="flex h-[34px] w-full items-center gap-2 rounded-[9px] px-2.5 text-[13.5px] text-foreground transition-colors hover:bg-interactive-hover disabled:opacity-50">
              <Icon name="chat-new" className="size-4 shrink-0" /><span className="truncate">{t('bot.session.new')}</span>
            </button>
          </span>
        </TooltipTrigger>
        {!canStart && selected ? <TooltipContent side="bottom">{t('bot.session.newNeedsAwake', { name: selected.name })}</TooltipContent> : null}
      </Tooltip>
      <Button variant="ghost" size="icon" className="size-[34px] shrink-0 text-muted-foreground" aria-label={t('bot.session.search')} aria-pressed={searching}
        onClick={() => { setSearching(value => !value); setQuery(''); }}>
        <Icon name="search" className="size-4" />
      </Button>
      <Button variant="ghost" size="icon" className="size-[34px] shrink-0 text-muted-foreground" disabled={busy} aria-label={t('tasksHub.refresh')} onClick={onRefresh}>
        <Icon name="refresh" className="size-4" />
      </Button>
    </div>
    {searching ? <div className="px-2.5 pb-2">
      <input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setSearching(false); setQuery(''); } }}
        placeholder={t('bot.session.search')} aria-label={t('bot.session.search')}
        className="h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]" />
    </div> : null}
    <div ref={list} className="bot-nav-list min-h-0 flex-1 overflow-y-auto px-2.5">
      {bots?.filter(bot => bot.archived === showArchived).map(bot => {
        const isSelected = bot.id === selectedId;
        const open = isSelected && !folded[bot.id];
        const figure = figures.get(bot.id) ?? 'idle';
        const short = shortState(figure);
        return <div key={bot.id} className="bot-nav-group" data-open={open}>
          <BotMenu bot={bot} disabled={busy} onAction={action => onBotAction(bot, action)}>
            <button type="button" data-sidebar-row={`bot:${bot.id}`} aria-expanded={isSelected ? open : undefined}
              aria-label={isSelected ? t(open ? 'bot.sidebar.collapse' : 'bot.sidebar.expand', { name: bot.name }) : bot.name}
              className="bot-nav-row bot-nav-bot min-w-0 flex-1"
              onClick={() => isSelected ? setFolded(state => ({ ...state, [bot.id]: open })) : onSelectBot(bot.id)}>
              <BotFigure state={figure} size={22} still />
              <span className="truncate">{bot.name}</span>
              {bot.pinnedAt ? <Icon name="pushpin" className="size-3 shrink-0 text-muted-foreground" /> : null}
              <span className={cn('ml-auto shrink-0 text-[11.5px] font-normal', short?.tone === 'warn' ? 'text-[var(--status-warning)]' : 'text-muted-foreground')}>
                {bot.deletion ? t(bot.deletion.error ? 'settings.bots.deleteFailed' : 'settings.bots.deleting') : short ? t(short.key) : ''}
              </span>
              <Icon name="arrow-down-s" className="bot-nav-chevron size-3.5 shrink-0" />
            </button>
          </BotMenu>
          {isSelected ? <div className="bot-nav-sessions"><div>
            {shownSessions === null ? <p role="status" className="py-2 pl-9 typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
            {shownSessions?.length === 0 && needle ? <p className="py-2 pl-9 typography-meta text-muted-foreground">{t('bot.session.noMatch')}</p> : null}
            {shownSessions?.map(session => {
              const main = session.identity;
              const mainCurrent = current?.threadId === main.threadId && current.branchId === main.branchId;
              return <React.Fragment key={main.threadId}>
                <button type="button" data-sidebar-row={rowId(main)} data-current={mainCurrent || undefined} aria-current={mainCurrent ? 'page' : undefined}
                  className="bot-nav-row bot-nav-session" disabled={busy && !mainCurrent} onClick={() => onSelectSession(main)}>
                  <span className="min-w-0 truncate">{sessionTitle(session)}</span>
                  <SessionMark waiting={session.waiting} running={session.running} unread={session.unread && !mainCurrent} />
                </button>
                {session.branches.map((branch, index) => {
                  const branchCurrent = current?.threadId === branch.threadId && current.branchId === branch.branchId;
                  const status = runStatus(liveRun(session.thread, branch.branchId, null));
                  return <button key={branch.branchId} type="button" data-sidebar-row={rowId(branch)} data-current={branchCurrent || undefined} data-branch=""
                    aria-current={branchCurrent ? 'page' : undefined} className="bot-nav-row bot-nav-session" disabled={busy && !branchCurrent} onClick={() => onSelectSession(branch)}>
                    <span className="min-w-0 truncate">{t('bot.session.branch', { index: index + 1 })}</span>
                    <SessionMark waiting={isWaitingStatus(status)} running={status !== null && !isWaitingStatus(status)} unread={false} />
                  </button>;
                })}
              </React.Fragment>;
            })}
          </div></div> : null}
        </div>;
      })}
      {bots && !bots.some(bot => bot.archived === showArchived) ? <p className="px-2 py-3 typography-meta text-muted-foreground">{t(showArchived ? 'settings.bots.archivedEmpty' : 'settings.bots.empty')}</p> : null}
    </div>
    <div className="border-t border-border px-2.5 py-2">
      <button type="button" disabled={busy || !bots} onClick={onCreateBot} className={rowClass}>
        <Icon name="add" className="size-4 shrink-0" />{t('settings.bots.create')}
      </button>
      <button type="button" onClick={onToggleArchived} className={rowClass}>
        <Icon name={showArchived ? 'robot' : 'archive'} className="size-4 shrink-0" />{t(showArchived ? 'settings.bots.activeList' : 'settings.bots.archivedList')}
      </button>
      <button type="button" onClick={onOpenSettings} className={rowClass}>
        <Icon name="settings-3" className="size-4 shrink-0" />{t('bot.sidebar.settings')}
      </button>
    </div>
  </nav>;
}
