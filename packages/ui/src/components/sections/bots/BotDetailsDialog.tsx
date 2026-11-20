import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type BotMemoryItem } from '@varin/application-client';
import type { MemorySourceExcerpt } from '@varin/protocol';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { listBotMemory, readBotMemorySource, readBotMemoryHistory, updateBotMemory } from '@/lib/bots';
import { memorySourceLabel } from '@/workbenches/bot/botPresentation';
import { Area, Btn, Empty, Field, Loading, Note, Section } from '../shared/kit';
import { SettingsFooterContext, SettingsNavigationContext } from '../shared/settings-context';
import { BotSettings } from './BotSettings';

export function BotDetailsDialog({ bot, onClose }: {
  bot: { id: string; name: string; tab: 'profile' | 'memory' } | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [footer, setFooter] = React.useState<HTMLDivElement | null>(null);
  const profileDraft = React.useRef({ dirty: false, saving: false });
  const handleDraftStateChange = React.useCallback((state: { dirty: boolean; saving: boolean }) => { profileDraft.current = state; }, []);
  React.useEffect(() => { profileDraft.current = { dirty: false, saving: false }; }, [bot?.id, bot?.tab]);
  const close = () => {
    if (bot?.tab === 'profile' && (profileDraft.current.saving || (profileDraft.current.dirty && !window.confirm(t('settings.bots.discardConfirm'))))) return;
    onClose();
  };
  return <Dialog open={bot !== null} onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>{bot?.name} · {t(bot?.tab === 'memory' ? 'settings.bots.memory' : 'settings.bots.section.profile')}</DialogTitle>
        <DialogDescription>{t(bot?.tab === 'memory' ? 'settings.bots.memory.description' : 'settings.bots.instructions.description')}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto"><SettingsNavigationContext.Provider value={false}><SettingsFooterContext.Provider value={footer}>
        {bot ? bot.tab === 'profile' ? <BotSettings key={bot.id} initialBotId={bot.id} embedded onDeleted={onClose} onDraftStateChange={handleDraftStateChange} />
          : <BotMemoryPanel key={bot.id} botId={bot.id} /> : null}
      </SettingsFooterContext.Provider></SettingsNavigationContext.Provider></div>
      <div ref={setFooter} className="sk relative shrink-0" />
    </DialogContent>
  </Dialog>;
}

export function BotMemoryPanel({ botId, onContentChange }: { botId: string; onContentChange?(present: boolean): void }) {
  const { t, locale } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [items, setItems] = React.useState<BotMemoryItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<BotMemoryItem | null>(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sources, setSources] = React.useState<Record<number, MemorySourceExcerpt[]>>({});
  const [histories, setHistories] = React.useState<Record<number, BotMemoryItem[]>>({});
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const alive = React.useRef(true);
  const hasContent = Boolean(items?.length || error || editing);
  React.useEffect(() => { onContentChange?.(hasContent); }, [hasContent, onContentChange]);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => {
    const controller = new AbortController();
    setItems(null); setSources({}); setHistories({}); setEditing(null);
    void listBotMemory(botId, controller.signal, includeInactive).then(list => {
      if (!controller.signal.aborted) { setItems(list); setError(null); }
    }).catch(cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [botId, revision, host, includeInactive]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setBusy(false); }
  };
  const change = (item: BotMemoryItem, action: 'correct' | 'forget' | 'archive', content?: string) => {
    void run(async () => {
      await updateBotMemory(botId, item, action, content);
      if (alive.current) { setEditing(null); refresh(); }
    });
  };
  const toggleSources = (item: BotMemoryItem) => {
    if (sources[item.id]) {
      setSources(current => { const next = { ...current }; delete next[item.id]; return next; });
      return;
    }
    void run(async () => {
      const rows = await readBotMemorySource(botId, item.id);
      if (alive.current) setSources(current => ({ ...current, [item.id]: rows }));
    });
  };
  const toggleHistory = (item: BotMemoryItem) => {
    if (histories[item.id]) {
      setHistories(current => { const next = { ...current }; delete next[item.id]; return next; });
      return;
    }
    void run(async () => {
      const rows = await readBotMemoryHistory(botId, item.id);
      if (alive.current) setHistories(current => ({ ...current, [item.id]: rows }));
    });
  };

  const query = search.trim().toLocaleLowerCase();
  const visible = items?.filter(item => item.id === editing?.id || (item.content + ' ' + item.trigger).toLocaleLowerCase().includes(query));
  const date = (value: number) => Number.isFinite(value) ? <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString(locale)}>
    {new Date(value).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}
  </time> : null;
  const searchLabel = t('settings.bots.memory.search');
  const link = 'sk-link disabled:opacity-50';

  return <div className="sk bot-memory-list">
    <div className="bot-memory-toolbar">
      <Btn kind="ghost" sm aria-pressed={includeInactive} disabled={busy || editing !== null}
        onClick={() => setIncludeInactive(value => !value)}>{t('settings.bots.memory.includeInactive')}</Btn>
      <Field type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
    </div>
    {error && <Note kind="err" actions={items === null ? <Btn kind="ghost" sm onClick={refresh}>{t('common.retry')}</Btn> : undefined}>{error}</Note>}
    {!items && !error && <Loading />}
    {visible && <Section>
      {!visible.length && <Empty icon={query ? 'search' : 'book-2'} title={t(query ? 'settings.memoryx.noMatches' : 'settings.bots.memory.empty')} />}
      {visible.map(item => <article key={item.id} className="sk-mem">
        {editing?.id === item.id ? <div className="space-y-2">
          <Area autoFocus value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} aria-label={t('settings.bots.memory.correct')} rows={4} />
          <div className="flex justify-end gap-2">
            <Btn kind="ghost" sm disabled={busy} onClick={() => setEditing(null)}>{t('settings.common.actions.cancel')}</Btn>
            <Btn kind="primary" sm disabled={busy || !draft.trim()} onClick={() => change(item, 'correct', draft)}>{t('settings.bots.save')}</Btn>
          </div>
        </div> : <>
          <p className={item.inactive ? 'break-words text-muted-foreground' : 'break-words'}>{item.content}</p>
          <div className="sk-meta">
            <button type="button" className={link} disabled={busy} aria-expanded={Boolean(sources[item.id])}
              onClick={() => toggleSources(item)}>{item.sourceKind ? memorySourceLabel(item.sourceKind, t) : t('settings.bots.memory.source')}</button>
            {date(item.createdAt)}
            {item.inactive && <span>{t('settings.bots.memory.inactive')}</span>}
            <span className="sk-grow" />
            {!item.inactive && <button type="button" className={link} disabled={busy || editing !== null}
              onClick={() => { setEditing(item); setDraft(item.content); }}>{t('settings.bots.memory.correct')}</button>}
            <button type="button" className={link} disabled={busy || editing !== null}
              onClick={() => change(item, 'forget')}>{t('settings.bots.memory.forget')}</button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Btn kind="ghost" sm icon="more" aria-label={t('settings.bots.actions')} disabled={busy || editing !== null} /></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => toggleHistory(item)}>{t('settings.bots.memory.history')}</DropdownMenuItem>
                {!item.inactive && <DropdownMenuItem onSelect={() => change(item, 'archive')}>{t('settings.bots.memory.archive')}</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>}
        {sources[item.id]?.length === 0 && <p className="mt-2 text-muted-foreground">{t('settings.bots.memory.noSource')}</p>}
        {sources[item.id]?.map((source, index) => <blockquote key={index} className="mt-2 whitespace-pre-wrap break-words border-l-2 border-border pl-3 typography-meta text-muted-foreground">
          {source.status === 'available' ? source.text : t(source.status === 'changed' ? 'bot.memory.sourceChanged' : 'settings.bots.memory.sourceUnavailable')}
        </blockquote>)}
        {histories[item.id]?.map(row => <div key={row.id} className="mt-2 border-l-2 border-border pl-3 typography-meta text-muted-foreground">
          {date(row.createdAt)}<p className="break-words">{row.content}</p>
        </div>)}
      </article>)}
    </Section>}
  </div>;
}
