import { SettingsTabs } from '../shared/SettingsTabs';
import { useSettingsSearchTarget } from '@/lib/settings/search-target';
import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@varin/application-client';
import type { BotModelSelection } from '@varin/application-client';
import { SettingsActionBar } from '@/components/sections/shared/SettingsActionBar';
import { Icon } from '@/components/icon/Icon';
import { BotMemoryPreferences } from './BotMemoryPreferences';
import { SettingsFieldRow, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { BotAppearanceSettings } from './BotAppearanceSettings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { BotModelSelector } from './BotModelSelector';
import {
  archiveBot, changeBotState, createBot, listBots, listBotWork, openBotEntryFor, updateBot,
  botWorkId, botWorkTitle, botWorkEntry, openBotWorkFor, type BotSummary, type BotWorkItem,
} from '@/lib/bots';
import type { ComputerDesktop } from '@varin/protocol';
import { ComputerDesktopView } from '@/components/sections/computers/ComputerDesktopView';
import { downloadComputerArtifact } from '@/lib/computers';
import { BotNameDialog } from './BotNameDialog';
import { BotMenu, type BotMenuAction } from './BotMenu';
import { BotDeleteDialog } from './BotDeleteDialog';
import { BotActivityBanner } from './BotActivityBanner';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useBotOrganization } from '@/workbenches/bot/useBotOrganization';
import { BotOrganizationDialog, type BotOrganizationDialogState } from '@/workbenches/bot/BotOrganizationDialog';

