import React from 'react';
import {
  defaultBotAppearance, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged,
  type BotAppearance, type BotModelSelection, type BotUpdateInput,
} from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SettingsActionBar } from '@/components/sections/shared/SettingsActionBar';
import { SettingsNavigationContext } from '@/components/sections/shared/settings-context';
import { Area, Btn, Catalog, CatalogItem, Empty, Field, Loading, Note, Section, useSettingsShell } from '@/components/sections/shared/kit';
import { SettingsTabs } from '../shared/SettingsTabs';
import { useI18n } from '@/lib/i18n';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { archiveBot, changeBotState, createBot, listBots, openBotEntryFor, updateBot, type BotSummary } from '@/lib/bots';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useUIStore } from '@/stores/useUIStore';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { useBotOrganization } from '@/workbenches/bot/useBotOrganization';
import { BotOrganizationDialog, type BotOrganizationDialogState } from '@/workbenches/bot/BotOrganizationDialog';
import { BotAppearanceSettings } from './BotAppearanceSettings';
import { BotModelSelector } from './BotModelSelector';
import { BotNameDialog } from './BotNameDialog';
import { BotMenu, type BotMenuAction } from './BotMenu';
import { BotDeleteDialog } from './BotDeleteDialog';
import { BotActivityBanner } from './BotActivityBanner';
import './bot-settings.css';

const BotMemoryPanel = React.lazy(() => import('./BotDetailsDialog').then(module => ({ default: module.BotMemoryPanel })));
type Tab = 'profile' | 'memory';
type Profile = { name: string; instructions: string; model: BotModelSelection | null; appearance: BotAppearance };
type Draft = { id: string; base: Profile; value: Profile };
type Props = {
  initialBotId?: string;
  embedded?: boolean;
  onDeleted?(): void;
  onDraftStateChange?(state: { dirty: boolean; saving: boolean }): void;
};

const profileOf = (bot: BotSummary): Profile => ({
  name: bot.name, instructions: bot.instructions ?? '', model: bot.model, appearance: bot.appearance ?? defaultBotAppearance(),
});

function profilePatch(base: Profile, value: Profile): BotUpdateInput {
  const patch: BotUpdateInput = {};
  if (base.name !== value.name) patch.name = value.name.trim();
  if (base.instructions !== value.instructions) patch.instructions = value.instructions.trim() ? value.instructions : null;
  if (base.model?.providerId !== value.model?.providerId || base.model?.modelId !== value.model?.modelId
    || base.model?.thinkingLevel !== value.model?.thinkingLevel) patch.model = value.model;
  if (JSON.stringify(base.appearance) !== JSON.stringify(value.appearance)) patch.appearance = value.appearance;
  return patch;
}

function DirectorySection({ name, archived, open, onToggle, children }: React.PropsWithChildren<{
  name: string; archived?: boolean; open: boolean; onToggle?(): void;
}>) {
  const heading = <><Icon name={archived ? 'archive' : 'folder'} className="size-4" />
    <span className="min-w-0 flex-1 truncate" title={name}>{name}</span></>;
  return <div className={archived ? 'bot-settings-archive' : 'bot-settings-group'}>
    {onToggle ? <button type="button" className="bot-settings-group-toggle" aria-expanded={open} onClick={onToggle}>
      {heading}<Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
    </button> : <div className="bot-settings-group-toggle">{heading}</div>}
    {open && <div className={archived ? undefined : 'bot-settings-group-items'}>{children}</div>}
  </div>;
}

export function BotSettingsPage() {
  const focus = useUIStore(state => state.settingsCatalogSelection);
  return <BotSettings initialBotId={focus ?? undefined} />;
}

export function BotSettings(props: Props = {}) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <BotSettingsForHost key={host} host={host} {...props} />;
}

