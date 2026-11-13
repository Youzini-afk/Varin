import React from 'react';
import { AgentAvatar } from '@/components/ui/AgentAvatar';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useBotPanel } from './botPanelModel';
import { useBotLayout } from './botLayout';
import { BotSegment } from './botParts';
import { BotWorkStatusLabel } from './BotActivityPane';
import { runStatus, workKey, type BotWorkView, type BotNeed } from './botPresentation';
import { useFlash, useScrollIntoFocus } from './botFocus';
import { useBotWorkspaceNavigation } from './botWorkspaceViews';
import { threadHostKey } from '@/stores/useThreadStore';

const NO_PINS: string[] = [];
function NeedRow({ need }: { need: BotNeed }) {
  const { t } = useI18n(), model = useBotPanel();
  const focused = model.focus?.tab === 'overview' && model.focus.id === need.key;
  const flash = useFlash(focused, model.focus?.token), ref = React.useRef<HTMLButtonElement>(null);
  useScrollIntoFocus(ref, focused, model.focus?.token);
  return <button ref={ref} type="button" className={`bot-need ${flash ?? ''}`} onClick={() => model.openNeed(need)}><Icon name="question" className="size-4 shrink-0" /><span className="min-w-0 flex-1"><b>{need.name}</b><span className="block typography-meta line-clamp-2" title={need.preview}>{need.preview || t(need.kind === 'permission' ? 'bot.overview.needPermission' : 'bot.overview.needQuestion')}</span></span><Icon name="arrow-right-s" className="size-4" /></button>;
}

function FollowingRow({ item, showSession }: { item: BotWorkView; showSession: boolean }) {
  const { t } = useI18n(), model = useBotPanel(), navigation = useBotWorkspaceNavigation();
  return <div className="bot-following-row">
    <button type="button" className="bot-following-main" onClick={() => navigation ? navigation.open({ kind: 'work', key: item.key, identity: item.identity, title: item.name }) : model.openWork(item.identity)}>
      <span className="bot-following-title"><b>{item.name}</b><AgentAvatar identity={item.identity.threadId} avatar={item.avatar} size={20} {...(item.lead ? { role: 'lead' as const } : {})} /></span>
      <span className="bot-following-state">{item.status ? <BotWorkStatusLabel status={item.status} /> : t(item.lastState === 'completed' ? 'bot.workspace.roundEnded' : item.lastState === 'failed' ? 'bot.workspace.failed' : item.lastState === 'cancelled' ? 'bot.workspace.cancelled' : 'bot.workspace.idle')}</span>
      {showSession && item.sessionThreadId && <small>{t('bot.workspace.fromSession', { name: model.sessionTitle(item.sessionThreadId) })}</small>}
    </button>
    {model.workItems?.find(raw => workKey(raw.identity) === item.key)?.desktops?.map(desktop => <button type="button" key={desktop.id} className="bot-work-link" onClick={() => navigation?.computer(desktop)}><Icon name="computer" className="size-3" />{desktop.label}</button>)}
  </div>;
}

