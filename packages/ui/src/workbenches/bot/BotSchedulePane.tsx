import React from 'react';
import type { ScheduledTask } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { formatSchedule } from '@/components/session/scheduleFormat';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useBotPanel } from './botPanelModel';
import { clockTime, dayLabel } from './botPresentation';
import { useFlash, useScrollIntoFocus } from './botFocus';

const openScheduleEditor = () => useUIStore.getState().setScheduledTasksDialogOpen(true);

function ScheduleRow({ task, open, onToggle, locale, rule }: { task: ScheduledTask; open: boolean; onToggle(): void; locale: string; rule: boolean }) {
  const { t } = useI18n();
  const model = useBotPanel();
  const definition = task.calendar?.definition;
  const next = definition?.next_at_ms ?? null;
  const focused = !rule && model.focus?.tab === 'schedule' && model.focus.id === task.id;
  const flash = useFlash(focused, model.focus?.token);
  const ref = React.useRef<HTMLDivElement>(null);
  useScrollIntoFocus(ref, focused, model.focus?.token);
  const target = definition?.target ?? task.target;
  const targetLabel = target.kind === 'existing_work'
    ? (model.sessions.some(session => session.identity.threadId === target.threadId) ? model.sessionTitle(target.threadId) : target.threadId)
    : t('bot.schedule.newWork');
  const whenLabel = next ? clockTime(next, locale) : '--:--';
  const dateLabel = next === null ? null : dayLabel(new Date(next).setHours(0, 0, 0, 0), Date.now(), locale);
  const dateText = dateLabel === null ? '' : 'key' in dateLabel ? t(dateLabel.key) : new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(next!);
  const nextNote = definition?.calculation_failure ? t('bot.schedule.calculationFailed')
    : definition?.calculation_pending ? t('bot.schedule.calculating') : !next ? t('bot.schedule.noNext') : null;
  return <div ref={ref} className={`bot-schedule ${flash ?? ''}`} data-open={open} data-paused={!task.enabled || undefined}>
    <button type="button" className="flex w-full items-start gap-3 px-3 py-[11px] text-left" aria-expanded={open} onClick={onToggle}>
      {rule ? <span className="bot-schedule-when items-center pt-0.5 text-muted-foreground"><Icon name="history" className="size-4" /></span>
        : <span className="bot-schedule-when"><b>{whenLabel}</b><span className="text-[11.5px] text-muted-foreground">{dateText}</span></span>}
      <span className="flex min-w-0 flex-col leading-normal">
        <span className="flex min-w-0 items-center gap-1.5"><b className="bot-schedule-name truncate text-[13.5px] font-medium">{task.name}</b>{!task.enabled ? <span className="bot-tag shrink-0">{t('bot.schedule.paused')}</span> : null}</span>
        <span className="truncate text-[12.5px] text-muted-foreground">{rule ? formatSchedule(task, t) : nextNote ?? targetLabel}</span>
      </span>
    </button>
    <div className="bot-fold" data-open={open}><div>
      <dl className="bot-schedule-detail">
        <dt>{t('bot.schedule.rule')}</dt><dd>{formatSchedule(task, t)}</dd>
        <dt>{t('bot.schedule.target')}</dt><dd>{targetLabel}</dd>
        <dt>{t('bot.schedule.missed')}</dt><dd>{(definition?.missed_policy ?? task.missedPolicy) === 'coalesce_once' ? t('bot.schedule.missedOnce') : t('bot.schedule.missedSkip')}</dd>
        {task.loopError ? <dd className="col-span-2 text-destructive">{task.loopError}</dd> : null}
        <dd className="col-span-2 flex gap-1.5 pt-1.5">
          <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-foreground shadow-[inset_0_0_0_1px_var(--interactive-border)] hover:bg-[var(--interactive-hover)]" onClick={openScheduleEditor}>
            <Icon name="edit" className="size-3.5" />{t('bot.schedule.edit')}
          </button>
        </dd>
      </dl>
    </div></div>
  </div>;
}

/** What comes next and what repeats. Editing stays in the Calendar dialog (§5.6). */
export function BotSchedulePane() {
  const { t } = useI18n();
  const model = useBotPanel();
  const locale = getCurrentIntlLocale();
  const [openId, setOpenId] = React.useState<string | null>(null);
  React.useEffect(() => { if (model.focus?.tab === 'schedule') setOpenId(model.focus.id); }, [model.focus]);
  const read = model.facts.tasks;
  const tasks = read.value ?? [];
  const upcoming = tasks.filter(task => task.enabled && task.calendar?.definition.next_at_ms)
    .sort((a, b) => (a.calendar!.definition.next_at_ms ?? 0) - (b.calendar!.definition.next_at_ms ?? 0));
  // Repeating rules, paused ones included; a once-only task that is no longer coming up stays visible here too.
  const rules = tasks.filter(task => task.schedule.kind !== 'once' || !upcoming.includes(task));
  const row = (task: ScheduledTask, rule: boolean) => {
    const key = rule ? `rule:${task.id}` : task.id;
    return <ScheduleRow key={key} task={task} locale={locale} rule={rule} open={openId === key} onToggle={() => setOpenId(current => current === key ? null : key)} />;
  };
  return <>
    {read.status === 'failed' ? <div role="alert" className="mx-2 my-2 flex gap-2 typography-meta text-destructive">
      <span className="min-w-0 flex-1 break-words">{read.error}</span>
      <button type="button" className="shrink-0 text-foreground hover:underline" onClick={model.facts.retryTasks}>{t('settings.harness.retry')}</button>
    </div> : null}
    {read.status === 'loading' && !read.value ? <p role="status" className="px-4 py-6 text-center typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {upcoming.length ? <section aria-label={t('bot.schedule.upcoming')}><p className="bot-section-label">{t('bot.schedule.upcoming')}</p>{upcoming.map(task => row(task, false))}</section> : null}
    {rules.length ? <section aria-label={t('bot.schedule.rules')}><p className="bot-section-label">{t('bot.schedule.rules')}</p>{rules.map(task => row(task, true))}</section> : null}
    {read.status === 'ready' && !tasks.length ? <p className="px-4 py-7 text-center text-[13px] leading-loose text-muted-foreground">{t('bot.schedule.empty')}</p> : null}
    <button type="button" className="mx-1 mt-3 flex h-9 w-[calc(100%-8px)] items-center justify-center gap-2 rounded-[10px] text-[13px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--interactive-border)] transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground" onClick={openScheduleEditor}>
      <Icon name="add" className="size-3.5" />{t('bot.schedule.new')}
    </button>
  </>;
}