const BotMemoryPanel = React.lazy(() => import('./BotDetailsDialog').then((module) => ({ default: module.BotMemoryPanel })));

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
  const [tab, setTab] = React.useState<'profile' | 'work' | 'memory'>('profile');
  const [memoryOpened, setMemoryOpened] = React.useState(false);
  const panelId = React.useId();
  const selectTab = (next: typeof tab) => { setTab(next); if (next === 'memory') setMemoryOpened(true); };
  const target = useSettingsSearchTarget();
  React.useEffect(() => { if (target === 'knowledge.model') { setTab('memory'); setMemoryOpened(true); } }, [target]);
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const [bots, setBots] = React.useState<BotSummary[] | null>(null);
  const organization = useBotOrganization(bots);
  const [organizationDialog, setOrganizationDialog] = React.useState<BotOrganizationDialogState | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(initialBotId ?? null);
  const [work, setWork] = React.useState<BotWorkItem[] | null>(null);
  const [viewingDesktop, setViewingDesktop] = React.useState<ComputerDesktop | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [instructions, setInstructions] = React.useState('');
  const [model, setModel] = React.useState<BotModelSelection | null>(null);
  const [profileBaseline, setProfileBaseline] = React.useState<{ id: string; name: string; instructions: string; model: BotModelSelection | null } | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState('');
  const [renaming, setRenaming] = React.useState<BotSummary | null>(null);
  const [deleting, setDeleting] = React.useState<BotSummary | null>(null);
  const loading = React.useRef({ version: 0 });

  const selected = bots?.find((bot) => bot.id === selectedId) ?? null;
  const workBotId = selected?.id;
  const dirty = Boolean(profileBaseline && (name !== profileBaseline.name || instructions !== profileBaseline.instructions
    || model?.providerId !== profileBaseline.model?.providerId || model?.modelId !== profileBaseline.model?.modelId
    || model?.thinkingLevel !== profileBaseline.model?.thinkingLevel));
  React.useEffect(() => { onDraftStateChange?.({ dirty, saving: busy !== null }); }, [dirty, busy, onDraftStateChange]);
  const discardProfile = () => { setError(null); if (selected) { setName(selected.name); setInstructions(selected.instructions ?? ''); setModel(selected.model); setProfileBaseline({ id: selected.id, name: selected.name, instructions: selected.instructions ?? '', model: selected.model }); } };
  const confirmDiscard = () => !dirty || window.confirm(t('settings.bots.discardConfirm'));
  const chooseBot = (id: string) => { if (id !== selectedId && !confirmDiscard()) return false; setSelectedId(id); return true; };
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
    setBots(null); setWork(null); setDeleting(null); setCreateDialogOpen(false);
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
    setModel(selected?.model ?? null);
    setProfileBaseline(selected ? { id: selected.id, name: selected.name, instructions: selected.instructions ?? '', model: selected.model } : null);
  }, [selected, dirty, profileBaseline?.id]);

  React.useEffect(() => {
    if (!workBotId || tab !== 'work') return;
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
  }, [workBotId, host, selected?.updatedAt, tab]);

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
        model,
      });
      setName(saved.name); setInstructions(saved.instructions ?? ''); setModel(saved.model);
      setProfileBaseline({ id: saved.id, name: saved.name, instructions: saved.instructions ?? '', model: saved.model });
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
      if (!renaming) { setSelectedId(created.id); setTab('profile'); }
      setCreateDialogOpen(false);
      setRenaming(null);
    });
  };

  const selectModel = (providerId: string, modelId: string) => {
    setModel(providerId && modelId ? { providerId, modelId } : null);
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
    if (action === 'profile') { if (chooseBot(bot.id)) selectTab('profile'); return; }
    if (action === 'memory') { if (chooseBot(bot.id)) selectTab('memory'); return; }
    void run(action, async () => {
      if (action === 'pin') await updateBot(bot.id, { pinned: !bot.pinnedAt });
      else if (action === 'archive') await archiveBot(bot.id);
      else await changeBotState(bot.id, action);
      await refresh();
    });
  };

  return <>
    <BotOrganizationDialog value={organizationDialog} onClose={() => setOrganizationDialog(null)} organization={organization} />
    {organization.error && !organizationDialog && <p role="alert" className="mb-4 typography-meta text-destructive">{organization.error} <button type="button" className="underline" onClick={() => { void organization.refresh(); }}>{t('common.retry')}</button></p>}
    {error ? <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="typography-meta text-destructive">{error}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => { void refresh(); }}>{t('settings.harness.retry')}</Button>
    </div> : null}
    {!bots && !error ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {bots ? <div className="@container min-w-0">
      <div className="mb-5 flex min-w-0 flex-wrap items-center justify-between gap-3">
        {selected ? <BotMenu bot={selected} persistentActions disabled={busy !== null || organization.pending} onAction={value => action(selected, value)} onMove={organization.ready ? () => setOrganizationDialog({ kind: 'move', bot: selected }) : undefined}>
          <div className="flex min-w-0 items-center gap-3 py-1 pr-2">
            <BotFigure bot={selected} state="idle" size={28} still />
            <div className="min-w-0">
              {!initialBotId && bots.length > 1 ? <DropdownMenu>
                <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={busy !== null}
                  aria-label={t('settings.bots.section.list')} className="-ml-2 h-8 max-w-full gap-2 text-base font-medium">
                  <span className="max-w-[min(50cqw,24rem)] truncate">{selected.name}</span><Icon name="arrow-down-s" className="size-3.5 shrink-0 text-muted-foreground" />
                </Button></DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56 max-w-[min(90vw,28rem)]">
                  <DropdownMenuRadioGroup value={selected.id} onValueChange={chooseBot}>
                    {organization.sections.filter(section => section.bots.length > 0).map(section => <React.Fragment key={section.group ? `group:${section.group.id}` : 'ungrouped'}>
                      {organization.value.groups.length > 0 && <DropdownMenuLabel>{section.group?.name ?? t('bot.groups.ungrouped')}</DropdownMenuLabel>}
                    {section.bots.map(bot => <DropdownMenuRadioItem key={bot.id} value={bot.id}>
                      <BotFigure bot={bot} state="idle" size={22} still />
                      <span className="min-w-0 flex-1 truncate">{bot.name}</span>
                      <span className="ml-3 shrink-0 typography-micro text-muted-foreground">{botStatusLabel(bot)}</span>
                    </DropdownMenuRadioItem>)}</React.Fragment>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu> : <p className="max-w-[min(50cqw,24rem)] truncate typography-settings-field-label">{selected.name}</p>}
              <p className="typography-meta text-muted-foreground">{botStatusLabel(selected)}</p>
            </div>
          </div>
        </BotMenu> : <p className="typography-meta text-muted-foreground">{t('settings.bots.empty')}</p>}
        <div className="flex flex-wrap items-center gap-1">
          {!initialBotId && <Button type="button" variant="ghost" size="sm" disabled={!organization.ready || organization.pending} onClick={() => setOrganizationDialog({ kind: 'create' })}><Icon name="folder-add" className="size-4" />{t('bot.groups.create')}</Button>}
          {selected ? <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => { if (confirmDiscard()) void run('entry', () => openBotEntryFor(selected.id)); }}>
            <Icon name="chat-1" className="size-4" />{t('settings.bots.openEntry')}
          </Button> : null}
          {!initialBotId ? <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => {
            if (!confirmDiscard()) return;
            discardProfile(); setCreateName(''); setError(null); setRenaming(null); setCreateDialogOpen(true);
          }}><Icon name="add" className="size-4" />{busy === 'create' ? t('settings.bots.creating') : t('settings.bots.create')}</Button> : null}
        </div>
      </div>
      {selected ? <SettingsTabs value={tab} onChange={selectTab} label={selected.name} items={[
        { value: 'profile', label: t('bot.profile.title'), controls: `${panelId}-profile` },
        { value: 'work', label: t('settings.bots.section.work'), controls: `${panelId}-work` },
        { value: 'memory', label: t('settings.bots.memory'), controls: `${panelId}-memory` },
      ]} /> : null}
      <div id={`${panelId}-profile`} role="tabpanel" aria-label={t('bot.profile.title')} className="settings-tab-panel" hidden={tab !== 'profile'}>
      {selected ? <div className="space-y-6">
        {selected.deletion || !selected.archived ? <BotActivityBanner bot={selected} busy={busy !== null} onAction={(value) => action(selected, value)} /> : null}
        <BotAppearanceSettings key={selected.id} bot={selected} disabled={locked} onChanged={saved => setBots(list => list?.map(item => item.id === saved.id ? saved : item) ?? null)} />
        <SettingsFieldRow label={t('settings.bots.name.label')}>
          <Input aria-label={t('settings.bots.name.label')} value={name} disabled={locked} onChange={(event) => setName(event.target.value)} />
        </SettingsFieldRow>
        <SettingsStackedField label={t('settings.bots.instructions.label')} description={t('settings.bots.instructions.description')} controlClassName="max-w-none">
          <Textarea aria-label={t('settings.bots.instructions.label')} value={instructions} disabled={locked} rows={7} className="min-h-40 w-full resize-y leading-relaxed"
            placeholder={t('settings.bots.instructions.placeholder')}
            onChange={(event) => setInstructions(event.target.value)} />
        </SettingsStackedField>
        <SettingsFieldRow label={t('settings.bots.model.label')} description={t('settings.bots.model.description')} className="border-t border-border/60 pt-5" controlClassName="w-full @xl:w-80">
          <BotModelSelector model={model} disabled={locked} onChange={selectModel}
            onThinkingChange={thinkingLevel => setModel(current => current ? { ...current, thinkingLevel } : null)} />
        </SettingsFieldRow>

      </div> : null}
      </div>
      <div id={`${panelId}-work`} role="tabpanel" aria-label={t('settings.bots.section.work')} className="settings-tab-panel" hidden={tab !== 'work'}>
      {selected ? <div className="space-y-3">
        {work?.length ? <p className="typography-meta text-muted-foreground">{t('settings.bots.work.summary', { count: work.length })}</p> : null}
        {work === null ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
        {work !== null && work.length === 0
          ? <p className="typography-meta text-muted-foreground">{t('settings.bots.work.empty')}</p> : null}
        <ul className="divide-y divide-border/60">
          {(work ?? []).map((item) => <li key={botWorkId(item)}
            className="flex flex-wrap items-center gap-3 py-3">
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
      </div> : null}
      </div>
      <div id={`${panelId}-memory`} role="tabpanel" aria-label={t('settings.bots.memory')} className="settings-tab-panel space-y-6" hidden={tab !== 'memory'}>
        {memoryOpened && selected ? <React.Suspense fallback={<p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}>
          <BotMemoryPanel key={selected.id} botId={selected.id} />
        </React.Suspense> : null}
        {memoryOpened ? <BotMemoryPreferences /> : null}
      </div>
      {selected && !selected.archived && !selected.deletion ? <SettingsActionBar dirty={dirty} saving={busy !== null} onSave={save} onCancel={discardProfile} saveDisabled={!name.trim()} saveLabel={t('settings.bots.save')} error={error} /> : null}
    </div> : null}
    {viewingDesktop ? <ComputerDesktopView desktop={viewingDesktop} open onOpenChange={(open) => { if (!open) setViewingDesktop(null); }} /> : null}
    <BotNameDialog
      open={createDialogOpen}
      title={t(renaming ? 'settings.bots.rename' : 'settings.bots.create')}
      submitLabel={t(renaming ? 'settings.bots.save' : 'settings.bots.createAction')}
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
  </>;
}
