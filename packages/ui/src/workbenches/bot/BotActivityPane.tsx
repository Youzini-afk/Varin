import React from 'react';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { getCurrentIntlLocale, useI18n, type I18nKey } from '@/lib/i18n';
import { useBotLayout } from './botLayout';
import { useBotPanel } from './botPanelModel';
import type { CalendarOccurrenceState } from '@varin/protocol';
import { clockTime, dayLabel, groupByDay, isWaitingStatus, type BotQuietInput, type BotTimelineEvent, type BotWorkStatus, type BotWorkView } from './botPresentation';
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
    <AgentAvatar identity={item.identity.threadId} avatar={item.avatar} size={24} {...(item.lead ? { role: 'lead' as const } : {})} />
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

const YOU_KEY: Record<Extract<BotTimelineEvent, { kind: 'you' }>['change'], I18nKey> = {
  user_input: 'bot.event.you',
  workspace_change: 'bot.event.youWorkspace',
  history_changed: 'bot.event.youHistory',
};
const SCHEDULE_NOTE: Partial<Record<CalendarOccurrenceState, I18nKey>> = {
  held: 'bot.event.scheduleHeld',
  failed: 'bot.event.scheduleFailed',
  cancelled: 'bot.event.scheduleCancelled',
};

function QuietLine({ inputs }: { inputs: readonly BotQuietInput[] }) {
  const { t } = useI18n();
  const [only] = inputs;
  if (!only) return <>{t('bot.event.quietRound')}</>;
  if (inputs.length === 1) return only.kind === 'report' && only.name ? <Named id="bot.event.quietOneReport" name={only.name} /> : <>{t('bot.event.quietOne')}</>;
  return <>{t(inputs.every(input => input.kind === 'report') ? 'bot.event.quietReports' : 'bot.event.quietMixed', { count: inputs.length })}</>;
}

function QuietInputRow({ input }: { input: BotQuietInput }) {
  const { t } = useI18n();
  const model = useBotPanel();
  const label = input.kind === 'report' && input.name ? <Named id="bot.event.quietReport" name={input.name} />
    : input.kind === 'change' && input.name ? <Named id="bot.event.quietChange" name={input.name} />
      : t(input.kind === 'schedule' ? 'bot.event.quietSchedule' : 'bot.event.quietOther');
  const open = input.target ? () => model.openWork(input.target!) : input.kind === 'schedule' ? () => model.focusTab('schedule') : null;
  return <li>{open ? <button type="button" className="bot-event-input" onClick={open}>{label}</button> : <span className="bot-event-input">{label}</span>}</li>;
}

/** A round that ended without a reply: a disclosure listing what it handled (§5.4). */
function QuietRow({ event, showSession, locale }: { event: Extract<BotTimelineEvent, { kind: 'quiet' }>; showSession: boolean; locale: string }) {
  const model = useBotPanel();
  const [open, setOpen] = React.useState(false);
  const listed = event.inputs.length > 1 || (event.inputs.length === 1 && event.inputs[0]!.kind !== 'report');
  const text = <span className="bot-event-text">
    <span><QuietLine inputs={event.inputs} />{listed ? <Icon name="arrow-right-s" className="bot-event-caret size-3.5" /> : null}</span>
    {showSession && event.sessionThreadId ? <span className="bot-event-sub">{model.sessionTitle(event.sessionThreadId)}</span> : null}
  </span>;
  const time = <span className="bot-event-time">{event.atMs === null ? '' : clockTime(event.atMs, locale)}</span>;
  if (!listed) {
    const only = event.inputs[0];
    return <button type="button" className="bot-event" data-kind="quiet" onClick={() => only?.target ? model.openWork(only.target) : model.openSession(event.session)}>{time}{text}</button>;
  }
  return <div className="bot-event-group" data-open={open || undefined}>
    <button type="button" className="bot-event" data-kind="quiet" aria-expanded={open} onClick={() => setOpen(value => !value)}>{time}{text}</button>
    {open ? <ul className="bot-event-inputs">{event.inputs.map((input, index) => <QuietInputRow key={index} input={input} />)}</ul> : null}
  </div>;
}

