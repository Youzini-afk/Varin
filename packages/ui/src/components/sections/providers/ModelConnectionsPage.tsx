import { SettingsScopeLabel } from '../shared/SettingsScope';
import React from 'react';
import { applyModelDirectoryDefaults, createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, registerRuntimeEndpointSwitchBlocker, type AgentSettingsSnapshot, type ChannelModel, type ModelChannel, type ModelConnectionOptions, type DiscoveredModel, type ConnectionAuthentication, type AuthorizationState, type ModelConnectionTestResult } from '@varin/application-client';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { Av, Catalog, CatalogGroup, CatalogItem, Empty, Loading, Note, ObjectHeader, Section, useSettingsShell } from '../shared/kit';
import { useSettingsSearchTarget } from '@/lib/settings/search-target';
import { RetrySettings } from '../varin/RetrySettings';
import { parseModelRetrySettings } from '@varin/protocol';
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
  const shell = useSettingsShell();
  const searchTarget = useSettingsSearchTarget();
  const api = React.useMemo(() => createModelConnectionsHttpAPI(host), [host]);
  const read = React.useCallback(() => api.read(), [api]);
  const { snapshot, saving, error, setError, reset, refresh, enqueue } = useModelConnectionWrites(read);
  const [settings, setSettings] = React.useState<AgentSettingsSnapshot | null>(null);
  const [retrySelected, setRetrySelected] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<ConnectionDraft | null>(null);
  const [baseDraft, setBaseDraft] = React.useState('');
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
    setSelectedModelId(null); setInvalidFields(new Set()); setEditorGeneration(value => value + 1); setRetrySelected(false); setError(null);
    if (details) shell.setCatalogStage('detail');
  };
  const close = () => {
    ++actionGeneration.current; setWorking(false); cancelAuthorization(); invalidateConnection();
    setDraft(null); setSelectedId(null); setSelectedModelId(null); setDrawerOpen(false); setSecret(''); setStep(null); setNewChannel(null);
  };
  const selectRetry = () => { close(); setRetrySelected(true); shell.setCatalogStage('detail'); };
  React.useEffect(() => {
    if (searchTarget === 'sessions.retry') selectRetry();
  // This is a one-shot navigation intent from settings search.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTarget]);
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
    if (!snapshot || focus || draft || retrySelected || searchTarget === 'sessions.retry' || step !== null || !snapshot.channels.length) return;
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
  const begin = () => requestSettingsNavigation(() => { close(); setRetrySelected(false); setStep(0); shell.setCatalogStage('detail'); setProviderQuery(''); });
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
  const usages: Record<string, {label: string; page: string; item: string}[]> = Object.create(null);
  const addUsage = (binding: {providerId?: string; modelId?: string} | null | undefined, label: string, item: string, page = 'model-roles') => {
    if (binding?.providerId && binding.providerId === channel?.id && binding.modelId) (usages[binding.modelId] ??= []).push({ label, page, item });
  };
  const global = settings?.global;
  if (global) {
    addUsage({providerId: typeof global.defaultProvider === 'string' ? global.defaultProvider : undefined, modelId: typeof global.defaultModel === 'string' ? global.defaultModel : undefined}, t('settings.models.usageDefault'), 'sessions.default-model');
    type Binding = {providerId?: string; modelId?: string};
    addUsage(global.utilityModel as Binding | undefined, t('settings.models.usageUtility'), 'sessions.small-model');
    const harness = global.harness as { models?: Record<string, Binding>; images?: {generation?: Binding; editing?: Binding}; embedding?: Binding; rerank?: Binding; delegationModelSelection?: {model?: Binding}; fastDecision?: {default?: Binding; purposes?: Record<string, Binding | 'off'>} } | undefined;
    const central = ['contextCompaction', 'agentPlanning', 'explore', 'nextStep', 'reader', 'webSelection', 'permissionJudge'];
    for (const [slot, binding] of Object.entries(harness?.models ?? {})) {
      addUsage(binding, t(`settings.harness.role.${slot}` as Parameters<typeof t>[0]),
        'harness.models.' + slot, central.includes(slot) ? 'model-roles' : 'agents');
    }
    addUsage(harness?.delegationModelSelection?.model, t('settings.models.usageDelegation'), 'harness.delegationModelSelection');
    addUsage(harness?.embedding, t('settings.page.harness.section.embedding'), 'harness.embedding');
    addUsage(harness?.rerank, t('settings.page.harness.section.rerank'), 'harness.rerank');
    for (const purpose of ['generation','editing'] as const) addUsage(harness?.images?.[purpose], t(`settings.harness.images.${purpose}`), 'harness.images');
    addUsage(harness?.fastDecision?.default, t('settings.page.harness.section.fastDecision'), 'harness.fastDecision');
    for (const [purpose, binding] of Object.entries(harness?.fastDecision?.purposes ?? {})) {
      if (binding === 'off') continue;
      const web = purpose === 'web-reading' || purpose === 'web-selection';
      addUsage(binding, web ? t(purpose === 'web-reading' ? 'settings.page.harness.web.assistance.reading' : 'settings.page.harness.web.assistance.selection') : t('settings.page.harness.section.fastDecision') + ' · ' + purpose,
        purpose === 'web-reading' ? 'harness.models.reader' : purpose === 'web-selection' ? 'harness.models.webSelection' : 'harness.fastDecision');
    }
  }
  const selectedModel = models.find(model => model.id === selectedModelId);
  const connectionValid = !invalidFields.size && Boolean(draft?.name.trim()) && authorization?.status !== 'pending';
  const connectionControls = preview && type && <ConnectionSettings draft={preview} type={type} busy={working} secret={secret} authorization={authorization} edit={edit} editConnection={editConnection} validity={validity}
    setSecret={value => { invalidateConnection(); setSecret(value); }} cancelAuthorization={cancelAuthorization} onSignIn={signIn}
    onSignOut={() => { void run(async () => { if (preview.authentication.kind === 'credential') await api.removeCredential(preview.authentication.reference); if (alive.current) edit({ authentication: { kind: 'credential', reference: '' } }); }); }}
    onAuthorizationReply={value => api.replyAuthorization(authorization!.id, value)} onAuthorizationCancel={async () => { await api.cancelAuthorization(authorization!.id); if (alive.current) { activeAuthorization.current = undefined; setAuthorization(null); } }} />;
  const channels = snapshot?.channels ?? [];
  const filter = query.trim().toLowerCase();
  const visibleChannels = channels.filter(channel => [channel.name, channel.type, channel.baseUrl,
    ...channel.models.flatMap(model => [model.id, model.name, model.requestModelId])]
    .some(value => value?.toLowerCase().includes(filter)));
  const retry = settings ? parseModelRetrySettings(settings.global.retry) : null;
  const saveRetry = async (set: Parameters<typeof api.updateSettings>[0]['set']) => {
    if (!settings) return false;
    try {
      const saved = await api.updateSettings({ scope: 'global', set, remove: [], expectedRevision: settings.globalRevision });
      if (!alive.current) return false;
      setSettings(saved); setError(null);
      return true;
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };
  return <Catalog title={t('settings.models.title')} description={t('settings.models.description')} scope={<SettingsScopeLabel kind="host" />}
    filter={{ value: query, onChange: setQuery, placeholder: t('settings.models.filterServices') }}
    headActions={snapshot && <>
      <Button variant="ghost" size="icon" aria-label={t('settings.models.addChannel')} onClick={begin}><Icon name="add" className="size-4" /></Button>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('settings.models.serviceActions')} />}><Icon name="more" className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={snapshot.directory?.refreshing} onClick={() => { void run(async () => { await api.refreshDirectory(); await refresh(); }); }}>{t('settings.models.refreshDirectory')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </>}
    items={<>
      <CatalogItem pinned selected={retrySelected} opensDetail={false} onSelect={() => requestSettingsNavigation(selectRetry)}
        lead={<Av><Icon name="refresh" className="size-4" /></Av>} name={t('settings.retry.title')}
        ariaLabel={t('settings.retry.title')} meta={retry && t(retry.enabled ? 'settings.kit.on' : 'settings.kit.off')} />
      <CatalogGroup label={t('settings.models.services')} count={filter ? visibleChannels.length : channels.length} />
      {!snapshot && !error ? <Loading /> : null}
      {visibleChannels.map(item => {
          const issues = snapshot?.issues?.filter(issue => issue.channelId === item.id) ?? [];
          const healthy = passed[item.id] === discoveryConfiguration(item);
          const state = issues.length ? issues.map(issue => issue.message).join('\n')
            : !item.enabled ? t('settings.models.disabled') : healthy ? t('settings.models.sessionHealthy') : undefined;
          return <CatalogItem key={item.id} selected={step === null && selectedId === item.id} opensDetail={false}
            ariaLabel={item.name} name={item.name} dim={!item.enabled} title={state}
            lead={<Av><ProviderLogo providerId={item.type} className="size-5" /></Av>}
            meta={t('settings.roles.serviceModelCount', { count: item.models.length })}
            end={state ? <span role="img" aria-label={state} className={cn('sk-dot', issues.length ? 'err' : !item.enabled ? 'off' : 'ok')} /> : undefined}
            onSelect={() => requestSettingsNavigation(() => choose(item))} />;
      })}
      {snapshot && !visibleChannels.length ? <p className="sk-muted sk-small sk-pad">{filter ? t('settings.shell.noResults', { query: query.trim() }) : t('settings.models.emptyHint')}</p> : null}
      {snapshot?.directory?.issue ? <p className="sk-muted sk-small sk-pad">{t(`settings.models.directoryIssue.${snapshot.directory.issue}`)}</p> : null}
      {snapshot?.issues?.filter(issue => !issue.channelId).map((issue, index) => <Note key={index} kind="warn">{issue.message}</Note>)}
    </>}
    detailKey={retrySelected ? 'retry' : step !== null ? 'new' : selectedId ?? 'empty'}
    detail={<>
      {error ? <Note kind="err" actions={<Button variant="ghost" size="sm" onClick={() => void refresh()}>{t('settings.harness.retry')}</Button>}>{error}</Note> : null}
      {retrySelected ? <><ObjectHeader avatar={<Av><Icon name="refresh" className="size-4" /></Av>} title={t('settings.retry.title')} sub={t('settings.retry.description')} />
        {settings ? <RetrySettings value={settings.global.retry} disabled={false} api={api} onSave={saveRetry} standalone /> : !error ? <Loading /> : null}
      </> : snapshot && <>
        {step !== null ? <div className="mb-6 flex items-center gap-3 typography-micro text-muted-foreground">{(['settings.models.chooseProvider', 'settings.models.connection', 'settings.models.chooseModels'] as const).map((key, index) => <React.Fragment key={key}>{index ? <Icon name="arrow-right-s" className="size-3" /> : null}<span aria-current={step === index ? 'step' : undefined} className={step === index ? 'text-foreground' : undefined}>{index + 1} · {t(key)}</span></React.Fragment>)}</div> : null}
        {step === 0 ? <>
          <Input aria-label={t('settings.models.filterProviders')} placeholder={t('settings.models.filterProviders')} value={providerQuery} onChange={event => setProviderQuery(event.target.value)} className="mb-5" />
          <div className="grid gap-3 @xl:grid-cols-2">{snapshot.types.filter(type => `${type.name} ${type.id}`.toLowerCase().includes(providerQuery.toLowerCase())).map(type => <button key={type.id} type="button" onClick={() => selectType(type.id)} className="flex items-center gap-3 rounded-xl border border-border/60 p-4 text-left transition-colors hover:bg-interactive-hover"><ProviderLogo providerId={type.id} className="size-6 shrink-0" /><span className="min-w-0 flex-1"><span className="block typography-ui-label">{type.name}</span><span className="mt-1 block truncate typography-micro text-muted-foreground" title={type.defaultBaseUrl}>{type.defaultBaseUrl ? providerEndpoint(type.defaultBaseUrl) : t('settings.models.customEndpoint')}</span>{accountSignInProviders(type).length ? <span className="mt-2 inline-block rounded bg-muted px-1.5 py-0.5 typography-micro text-muted-foreground">{t('settings.models.accountSignIn')}</span> : null}</span></button>)}</div>
        </> : null}
        {preview && type && step !== 0 ? <div key={`${preview.id}:${editorGeneration}`}>
          <ObjectHeader avatar={<Av><ProviderLogo providerId={type.id} className="size-6" /></Av>} title={preview.name || type.name} sub={type.name}
            actions={step === null ? <><Switch aria-label={t('settings.models.enabled')} checked={channel!.enabled} onCheckedChange={enabled => { void mutateChannel(channel => ({ ...channel, enabled })); }} /><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={t('settings.models.serviceActions')} />}><Icon name="more" className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={remove}>{t('settings.models.removeService')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></> : null} />
          <div hidden={step === 2}><Section title={t('settings.models.connection')} description={t('settings.models.connectionDraft')}>
            <div className="sk-pad">{connectionControls}</div>
            <div className="sk-pad flex flex-wrap items-center gap-3"><Button variant="outline" disabled={working || !connectionValid} onClick={() => { if (step === 1 && !type.discovery) setStep(2); else void discover().then(ok => { if (ok && step === 1) setStep(2); }); }}><Icon name={working ? 'loader-4' : 'play'} className={cn('size-3.5', working && 'animate-spin')} />{t(step === 1 ? type.discovery ? 'settings.models.connectAndDiscover' : 'settings.models.chooseModels' : 'settings.models.testConnection')}</Button>
              {step === 1 ? <Button variant="ghost" disabled={working || !connectionValid} onClick={() => setStep(2)}>{t('settings.models.skipValidation')}</Button> : null}
              {connectionResult ? <span role="status" className="typography-micro text-muted-foreground">{connectionResult}</span> : null}
            </div>
            {connectionFailure ? <Note kind="err" inPanel>{connectionFailure}</Note> : null}
            <SettingsActionBar placement="inline" dirty={dirty} saving={working && !authorization} onSave={step === null ? () => save() : undefined} onCancel={() => { if (savedChannel && step === null) choose(savedChannel); else { close(); shell.setCatalogStage('list'); } }} saveDisabled={!connectionValid || step !== null} saveLabel={t('settings.models.save')} />
          </Section></div>
          {step === 2 && connectionFailure ? <Note kind="err">{connectionFailure}</Note> : null}
          {step === 2 ? <><Button variant="ghost" size="sm" className="mb-4" disabled={working} onClick={() => setStep(1)}><Icon name="arrow-left-s" className="size-4" />{t('settings.models.connection')}</Button><ModelPicker available={modelCandidates(type, candidates)} initialIds={type.defaultModelIds} busy={working || saving} confirmLabel={t('settings.models.addChannel')} onConfirm={entries => { void save(entries); }} /></> : null}
          {step === null ? <>
            <ModelSelection models={models} type={type} candidates={candidates} busy={working || saving} usages={usages} onConfigure={id => { setSelectedModelId(id); setDrawerOpen(true); }}
              onToggle={(id, enabled) => { void mutateModels(models => models.map(model => model.id === id ? { ...model, enabled } : model)); }}
              onAdd={entries => mutateModels(models => addModels(models, entries, type))} onDiscover={discover} />
            <Button variant="ghost" size="sm" className="text-destructive" disabled={saving || working} onClick={remove}>{t('settings.models.removeService')}</Button>
          </> : null}
        </div> : null}
        {!preview && step === null ? <Empty icon="cloud" title={t('settings.models.emptyTitle')}
          action={<Button variant="outline" onClick={begin}>{t('settings.models.addChannel')}</Button>} /> : null}
      </>}
    </>}
    dock={selectedModel && type && savedChannel ? <ModelConfigurationDrawer key={`${savedChannel.id}:${selectedModel.id}`} reset={reset} open={drawerOpen} onOpenChange={setDrawerOpen} model={selectedModel} type={type} defaults={type.catalog?.find(model => model.id === selectedModel.id)}
      inheritedImageApi={typeof savedChannel.parameters.imageApi === 'string' ? savedChannel.parameters.imageApi : undefined} inheritedDecisionApi={typeof savedChannel.parameters.decisionApi === 'string' ? savedChannel.parameters.decisionApi : undefined} inheritedPaths={savedChannel.connection?.paths}
      onChange={patch => { void mutateModels(models => models.map(model => model.id === selectedModel.id ? editModel(model, patch, type.catalog?.find(value => value.id === model.id)) : model)); }}
      onFollow={field => { void mutateModels(models => models.map(model => { const defaults = type.catalog?.find(value => value.id === model.id); return model.id === selectedModel.id && defaults ? followModel(model, defaults, field) : model; })); }}
      onRemove={() => { void mutateModels(models => models.filter(model => model.id !== selectedModel.id)).then(ok => { if (ok) setSelectedModelId(null); }); }}
      onTest={(thinkingLevel, signal): Promise<ModelConnectionTestResult> => api.test({ key: crypto.randomUUID(), channel: { ...savedChannel, models }, modelId: selectedModel.id, thinkingLevel }, signal)} /> : null}
  />;
}
