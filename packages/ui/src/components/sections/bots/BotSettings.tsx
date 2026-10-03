import React from 'react';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { openPiSessionFromNavigation } from '@/lib/pi-runtime/sessionNavigation';
import {
  archiveBot, changeBotState, createBot, listBots, listBotWork, openBotEntryFor, updateBot,
  type BotSummary, type BotWorkItem,
} from '@/lib/bots';
import { cn } from '@/lib/utils';
import type { ComputerDesktop } from '@varin/protocol';
import { ComputerDesktopView } from '@/components/sections/computers/ComputerDesktopView';
import { downloadComputerArtifact } from '@/lib/computers';
import { BotNameDialog } from './BotNameDialog';
import { BotMenu, type BotMenuAction } from './BotMenu';
import { BotDeleteDialog } from './BotDeleteDialog';
import { BotActivityBanner } from './BotActivityBanner';
import { subscribeVarinEvents } from '@/lib/varinEvents';

const BotDetailsDialog = React.lazy(() => import('./BotDetailsDialog').then((module) => ({ default: module.BotDetailsDialog })));

/**
 * Bots settings (BC0): the durable Bot catalog — identity, persona
 * instructions, preferred model, and the real work items in the Bot's owner
 * scope. Profiles are Host records; edits apply to the live entry worker.
 */
