import React from 'react';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import { useBotLayout } from './botLayout';
import { useBotPanel } from './botPanelModel';
import { clockTime, dayLabel, groupByDay, isWaitingStatus, type BotTimelineEvent, type BotWorkStatus, type BotWorkView } from './botPresentation';
import { BotSegment, Named } from './botParts';
import { useFlash, useScrollIntoFocus } from './botFocus';

const STATUS_LABEL: Record<BotWorkStatus, I18nKey> = {
  'waiting-permission': 'bot.work.waitingPermission',
  'waiting-question': 'bot.work.waitingQuestion',
  running: 'bot.work.running',
  preparing: 'bot.work.preparing',
  queued: 'bot.work.queued',
  paused: 'bot.work.paused',
  stopping: 'bot.work.stopping',
};

export function BotWorkStatusLabel({ status }: { status: BotWorkStatus }) {
  const { t } = useI18n();
  const waiting = isWaitingStatus(status);
  return <span data-tone={waiting ? 'warn' : undefined} className="inline-flex items-center gap-1.5">
    {status === 'running' || status === 'preparing' ? <span className="bot-ring" aria-hidden="true" /> : null}
    {waiting ? <Icon name={status === 'waiting-permission' ? 'shield-check' : 'question'} className="size-3.5" /> : status === 'paused' ? <Icon name="pause" className="size-3.5" /> : null}
    {t(STATUS_LABEL[status])}
  </span>;
}

function WorkRow({ item, showSession }: { item: BotWorkView; showSession: boolean }) {
  const { t } = useI18n();
  const model = useBotPanel();
  const focused = model.focus?.tab === 'activity' && model.focus.id === item.key;
  const flash = useFlash(focused, model.focus?.token);
  const ref = React.useRef<HTMLButtonElement>(null);
  useScrollIntoFocus(ref, focused, model.focus?.token);
  return <button ref={ref} type="button" className={`bot-row min-h-12 ${flash ?? ''}`} onClick={() => model.openWork(item.identity, { tab: 'activity', id: item.key })}>
    <AgentAvatar identity={item.identity.threadId} avatar={item.avatar} size={24} />
    <span className="flex min-w-0 flex-col leading-snug">
      <b className="truncate text-[13.5px] font-semibold">{item.name}</b>
      <span className="truncate text-[12.5px] text-muted-foreground">{item.task || item.identity.threadId}{showSession && item.sessionThreadId ? <i className="not-italic opacity-75"> · {model.sessionTitle(item.sessionThreadId)}</i> : null}</span>
    </span>
    <span className="bot-row-status">
      <span data-now="">{item.status ? <BotWorkStatusLabel status={item.status} /> : null}</span>
      <span data-go="">{t('bot.work.openInWorkbench')}<Icon name="external-link" className="size-3" /></span>
    </span>
  </button>;
}

function EventRow({ event, showSession, locale }: { event: BotTimelineEvent; showSession: boolean; locale: string }) {
  const model = useBotPanel();
  const open = () => {
    if (event.kind === 'dispatch' || event.kind === 'you') model.openWork(event.target);
    else if (event.kind === 'report') model.openSession(event.session);
    else model.focusTab('memory', String(event.memoryId));
  };
  const reportKey: I18nKey | null = event.kind !== 'report' ? null : event.outcome === 'succeeded' ? 'bot.event.reportSucceeded'
    : event.outcome === 'failed' ? 'bot.event.reportFailed' : event.outcome === 'cancelled' ? 'bot.event.reportCancelled' : 'bot.event.reportUnknown';
  return <button type="button" className="bot-event" data-kind={event.kind} data-tone={event.kind === 'report' && event.outcome !== 'succeeded' ? 'warn' : undefined} onClick={open}>
    <span className="bot-event-time">{clockTime(event.atMs, locale)}</span>
    <span className="bot-event-text">
      {event.kind === 'dispatch' ? <Named id="bot.event.dispatch" name={event.name} />
        : event.kind === 'report' ? <Named id={reportKey!} name={event.name} />
          : event.kind === 'you' ? <Named id="bot.event.you" name={event.name} />
            : <MemoryEvent content={event.content} />}
      {event.kind === 'dispatch' && event.task ? <span className="bot-event-sub line-clamp-2">{event.task}</span> : null}
      {showSession && event.sessionThreadId ? <span className="bot-event-sub">{model.sessionTitle(event.sessionThreadId)}</span> : null}
    </span>
  </button>;
}

