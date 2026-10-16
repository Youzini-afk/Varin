import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { SettingsActionBar } from '@/components/sections/shared/SettingsActionBar';
import { Icon } from '@/components/icon/Icon';
import { BotMemoryPreferences } from './BotMemoryPreferences';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { BotModelSelector } from './BotModelSelector';
import {
  archiveBot, changeBotState, createBot, listBots, listBotWork, openBotEntryFor, updateBot,
  botWorkId, botWorkTitle, botWorkEntry, openBotWorkFor, type BotSummary, type BotWorkItem,
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
 * Host-owned Bot profiles, independent model preferences, memory and native work.
 * Profile drafts are retained across unrelated model/activity refreshes.
 */
type BotSettingsProps = { initialBotId?: string; onDeleted?(): void; onDraftStateChange?(state: { dirty: boolean; saving: boolean }): void };

export function BotSettings(props: BotSettingsProps = {}) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <BotSettingsForHost key={host} {...props} />;
}
function BotSettingsForHost({ initialBotId, onDeleted, onDraftStateChange }: BotSettingsProps) {
  const { t } = useI18n();
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [bots, setBots] = React.useState<BotSummary[] | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(initialBotId ?? null);
  const [work, setWork] = React.useState<BotWorkItem[] | null>(null);
  const [viewingDesktop, setViewingDesktop] = React.useState<ComputerDesktop | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [instructions, setInstructions] = React.useState('');
  const [profileBaseline, setProfileBaseline] = React.useState<{ id: string; name: string; instructions: string } | null>(null);
  const [showDirectory, setShowDirectory] = React.useState(!initialBotId);
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState('');
  const [renaming, setRenaming] = React.useState<BotSummary | null>(null);
  const [deleting, setDeleting] = React.useState<BotSummary | null>(null);
  const [memoryBot, setMemoryBot] = React.useState<BotSummary | null>(null);
  const loading = React.useRef({ version: 0 });

  const selected = bots?.find((bot) => bot.id === selectedId) ?? null;
  const workBotId = selected?.id;
  const dirty = Boolean(profileBaseline && (name !== profileBaseline.name || instructions !== profileBaseline.instructions));
  React.useEffect(() => { onDraftStateChange?.({ dirty, saving: busy !== null }); }, [dirty, busy, onDraftStateChange]);
  const discardProfile = () => { setError(null); if (selected) { setName(selected.name); setInstructions(selected.instructions ?? ''); setProfileBaseline({ id: selected.id, name: selected.name, instructions: selected.instructions ?? '' }); } };
  const confirmDiscard = () => !dirty || window.confirm(t('settings.bots.discardConfirm'));
  const chooseBot = (id: string) => { if (id !== selectedId && !confirmDiscard()) return; setSelectedId(id); setShowDirectory(false); };
  const locked = Boolean(selected?.archived || selected?.deletion || busy);

  const refresh = React.useCallback(async () => {
    const version = ++loading.current.version;
    try {
      const list = await listBots();
      if (loading.current.version !== version || host !== getRuntimeEndpointGeneration()) return;
      setBots(list);
      setError(null);
      setSelectedId((current) => list.some((bot) => bot.id === current) ? current : list.find((bot) => !bot.archived)?.id ?? list[0]?.id ?? null);
      if (initialBotId && !list.some((bot) => bot.id === initialBotId)) onDeleted?.();
    } catch (cause) {
      if (loading.current.version === version && host === getRuntimeEndpointGeneration()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [initialBotId, onDeleted, host]);

  React.useEffect(() => {
    const generation = loading.current;
    setBots(null); setWork(null); setDeleting(null); setMemoryBot(null); setCreateDialogOpen(false);
    void refresh();
    return () => { generation.version++; };
  }, [refresh]);
  React.useEffect(() => subscribeVarinEvents((event) => {
    if (event.type === 'bot-changed' || event.type === 'stream-ready') void refresh();
  }), [refresh]);

  React.useEffect(() => {
    if (selected?.id === profileBaseline?.id && dirty) return;
    setName(selected?.name ?? '');
    setInstructions(selected?.instructions ?? '');
    setProfileBaseline(selected ? { id: selected.id, name: selected.name, instructions: selected.instructions ?? '' } : null);
  }, [selected, dirty, profileBaseline?.id]);

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
  }, [workBotId, host, selected?.updatedAt]);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    try {
      await task();
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    if (!selected || !name.trim()) return Promise.resolve(false);
    return run('save', async () => {
      const saved = await updateBot(selected.id, {
        ...(name.trim() && name.trim() !== selected.name ? { name } : {}),
        instructions: instructions.trim() ? instructions : null,
      });
      setName(saved.name); setInstructions(saved.instructions ?? '');
      setProfileBaseline({ id: saved.id, name: saved.name, instructions: saved.instructions ?? '' });
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
      if (!renaming) { setSelectedId(created.id); setShowDirectory(false); }
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
    }).then(saved => { if (!saved) throw new Error('Model selection failed'); });
  };

  const botStatusLabel = (bot: BotSummary) => t(bot.deletion ? bot.deletion.error ? 'settings.bots.deleteFailed' : 'settings.bots.deleting'
    : bot.archived ? 'settings.bots.archived' : bot.activity?.state === 'sleeping' ? 'settings.bots.sleeping'
      : bot.activity?.state === 'waking' ? 'settings.bots.waking' : bot.activity?.state === 'sleep-failed' ? 'settings.bots.sleepFailed'
        : bot.activity?.state === 'wake-failed' ? 'settings.bots.wakeFailed' : bot.activity?.state === 'asleep' ? 'settings.bots.asleep' : 'settings.bots.ready');
  const workStateLabel = (item: BotWorkItem): string => item.activeRun?.state ?? t('settings.bots.ready');

  const action = (bot: BotSummary, action: BotMenuAction) => {
    if (bot.id === selectedId && dirty && ['rename', 'archive', 'delete'].includes(action)) { if (!confirmDiscard()) return; discardProfile(); }
    if (action === 'rename') { setError(null); setRenaming(bot); setCreateName(bot.name); setCreateDialogOpen(true); return; }
    if (action === 'delete') { setDeleting(bot); return; }
    if (action === 'profile') { chooseBot(bot.id); return; }
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
    {bots ? <div className={cn("overflow-hidden rounded-xl border border-border/70 bg-background", !initialBotId && "@3xl:grid @3xl:grid-cols-[220px_minmax(0,1fr)]")}>
      {!initialBotId ? <aside className={cn("border-border/60 bg-muted/25 p-3 @3xl:block @3xl:border-r", !showDirectory && "hidden")}> <SettingsSection title={t('settings.bots.section.list')} contentClassName="space-y-3" divider={false}>
        {bots.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.bots.empty')}</p> : null}
        <ul className="space-y-1">
          {bots.map((bot) => <li key={bot.id}>
            <BotMenu bot={bot} disabled={busy !== null} onAction={(value) => action(bot, value)}>
              <button type="button" onClick={() => chooseBot(bot.id)}
                aria-current={bot.id === selectedId ? 'page' : undefined}
                className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-3 text-left typography-ui-label transition-colors',
                  bot.id === selectedId ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
                <span className="min-w-0 flex-1"><span className="block truncate">{bot.name}</span><span className="mt-1 block typography-micro font-normal text-muted-foreground">{botStatusLabel(bot)}</span></span>
              </button>
            </BotMenu>
          </li>)}
        </ul>
        <div>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => {
            if (!confirmDiscard()) return;
            discardProfile();
            setCreateName('');
            setError(null);
            setRenaming(null);
            setCreateDialogOpen(true);
          }}>{busy === 'create' ? t('settings.bots.creating') : t('settings.bots.create')}</Button>
        </div>
      </SettingsSection></aside> : null}
      <div className={cn('min-w-0 px-4 py-5 @xl:px-6', !initialBotId && showDirectory && 'hidden @3xl:block')}>
      {selected ? <>
        {!initialBotId ? <Button variant="ghost" size="sm" className="mb-3 @3xl:hidden" onClick={() => setShowDirectory(true)}><Icon name="arrow-left-s" className="size-4" />{t('settings.bots.backToList')}</Button> : null}
        <BotMenu bot={selected} disabled={busy !== null} onAction={value => action(selected, value)}><div className="min-w-0 flex-1 pb-4"><h2 className="truncate text-xl font-semibold">{selected.name}</h2><p className="mt-1 typography-micro text-muted-foreground">{t('settings.bots.section.profile')}{selected.archived ? ` · ${t('settings.bots.archived')}` : ''}</p></div></BotMenu>
        <div className="mb-6 flex flex-wrap gap-2"><Button size="sm" disabled={locked} onClick={() => { if (confirmDiscard()) void run('entry', async () => { await openBotEntryFor(selected.id); }); }}><Icon name="chat-1" className="size-4" />{t('settings.bots.openEntry')}</Button>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => setMemoryBot(selected)}>{t('settings.bots.viewMemory')}</Button></div>
      </> : null}
      <div className="@container">
      {selected ? <SettingsSection title={t('settings.bots.section.profile')} contentClassName="space-y-5">
        {selected.deletion || !selected.archived ? <BotActivityBanner bot={selected} busy={busy !== null} onAction={(value) => action(selected, value)} /> : null}
        <SettingsFieldRow label={t('settings.bots.name.label')}>
          <Input aria-label={t('settings.bots.name.label')} value={name} disabled={locked} onChange={(event) => setName(event.target.value)} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.bots.instructions.label')} description={t('settings.bots.instructions.description')}>
          <Textarea aria-label={t('settings.bots.instructions.label')} value={instructions} disabled={locked} rows={5}
            placeholder={t('settings.bots.instructions.placeholder')}
            onChange={(event) => setInstructions(event.target.value)} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.bots.model.label')} description={<>{t('settings.bots.model.description')} {t('settings.bots.modelSavedSeparately')}</>}>
          <BotModelSelector model={selected.model} disabled={locked} onChange={selectModel} />
        </SettingsFieldRow>

      </SettingsSection> : null}
      {selected ? <SettingsSection title={t('settings.bots.section.work')} contentClassName="space-y-2" description={work ? t('settings.bots.work.summary', { count: work.length }) : undefined}>
        {work === null ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
        {work !== null && work.length === 0
          ? <p className="typography-meta text-muted-foreground">{t('settings.bots.work.empty')}</p> : null}
        <ul className="space-y-1">
          {(work ?? []).map((item) => <li key={botWorkId(item)}
            className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="typography-ui-label truncate text-foreground">{botWorkTitle(item)}</p>
              <p className="typography-meta text-muted-foreground">{workStateLabel(item)}</p>
            </div>
            {botWorkEntry(item) ? <Button variant="outline" size="sm" onClick={() => {
              void run('work', () => openBotWorkFor(selected, item));
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
      </div>
      {selected && !selected.archived && !selected.deletion ? <SettingsActionBar dirty={dirty} saving={busy !== null} onSave={save} onCancel={discardProfile} saveDisabled={!name.trim()} saveLabel={t('settings.bots.save')} error={error} /> : null}
      </div>
    </div> : null}
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
    <BotMemoryPreferences />
  </>;
}
