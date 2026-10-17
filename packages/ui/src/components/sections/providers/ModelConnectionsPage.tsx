import React from 'react';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, registerRuntimeEndpointSwitchBlocker, MODEL_CATALOG_FIELDS, type ChannelModel, type ModelChannel, type ModelConnectionOptions, type ModelConnectionsSnapshot, type DiscoveredModel, type ConnectionAuthentication, type AuthorizationState } from '@varin/application-client';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { ConnectionSettings } from './ConnectionSettings';
import { ModelConfiguration } from './ModelConfiguration';
import { ModelSelection } from './ModelSelection';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';

const discoveryConfiguration = (channel: ModelChannel) => JSON.stringify([channel.type, channel.baseUrl, channel.connection, channel.authentication, channel.parameters]);
const providerEndpoint = (baseUrl: string) => {
  const url = new URL(baseUrl);
  return `${url.host}${url.pathname.replace(/\/$/, '')}`;
};

export function ModelConnectionsPage() {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <ModelConnectionsEditor key={host} host={host} />;
}

function ModelConnectionsEditor({ host }: { host: number }) {
  const { t } = useI18n();
  const api = React.useMemo(() => createModelConnectionsHttpAPI(host), [host]);
  const [snapshot, setSnapshot] = React.useState<ModelConnectionsSnapshot | null>(null);
  const [draft, setDraft] = React.useState<ModelChannel | null>(null);
  const [query, setQuery] = React.useState('');
  const [tab, setTab] = React.useState<'connection' | 'advanced'>('connection');
  const [selectedModelId, setSelectedModelId] = React.useState<string | null>(null);
  const [openedModels, setOpenedModels] = React.useState<Set<string>>(() => new Set());
  const [secret, setSecret] = React.useState('');
  const [candidates, setCandidates] = React.useState<DiscoveredModel[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [providerQuery, setProviderQuery] = React.useState('');
  const [baseRevision, setBaseRevision] = React.useState('');
  const [baseDraft, setBaseDraft] = React.useState('');
  const [catalogs, setCatalogs] = React.useState<Record<string, ChannelModel[]>>({});
  const [authorization, setAuthorization] = React.useState<AuthorizationState | null>(null);
  const [invalidFields, setInvalidFields] = React.useState<Set<string>>(() => new Set());
  const [editorGeneration, setEditorGeneration] = React.useState(0);
  const activeAuthorization = React.useRef<string | undefined>(undefined);
  const alive = React.useRef(true);
  const pendingAuthorization = React.useRef<Promise<AuthorizationState> | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    alive.current = true;
    setSnapshot(null); setDraft(null); setSecret(''); setError(null);
    void api.read(controller.signal).then(value => { if (!controller.signal.aborted) setSnapshot(value); }, error => { if (!controller.signal.aborted) setError(String(error)); });
    const stop = subscribeVarinEvents(event => {
      if (event.type === 'settings-changed' && event.owner === 'agent-settings' && (event.ids.includes('model-channels') || event.ids.includes('model-credentials'))) {
        void api.read(controller.signal).then(value => { if (!controller.signal.aborted) setSnapshot(value); }, error => { if (!controller.signal.aborted) setError(String(error)); });
      }
      if (event.type === 'settings-changed' && event.owner === 'agent-settings' && event.ids.includes('model-authorization') && activeAuthorization.current) {
        const id = activeAuthorization.current;
        void api.authorization(id, controller.signal).then(value => { if (!controller.signal.aborted && activeAuthorization.current === id) setAuthorization(value); }, error => { if (!controller.signal.aborted && activeAuthorization.current === id) setError(String(error)); });
      }
    });
    const stopSwitch = registerRuntimeEndpointSwitchBlocker(async () => {
      const pending = await pendingAuthorization.current?.catch(() => undefined);
      const id = activeAuthorization.current ?? pending?.id;
      if (id) await api.cancelAuthorization(id);
      activeAuthorization.current = undefined;
      if (alive.current) setAuthorization(null);
    });
    return () => { stopSwitch(); alive.current = false; controller.abort(); stop(); const id = activeAuthorization.current; activeAuthorization.current = undefined; if (id) void api.cancelAuthorization(id).catch(() => {}); };
  }, [api]);
  const cancelAuthorization = () => { const id = activeAuthorization.current; activeAuthorization.current = undefined; if (id) void api.cancelAuthorization(id).catch(() => {}); setAuthorization(null); };
  const closeEditor = () => { cancelAuthorization(); setDraft(null); setSecret(''); setError(null); };
  const choose = (channel: ModelChannel) => { cancelAuthorization(); setSelectedModelId(null); setOpenedModels(new Set()); setInvalidFields(new Set()); setEditorGeneration(value => value + 1); setDraft(structuredClone(channel)); setBaseDraft(JSON.stringify(channel)); setBaseRevision(snapshot!.revision); setCandidates([]); setSecret(''); setTab('connection'); setAdding(false); setError(null); };
  const typeInfo = snapshot?.types.find(type => type.id === draft?.type);
  const savedChannel = snapshot?.channels.find(channel => channel.id === draft?.id);
  const accountDirectory = Boolean(draft && savedChannel && !secret && discoveryConfiguration(draft) === discoveryConfiguration(savedChannel));
  const catalogKey = draft ? `${draft.id}:${accountDirectory ? 'account' : 'public'}` : '';
  const type = typeInfo ? { ...typeInfo, catalog: catalogs[catalogKey] ?? [] } : undefined;
  const selectedType = draft?.type;
  React.useEffect(() => {
    if (!selectedType) return;
    const controller = new AbortController();
    void api.directory(selectedType, controller.signal, accountDirectory ? draft?.id : undefined).then(value => { if (!controller.signal.aborted) setCatalogs(previous => ({ ...previous, [catalogKey]: value.models })); }, error => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, [api, selectedType, draft?.id, accountDirectory, catalogKey, snapshot?.directory?.revision]);
  const dirty = Boolean(draft && (!savedChannel || secret || invalidFields.size || JSON.stringify(draft) !== baseDraft));
  React.useEffect(() => {
    if (!dirty && savedChannel) { setDraft(structuredClone(savedChannel)); setBaseDraft(JSON.stringify(savedChannel)); setBaseRevision(snapshot!.revision); }
  }, [dirty, savedChannel, snapshot]);
  const edit = (patch: Partial<ModelChannel>) => {
    if (draft && discoveryConfiguration({ ...draft, ...patch }) !== discoveryConfiguration(draft)) setCandidates([]);
    setDraft(value => value ? { ...value, ...patch } : value);
  };
  const editModels = (models: ChannelModel[]) => edit({ models: models.map(model => {
    const previous = draft?.models.find(value => value.id === model.id);
    if (!previous?.catalog || !model.catalog) return model;
    const changed = MODEL_CATALOG_FIELDS.filter(field => JSON.stringify(previous[field]) !== JSON.stringify(model[field]));
    return { ...model, catalog: { ...model.catalog, overrides: [...new Set([...model.catalog.overrides, ...changed])] } };
  }) });
  const editConnection = (patch: Partial<ModelConnectionOptions>) => {
    if (!draft) return;
    const connection = { ...draft.connection, ...patch };
    for (const key of Object.keys(connection) as (keyof ModelConnectionOptions)[]) if (connection[key] === undefined) delete connection[key];
    edit({ connection: Object.keys(connection).length ? connection : undefined });
  };
  const validity = (key: string, valid: boolean) => setInvalidFields(previous => {
    if (previous.has(key) === !valid) return previous;
    const next = new Set(previous); if (valid) next.delete(key); else next.add(key); return next;
  });
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); return true; }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { if (alive.current) setBusy(false); }
  };
  const save = () => run(async () => {
    if (!draft) return;
    let channel = draft;
    if (secret && channel.authentication.kind === 'credential') {
      const { reference } = await api.storeCredential(secret);
      channel = { ...channel, authentication: { kind: 'credential', reference } };
      if (alive.current) { setDraft(channel); setSecret(''); }
    }
    const next = await api.save(channel, baseRevision);
    if (alive.current) { const saved = next.channels.find(value => value.id === channel.id)!; setSnapshot(next); setDraft(structuredClone(saved)); setBaseDraft(JSON.stringify(saved)); setBaseRevision(next.revision); }
  });
  const signIn = (provider: string) => { if (draft) void run(async () => {
    const reference = draft.authentication.kind === 'credential' && draft.authentication.reference || `model:${draft.id}`;
    const pending = api.signIn(provider, reference); pendingAuthorization.current = pending;
    let state: AuthorizationState;
    try { state = await pending; } finally { if (pendingAuthorization.current === pending) pendingAuthorization.current = null; }
    if (!alive.current) { await api.cancelAuthorization(state.id); return; }
    activeAuthorization.current = state.id;
    edit({ authentication: { kind: 'credential', reference } }); setSecret('');
    const next = await api.authorization(state.id);
    if (alive.current && activeAuthorization.current === state.id) setAuthorization(next);
  }); };
  const addChannel = (id: string) => { void run(async () => {
    const selected = snapshot!.types.find(type => type.id === id)!;
    const { models } = await api.directory(id);
    if (!alive.current) return;
    const channelId = crypto.randomUUID();
    setCatalogs(previous => ({ ...previous, [`${channelId}:public`]: models }));
    const kind = selected.authentication[0]!;
    const starters = models.filter(model => selected.defaultModelIds?.includes(model.id) || model.enabled).slice(0, 3);
    choose({ id: channelId, name: selected.name, type: id, enabled: true, baseUrl: selected.defaultBaseUrl ?? '',
      authentication: kind === 'credential' ? { kind, reference: '' } : kind === 'environment' ? { kind, variable: '' } : { kind } as ConnectionAuthentication,
      parameters: structuredClone(selected.defaultParameters ?? {}), models: structuredClone((starters.length ? starters : models.slice(0, 3)).map(model => ({ ...model, enabled: true, catalog: { overrides: [] } }))) });
  }); };
  const back = () => selectedModelId ? setSelectedModelId(null) : draft ? requestSettingsNavigation(closeEditor) : setAdding(false);
  const selectedModel = draft?.models.find(model => model.id === selectedModelId);
  const title = selectedModel ? selectedModel.name || selectedModel.id : draft ? draft.name || type?.name : adding ? t('settings.models.addChannel') : t('settings.models.title');
  return <SettingsPageLayout title={title} className="max-w-[1120px]"
    titleLeading={draft || adding ? <Button variant="ghost" size="icon" aria-label={t('settings.models.back')} disabled={busy} onClick={back}><Icon name="arrow-left-s" className="size-5" /></Button> : undefined}
    description={selectedModel ? `${draft!.name} / ${selectedModel.id}` : draft ? (type?.name !== draft.name ? type?.name : undefined) : adding ? t('settings.models.chooseProvider') : t('settings.models.description')}
    headerEnd={!draft ? <div className="flex gap-2"><Button variant="ghost" disabled={busy || snapshot?.directory?.refreshing} onClick={() => { void run(async () => { await api.refreshDirectory(); if (alive.current) setSnapshot(await api.read()); }); }}><Icon name="refresh" className={snapshot?.directory?.refreshing ? 'size-4 animate-spin' : 'size-4'} />{t('settings.models.refreshDirectory')}</Button>{!adding ? <Button disabled={busy || !snapshot?.types.length} onClick={() => { setAdding(true); setProviderQuery(''); }}><Icon name="add" className="size-4" />{t('settings.models.addChannel')}</Button> : null}</div> : !selectedModel ? <Switch aria-label={t('settings.models.enabled')} checked={draft.enabled} disabled={busy} onCheckedChange={enabled => edit({ enabled })} /> : undefined}>
    {snapshot?.directory ? <p role="status" className="mb-4 typography-micro text-muted-foreground">{snapshot.directory.issue ? t(`settings.models.directoryIssue.${snapshot.directory.issue}`) : t(snapshot.directory.refreshing ? 'settings.models.directoryRefreshing' : 'settings.models.directoryAutomatic')}{snapshot.directory.updatedAt ? ` · ${new Date(snapshot.directory.updatedAt).toLocaleString()}` : ''}</p> : null}
    {error && !draft ? <p role="alert" className="mb-4 typography-meta text-destructive">{error}</p> : null}
    {snapshot?.issues?.map((issue, index) => <p key={index} role="alert" className="mb-3 typography-meta text-destructive">{issue.channelId ? `${issue.channelId}: ` : ''}{issue.message}</p>)}
    {!snapshot ? error ? <Button variant="outline" disabled={busy} onClick={() => { void run(async () => setSnapshot(await api.read())); }}>{t('settings.harness.retry')}</Button> : <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : <>
      {!draft && adding ? <>
        <Input aria-label={t('settings.models.filterProviders')} placeholder={t('settings.models.filterProviders')} value={providerQuery} onChange={event => setProviderQuery(event.target.value)} className="mb-6 max-w-sm" />
        <div className="grid gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
          {snapshot.types.filter(type => `${type.name} ${type.id}`.toLowerCase().includes(providerQuery.toLowerCase())).map(type => <button key={type.id} type="button" disabled={busy} onClick={() => addChannel(type.id)} className="group flex items-center gap-4 rounded-xl border border-border/60 p-5 text-left transition-colors hover:border-border hover:bg-interactive-hover">
            <ProviderLogo providerId={type.id} className="size-7 shrink-0" /><span className="min-w-0 flex-1"><span className="block typography-ui-label">{type.name}</span><span title={type.defaultBaseUrl} className="mt-1 block truncate typography-micro text-muted-foreground">{type.defaultBaseUrl ? providerEndpoint(type.defaultBaseUrl) : t('settings.models.customEndpoint')}</span>{type.oauthProviders?.length ? <span className="mt-2 inline-block rounded bg-muted px-1.5 py-0.5 typography-micro text-muted-foreground">{t('settings.models.accountSignIn')}</span> : null}</span><Icon name="arrow-right-s" className="size-4 text-muted-foreground" />
          </button>)}
        </div>
      </> : null}
      {!draft && !adding ? <>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><span className="typography-meta text-muted-foreground">{t('settings.models.services')} · {snapshot.channels.length}</span><Input aria-label={t('settings.models.filterServices')} placeholder={t('settings.models.filterServices')} value={query} onChange={event => setQuery(event.target.value)} className="h-9 w-full @lg:w-64" /></div>
        {snapshot.channels.length === 0 ? <div className="rounded-xl border border-dashed border-border px-6 py-14 text-center"><Icon name="cloud" className="mx-auto mb-4 size-8 text-muted-foreground" /><h2 className="typography-ui-label">{t('settings.models.emptyTitle')}</h2><p className="mt-2 typography-meta text-muted-foreground">{t('settings.models.emptyHint')}</p><Button className="mt-5" onClick={() => setAdding(true)}>{t('settings.models.addChannel')}</Button></div> : <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
          {snapshot.channels.filter(channel => `${channel.name} ${channel.type} ${channel.baseUrl}`.toLowerCase().includes(query.toLowerCase())).map(channel => <div key={channel.id} className="flex items-center gap-4 px-4 py-5 @xl:px-5">
            <ProviderLogo providerId={channel.type} className="size-7 shrink-0" />
            <button type="button" aria-label={channel.name} disabled={busy} onClick={() => choose(channel)} className="min-w-0 flex-1 text-left"><span className="block truncate typography-ui-label">{channel.name}</span><span className="mt-1 block truncate typography-micro text-muted-foreground">{channel.baseUrl}</span><span className="mt-2 block typography-micro text-muted-foreground">{channel.models.filter(model => model.enabled).length} {t('settings.models.models')} · {t(channel.enabled ? 'settings.models.enabled' : 'settings.models.disabled')}</span></button>
            <Switch aria-label={`${t('settings.models.enabled')}: ${channel.name}`} checked={channel.enabled} disabled={busy} onCheckedChange={enabled => { void run(async () => { const next = await api.save({ ...channel, enabled }, snapshot.revision); if (alive.current) setSnapshot(next); }); }} />
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => choose(channel)}>{t('settings.models.manage')}<Icon name="arrow-right-s" className="size-4" /></Button>
          </div>)}
        </div>}
      </> : null}
      {draft && type ? <div key={`${draft.id}:${draft.type}:${editorGeneration}`}>
        <div hidden={selectedModelId !== null}>
          <div role="tablist" aria-label={t('settings.models.title')} className="mb-6 flex gap-6 border-b border-border/60">
            {(['connection', 'advanced'] as const).map(value => <button type="button" key={value} role="tab" aria-selected={tab === value} aria-controls={`model-channel-${value}`} id={`model-tab-${value}`} tabIndex={tab === value ? 0 : -1}
              onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'connection' : event.key === 'End' ? 'advanced' : value === 'connection' ? 'advanced' : 'connection'; setTab(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#model-tab-${next}`)?.focus(); }}
              onClick={() => setTab(value)} className={cn('border-b-2 pb-3 typography-meta', tab === value ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground')}>{t(value === 'connection' ? 'settings.models.connectionModels' : 'settings.models.advanced')}</button>)}
          </div>
          <ConnectionSettings draft={draft} type={type} busy={busy} advanced={tab === 'advanced'} secret={secret} authorization={authorization} edit={edit} editConnection={editConnection} validity={validity}
            setSecret={value => { setSecret(value); setCandidates([]); }} cancelAuthorization={cancelAuthorization} onSignIn={signIn}
            onSignOut={() => { void run(async () => { if (draft.authentication.kind === 'credential') await api.removeCredential(draft.authentication.reference); if (alive.current) edit({ authentication: { kind: 'credential', reference: '' } }); }); }}
            onAuthorizationReply={value => api.replyAuthorization(authorization!.id, value)} onAuthorizationCancel={async () => { await api.cancelAuthorization(authorization!.id); if (alive.current) { activeAuthorization.current = undefined; setAuthorization(null); } }} />
          <div hidden={tab !== 'connection'} id="model-channel-connection" role="tabpanel" aria-labelledby="model-tab-connection">
            <ModelSelection models={draft.models} type={type} candidates={candidates} busy={busy} onChange={editModels}
              onFollow={(id, field) => edit({ models: draft.models.map(model => {
                if (model.id !== id) return model;
                const defaults = type.catalog?.find(value => value.id === id);
                if (!defaults) return model;
                if (field) { const next = { ...model, catalog: { ...defaults.catalog, overrides: model.catalog?.overrides.filter(value => value !== field) ?? MODEL_CATALOG_FIELDS.filter(value => value !== field) } }; if (defaults[field] === undefined) delete next[field]; else Object.assign(next, { [field]: structuredClone(defaults[field]) }); return next; }
                return { ...structuredClone(defaults), enabled: model.enabled, catalog: { ...defaults.catalog, overrides: [] } };
              }) })}
              onConfigure={id => { setOpenedModels(previous => new Set(previous).add(id)); setSelectedModelId(id); }}
              validity={(id, field, valid) => validity(`${id}:${field}`, valid)}
              onDiscover={() => run(async () => { const result = await api.discoverDraft({ channel: draft, ...(secret ? { secret } : {}) }); if (alive.current) setCandidates(result.models); })} />
          </div>
          <div hidden={tab !== 'advanced'} id="model-channel-advanced" role="tabpanel" aria-labelledby="model-tab-advanced" className="mt-6 border-t border-border/60 pt-5"><Button variant="ghost" className="text-destructive" disabled={busy} onClick={() => {
            if (!window.confirm(t('settings.models.removeConfirm'))) return;
            if (savedChannel) void run(async () => { const next = await api.remove(draft.id, baseRevision); if (alive.current) { setSnapshot(next); closeEditor(); } }); else closeEditor();
          }}>{t('settings.models.removeService')}</Button></div>
        </div>
        {draft.models.filter(model => openedModels.has(model.id)).map(model => <div key={model.id} hidden={selectedModelId !== model.id}>
          <ModelConfiguration model={model} type={type} busy={busy} selected={selectedModelId === model.id} validity={(field, valid) => validity(`${model.id}:${field}`, valid)}
            onChange={next => editModels(draft.models.map(value => value.id === model.id ? next : value))}
            onRemove={() => { edit({ models: draft.models.filter(value => value.id !== model.id) }); setSelectedModelId(null); setInvalidFields(previous => new Set([...previous].filter(key => !key.startsWith(`${model.id}:`)))); }}
            onTest={(thinkingLevel, signal) => api.test({ key: crypto.randomUUID(), channel: draft, ...(secret ? { secret } : {}), modelId: model.id, thinkingLevel }, signal)} />
        </div>)}
        <SettingsActionBar dirty={dirty} saving={busy} onSave={save} onCancel={() => { if (savedChannel) choose(savedChannel); else closeEditor(); }} saveDisabled={invalidFields.size > 0 || authorization?.status === 'pending' || !draft.name.trim()} saveLabel={t('settings.models.save')} error={error} />
      </div> : null}
    </>}
  </SettingsPageLayout>;
}