function BotSettingsForHost({ host, initialBotId, embedded = false, onDeleted, onDraftStateChange }: Props & { host: number }) {
  const { t } = useI18n();
  const shell = useSettingsShell();
  const guardedNavigation = React.useContext(SettingsNavigationContext);
  const panelId = React.useId();
  const [tab, setTab] = React.useState<Tab>('profile');
  const [memoryOpened, setMemoryOpened] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set());
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [bots, setBots] = React.useState<BotSummary[] | null>(null);
  const organization = useBotOrganization(bots);
  const [selectedId, setSelectedId] = React.useState<string | null>(initialBotId ?? null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState('');
  const [deleting, setDeleting] = React.useState<BotSummary | null>(null);
  const [organizationDialog, setOrganizationDialog] = React.useState<BotOrganizationDialogState | null>(null);
  const requests = React.useRef({ version: 0 });
  const initialArchived = React.useRef(initialBotId);

  const selected = bots?.find(bot => bot.id === selectedId) ?? null;
  const activeDraft = draft?.id === selectedId ? draft : null;
  const profile = selected ? activeDraft?.value ?? profileOf(selected) : null;
  const patch = activeDraft ? profilePatch(activeDraft.base, activeDraft.value) : {};
  const dirty = Object.keys(patch).length > 0;
  const locked = Boolean(selected?.archived || selected?.deletion || busy);

  React.useEffect(() => { onDraftStateChange?.({ dirty, saving: busy !== null }); }, [dirty, busy, onDraftStateChange]);
  const edit = (change: Partial<Profile>) => {
    if (!selected) return;
    setSaveError(null);
    setDraft(current => {
      const base = current?.id === selected.id ? current.base : profileOf(selected);
      const value = { ...(current?.id === selected.id ? current.value : base), ...change };
      return Object.keys(profilePatch(base, value)).length > 0 ? { id: selected.id, base, value } : null;
    });
  };
  const discard = () => { setSaveError(null); setDraft(null); };
  const navigate = (proceed: () => void) => {
    if (busy) return;
    if (guardedNavigation) requestSettingsNavigation(proceed);
    else if (!dirty || window.confirm(t('settings.bots.discardConfirm'))) { discard(); proceed(); }
  };
  const selectTab = (next: Tab) => {
    setTab(next);
    if (next === 'memory') setMemoryOpened(true);
  };
  const choose = (id: string) => {
    if (id === selectedId) { shell.setCatalogStage('detail'); return; }
    navigate(() => {
      setSelectedId(id);
      setMemoryOpened(tab === 'memory');
      shell.setCatalogStage('detail');
    });
  };

  const refresh = React.useCallback(async () => {
    const request = ++requests.current.version;
    try {
      const list = await listBots();
      if (request !== requests.current.version || host !== getRuntimeEndpointGeneration()) return;
      setBots(list);
      setError(null);
      setSelectedId(current => list.some(bot => bot.id === current) ? current : list.find(bot => !bot.archived)?.id ?? list[0]?.id ?? null);
      if (initialArchived.current && list.some(bot => bot.id === initialArchived.current && bot.archived)) setArchiveOpen(true);
      initialArchived.current = undefined;
      if (embedded && initialBotId && !list.some(bot => bot.id === initialBotId)) onDeleted?.();
    } catch (cause) {
      if (request === requests.current.version && host === getRuntimeEndpointGeneration()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [embedded, host, initialBotId, onDeleted]);

  React.useEffect(() => {
    const generation = requests.current;
    void refresh();
    const unsubscribe = subscribeVarinEvents(event => {
      if (event.type === 'bot-changed' || event.type === 'stream-ready') void refresh();
    });
    return () => { generation.version++; unsubscribe(); };
  }, [refresh]);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    if (key !== 'save') setError(null);
    try {
      await task();
      return true;
    } catch (cause) {
      if (host === getRuntimeEndpointGeneration()) {
        (key === 'save' ? setSaveError : setError)(cause instanceof Error ? cause.message : String(cause));
      }
      return false;
    } finally {
      setBusy(null);
    }
  };
  const accept = (saved: BotSummary) => {
    requests.current.version++;
    setBots(list => list?.some(bot => bot.id === saved.id)
      ? list.map(bot => bot.id === saved.id && bot.revision <= saved.revision ? saved : bot)
      : [...(list ?? []), saved]);
  };
  const save = () => {
    if (!selected || !profile?.name.trim() || !dirty || locked) return Promise.resolve(false);
    return run('save', async () => {
      const saved = await updateBot(selected.id, patch);
      if (host !== getRuntimeEndpointGeneration()) return;
      accept(saved);
      discard();
    });
  };

  const action = (bot: BotSummary, choice: BotMenuAction) => {
    if (choice === 'rename' || choice === 'profile' || choice === 'memory') return;
    if (choice === 'delete') { navigate(() => setDeleting(bot)); return; }
    const change = () => { void run(choice, async () => {
      const updated = choice === 'pin' ? await updateBot(bot.id, { pinned: !bot.pinnedAt })
        : choice === 'archive' ? await archiveBot(bot.id) : await changeBotState(bot.id, choice);
      if (host !== getRuntimeEndpointGeneration()) return;
      accept(updated);
      if (choice === 'archive') setArchiveOpen(true);
      await refresh();
    }); };
    if (choice === 'archive') navigate(change);
    else change();
  };

  const submitCreate = (name: string, appearance?: BotAppearance) => {
    void run('create', async () => {
      const created = await createBot({ name, appearance });
      if (host !== getRuntimeEndpointGeneration()) return;
      accept(created);
      setQuery('');
      setSelectedId(created.id);
      selectTab('profile');
      shell.setCatalogStage('detail');
      setCreateOpen(false);
    });
  };

  const search = query.trim().toLocaleLowerCase();
  const matches = (bot: BotSummary) => bot.name.toLocaleLowerCase().includes(search);
  const archived = bots?.filter(bot => bot.archived && matches(bot)) ?? [];
  const row = (bot: BotSummary) => <CatalogItem key={bot.id} selected={bot.id === selectedId} onSelect={() => choose(bot.id)}
    lead={<BotFigure bot={bot} state="idle" size={27} still />} name={bot.name} title={bot.name} opensDetail={false}
    end={bot.pinnedAt ? <Icon name="pushpin" className="size-3.5" aria-label={t('settings.bots.unpin')} /> : undefined} />;
  const sections = organization.sections.map(({ group, bots }) => ({
    group, members: bots.filter(bot => !bot.archived && (matches(bot) || group?.name.toLocaleLowerCase().includes(search))),
  }));
  const toggleGroup = (id: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const directory = <>
    {!bots && !error && <Loading />}
    {organization.error && !organizationDialog && <Note kind="err" actions={<Btn sm onClick={() => void organization.refresh()}>{t('common.retry')}</Btn>}>{organization.error}</Note>}
    {error && !bots && <Note kind="err" actions={<Btn sm onClick={() => void refresh()}>{t('common.retry')}</Btn>}>{error}</Note>}
    {sections.map(({ group, members }) => group ? (!search || members.length || group.name.toLocaleLowerCase().includes(search)) &&
      <DirectorySection key={group.id} name={group.name} open={Boolean(search) || !collapsed.has(group.id)}
        onToggle={search ? undefined : () => toggleGroup(group.id)}>{members.map(row)}</DirectorySection> : members.map(row))}
    {archived.length > 0 && <DirectorySection name={t('settings.bots.archived')} archived
      open={Boolean(search) || archiveOpen} onToggle={search ? undefined : () => setArchiveOpen(value => !value)}>{archived.map(row)}</DirectorySection>}
    {bots && search && !archived.length && !sections.some(section => section.members.length || section.group?.name.toLocaleLowerCase().includes(search))
      && <p className="px-2 py-4 typography-meta text-muted-foreground">{t('settings.bots.noMatches')}</p>}
  </>;

  const bar = selected && !selected.archived && !selected.deletion ? <SettingsActionBar dirty={dirty}
    saving={busy === 'save'} onSave={save} onCancel={discard} saveDisabled={!profile?.name.trim() || locked}
    saveLabel={t('settings.bots.save')} error={saveError} /> : null;
  const details = selected && profile ? <>
    <header className="bot-settings-header">
      <BotFigure appearance={profile.appearance} state="idle" size={72} still portrait />
      <div className="bot-settings-identity">
        <label className="bot-settings-name">
          <Field width="wn" aria-label={t('settings.bots.name.label')} value={profile.name} disabled={locked}
            onChange={event => edit({ name: event.target.value })} />
          {!locked && <Icon name="pencil" className="size-3.5" />}
        </label>
        <BotAppearanceSettings key={selected.id} bot={{ ...selected, ...profile }} disabled={locked} onApply={appearance => edit({ appearance })} />
      </div>
      <div className="bot-settings-header-actions">
        {!selected.archived && !selected.deletion && <Button type="button" variant="outline" size="sm" disabled={locked}
          onClick={() => navigate(() => { void run('entry', () => openBotEntryFor(selected.id)); })}>
          <Icon name="chat-1" className="size-4" />{t('settings.bots.openConversation')}
        </Button>}
        <BotMenu bot={selected} disabled={busy !== null || organization.pending}
          onAction={value => action(selected, value)}
          onMove={organization.ready ? () => setOrganizationDialog({ kind: 'move', bot: selected }) : undefined} />
      </div>
    </header>
    {!createOpen && error && <Note kind="err">{error}</Note>}
    <BotActivityBanner bot={selected} busy={busy !== null} onAction={value => action(selected, value)} />
    <SettingsTabs value={tab} onChange={selectTab} label={selected.name} items={[
      { value: 'profile', label: t('bot.profile.title'), controls: panelId + '-profile' },
      { value: 'memory', label: t('assistant.memory.title'), controls: panelId + '-memory' },
    ]} />
    <div id={panelId + '-profile'} role="tabpanel" aria-label={t('bot.profile.title')} className="settings-tab-panel" hidden={tab !== 'profile'}>
      <Section title={t('settings.bots.model.label')}>
        <BotModelSelector model={profile.model} disabled={locked}
          onChange={(providerId, modelId) => edit({ model: providerId && modelId ? { providerId, modelId } : null })}
          onThinkingChange={thinkingLevel => edit({ model: profile.model ? { ...profile.model, thinkingLevel } : null })} />
      </Section>
      <Section title={t('settings.bots.instructions.label')} raw>
        <Area aria-label={t('settings.bots.instructions.label')} value={profile.instructions} disabled={locked} rows={6}
          placeholder={t('settings.bots.instructions.placeholder')}
          onChange={event => edit({ instructions: event.target.value })} />
      </Section>
    </div>
    <div id={panelId + '-memory'} role="tabpanel" aria-label={t('assistant.memory.title')} className="settings-tab-panel" hidden={tab !== 'memory'}>
      {memoryOpened && <React.Suspense fallback={<Loading />}><BotMemoryPanel key={selected.id} botId={selected.id} /></React.Suspense>}
    </div>
  </> : bots ? <Empty icon="robot" title={t('settings.bots.empty')} /> : error
    ? <Note kind="err" actions={<Btn sm onClick={() => void refresh()}>{t('common.retry')}</Btn>}>{error}</Note> : <Loading />;

  const newBot = () => navigate(() => { setCreateName(''); setError(null); setCreateOpen(true); });

  return <>
    {embedded ? <div className="sk bot-settings-embedded relative min-w-0">{details}{bar}</div> :
      <Catalog className="bot-settings-catalog" title={t('settings.page.harness.page.bots.title')}
        headActions={<>
          <Btn sm icon="add" disabled={!bots || busy !== null} onClick={newBot}>{t('settings.bots.create')}</Btn>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Btn kind="ghost" sm icon="more" aria-label={t('settings.bots.actions')} /></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!organization.ready || organization.pending} onSelect={() => setOrganizationDialog({ kind: 'create' })}>
                <Icon name="folder-add" className="size-4" />{t('bot.groups.create')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>}
        filter={{ value: query, onChange: setQuery, placeholder: t('settings.bots.search') }}
        items={directory} detail={details} detailKey={selected?.id} dock={bar} />}
    <BotOrganizationDialog value={organizationDialog} onClose={() => setOrganizationDialog(null)} organization={organization} />
    <BotNameDialog open={createOpen} mode="create" title={t('settings.bots.create')} submitLabel={t('settings.bots.createAction')} name={createName}
      busy={busy === 'create'} error={error} onNameChange={setCreateName}
      onOpenChange={open => { if (busy !== 'create') { setCreateOpen(open); setError(null); } }}
      onSubmit={submitCreate} />
    {deleting && <BotDeleteDialog key={deleting.id} bot={deleting} onClose={() => setDeleting(null)} onAccepted={bot => {
      setBots(list => list?.flatMap(item => item.id === deleting.id ? bot ? [bot] : [] : [item]) ?? null);
      void refresh();
    }} />}
  </>;
}
