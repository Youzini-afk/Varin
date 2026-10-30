import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SwapText } from '@/components/motion/SwapText';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useMainColumnGlide } from '@/components/layout/railMotion';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { IconName } from '@/components/icon/icons';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { documentMotionLevel } from '@/lib/motion/preference';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { BOT_PANEL_TABS, BOT_PANEL_WIDTH, clampBotPanelWidth, dampBotPanelWidth, useBotLayout, type BotPanelTab } from './botLayout';
import { BotPanelContext, useBotPanel, type BotPanelModel } from './botPanelModel';
import { BotFigure } from './BotFigure';
import { useSegmentKnob } from './segmentKnob';
import { stateIcon } from './botPresentation';
import { BotOverviewPane } from './BotOverviewPane';
import { BotActivityPane } from './BotActivityPane';
import { BotMemoryPane } from './BotMemoryPane';
import { BotSchedulePane } from './BotSchedulePane';
import { BotProfilePage, type BotProfileGuard } from './BotProfilePage';

const TAB_LABEL: Record<BotPanelTab, I18nKey> = { overview: 'bot.tab.overview', activity: 'bot.tab.activity', memory: 'bot.tab.memory', schedule: 'bot.tab.schedule' };
const TAB_ICON: Record<BotPanelTab, IconName> = { overview: 'list-unordered', activity: 'history', memory: 'bot-memory', schedule: 'calendar-schedule' };
const PANE: Record<BotPanelTab, React.FC> = { overview: BotOverviewPane, activity: BotActivityPane, memory: BotMemoryPane, schedule: BotSchedulePane };
const EXIT_MS = 110;

const openBotSettings = () => {
  useUIStore.getState().setSettingsPage('harness-bots');
  useUIStore.getState().setSettingsDialogOpen(true);
};