/** Stable, source-owned work identities; updates never reorder the user's current reading. */
export function BotOverviewPane() {
  const { t } = useI18n(), model = useBotPanel(), navigation = useBotWorkspaceNavigation();
  const scope = useBotLayout(state => state.overviewScope), setScope = useBotLayout(state => state.setOverviewScope);
  const sessionId = model.session?.identity.threadId;
  const pinScope = JSON.stringify([threadHostKey(), model.bot.id]);
  const pinned = useBotLayout(state => state.pinnedComputers[pinScope] ?? NO_PINS);
  const togglePin = useBotLayout(state => state.toggleComputerPin);
  const inScope = (id: string | null | undefined) => scope === 'all' || Boolean(sessionId && sessionId === id);
  const matters = (model.matters ?? []).filter(matter => !matter.archived && (scope === 'all' || matter.threads.some(link => model.work.some(item => item.identity.threadId === link.threadId && item.identity.branchId === link.branchId && inScope(item.sessionThreadId)))));
  const grouped = new Set(matters.flatMap(matter => matter.threads.map(link => workKey({ runtime: 'agent', threadId: link.threadId, branchId: link.branchId }))));
  const pending = model.work.filter(item => item.lead && inScope(item.sessionThreadId) && item.status !== null && !grouped.has(item.key));
  const followed = (model.workItems ?? []).filter(item => item.purpose === 'followed' && (scope === 'all' || grouped.has(workKey(item.identity))));
  const recent = model.work.filter(item => item.lead && inScope(item.sessionThreadId) && item.status === null && !grouped.has(item.key));
  const elsewhere = model.work.filter(item => item.lead && item.status && item.sessionThreadId && item.sessionThreadId !== sessionId).length;
  const needs = model.needs.filter(need => scope === 'all' || need.session && need.identity.threadId === sessionId || model.work.some(item => item.key === need.key && inScope(item.sessionThreadId)));
  return <>
    {needs.map(need => <NeedRow key={need.key} need={need} />)}
    <section className="bot-following"><header className="bot-section-heading"><h3>{t('bot.workspace.following')}</h3><BotSegment label={t('bot.workspace.following')} value={scope} onChange={setScope} options={[{ value: 'session', label: t('bot.workspace.currentSession') }, { value: 'all', label: t('bot.workspace.allWork') }]} /></header>
      {model.session?.running && <button type="button" className="bot-following-main" onClick={() => model.openSession(model.session!.identity)}><span className="bot-following-title"><b>{model.bot.name}</b></span><span className="bot-following-state">{t(model.line.key, model.line.params)}</span></button>}
      {matters.map(matter => <details key={matter.id} className="bot-matter-row"><summary>{matter.title}<span>{matter.threads.length}</span></summary><p>{matter.description}</p>{matter.threads.map(link => {
        const item = model.work.find(item => item.identity.threadId === link.threadId && item.identity.branchId === link.branchId);
        return item ? <FollowingRow key={item.key} item={item} showSession={scope === 'all' && item.sessionThreadId !== sessionId} /> : null;
      })}</details>)}
      {pending.map(item => <FollowingRow key={item.key} item={item} showSession={scope === 'all' && item.sessionThreadId !== sessionId} />)}
      {followed.map(item => <button type="button" key={workKey(item.identity)} className="bot-following-main" onClick={() => navigation?.open({ kind: 'work', key: workKey(item.identity), identity: item.identity, title: item.thread.title })}><b>{item.thread.title}</b><small>{t('bot.workspace.followed')} · {runStatus(item.activeRun) ? t('bot.work.running') : t('bot.workspace.idle')}</small></button>)}
      {!pending.length && !matters.length && !followed.length && !model.session?.running && <p className="bot-overview-empty">{t('bot.workspace.emptyWork')}</p>}
      {scope === 'session' && elsewhere > 0 && <button className="bot-section-more" type="button" onClick={() => setScope('all')}>{t('bot.workspace.otherSessions', { count: elsewhere })}<Icon name="arrow-right-s" className="size-3" /></button>}
    </section>
    {recent.length > 0 && <details className="bot-matter-row"><summary>{t('bot.workspace.recent')}<span>{recent.length}</span></summary>{recent.map(item => <FollowingRow key={item.key} item={item} showSession={scope === 'all' && item.sessionThreadId !== sessionId} />)}</details>}
    {navigation && <section className="bot-environments"><h3 className="bot-section-label">{t('bot.workspace.environment')}</h3>
      {navigation.computers?.desktops.slice().sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id))).map(desktop => <div key={desktop.id} className="bot-env-computer"><button type="button" className="bot-env-row" onClick={() => navigation.computer(desktop)}><Icon name="computer" className="size-4" /><span>{desktop.label}<small>{t(desktop.status === 'available' ? 'settings.computers.status.available' : desktop.status === 'stopped' ? 'settings.computers.status.stopped' : 'settings.computers.status.unavailable')}</small></span><Icon name="arrow-right-s" className="size-3.5" /></button><button className="bot-env-pin" aria-label={t('bot.workspace.pinComputer', { name: desktop.label })} aria-pressed={pinned.includes(desktop.id)} onClick={() => togglePin(pinScope, desktop.id)}><Icon name={pinned.includes(desktop.id) ? 'pushpin-2-fill' : 'pushpin-2'} className="size-3.5" /></button></div>)}
      {navigation.sources?.targets.map(target => <button key={JSON.stringify(target.resourceOwner)} type="button" className="bot-env-row" onClick={() => navigation.files(target.resourceOwner, target.resourceOwner.kind === 'local' ? t('bot.workspace.local') : target.label)}><Icon name="folder" className="size-4" /><span>{target.resourceOwner.kind === 'local' ? t('bot.workspace.local') : target.label}<small>{t('bot.workspace.files')}</small></span><Icon name="arrow-right-s" className="size-3.5" /></button>)}
      {navigation.sources?.unavailable.map(target => <p key={target.connectionId} className="bot-files-feedback">{target.label} · {target.message}</p>)}
      {navigation.error && <p role="alert" className="bot-files-feedback">{navigation.error}<button type="button" onClick={navigation.refresh}>{t('settings.harness.retry')}</button></p>}
      <button type="button" className="bot-env-row text-muted-foreground" onClick={navigation.connections}><Icon name="add" className="size-4" /><span>{t('bot.workspace.addDevice')}</span></button>
    </section>}
    {model.facts.activity.status === 'failed' && <p role="alert" className="bot-files-feedback text-destructive">{model.facts.activity.error}<button type="button" onClick={model.facts.retryActivity}>{t('settings.harness.retry')}</button></p>}
  </>;
}