function EventRow({ event, showSession, locale }: { event: BotTimelineEvent; showSession: boolean; locale: string }) {
  const model = useBotPanel();
  const { t } = useI18n();
  if (event.kind === 'quiet') return <QuietRow event={event} showSession={showSession} locale={locale} />;
  const open = () => {
    if (event.kind === 'dispatch' || event.kind === 'you') model.openWork(event.target);
    else if (event.kind === 'report') model.openSession(event.session);
    else if (event.kind === 'schedule') model.focusTab('schedule');
    else model.focusTab('memory', String(event.memoryId));
  };
  const reportKey: I18nKey | null = event.kind !== 'report' ? null : event.outcome === 'succeeded' ? 'bot.event.reportSucceeded'
    : event.outcome === 'failed' ? 'bot.event.reportFailed' : event.outcome === 'cancelled' ? 'bot.event.reportCancelled' : 'bot.event.reportUnknown';
  const note = event.kind === 'schedule' ? SCHEDULE_NOTE[event.state] : undefined;
  const warn = (event.kind === 'report' && event.outcome !== 'succeeded') || (event.kind === 'schedule' && event.state === 'failed');
  return <button type="button" className="bot-event" data-kind={event.kind} data-tone={warn ? 'warn' : undefined} onClick={open}>
    <span className="bot-event-time">{event.atMs === null ? '' : clockTime(event.atMs, locale)}</span>
    <span className="bot-event-text">
      {event.kind === 'dispatch' ? <Named id="bot.event.dispatch" name={event.name} />
        : event.kind === 'report' ? <Named id={reportKey!} name={event.name} />
          : event.kind === 'you' ? <Named id={YOU_KEY[event.change]} name={event.name} />
            : event.kind === 'schedule' ? <Named id="bot.event.schedule" name={event.name} />
              : <MemoryEvent content={event.content} />}
      {event.kind === 'dispatch' && event.task ? <span className="bot-event-sub line-clamp-2">{event.task}</span> : null}
      {note ? <span className="bot-event-sub">{t(note)}</span> : null}
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
  const activity = model.facts.activity;
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
    {activity.status === 'failed' ? <div role="alert" className="mx-2 my-2 flex gap-2 typography-meta text-destructive">
      <span className="min-w-0 flex-1 break-words">{activity.error}</span>
      <button type="button" className="shrink-0 text-foreground hover:underline" onClick={model.facts.retryActivity}>{t('settings.harness.retry')}</button>
    </div> : null}
    {groupByDay(events).map(group => {
      const label = group.day === null ? { key: 'bot.activity.undated' as const } : dayLabel(group.day, now, locale);
      return <section key={group.day ?? 'undated'} aria-label={'key' in label ? t(label.key) : label.text}>
        <p className="bot-section-label">{'key' in label ? t(label.key) : label.text}</p>
        <div className="bot-timeline">{group.events.map(event => <EventRow key={event.id} event={event} showSession={showSession} locale={locale} />)}</div>
      </section>;
    })}
    {activity.value?.before != null ? <div className="flex flex-col items-center gap-1 px-4 py-3">
      <button type="button" className="text-[12.5px] text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={model.facts.earlier.loading} onClick={model.facts.loadEarlier}>
        {model.facts.earlier.loading ? t('common.loading') : t('bot.activity.earlier')}
      </button>
      {model.facts.earlier.error ? <span role="alert" className="typography-meta text-destructive">{model.facts.earlier.error}</span> : null}
    </div> : null}
    {!events.length && !running.length && activity.status === 'ready' && activity.value.before === null ? <p className="px-4 py-7 text-center text-[13px] text-muted-foreground">{t('bot.activity.empty')}</p> : null}
    {!events.length && activity.status === 'loading' ? <p role="status" className="px-4 py-7 text-center typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
  </>;
}