/** Bot area: figure, name and one state line. It only changes with the Bot (§5.1). */
function BotStage() {
  const { t } = useI18n();
  const model = useBotPanel();
  const { bot, line } = model;
  const state = bot.activity?.state ?? 'awake';
  const resting = state !== 'awake' && state !== 'sleep-failed';
  const transitioning = state === 'sleeping' || state === 'waking';
  const text = t(line.key, line.params);
  const mark = stateIcon(line);
  return <div className="bot-stage">
    <span className="bot-stage-floor" aria-hidden="true" />
    <div className="bot-stage-menu">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground" aria-label={`${bot.name} · ${t('settings.bots.actions')}`}>
            <Icon name="more" className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <DropdownMenuItem onSelect={model.openProfile}><Icon name="user" className="size-4" />{t('bot.profile.title')}</DropdownMenuItem>
          <DropdownMenuItem disabled={model.readOnly || model.busy} onSelect={model.newSession}><Icon name="chat-new" className="size-4" />{t('bot.session.new')}</DropdownMenuItem>
          {!bot.archived && !bot.deletion ? <DropdownMenuItem disabled={transitioning || model.busy} onSelect={() => model.changeState(state === 'sleep-failed' || state === 'wake-failed' ? 'retry' : resting ? 'wake' : 'sleep')}>
            <Icon name={resting ? 'play' : 'moon'} className="size-4" />{t(state === 'sleep-failed' ? 'settings.bots.sleepRetry' : resting ? 'settings.bots.wake' : 'settings.bots.sleep')}
          </DropdownMenuItem> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openBotSettings}><Icon name="settings-3" className="size-4" />{t('bot.sidebar.settings')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <div className="bot-stage-figure">
      <BotFigure key={bot.id} className="bot-figure-arrive" state={model.figure} size={112} label={bot.name} />
      <button type="button" className="bot-stage-edit" aria-label={t('bot.stage.editProfile')} title={t('bot.stage.editProfile')} onClick={model.openProfile}>
        <Icon name="pencil" className="size-4" />
      </button>
    </div>
    <div className="bot-stage-text">
      <button type="button" className="bot-stage-name truncate" onClick={model.openProfile}><SwapText text={bot.name} hold={0} /></button>
      <div className="bot-stage-state" data-tone={line.tone === 'warn' ? 'warn' : undefined}>
        <span className="bot-stage-state-mark" aria-hidden="true"><Icon name={mark.icon} className={cn('size-2.5', mark.spin && 'animate-spin')} /></span>
        <SwapText text={text} className="min-w-0" />
        {line.wake ? <button type="button" className="bot-stage-wake" disabled={model.busy} onClick={() => model.changeState(state === 'wake-failed' ? 'retry' : 'wake')}>{t('settings.bots.wake')}</button> : null}
      </div>
      {/* Only meaningful changes are announced: needs you, a result, offline. */}
      <span className="sr-only" aria-live="polite">{line.announce ? text : ''}</span>
    </div>
  </div>;
}

/** Stage, tabs and tab content; the desktop frame and the mobile drawer both host this. */
export function BotPanelBody({ model }: { model: BotPanelModel }) {
  return <BotPanelContext.Provider value={model}><BotPanelContent /></BotPanelContext.Provider>;
}

function BotPanelContent() {
  const { t } = useI18n();
  const model = useBotPanel();
  const tab = useBotLayout(state => state.tab);
  const setTab = useBotLayout(state => state.setTab);
  const seen = useBotLayout(state => state.seen[model.bot.id]);
  const markSeen = useBotLayout(state => state.markSeen);
  const knob = React.useRef<HTMLSpanElement>(null);
  const tabRow = React.useRef<HTMLDivElement>(null);
  const panes = React.useRef<HTMLDivElement>(null);
  const [entered, setEntered] = React.useState<{ tab: BotPanelTab; direction: 1 | -1 } | null>(null);
  const previousTab = React.useRef(tab);
  const profileGuard = React.useRef<BotProfileGuard>({ dirty: false, saving: false });
  const [profileLeaving, setProfileLeaving] = React.useState(false);
  const [profileShown, setProfileShown] = React.useState(model.profileOpen);

  useSegmentKnob(tabRow, knob, '[role="tab"][aria-selected="true"]', model.profileOpen ? '' : tab);

  // The old pane leaves as a still copy of what was on screen, so it is not mounted (and read) again.
  const paneNode = React.useRef<HTMLDivElement | null>(null);
  const departing = React.useRef<HTMLElement | null>(null);
  const bindPane = React.useCallback((node: HTMLDivElement | null) => {
    if (node) { paneNode.current = node; return; }
    const old = paneNode.current;
    paneNode.current = null;
    if (!old || documentMotionLevel() === 'off') return;
    const copy = old.cloneNode(true) as HTMLElement;
    copy.dataset.scrollTop = String(old.scrollTop);
    departing.current = copy;
  }, []);
  React.useLayoutEffect(() => {
    const before = previousTab.current;
    previousTab.current = tab;
    if (before === tab) return undefined;
    const direction = BOT_PANEL_TABS.indexOf(tab) >= BOT_PANEL_TABS.indexOf(before) ? 1 : -1;
    setEntered({ tab, direction });
    const copy = departing.current;
    departing.current = null;
    const host = panes.current;
    if (!copy || !host) return undefined;
    copy.removeAttribute('id'); copy.removeAttribute('role'); copy.removeAttribute('data-enter');
    copy.setAttribute('data-leaving', ''); copy.setAttribute('aria-hidden', 'true'); copy.setAttribute('inert', '');
    copy.style.setProperty('--bot-pane-direction', String(direction));
    host.prepend(copy);
    copy.scrollTop = Number(copy.dataset.scrollTop) || 0;
    const timer = setTimeout(() => copy.remove(), EXIT_MS);
    return () => { clearTimeout(timer); copy.remove(); };
  }, [tab]);

  React.useEffect(() => {
    if (model.profileOpen) { setProfileShown(true); setProfileLeaving(false); return undefined; }
    if (!profileShown) return undefined;
    setProfileLeaving(true);
    const timer = setTimeout(() => { setProfileShown(false); setProfileLeaving(false); }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [model.profileOpen, profileShown]);

  const needsSignature = model.needs.map(need => need.key).join('|');
  const latestActivity = model.timeline[0]?.atMs ?? 0;
  React.useEffect(() => {
    if (tab === 'overview' && !model.profileOpen) markSeen(model.bot.id, { needs: needsSignature });
    if (tab === 'activity' && !model.profileOpen) markSeen(model.bot.id, { activityAtMs: latestActivity });
  }, [tab, model.profileOpen, model.bot.id, needsSignature, latestActivity, markSeen]);
  const dots: Partial<Record<BotPanelTab, 'warn' | 'info'>> = {
    ...(needsSignature && seen?.needs !== needsSignature && tab !== 'overview' ? { overview: 'warn' as const } : {}),
    ...(latestActivity > (seen?.activityAtMs ?? 0) && tab !== 'activity' && seen?.activityAtMs !== undefined ? { activity: 'info' as const } : {}),
  };

  const choose = (next: BotPanelTab) => {
    if (model.profileOpen) {
      if (profileGuard.current.saving || (profileGuard.current.dirty && !window.confirm(t('settings.bots.discardConfirm')))) return;
      model.closeProfile();
    }
    setTab(next);
  };
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = BOT_PANEL_TABS.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? BOT_PANEL_TABS.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + BOT_PANEL_TABS.length) % BOT_PANEL_TABS.length;
    choose(BOT_PANEL_TABS[next]!);
    tabRow.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const closeProfile = model.closeProfile;
  const guardedModel = React.useMemo<BotPanelModel>(() => ({
    ...model,
    closeProfile: () => {
      if (profileGuard.current.saving || (profileGuard.current.dirty && !window.confirm(t('settings.bots.discardConfirm')))) return;
      closeProfile();
    },
  }), [model, closeProfile, t]);

  const Pane = PANE[tab];
  return <BotPanelContext.Provider value={guardedModel}>
    <div className="bot-panel-body" aria-label={t('bot.panel.aria')} role="complementary">
      <BotStage />
      <div className="bot-tabs-frame">
        <div ref={tabRow} className="bot-tabs" role="tablist" aria-label={t('bot.panel.aria')} onKeyDown={onTabKey}>
          <span ref={knob} className="bot-tabs-knob" aria-hidden="true" data-hidden="" />
          {BOT_PANEL_TABS.map(id => <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button type="button" role="tab" id={`bot-tab-${id}`} aria-controls={`bot-pane-${id}`} aria-label={t(TAB_LABEL[id])}
                aria-selected={!model.profileOpen && tab === id} tabIndex={tab === id ? 0 : -1} className="bot-tab" onClick={() => choose(id)}>
                <Icon name={TAB_ICON[id]} className="size-[18px]" />
                {dots[id] ? <span className="bot-dot" data-arrive="" data-tone={dots[id] === 'warn' ? 'warn' : undefined} aria-label={t(dots[id] === 'warn' ? 'bot.panel.needsYou' : 'bot.tab.newActivity')} /> : null}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t(TAB_LABEL[id])}</TooltipContent>
          </Tooltip>)}
        </div>
      </div>
      <div ref={panes} className="bot-panes">
        <div key={tab} ref={bindPane} id={`bot-pane-${tab}`} role="tabpanel" aria-labelledby={`bot-tab-${tab}`} className="bot-pane"
          data-enter={entered?.tab === tab ? '' : undefined} style={{ ['--bot-pane-direction' as string]: entered?.tab === tab ? entered.direction : 1 }}>
          <Pane />
        </div>
        {profileShown ? <BotProfilePage leaving={profileLeaving} guard={profileGuard} /> : null}
      </div>
    </div>
  </BotPanelContext.Provider>;
}

/**
 * The docked right panel (§5.9). Its width glides with the conversation beside it; dragging follows
 * the pointer 1:1 with resistance past the range, releasing below 240px closes it, a double click
 * restores 360px, and the handle takes arrow keys and Enter.
 */
export function BotPanel({ model, open, floating, onOpenChange }: {
  model: BotPanelModel | null;
  open: boolean;
  /** Narrow windows: a card over the conversation instead of a docked column (§8). */
  floating: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const width = useBotLayout(state => state.panelWidth);
  const setWidth = useBotLayout(state => state.setPanelWidth);
  const panel = React.useRef<HTMLElement | null>(null);
  const [drag, setDrag] = React.useState<number | null>(null);
  const shown = drag ?? width;
  useMainColumnGlide(panel, open, !floating && drag === null, width);
  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!open || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    let raw = startWidth;
    let frame = 0;
    document.documentElement.style.cursor = 'col-resize';
    const move = (next: PointerEvent) => {
      raw = startWidth + (startX - next.clientX);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setDrag(dampBotPanelWidth(raw)); });
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      if (frame) cancelAnimationFrame(frame);
      document.documentElement.style.cursor = '';
      // The release glides back to the range, or closes from where it was let go.
      if (raw < BOT_PANEL_WIDTH.collapse) { setDrag(null); onOpenChange(false); return; }
      setWidth(clampBotPanelWidth(raw));
      setDrag(null);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    setDrag(startWidth);
  };
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setWidth(width + (event.key === 'ArrowLeft' ? BOT_PANEL_WIDTH.step : -BOT_PANEL_WIDTH.step));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onOpenChange(!open);
    }
  };
  const style: React.CSSProperties = open
    ? { ['--varin-context-panel-width' as string]: `${shown}px`, width: 'min(var(--varin-context-panel-width), 100%)', maxWidth: '100%', overflowX: 'clip' }
    : { ['--varin-context-panel-width' as string]: `${shown}px`, width: 0, maxWidth: '100%', overflowX: 'clip' };
  return <aside ref={panel} className={cn('workbench-resource-canvas bot-panel relative flex h-full min-h-0 flex-shrink-0 flex-col overflow-hidden bg-background', !open && 'pointer-events-none')}
    data-open={open} data-resizing={drag !== null || undefined} data-floating={floating || undefined} inert={!open || undefined} style={style}
    onKeyDown={event => { if (event.key === 'Escape' && floating && open) onOpenChange(false); }}>
    {open ? <div aria-hidden="true" className="bot-panel-seam" /> : null}
    {open && !floating ? <div className="bot-panel-handle" role="separator" aria-orientation="vertical" aria-label={t('bot.panel.resize')} tabIndex={0}
      aria-valuenow={Math.round(shown)} aria-valuemin={BOT_PANEL_WIDTH.min} aria-valuemax={BOT_PANEL_WIDTH.max}
      onPointerDown={begin} onDoubleClick={() => setWidth(BOT_PANEL_WIDTH.initial)} onKeyDown={onKey} /> : null}
    <div className="relative z-10 flex h-full min-h-0 shrink-0 flex-col" style={{ width: 'var(--varin-context-panel-width)' }} aria-hidden={!open}>
      {model ? <BotPanelBody model={model} /> : null}
    </div>
  </aside>;
}
