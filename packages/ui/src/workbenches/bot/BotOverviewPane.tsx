import React from 'react';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { useBotPanel } from './botPanelModel';
import { clockTime, latestReport, isWaitingStatus, scheduleWhen, type BotNeed } from './botPresentation';
import { Named } from './botParts';
import { useFlash } from './botFocus';

const MAX_NEEDS = 3;

function NeedCard({ need }: { need: BotNeed }) {
  const { t } = useI18n();
  const model = useBotPanel();
  const flash = useFlash(model.focus?.tab === 'overview' && model.focus.id === need.key, model.focus?.token);
  return <button type="button" className={`bot-need ${flash ?? ''}`} onClick={() => model.openNeed(need)}>
    <AgentAvatar identity={need.identity.threadId} avatar={need.avatar} size={26} />
    <span className="flex min-w-0 flex-col leading-snug">
      <b className="truncate text-[13.5px] font-semibold">{need.name}</b>
      <span className="bot-need-detail truncate text-[12.5px]">{t(need.kind === 'permission' ? 'bot.overview.needPermission' : 'bot.overview.needQuestion')}</span>
    </span>
    <span className="bot-need-detail ml-auto flex shrink-0 items-center gap-1 text-[12.5px]">{t('bot.overview.handle')}<Icon name={need.session ? 'arrow-right-s' : 'external-link'} className="size-3.5" /></span>
  </button>;
}

/** One sentence per block; any block opens its tab and lights the matching row (§5.3). */
export function BotOverviewPane() {
  const { t } = useI18n();
  const model = useBotPanel();
  const locale = getCurrentIntlLocale();
  const running = model.work.filter(item => item.status !== null && !isWaitingStatus(item.status));
  const report = latestReport(model.timeline);
  const memory = model.facts.memory.value?.filter(item => !item.inactive).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  const next = model.facts.tasks.value?.filter(task => task.enabled && task.calendar?.definition.next_at_ms)
    .sort((a, b) => (a.calendar!.definition.next_at_ms ?? 0) - (b.calendar!.definition.next_at_ms ?? 0))[0] ?? null;
  const loading = model.facts.feeds.status === 'loading' && model.facts.memory.status === 'loading' && model.facts.tasks.status === 'loading';
  const failures = [model.facts.feeds, model.facts.memory, model.facts.tasks].filter(read => read.status === 'failed');
  const empty = !model.needs.length && !running.length && !report && !memory && !next;

  return <>
    {failures.length ? <div role="alert" className="mx-2 my-2 flex items-start gap-2 rounded-lg px-2 py-2 typography-meta text-destructive">
      <span className="min-w-0 flex-1 break-words">{failures.map(read => read.status === 'failed' ? read.error : '').join(' · ')}</span>
      <button type="button" className="shrink-0 text-foreground hover:underline" onClick={() => { model.facts.retryFeeds(); model.facts.retryMemory(); model.facts.retryTasks(); }}>{t('settings.harness.retry')}</button>
    </div> : null}
    {model.needs.slice(0, MAX_NEEDS).map(need => <NeedCard key={need.key} need={need} />)}
    {running.length ? <button type="button" className="bot-block" onClick={() => model.focusTab('activity', running[0]!.key)}>
      <span className="bot-block-head">{t('bot.overview.running')}<Icon name="arrow-right-s" className="size-3.5" /></span>
      <span className="flex min-w-0 items-center gap-2 text-[14px]">
        <span className="bot-faces">{running.slice(0, 4).map(item => <AgentAvatar key={item.key} identity={item.identity.threadId} avatar={item.avatar} size={20} />)}</span>
        <span className="truncate">{t('bot.overview.runningCount', { count: running.length })}</span>
      </span>
      <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground"><span className="bot-ring" aria-hidden="true" />
        <span className="truncate">{running[0]!.name}{running[0]!.task ? ` · ${running[0]!.task}` : ''}</span></span>
    </button> : null}
    {report ? <button type="button" className="bot-block" onClick={() => model.openSession(report.session)}>
      <span className="bot-block-head">{t('bot.overview.latest')} · {clockTime(report.atMs, locale)}<Icon name="arrow-right-s" className="size-3.5" /></span>
      <span className="text-[14px] leading-relaxed"><Named id="bot.overview.latestReport" name={report.name} params={{ session: model.sessionTitle(report.session.threadId) }} /></span>
    </button> : null}
    {memory ? <button type="button" className="bot-block" onClick={() => model.focusTab('memory', String(memory.id))}>
      <span className="bot-block-head">{t('bot.overview.memory')}<Icon name="arrow-right-s" className="size-3.5" /></span>
      <span className="bot-quote line-clamp-3">{memory.content}</span>
      <span className="text-[12.5px] text-muted-foreground">{new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(memory.createdAt)}{memory.sourceKind ? ` · ${memory.sourceKind}` : ` · ${t('bot.memory.direct')}`}</span>
    </button> : null}
    {next ? <button type="button" className="bot-block" onClick={() => model.focusTab('schedule', next.id)}>
      <span className="bot-block-head">{t('bot.overview.schedule')}<Icon name="arrow-right-s" className="size-3.5" /></span>
      <span className="truncate text-[14px]">{t('bot.overview.scheduleNext', { time: scheduleWhen(next.calendar!.definition.next_at_ms!, locale), name: next.name })}</span>
    </button> : null}
    {empty && !loading && !failures.length ? <p className="px-4 py-7 text-center text-[13px] leading-loose text-muted-foreground">{t('bot.overview.empty', { name: model.bot.name })}</p> : null}
    {empty && loading ? <p role="status" className="px-4 py-7 text-center typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
  </>;
}
