import React from 'react';
import { applyModelDirectoryDefaults, createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, registerRuntimeEndpointSwitchBlocker, type AgentSettingsSnapshot, type ChannelModel, type ModelChannel, type ModelConnectionOptions, type DiscoveredModel, type ConnectionAuthentication, type AuthorizationState, type ModelConnectionTestResult } from '@varin/application-client';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { SettingsPageLink } from '../shared/SettingsPageLink';
import { ConnectionSettings } from './ConnectionSettings';
import { accountSignInProviders } from './account-sign-in';
import { ModelConfigurationDrawer } from './ModelConfiguration';
import { ModelPicker, ModelSelection } from './ModelSelection';
import { addModels, editModel, followModel, modelCandidates } from './model-edits';
import { useModelConnectionWrites } from './useModelConnectionWrites';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

type ConnectionDraft = Pick<ModelChannel, 'name' | 'baseUrl' | 'authentication' | 'parameters' | 'connection'>;
const connectionDraft = ({ name, baseUrl, authentication, parameters, connection }: ModelChannel): ConnectionDraft => structuredClone({ name, baseUrl, authentication, parameters, connection });
const discoveryConfiguration = (channel: ModelChannel) => JSON.stringify([channel.type, channel.baseUrl, channel.connection, channel.authentication, channel.parameters]);
const providerEndpoint = (baseUrl: string) => { try { const url = new URL(baseUrl); return `${url.host}${url.pathname.replace(/\/$/, '')}`; } catch { return baseUrl; } };

export function ModelConnectionsPage() {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <ModelConnectionsEditor key={host} host={host} />;
}