export function BotSettings({ initialBotId, onDeleted }: { initialBotId?: string; onDeleted?(): void } = {}) {
  const { t } = useI18n();
  const [bots, setBots] = React.useState<BotSummary[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(initialBotId ?? null);
  const [work, setWork] = React.useState<BotWorkItem[] | null>(null);
  const [viewingDesktop, setViewingDesktop] = React.useState<ComputerDesktop | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [instructions, setInstructions] = React.useState('');
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState('');
  const [renaming, setRenaming] = React.useState<BotSummary | null>(null);
  const [deleting, setDeleting] = React.useState<BotSummary | null>(null);
  const [memoryBot, setMemoryBot] = React.useState<BotSummary | null>(null);
  const loading = React.useRef({ version: 0 });

  const selected = bots?.find((bot) => bot.id === selectedId) ?? null;
  const workBotId = selected?.id;
  const locked = Boolean(selected?.archived || selected?.deletion || busy);
  const transitioning = selected?.activity?.state === 'sleeping' || selected?.activity?.state === 'waking';

  const refresh = React.useCallback(async () => {
    const version = ++loading.current.version;
    try {
      const list = await listBots();
      if (loading.current.version !== version) return;
      setBots(list);
      setError(null);
      setSelectedId((current) => list.some((bot) => bot.id === current) ? current : list.find((bot) => !bot.archived)?.id ?? list[0]?.id ?? null);
      if (initialBotId && !list.some((bot) => bot.id === initialBotId)) onDeleted?.();
    } catch (cause) {
      if (loading.current.version === version) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [initialBotId, onDeleted]);

  React.useEffect(() => {
    const generation = loading.current;
    void refresh();
    return () => { generation.version++; };
  }, [refresh]);
  React.useEffect(() => subscribeVarinEvents((event) => {
    if (event.type === 'bot-changed' || event.type === 'stream-ready') void refresh();
  }), [refresh]);

  React.useEffect(() => {
    setName(selected?.name ?? '');
    setInstructions(selected?.instructions ?? '');
  }, [selected?.id, selected?.name, selected?.instructions]);

  React.useEffect(() => {
    if (!workBotId) { setWork(null); return; }
    setWork(null);
    let cancelled = false;
    void listBotWork(workBotId)
      .then((items) => { if (!cancelled) setWork(items); })
      .catch((cause) => {
        if (!cancelled) {
          setWork(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => { cancelled = true; };
  }, [workBotId]);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    try {
      await task();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    if (!selected) return;
    void run('save', async () => {
      await updateBot(selected.id, {
        ...(name.trim() && name.trim() !== selected.name ? { name } : {}),
        instructions: instructions.trim() ? instructions : null,
      });
      await refresh();
    });
  };

  const submitCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = createName.trim();
    if (!trimmed) return;
    void run('create', async () => {
      const created = renaming ? await updateBot(renaming.id, { name: trimmed }) : await createBot({ name: trimmed });
      await refresh();
      if (!renaming) setSelectedId(created.id);
      setCreateDialogOpen(false);
      setRenaming(null);
    });
  };

  const selectModel = (providerId: string, modelId: string) => {
    if (!selected) return Promise.resolve();
    return run('model', async () => {
      await updateBot(selected.id, {
        model: providerId && modelId ? { providerId, modelId } : null,
      });
      await refresh();
    });
  };

  const workStateLabel = (item: BotWorkItem): string => {
    const { thread, activeRun } = item;
    if (activeRun?.workerState === 'running' || activeRun?.workerState === 'starting') return activeRun.workerState;
    if (thread.attention !== 'none') return `attention:${thread.attention}`;
    return thread.lifecycle;
  };

  const action = (bot: BotSummary, action: BotMenuAction) => {
    if (action === 'rename') { setError(null); setRenaming(bot); setCreateName(bot.name); setCreateDialogOpen(true); return; }
    if (action === 'delete') { setDeleting(bot); return; }
    if (action === 'profile') { setSelectedId(bot.id); return; }
    if (action === 'memory') { setMemoryBot(bot); return; }
    void run(action, async () => {
      if (action === 'pin') await updateBot(bot.id, { pinned: !bot.pinnedAt });
      else if (action === 'archive') await archiveBot(bot.id);
      else await changeBotState(bot.id, action);
      await refresh();
    });
  };

  return <>
    {error ? <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="typography-meta text-destructive">{error}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => { void refresh(); }}>{t('settings.harness.retry')}</Button>
    </div> : null}
    {!bots && !error ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {bots ? <>
      {!initialBotId ? <SettingsSection title={t('settings.bots.section.list')} contentClassName="space-y-3">
        {bots.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.bots.empty')}</p> : null}
        <ul className="space-y-1">
          {bots.map((bot) => <li key={bot.id}>
            <BotMenu bot={bot} disabled={busy !== null} onAction={(value) => action(bot, value)}>
              <button type="button" onClick={() => setSelectedId(bot.id)}
                aria-current={bot.id === selectedId ? 'page' : undefined}
                className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left typography-ui-label transition-colors',
                  bot.id === selectedId ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
                <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                {bot.deletion || bot.archived ? <span className="typography-meta text-muted-foreground">{t(bot.deletion ? bot.deletion.error ? 'settings.bots.deleteFailed' : 'settings.bots.deleting' : 'settings.bots.archived')}</span> : null}
              </button>
            </BotMenu>
          </li>)}
        </ul>
        <div>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => {
            setCreateName('');
            setError(null);
            setRenaming(null);
            setCreateDialogOpen(true);
          }}>{busy === 'create' ? t('settings.bots.creating') : t('settings.bots.create')}</Button>
        </div>
      </SettingsSection> : null}

      {selected ? <SettingsSection title={t('settings.bots.section.profile')} contentClassName="space-y-5">
        {selected.deletion || !selected.archived ? <BotActivityBanner bot={selected} busy={busy !== null} onAction={(value) => action(selected, value)} /> : null}
        <SettingsFieldRow label={t('settings.bots.name.label')}>
          <Input value={name} disabled={locked} onChange={(event) => setName(event.target.value)} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.bots.instructions.label')} description={t('settings.bots.instructions.description')}>
          <Textarea value={instructions} disabled={locked} rows={5}
            placeholder={t('settings.bots.instructions.placeholder')}
            onChange={(event) => setInstructions(event.target.value)} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.bots.model.label')} description={t('settings.bots.model.description')}>
          <ModelSelector
            providerId={selected.model?.providerId ?? ''}
            modelId={selected.model?.modelId ?? ''}
            allowNone
            defaultSelectionLabel={t('settings.bots.model.inherit')}
            disabled={locked}
            onChange={selectModel}
          />
        </SettingsFieldRow>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={locked
            || (name.trim() === selected.name && instructions.trim() === (selected.instructions ?? ''))}
            onClick={save}>{busy === 'save' ? t('settings.bots.saving') : t('settings.bots.save')}</Button>
          <Button variant="outline" size="sm" disabled={locked} onClick={() => {
            void run('entry', async () => { await openBotEntryFor(selected.id); });
          }}>{t('settings.bots.openEntry')}</Button>
          {!selected.archived ? <Button variant="outline" size="sm" disabled={locked || transitioning} onClick={() => {
            void run('archive', async () => { await archiveBot(selected.id); await refresh(); });
          }}>{busy === 'archive' ? t('settings.bots.archiving') : t('settings.bots.archive')}</Button> : null}
          {selected.archived ? <Button variant="outline" size="sm" disabled={busy !== null || Boolean(selected.deletion)} onClick={() => {
            void run('restore', async () => { await changeBotState(selected.id, 'restore'); await refresh(); });
          }}>{t('settings.bots.restore')}</Button> : null}
          <Button variant="destructive" size="sm" disabled={busy !== null || transitioning || Boolean(selected.deletion)} onClick={() => setDeleting(selected)}>{t('settings.bots.delete')}</Button>
        </div>
      </SettingsSection> : null}

      {selected ? <SettingsSection title={t('settings.bots.section.work')} contentClassName="space-y-2">
        {work === null ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
        {work !== null && work.length === 0
          ? <p className="typography-meta text-muted-foreground">{t('settings.bots.work.empty')}</p> : null}
        <ul className="space-y-1">
          {(work ?? []).map((item) => <li key={item.thread.id}
            className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="typography-ui-label truncate text-foreground">{item.thread.brief || item.thread.id}</p>
              <p className="typography-meta text-muted-foreground">{workStateLabel(item)}</p>
            </div>
            {item.sessionId ? <Button variant="outline" size="sm" onClick={() => {
              void openPiSessionFromNavigation({ sessionId: item.sessionId! });
            }}>{t('settings.bots.work.open')}</Button> : null}
            {item.desktops?.map((desktop) => <Button key={desktop.id} variant="outline" size="sm"
              disabled={desktop.status !== 'available'} onClick={() => setViewingDesktop(desktop)}
              title={desktop.label}>{t('settings.computers.view.open')}</Button>)}
            {item.artifacts?.map((artifact) => <Button key={artifact.id} variant="outline" size="sm"
              disabled={busy === `artifact:${artifact.id}`} title={artifact.relativePath} onClick={() => {
                void run(`artifact:${artifact.id}`, () => downloadComputerArtifact(artifact));
              }}>{artifact.relativePath.split('/').at(-1)}</Button>)}
          </li>)}
        </ul>
      </SettingsSection> : null}
    </> : null}
    {viewingDesktop ? <ComputerDesktopView desktop={viewingDesktop} open onOpenChange={(open) => { if (!open) setViewingDesktop(null); }} /> : null}
    <BotNameDialog
      open={createDialogOpen}
      title={t(renaming ? 'settings.bots.rename' : 'settings.bots.create')}
      name={createName}
      busy={busy === 'create'}
      error={error}
      onNameChange={setCreateName}
      onOpenChange={(open) => { if (busy !== 'create') setCreateDialogOpen(open); }}
      onSubmit={submitCreate}
    />
    {deleting ? <BotDeleteDialog key={deleting.id} bot={deleting} onClose={() => setDeleting(null)} onAccepted={(bot) => {
      setBots((list) => list?.flatMap((item) => item.id === deleting.id ? bot ? [bot] : [] : [item]) ?? null);
      void refresh();
    }} /> : null}
    {memoryBot ? <React.Suspense fallback={null}><BotDetailsDialog bot={{ ...memoryBot, tab: 'memory' }} onClose={() => setMemoryBot(null)} /></React.Suspense> : null}
  </>;
}
