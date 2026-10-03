import React from 'react';
import type { BotMemoryItem } from '@varin/application-client';
import type { MemorySourceExcerpt } from '@varin/protocol';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { listBotMemory, readBotMemorySource, updateBotMemory } from '@/lib/bots';
import { BotSettings } from './BotSettings';

export function BotDetailsDialog({ bot, onClose }: {
  bot: { id: string; name: string; tab: 'profile' | 'memory' } | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  return <Dialog open={bot !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{bot?.name} · {t(bot?.tab === 'memory' ? 'settings.bots.memory' : 'settings.bots.section.profile')}</DialogTitle>
        <DialogDescription>{t(bot?.tab === 'memory' ? 'settings.bots.memory.description' : 'settings.bots.instructions.description')}</DialogDescription>
      </DialogHeader>
      {bot ? bot.tab === 'profile' ? <BotSettings key={bot.id} initialBotId={bot.id} onDeleted={onClose} />
        : <BotMemoryPanel key={bot.id} botId={bot.id} /> : null}
    </DialogContent>
  </Dialog>;
}

function BotMemoryPanel({ botId }: { botId: string }) {
  const { t } = useI18n();
  const [items, setItems] = React.useState<BotMemoryItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<BotMemoryItem | null>(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sources, setSources] = React.useState<Record<number, MemorySourceExcerpt[]>>({});
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => {
    const controller = new AbortController();
    void listBotMemory(botId, controller.signal).then((list) => {
      if (!controller.signal.aborted) { setItems(list); setError(null); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [botId, revision]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setBusy(false); }
  };
  return <div className="space-y-3">
    <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('settings.bots.memory.search')} aria-label={t('settings.bots.memory.search')} />
    {error ? <div role="alert" className="typography-meta text-destructive">{error} <Button variant="ghost" size="sm" onClick={refresh}>{t('settings.harness.retry')}</Button></div> : null}
    {!items && !error ? <p role="status">{t('common.loading')}</p> : null}
    {items?.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.bots.memory.empty')}</p> : null}
    {items?.filter((item) => `${item.content} ${item.trigger}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((item) => <article key={item.id} className="space-y-2 rounded-md border border-border p-3">
      {editing?.id === item.id ? <>
        <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={t('settings.bots.memory.correct')} rows={4} />
        <Button size="sm" disabled={busy || !draft.trim()} onClick={() => { void run(async () => {
          await updateBotMemory(botId, editing, 'correct', draft);
          if (alive.current) { setEditing(null); refresh(); }
        }); }}>{t('settings.bots.save')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>{t('settings.common.actions.cancel')}</Button>
      </> : <p className="whitespace-pre-wrap typography-body">{item.content}</p>}
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing(item); setDraft(item.content); }}>{t('settings.bots.memory.correct')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void run(async () => {
          const result = await readBotMemorySource(botId, item.id);
          if (alive.current) setSources((current) => ({ ...current, [item.id]: result }));
        }); }}>{t('settings.bots.memory.source')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void run(async () => {
          await updateBotMemory(botId, item, 'forget');
          if (alive.current) refresh();
        }); }}>{t('settings.bots.memory.forget')}</Button>
      </div>
      {sources[item.id]?.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.bots.memory.noSource')}</p> : null}
      {sources[item.id]?.map((source, index) => <blockquote key={index} className="whitespace-pre-wrap border-l-2 border-border pl-3 typography-meta text-muted-foreground">
        {source.status === 'available' ? source.text : t('settings.bots.memory.sourceUnavailable')}
      </blockquote>)}
    </article>)}
  </div>;
}
