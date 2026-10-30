import React from 'react';
import { getRuntimeEndpointGeneration, type BotMemoryItem } from '@varin/application-client';
import type { MemorySourceExcerpt } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { documentMotionLevel } from '@/lib/motion/preference';
import { listBotMemory, readBotMemoryHistory, readBotMemorySource, updateBotMemory } from '@/lib/bots';
import { springTiming } from '@/lib/motion/tokens';
import { useBotLayout } from './botLayout';
import { useBotPanel } from './botPanelModel';
import { BotSegment } from './botParts';
import { useFlash, useScrollIntoFocus } from './botFocus';
import type { BotRead } from './useBotFacts';

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
type Detail = { sources: BotRead<MemorySourceExcerpt[]>; history: BotRead<BotMemoryItem[]> };

function MemoryItem({ item, open, onToggle, onChanged, onForgotten }: {
  item: BotMemoryItem;
  open: boolean;
  onToggle(): void;
  onChanged(): void;
  onForgotten(): void;
}) {
  const { t } = useI18n();
  const model = useBotPanel();
  const locale = getCurrentIntlLocale();
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(item.content);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const focused = model.focus?.tab === 'memory' && model.focus.id === String(item.id);
  const flash = useFlash(focused, model.focus?.token);
  const ref = React.useRef<HTMLElement>(null);
  useScrollIntoFocus(ref, focused, model.focus?.token);

  React.useEffect(() => {
    if (!open || detail) return undefined;
    const controller = new AbortController();
    const host = getRuntimeEndpointGeneration();
    setDetail({ sources: { status: 'loading', value: null }, history: { status: 'loading', value: null } });
    const settle = <K extends keyof Detail>(key: K, read: Detail[K]) => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setDetail(current => current ? { ...current, [key]: read } : current);
    };
    void readBotMemorySource(model.bot.id, item.id, controller.signal).then(value => settle('sources', { status: 'ready', value }), cause => settle('sources', { status: 'failed', value: null, error: message(cause) }));
    void readBotMemoryHistory(model.bot.id, item.id, controller.signal).then(value => settle('history', { status: 'ready', value }), cause => settle('history', { status: 'failed', value: null, error: message(cause) }));
    return () => controller.abort();
  }, [open, detail, model.bot.id, item.id]);
  React.useEffect(() => { if (!open) { setEditing(false); setConfirming(false); setError(null); } }, [open]);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const forget = () => act(async () => {
    await updateBotMemory(model.bot.id, item, 'forget');
    setLeaving(true);
    const glide = springTiming('glide');
    setTimeout(onForgotten, documentMotionLevel() === 'full' ? glide.duration : 0);
  });
  const sessionOf = (threadId: string) => model.sessions.find(session => session.identity.threadId === threadId);

  return <article ref={ref} className={`bot-memory ${flash ?? ''}`} data-open={open} data-inactive={item.inactive || undefined} data-leaving={leaving || undefined}>
    <div>
      {editing ? <div className="space-y-2">
        <Textarea value={draft} onChange={event => setDraft(event.target.value)} rows={4} aria-label={t('bot.memory.edit')} autoFocus />
        <div className="flex gap-1.5">
          <Button size="sm" disabled={busy || !draft.trim() || draft === item.content} onClick={() => { void act(async () => { await updateBotMemory(model.bot.id, item, 'correct', draft); setEditing(false); onChanged(); }); }}>{t('settings.bots.save')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setDraft(item.content); }}>{t('settings.common.actions.cancel')}</Button>
        </div>
      </div> : <button type="button" className="flex w-full flex-col gap-1.5 text-left" aria-expanded={open} onClick={onToggle}>
        <p className="m-0 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{item.content}</p>
        <span className="bot-memory-meta">
          <span>{new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(item.createdAt)}</span>
          <span>· {item.sourceKind ?? t('bot.memory.direct')}</span>
          {item.inactive ? <span className="bot-tag">{t('bot.memory.obsolete')}</span> : null}
        </span>
      </button>}
      <div className="bot-fold" data-open={open && !editing}>
        <div>
          <div className="flex flex-col gap-2.5 pt-2.5">
            {detail?.sources.status === 'loading' ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
            {detail?.sources.status === 'failed' ? <p role="alert" className="typography-meta text-destructive">{detail.sources.error}</p> : null}
            {detail?.sources.status === 'ready' && detail.sources.value.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.bots.memory.noSource')}</p> : null}
            {detail?.sources.status === 'ready' && detail.sources.value.length ? <>
              <span className="text-[12px] text-muted-foreground">{t('bot.memory.sources')}</span>
              {detail.sources.value.map((source, index) => {
                const session = sessionOf(source.span.threadId);
                const target = { runtime: 'agent' as const, threadId: source.span.threadId, branchId: source.span.branchId };
                return <div key={`${source.span.id}:${index}`} className="bot-source">
                  <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <span className="min-w-0 truncate">{session ? model.sessionTitle(session.identity.threadId) : source.span.threadId}</span>
                    {source.status !== 'unavailable' ? <button type="button" className="ml-auto shrink-0 text-[12px] text-primary hover:underline" onClick={() => session ? model.openSession(target) : model.openWork(target)}>{t('bot.memory.openSource')}</button> : null}
                  </span>
                  {source.status === 'available' && source.text ? <q className="text-[13px] leading-relaxed text-muted-foreground">{source.text}</q> : null}
                  {source.status === 'changed' ? <span className="text-[12.5px] text-muted-foreground">{t('bot.memory.sourceChanged')}</span> : null}
                  {source.status === 'unavailable' ? <span className="text-[12.5px] text-muted-foreground">{t('settings.bots.memory.sourceUnavailable')}</span> : null}
                </div>;
              })}
            </> : null}
            {detail?.history.status === 'ready' && detail.history.value.length > 1 ? <div className="space-y-1">
              <span className="text-[12px] text-muted-foreground">{t('settings.bots.memory.history')}</span>
              {detail.history.value.filter(row => row.id !== item.id).map(row => <p key={row.id} className="m-0 border-l-2 border-border pl-2.5 text-[12px] text-muted-foreground">
                <time dateTime={new Date(row.createdAt).toISOString()}>{new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(row.createdAt)}</time> · {row.content}
              </p>)}
            </div> : null}
            {detail?.history.status === 'failed' ? <p role="alert" className="typography-meta text-destructive">{detail.history.error}</p> : null}
            {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
            {confirming ? <div className="space-y-2">
              <p className="m-0 text-[12.5px] leading-relaxed text-muted-foreground">{t('bot.memory.forgetConfirm')}</p>
              <div className="flex gap-1.5">
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => { void forget(); }}>{t('bot.memory.forgetConfirmAction')}</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{t('settings.common.actions.cancel')}</Button>
              </div>
            </div> : <div className="flex flex-wrap gap-1.5">
              {!item.inactive ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { setDraft(item.content); setEditing(true); }}><Icon name="edit" className="size-3.5" />{t('bot.memory.edit')}</Button> : null}
              {!item.inactive ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void act(async () => { await updateBotMemory(model.bot.id, item, 'archive'); onChanged(); }); }}>{t('bot.memory.obsolete')}</Button> : null}
              <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => setConfirming(true)}>{t('bot.memory.forget')}</Button>
            </div>}
          </div>
        </div>
      </div>
    </div>
  </article>;
}