function ModelConnectionsEditor({ host }: { host: number }) {
  const { t } = useI18n();
  const api = React.useMemo(() => createModelConnectionsHttpAPI(host), [host]);
  const read = React.useCallback(() => api.read(), [api]);
  const { snapshot, saving, error, setError, reset, refresh, enqueue } = useModelConnectionWrites(read);
  const [settings, setSettings] = React.useState<AgentSettingsSnapshot | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<ConnectionDraft | null>(null);
  const [baseDraft, setBaseDraft] = React.useState('');
  const [showDetail, setShowDetail] = React.useState(false);
  const [newChannel, setNewChannel] = React.useState<ModelChannel | null>(null);
  const [step, setStep] = React.useState<0 | 1 | 2 | null>(null);
  const [query, setQuery] = React.useState('');
  const [providerQuery, setProviderQuery] = React.useState('');
  const [selectedModelId, setSelectedModelId] = React.useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [secret, setSecret] = React.useState('');
  const [candidates, setCandidates] = React.useState<DiscoveredModel[]>([]);
  const [catalog, setCatalog] = React.useState<{ key: string; models: ChannelModel[] }>({ key: '', models: [] });
  const [connectionResult, setConnectionResult] = React.useState<string | null>(null);
  const [connectionFailure, setConnectionFailure] = React.useState<string | null>(null);
  const [passed, setPassed] = React.useState<Record<string, string>>({});
  const [working, setWorking] = React.useState(false);
  const [authorization, setAuthorization] = React.useState<AuthorizationState | null>(null);
  const [invalidFields, setInvalidFields] = React.useState<Set<string>>(() => new Set());
  const [editorGeneration, setEditorGeneration] = React.useState(0);
  const activeAuthorization = React.useRef<string | undefined>(undefined);
  const pendingAuthorization = React.useRef<Promise<AuthorizationState> | null>(null);
  const alive = React.useRef(true);
  const connectionGeneration = React.useRef(0);
  const actionGeneration = React.useRef(0);
  const discoveryController = React.useRef<AbortController | null>(null);
  const focus = useUIStore(state => state.settingsModelFocus);
  const savedChannel = snapshot?.channels.find(channel => channel.id === selectedId);
  const channel = step !== null ? newChannel : savedChannel;
  const preview = channel && draft ? { ...channel, ...draft } : channel;
  const typeInfo = snapshot?.types.find(type => type.id === preview?.type);
  const accountDirectory = Boolean(preview && savedChannel && !secret && discoveryConfiguration(preview) === discoveryConfiguration(savedChannel));
  const metadataRequests = JSON.stringify(channel?.models.map(({ id, requestModelId, protocol, operations }) => ({ id, requestModelId, protocol, operations })) ?? []);
  const channelId = channel?.id;
  const typeId = typeInfo?.id;
  const catalogKey = `${channel?.id}:${accountDirectory}:${metadataRequests}`;
  const type = typeInfo ? { ...typeInfo, catalog: catalog.key === catalogKey ? catalog.models : [] } : undefined;
  const models = React.useMemo(() => channel?.models.map(model => applyModelDirectoryDefaults(model, type?.catalog?.find(value => value.id === model.id))) ?? [], [channel?.models, type?.catalog]);
  const dirty = Boolean(draft && (step !== null || secret || invalidFields.size || JSON.stringify(draft) !== baseDraft));

  const cancelAuthorization = () => { const id = activeAuthorization.current; activeAuthorization.current = undefined; if (id) void api.cancelAuthorization(id).catch(() => {}); setAuthorization(null); };
  const invalidateConnection = () => {
    ++connectionGeneration.current; discoveryController.current?.abort(); setCandidates([]); setConnectionResult(null); setConnectionFailure(null);
  };
  const choose = (value: ModelChannel, details = true) => {
    ++actionGeneration.current; setWorking(false);
    cancelAuthorization(); invalidateConnection(); setSelectedId(value.id); setStep(null); setNewChannel(null);
    const next = connectionDraft(value); setDraft(next); setBaseDraft(JSON.stringify(next)); setSecret('');
    setSelectedModelId(null); setInvalidFields(new Set()); setEditorGeneration(value => value + 1); setShowDetail(details); setError(null);
  };
  const close = () => { ++actionGeneration.current; setWorking(false); cancelAuthorization(); invalidateConnection(); setDraft(null); setSelectedId(null); setSelectedModelId(null); setSecret(''); setStep(null); setNewChannel(null); setShowDetail(false); };
  React.useEffect(() => {
    alive.current = true; const controller = new AbortController();
    void refresh();
    const readSettings = () => { void api.readSettings(undefined, controller.signal).then(value => { if (!controller.signal.aborted) setSettings(value); }, cause => { if (!controller.signal.aborted) setError(String(cause)); }); };
    readSettings();
    const stop = subscribeVarinEvents(event => {
      if (event.type !== 'settings-changed' || event.owner !== 'agent-settings') return;
      if (event.ids.includes('model-channels') || event.ids.includes('model-credentials')) void refresh();
      if (!event.ids.includes('model-authorization')) readSettings();
      if (event.ids.includes('model-authorization') && activeAuthorization.current) {
        const id = activeAuthorization.current;
        void api.authorization(id, controller.signal).then(value => { if (!controller.signal.aborted && activeAuthorization.current === id) setAuthorization(value); }, cause => { if (!controller.signal.aborted) setError(String(cause)); });
      }
    });
    const stopSwitch = registerRuntimeEndpointSwitchBlocker(async () => {
      const pending = await pendingAuthorization.current?.catch(() => undefined);
      const id = activeAuthorization.current ?? pending?.id;
      if (id) await api.cancelAuthorization(id);
      activeAuthorization.current = undefined;
      if (alive.current) setAuthorization(null);
    });
    return () => { alive.current = false; controller.abort(); discoveryController.current?.abort(); stop(); stopSwitch(); const id = activeAuthorization.current; activeAuthorization.current = undefined; if (id) void api.cancelAuthorization(id).catch(() => {}); };
  }, [api, refresh, setError]);
  React.useEffect(() => {
    if (!snapshot || !focus) return;
    const target = snapshot.channels.find(channel => channel.id === focus.channelId);
    if (target) { choose(target); setSelectedModelId(focus.modelId); setDrawerOpen(true); }
    useUIStore.getState().setSettingsModelFocus(null);
  // The intent is consumed once after the selected Host's snapshot arrives.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, focus]);
  React.useEffect(() => {
    if (!snapshot || focus || draft || step !== null || !snapshot.channels.length) return;
    choose(snapshot.channels[0]!, false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  React.useEffect(() => {
    if (savedChannel && !dirty && step === null) { const next = connectionDraft(savedChannel); setDraft(next); setBaseDraft(JSON.stringify(next)); }
  }, [savedChannel, dirty, step]);
  React.useEffect(() => {
    if (!channelId || !typeId) return;
    const controller = new AbortController();
    void api.directory(typeId, controller.signal, accountDirectory ? channelId : undefined, JSON.parse(metadataRequests)).then(value => {
      if (!controller.signal.aborted) setCatalog({ key: catalogKey, models: value.models });
    }, cause => { if (!controller.signal.aborted) { setCatalog({ key: catalogKey, models: [] }); setError(String(cause)); } });
    return () => controller.abort();
  }, [api, channelId, typeId, accountDirectory, metadataRequests, catalogKey, snapshot?.directory?.revision, setError]);
  const edit = (patch: Partial<ModelChannel>) => {
    if (preview && discoveryConfiguration({ ...preview, ...patch }) !== discoveryConfiguration(preview)) invalidateConnection();
    setDraft(value => value ? { ...value, ...patch } : value);
  };
  const editConnection = (patch: Partial<ModelConnectionOptions>) => {
    if (!draft) return;
    const connection = { ...draft.connection, ...patch };
    for (const key of Object.keys(connection) as (keyof ModelConnectionOptions)[]) if (connection[key] === undefined) delete connection[key];
    edit({ connection: Object.keys(connection).length ? connection : undefined });
  };
  const validity = React.useCallback((key: string, valid: boolean) => setInvalidFields(previous => {
    if (previous.has(key) === !valid) return previous;
    const next = new Set(previous); if (valid) next.delete(key); else next.add(key); return next;
  }), []);
  const run = async (work: () => Promise<void>) => {
    const generation = connectionGeneration.current;
    const action = ++actionGeneration.current;
    setWorking(true); setConnectionFailure(null);
    try { await work(); return alive.current && generation === connectionGeneration.current; }
    catch (cause) { if (alive.current && generation === connectionGeneration.current) setConnectionFailure(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { if (alive.current && actionGeneration.current === action) setWorking(false); }
  };
  const save = async (entries?: DiscoveredModel[]) => {
    if (!preview || !draft) return false;
    const originalId = preview.id;
    const originalDraft = draft;
    let connection = draft;
    setWorking(true);
    const ok = await enqueue(async current => {
      if (secret && connection.authentication.kind === 'credential') {
        const { reference } = await api.storeCredential(secret);
        connection = { ...connection, authentication: { kind: 'credential', reference } };
        if (alive.current) { setDraft(connection); setSecret(''); }
      }
      const latest = current.channels.find(value => value.id === originalId) ?? preview;
      return api.save({ ...latest, ...connection, ...(entries && type ? { models: addModels([], entries, type) } : {}) }, current.revision);
    });
    if (alive.current) {
      setWorking(false);
      if (ok) { setBaseDraft(JSON.stringify(connection)); setDraft(previous => previous === originalDraft ? connection : previous); setStep(null); setNewChannel(null); setSelectedId(originalId); setConnectionResult(null); }
    }
    return ok;
  };
  const mutateChannel = (transform: (channel: ModelChannel) => ModelChannel) => {
    const id = channel!.id;
    const project = (current: NonNullable<typeof snapshot>) => ({ ...current, channels: current.channels.map(channel => channel.id === id ? transform(channel) : channel) });
    return enqueue(current => {
      const latest = current.channels.find(value => value.id === id);
      if (!latest) throw new Error(t('settings.models.serviceUnavailable'));
      return api.save(transform(latest), current.revision);
    }, project);
  };
  const mutateModels = (transform: (models: ChannelModel[]) => ChannelModel[]) => mutateChannel(channel => ({ ...channel, models: transform(channel.models) }));
  const signIn = (provider: string) => { if (preview) void run(async () => {
    const generation = connectionGeneration.current;
    const reference = preview.authentication.kind === 'credential' && preview.authentication.reference || `model:${preview.id}`;
    const pending = api.signIn(provider, reference); pendingAuthorization.current = pending;
    let state: AuthorizationState;
    try { state = await pending; } finally { if (pendingAuthorization.current === pending) pendingAuthorization.current = null; }
    if (!alive.current || generation !== connectionGeneration.current) { await api.cancelAuthorization(state.id); return; }
    activeAuthorization.current = state.id;
    edit({ authentication: { kind: 'credential', reference } }); setSecret('');
    const next = await api.authorization(state.id);
    if (alive.current && activeAuthorization.current === state.id) setAuthorization(next);
  }); };
  const discover = () => run(async () => {
    if (!preview || !type) return;
    const generation = connectionGeneration.current;
    const controller = new AbortController(); discoveryController.current?.abort(); discoveryController.current = controller;
    if (type.discovery) {
      const result = await api.discoverDraft({ channel: preview, ...(secret ? { secret } : {}) }, controller.signal);
      if (!alive.current || generation !== connectionGeneration.current) return;
      setCandidates(result.models); setConnectionResult(t('settings.models.discoveryPassed').replace('{count}', String(result.models.length)));
    } else {
      const model = preview.models.find(model => model.enabled);
      if (!model) throw new Error(t('settings.models.testNeedsModel'));
      const result = await api.test({ key: crypto.randomUUID(), channel: preview, ...(secret ? { secret } : {}), modelId: model.id }, controller.signal);
      if (!alive.current || generation !== connectionGeneration.current) return;
      setConnectionResult(`${t('settings.models.testPassed')} · ${(result.elapsedMs / 1000).toFixed(1)} s`);
    }
    setPassed(previous => ({ ...previous, [preview.id]: discoveryConfiguration(preview) }));
  });
  const begin = () => requestSettingsNavigation(() => { close(); setStep(0); setShowDetail(true); setProviderQuery(''); });
  const selectType = (id: string) => {
    const selected = snapshot!.types.find(type => type.id === id)!;
    cancelAuthorization(); invalidateConnection(); const kind = selected.authentication[0]!;
    const next: ModelChannel = { id: crypto.randomUUID(), name: selected.name, type: id, enabled: true, baseUrl: selected.defaultBaseUrl ?? '',
      authentication: kind === 'credential' ? { kind, reference: '' } : kind === 'environment' ? { kind, variable: selected.defaultEnvironmentVariable ?? '' } : kind === 'anthropic-federation' ? { kind, identityTokenFile: '', organizationId: '', federationRuleId: '' } : { kind } as ConnectionAuthentication,
      parameters: structuredClone(selected.defaultParameters ?? {}), models: [] };
    setNewChannel(next); const connection = connectionDraft(next); setDraft(connection); setBaseDraft(JSON.stringify(connection)); setSecret(''); setStep(1); setEditorGeneration(value => value + 1); setInvalidFields(new Set());
  };
  const remove = () => {
    if (!savedChannel || !window.confirm(t('settings.models.removeConfirm'))) return;
    const id = savedChannel.id;
    void enqueue(current => api.remove(id, current.revision)).then(ok => { if (ok && alive.current) close(); });
  };
  const usages: Record<string, string[]> = {};
  const addUsage = (provider: unknown, model: unknown, label: string) => { if (provider === channel?.id && typeof model === 'string') (usages[model] ??= []).push(label); };
  const global = settings?.global;
  if (global) {
    addUsage(global.defaultProvider, global.defaultModel, t('settings.models.usageDefault'));
    const utility = global.utilityModel as { providerId?: string; modelId?: string } | undefined;
    addUsage(utility?.providerId, utility?.modelId, t('settings.models.usageUtility'));
    const harness = global.harness as { models?: Record<string, { providerId?: string; modelId?: string }>; delegationModelSelection?: { model?: { providerId?: string; modelId?: string } } } | undefined;
    for (const [slot, binding] of Object.entries(harness?.models ?? {})) {
      const key = `settings.harness.role.${slot}`;
      addUsage(binding.providerId, binding.modelId, t(key as Parameters<typeof t>[0]));
    }
    addUsage(harness?.delegationModelSelection?.model?.providerId, harness?.delegationModelSelection?.model?.modelId, t('settings.models.usageDelegation'));
  }
  const selectedModel = models.find(model => model.id === selectedModelId);
  const connectionValid = !invalidFields.size && Boolean(draft?.name.trim()) && authorization?.status !== 'pending';
  const connectionControls = preview && type && <ConnectionSettings draft={preview} type={type} busy={working} secret={secret} authorization={authorization} edit={edit} editConnection={editConnection} validity={validity}
    setSecret={value => { invalidateConnection(); setSecret(value); }} cancelAuthorization={cancelAuthorization} onSignIn={signIn}
    onSignOut={() => { void run(async () => { if (preview.authentication.kind === 'credential') await api.removeCredential(preview.authentication.reference); if (alive.current) edit({ authentication: { kind: 'credential', reference: '' } }); }); }}
    onAuthorizationReply={value => api.replyAuthorization(authorization!.id, value)} onAuthorizationCancel={async () => { await api.cancelAuthorization(authorization!.id); if (alive.current) { activeAuthorization.current = undefined; setAuthorization(null); } }} />;
  return <SettingsPageLayout title={t('settings.models.title')} description={t('settings.models.description')} className="max-w-[1320px] @container/model-connections">
    {error ? <div role="alert" className="mb-4 flex items-center gap-3 typography-meta text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => { void refresh(); }}>{t('settings.harness.retry')}</Button></div> : null}
    {!snapshot ? <p role="status" className="py-6 typography-meta text-muted-foreground">{t('common.loading')}</p> : <div className="mt-6 min-w-0 @3xl/model-connections:grid @3xl/model-connections:grid-cols-[240px_minmax(0,1fr)] @3xl/model-connections:gap-7">
      <aside className={cn('min-w-0 self-start @3xl/model-connections:sticky @3xl/model-connections:top-0 @3xl/model-connections:border-r @3xl/model-connections:border-border/60 @3xl/model-connections:pr-5', showDetail ? 'hidden @3xl/model-connections:block' : 'block')}>
        <div className="mb-3 flex items-center gap-1"><Input aria-label={t('settings.models.filterServices')} placeholder={t('settings.models.filterServices')} value={query} onChange={event => setQuery(event.target.value)} className="h-9 min-w-0" /><Button variant="ghost" size="icon" aria-label={t('settings.models.addChannel')} onClick={begin}><Icon name="add" className="size-4" /></Button><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('settings.models.serviceActions')} />}><Icon name="more" className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={snapshot.directory?.refreshing} onClick={() => { void run(async () => { await api.refreshDirectory(); await refresh(); }); }}>{t('settings.models.refreshDirectory')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
        <div className="space-y-1">{snapshot.channels.filter(channel => `${channel.name} ${channel.type} ${channel.baseUrl}`.toLowerCase().includes(query.toLowerCase())).map(item => {
          const issues = snapshot.issues?.filter(issue => issue.channelId === item.id) ?? [];
          const healthy = passed[item.id] === discoveryConfiguration(item);
          return <button key={item.id} type="button" aria-label={item.name} aria-current={step === null && selectedId === item.id ? 'true' : undefined} onClick={() => requestSettingsNavigation(() => choose(item))} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-3 text-left transition-colors hover:bg-interactive-hover', step === null && selectedId === item.id && 'bg-foreground/5')}>
            <ProviderLogo providerId={item.type} className="size-5 shrink-0" /><span className="min-w-0 flex-1 truncate typography-meta">{item.name}</span><span className="typography-micro tabular-nums text-muted-foreground">{item.models.filter(model => model.enabled).length}</span>
            {issues.length || !item.enabled || healthy ? <span role="img" aria-label={issues.length ? issues.map(issue => issue.message).join('\n') : t(!item.enabled ? 'settings.models.disabled' : 'settings.models.sessionHealthy')} title={issues.length ? issues.map(issue => issue.message).join('\n') : t(!item.enabled ? 'settings.models.disabled' : 'settings.models.sessionHealthy')} className={cn('size-1.5 shrink-0 rounded-full', issues.length ? 'bg-destructive' : !item.enabled ? 'border border-muted-foreground' : 'bg-[var(--status-success)]')} /> : null}
          </button>;
        })}</div>
        {!snapshot.channels.length ? <p className="py-5 typography-meta text-muted-foreground">{t('settings.models.emptyHint')}</p> : null}
        {snapshot.directory?.issue ? <p className="mt-5 typography-micro text-muted-foreground">{t(`settings.models.directoryIssue.${snapshot.directory.issue}`)}</p> : null}
        {snapshot.issues?.filter(issue => !issue.channelId).map((issue, index) => <p key={index} role="alert" className="mt-3 typography-micro text-destructive">{issue.message}</p>)}
      </aside>
      <div className={cn('min-w-0 @container', showDetail ? 'block' : 'hidden @3xl/model-connections:block')}>
        <Button variant="ghost" size="sm" className="mb-4 @3xl/model-connections:hidden" disabled={working} onClick={() => requestSettingsNavigation(() => { if (step !== null) close(); else setShowDetail(false); })}><Icon name="arrow-left-s" className="size-4" />{t('settings.models.back')}</Button>
        {step !== null ? <div className="mb-6 flex items-center gap-3 typography-micro text-muted-foreground">{(['settings.models.chooseProvider', 'settings.models.connection', 'settings.models.chooseModels'] as const).map((key, index) => <React.Fragment key={key}>{index ? <Icon name="arrow-right-s" className="size-3" /> : null}<span aria-current={step === index ? 'step' : undefined} className={step === index ? 'text-foreground' : undefined}>{index + 1} · {t(key)}</span></React.Fragment>)}</div> : null}
        {step === 0 ? <>
          <Input aria-label={t('settings.models.filterProviders')} placeholder={t('settings.models.filterProviders')} value={providerQuery} onChange={event => setProviderQuery(event.target.value)} className="mb-5" />
          <div className="grid gap-3 @xl:grid-cols-2">{snapshot.types.filter(type => `${type.name} ${type.id}`.toLowerCase().includes(providerQuery.toLowerCase())).map(type => <button key={type.id} type="button" onClick={() => selectType(type.id)} className="flex items-center gap-3 rounded-xl border border-border/60 p-4 text-left transition-colors hover:bg-interactive-hover"><ProviderLogo providerId={type.id} className="size-6 shrink-0" /><span className="min-w-0 flex-1"><span className="block typography-ui-label">{type.name}</span><span className="mt-1 block truncate typography-micro text-muted-foreground" title={type.defaultBaseUrl}>{type.defaultBaseUrl ? providerEndpoint(type.defaultBaseUrl) : t('settings.models.customEndpoint')}</span>{accountSignInProviders(type).length ? <span className="mt-2 inline-block rounded bg-muted px-1.5 py-0.5 typography-micro text-muted-foreground">{t('settings.models.accountSignIn')}</span> : null}</span></button>)}</div>
        </> : null}
        {preview && type && step !== 0 ? <div key={`${preview.id}:${editorGeneration}`}>
          <header className="mb-6 flex items-center gap-3"><ProviderLogo providerId={type.id} className="size-7 shrink-0" /><div className="min-w-0 flex-1"><h2 className="truncate typography-ui-label">{preview.name || type.name}</h2><p className="mt-1 typography-micro text-muted-foreground">{type.name}</p></div>{step === null ? <><Switch aria-label={t('settings.models.enabled')} checked={channel!.enabled} onCheckedChange={enabled => { void mutateChannel(channel => ({ ...channel, enabled })); }} /><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('settings.models.serviceActions')} />}><Icon name="more" className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={remove}>{t('settings.models.removeService')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></> : null}</header>
          <div hidden={step === 2}>
            <p className="mb-4 typography-micro text-muted-foreground">{t('settings.models.connectionDraft')}</p>
            {connectionControls}
            <div className="mt-5 flex flex-wrap items-center gap-3"><Button variant="outline" disabled={working || !connectionValid} onClick={() => { if (step === 1 && !type.discovery) setStep(2); else void discover().then(ok => { if (ok && step === 1) setStep(2); }); }}><Icon name={working ? 'loader-4' : 'play'} className={cn('size-3.5', working && 'animate-spin')} />{t(step === 1 ? type.discovery ? 'settings.models.connectAndDiscover' : 'settings.models.chooseModels' : 'settings.models.testConnection')}</Button>
              {step === 1 ? <Button variant="ghost" disabled={working || !connectionValid} onClick={() => setStep(2)}>{t('settings.models.skipValidation')}</Button> : null}
              {connectionResult ? <span role="status" className="typography-micro text-muted-foreground">{connectionResult}</span> : null}
            </div>
          </div>
          {connectionFailure ? <p role="alert" className="mt-3 break-words typography-meta text-destructive">{connectionFailure}</p> : null}
          {step === 2 ? <><Button variant="ghost" size="sm" className="mb-4" disabled={working} onClick={() => setStep(1)}><Icon name="arrow-left-s" className="size-4" />{t('settings.models.connection')}</Button><ModelPicker available={modelCandidates(type, candidates)} initialIds={type.defaultModelIds} busy={working || saving} confirmLabel={t('settings.models.addChannel')} onConfirm={entries => { void save(entries); }} /></> : null}
          {step === null ? <>
            <ModelSelection models={models} type={type} candidates={candidates} busy={working || saving} usages={usages} onConfigure={id => { setSelectedModelId(id); setDrawerOpen(true); }}
              onToggle={(id, enabled) => { void mutateModels(models => models.map(model => model.id === id ? { ...model, enabled } : model)); }}
              onAdd={entries => mutateModels(models => addModels(models, entries, type))} onDiscover={discover} />
            <div className="mt-7 border-t border-border/60 pt-4"><Button variant="ghost" size="sm" className="text-destructive" disabled={saving || working} onClick={remove}>{t('settings.models.removeService')}</Button></div>
          </> : null}
          <SettingsActionBar dirty={dirty} saving={working && !authorization} onSave={step === null ? () => save() : undefined} onCancel={() => { if (savedChannel && step === null) choose(savedChannel); else close(); }} saveDisabled={!connectionValid || step !== null} saveLabel={t('settings.models.save')} />
        </div> : null}
        {!preview && step === null ? <div className="py-16 text-center"><Icon name="cloud" className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="typography-meta text-muted-foreground">{t('settings.models.emptyTitle')}</p><Button variant="outline" className="mt-4" onClick={begin}>{t('settings.models.addChannel')}</Button></div> : null}
      </div>
    </div>}
    <div className="mt-8 border-t border-border/60 pt-3"><SettingsPageLink page="sessions">{t('settings.page.sessions.title')}</SettingsPageLink><SettingsPageLink page="agents">{t('settings.experience.agentModels')}</SettingsPageLink></div>
    {selectedModel && type && savedChannel ? <ModelConfigurationDrawer key={`${savedChannel.id}:${selectedModel.id}`} reset={reset} open={drawerOpen} onOpenChange={setDrawerOpen} model={selectedModel} type={type} defaults={type.catalog?.find(model => model.id === selectedModel.id)}
      inheritedImageApi={typeof savedChannel.parameters.imageApi === 'string' ? savedChannel.parameters.imageApi : undefined} inheritedDecisionApi={typeof savedChannel.parameters.decisionApi === 'string' ? savedChannel.parameters.decisionApi : undefined} inheritedPaths={savedChannel.connection?.paths}
      onChange={patch => { void mutateModels(models => models.map(model => model.id === selectedModel.id ? editModel(model, patch, type.catalog?.find(value => value.id === model.id)) : model)); }}
      onFollow={field => { void mutateModels(models => models.map(model => { const defaults = type.catalog?.find(value => value.id === model.id); return model.id === selectedModel.id && defaults ? followModel(model, defaults, field) : model; })); }}
      onRemove={() => { void mutateModels(models => models.filter(model => model.id !== selectedModel.id)).then(ok => { if (ok) setSelectedModelId(null); }); }}
      onTest={(thinkingLevel, signal): Promise<ModelConnectionTestResult> => api.test({ key: crypto.randomUUID(), channel: { ...savedChannel, models }, modelId: selectedModel.id, thinkingLevel }, signal)} /> : null}
  </SettingsPageLayout>;
}