function MemoryEvent({ content }: { content: string }) {
  const { t } = useI18n();
  return <>{t('bot.event.memory')} · <span className="text-foreground">{content.length > 80 ? `${content.slice(0, 80)}…` : content}</span></>;
}

/** The whole picture of the work: matters followed, what is running and what happened (§5.4). */
export function BotActivityPane() {
  const { t } = useI18n();
  const model = useBotPanel();
  const scope = useBotLayout(state => state.activityScope);
  const setScope = useBotLayout(state => state.setActivityScope);
  const locale = getCurrentIntlLocale();
  const sessionId = model.session?.identity.threadId ?? null;
  const inScope = (id: string | null) => scope === 'all' || (sessionId !== null && id === sessionId);
  const running = model.work.filter(item => item.status !== null && inScope(item.sessionThreadId));
  const events = model.timeline.filter(event => event.kind === 'memory' ? scope === 'all' : inScope(event.sessionThreadId));
  const matters = model.matters?.filter(matter => !matter.archived) ?? [];
  const showSession = scope === 'all' && model.sessions.length > 1;
  const now = Date.now();
  return <>
    <div className="bot-pane-bar">
      <BotSegment label={t('bot.tab.activity')} value={scope} onChange={setScope}
        options={[{ value: 'all', label: t('bot.activity.scopeAll') }, { value: 'session', label: t('bot.activity.scopeSession') }]} />
    </div>
    {scope === 'all' && matters.length ? <section aria-label={t('bot.matters.title')}>
      <p className="bot-section-label">{t('bot.matters.title')}</p>
      {matters.map(matter => <Collapsible key={matter.id}>
        <CollapsibleTrigger className="bot-row justify-start text-[13px] [&[data-panel-open]>svg]:rotate-90"><Icon name="arrow-right-s" className="size-3.5 shrink-0" /><span className="min-w-0 break-words">{matter.title}</span></CollapsibleTrigger>
        <CollapsibleContent><div className="space-y-2 pb-3 pl-9 pr-3">
          <p className="whitespace-pre-wrap break-words text-[12.5px] text-muted-foreground">{matter.description}</p>
          {matter.threads.map(link => {
            const item = model.work.find(work => work.identity.threadId === link.threadId && work.identity.branchId === link.branchId);
            return item ? <button key={link.branchId} type="button" className="block max-w-full truncate text-[12.5px] text-primary hover:underline" onClick={() => model.openWork(item.identity)}>{item.name}</button> : null;
          })}
          <button type="button" disabled={model.readOnly || model.busy} className="text-[12.5px] text-muted-foreground hover:text-foreground disabled:opacity-50" onClick={() => model.archiveMatter(matter)}>{t('bot.matters.archive')}</button>
        </div></CollapsibleContent>
      </Collapsible>)}
    </section> : null}
    {running.length ? <section aria-label={t('bot.activity.running')}>
      <p className="bot-section-label">{t('bot.activity.running')}</p>
      {running.map(item => <WorkRow key={item.key} item={item} showSession={showSession} />)}
    </section> : null}
    {model.facts.feeds.status === 'failed' ? <div role="alert" className="mx-2 my-2 flex gap-2 typography-meta text-destructive">
      <span className="min-w-0 flex-1 break-words">{model.facts.feeds.error}</span>
      <button type="button" className="shrink-0 text-foreground hover:underline" onClick={model.facts.retryFeeds}>{t('settings.harness.retry')}</button>
    </div> : null}
    {groupByDay(events).map(group => {
      const label = dayLabel(group.day, now, locale);
      return <section key={group.day} aria-label={'key' in label ? t(label.key) : label.text}>
        <p className="bot-section-label">{'key' in label ? t(label.key) : label.text}</p>
        <div className="bot-timeline">{group.events.map(event => <EventRow key={event.id} event={event} showSession={showSession} locale={locale} />)}</div>
      </section>;
    })}
    {!events.length && !running.length && model.facts.feeds.status === 'ready' ? <p className="px-4 py-7 text-center text-[13px] text-muted-foreground">{t('bot.activity.empty')}</p> : null}
    {!events.length && model.facts.feeds.status === 'loading' ? <p role="status" className="px-4 py-7 text-center typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
  </>;
}