/** Whole paragraphs with their sources; editing is one user write (§5.5). */
export function BotMemoryPane() {
  const { t } = useI18n();
  const model = useBotPanel();
  const scope = useBotLayout(state => state.memoryScope);
  const setScope = useBotLayout(state => state.setMemoryScope);
  const [search, setSearch] = React.useState('');
  const [openId, setOpenId] = React.useState<number | null>(null);
  const [read, setRead] = React.useState<BotRead<BotMemoryItem[]>>({ status: 'loading', value: null });
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const botId = model.bot.id;
  const sharedRevision = model.facts.memory.status === 'ready' ? model.facts.memory.value : null;
  React.useEffect(() => {
    const controller = new AbortController();
    const host = getRuntimeEndpointGeneration();
    setRead(current => ({ status: 'loading', value: current.value }));
    void listBotMemory(botId, controller.signal, scope === 'all').then(value => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setRead({ status: 'ready', value });
    }, cause => {
      if (!controller.signal.aborted && host === getRuntimeEndpointGeneration()) setRead(current => ({ status: 'failed', value: current.value, error: message(cause) }));
    });
    return () => controller.abort();
  }, [botId, scope, revision, sharedRevision]);
  React.useEffect(() => {
    if (model.focus?.tab === 'memory') setOpenId(Number(model.focus.id));
  }, [model.focus]);
  const query = search.trim().toLocaleLowerCase();
  const items = (read.value ?? []).filter(item => !query || `${item.content} ${item.trigger}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(Boolean(a.inactive)) - Number(Boolean(b.inactive)) || b.createdAt - a.createdAt);
  const changed = () => { refresh(); model.facts.refreshMemory(); };
  return <>
    <label className="mx-1 mt-1 flex h-[34px] items-center gap-2 rounded-[9px] bg-[var(--surface-muted,var(--interactive-hover))] px-3 text-[13px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
      <Icon name="search" className="size-3.5 shrink-0" />
      <input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('settings.bots.memory.search')} aria-label={t('settings.bots.memory.search')}
        className="min-w-0 flex-1 border-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground" />
    </label>
    <div className="bot-pane-bar">
      <BotSegment label={t('bot.tab.memory')} value={scope} onChange={setScope}
        options={[{ value: 'current', label: t('bot.memory.current') }, { value: 'all', label: t('bot.memory.all') }]} />
    </div>
    {read.status === 'failed' ? <div role="alert" className="mx-2 my-2 flex gap-2 typography-meta text-destructive">
      <span className="min-w-0 flex-1 break-words">{read.error}</span>
      <button type="button" className="shrink-0 text-foreground hover:underline" onClick={refresh}>{t('settings.harness.retry')}</button>
    </div> : null}
    {read.status === 'loading' && !read.value ? <p role="status" className="px-4 py-6 text-center typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {read.value && read.value.length === 0 ? <p className="px-4 py-7 text-center text-[13px] text-muted-foreground">{t('settings.bots.memory.empty')}</p> : null}
    {read.value && read.value.length > 0 && !items.length ? <p className="px-4 py-7 text-center text-[13px] text-muted-foreground">{t('bot.memory.noMatch')}</p> : null}
    <div className="relative mt-1">
      {items.map(item => <MemoryItem key={`${item.id}:${item.revision}`} item={item} open={openId === item.id}
        onToggle={() => setOpenId(current => current === item.id ? null : item.id)}
        onChanged={changed}
        onForgotten={() => { setRead(current => current.value ? { ...current, value: current.value.filter(value => value.id !== item.id) } as BotRead<BotMemoryItem[]> : current); changed(); }} />)}
    </div>
  </>;
}
