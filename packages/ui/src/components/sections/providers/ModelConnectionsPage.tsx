import React from 'react';
import { createModelConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, registerRuntimeEndpointSwitchBlocker, type ModelChannel, type ModelConnectionOptions, type ChannelModel, type ModelConnectionsSnapshot, type DiscoveredModel, type ConnectionAuthentication, type AuthorizationState } from '@varin/application-client';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { SettingsSection, SettingsFieldRow, SettingsStackedField } from '../shared/SettingsSection';
import { AuthorizationPanel } from '../shared/AuthorizationPanel';
import { JsonObjectField } from '../shared/JsonObjectField';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { Switch } from '@/components/ui/switch';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import type { JsonValue } from '@varin/protocol';

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
  const [tab, setTab] = React.useState<'models' | 'connection' | 'advanced'>('models');
  const [selectedModelId, setSelectedModelId] = React.useState<string | null>(null);
  const [secret, setSecret] = React.useState('');
  const [candidates, setCandidates] = React.useState<DiscoveredModel[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [modelId, setModelId] = React.useState('');
  const [baseRevision, setBaseRevision] = React.useState('');
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
  const closeEditor = () => { cancelAuthorization(); setDraft(null); setSecret(''); };
  const choose = (channel: ModelChannel) => { cancelAuthorization(); setSelectedModelId(null); setInvalidFields(new Set()); setEditorGeneration(value => value + 1); setDraft(structuredClone(channel)); setBaseRevision(snapshot!.revision); setCandidates([]); setModelId(''); setSecret(''); setError(null); };
  const type = snapshot?.types.find(type => type.id === draft?.type);
  const savedChannel = snapshot?.channels.find(channel => channel.id === draft?.id);
  const dirty = Boolean(draft && (!savedChannel || secret || invalidFields.size || JSON.stringify(draft) !== JSON.stringify(savedChannel)));
  const confirmDiscard = () => !dirty || window.confirm(t('settings.models.discardConfirm'));
  const discoveryConfiguration = (channel: ModelChannel) => JSON.stringify([channel.type, channel.baseUrl, channel.connection, channel.authentication, channel.parameters, channel.enabled]);
  const discoveryDirty = !draft || !savedChannel || !!secret || discoveryConfiguration(draft) !== discoveryConfiguration(savedChannel);
  const edit = (patch: Partial<ModelChannel>) => {
    if (draft && discoveryConfiguration({ ...draft, ...patch }) !== discoveryConfiguration(draft)) setCandidates([]);
    setDraft(value => value ? { ...value, ...patch } : value);
  };
  const editConnection = (patch: Partial<ModelConnectionOptions>) => {
    if (!draft) return;
    const connection = { ...draft.connection, ...patch };
    for (const key of Object.keys(connection) as (keyof ModelConnectionOptions)[]) if (connection[key] === undefined) delete connection[key];
    edit({ connection: Object.keys(connection).length ? connection : undefined });
  };
  const editModel = (index: number, patch: Partial<ChannelModel>) => { if (draft) edit({ models: draft.models.map((model, i) => i === index ? { ...model, ...patch } : model) }); };
  const validity = (key: string, valid: boolean) => setInvalidFields(previous => { if (previous.has(key) === !valid) return previous; const next = new Set(previous); if (valid) next.delete(key); else next.add(key); return next; });
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); return true; } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { if (alive.current) setBusy(false); }
  };
  const addModel = (id: string, name = id, candidate?: DiscoveredModel) => {
    if (!draft || !type || !id.trim() || draft.models.some(model => model.id === id.trim())) return;
    const catalogModel = type.catalog?.find(model => model.id === id.trim());
    const operations = candidate?.operations?.filter(operation => type.operations.includes(operation));
    edit({ models: [...draft.models, catalogModel ? { ...structuredClone(catalogModel), enabled: true } : { id: id.trim(), name, enabled: true, operations: operations?.length ? operations : type.operations.includes('chat') ? ['chat'] : [type.operations[0]!] }] });
    setModelId(''); setSelectedModelId(id.trim());
  };
  const save = () => run(async () => {
    if (!draft) return;
    let channel = draft;
    if (secret && channel.authentication.kind === 'credential') {
      const { reference } = await api.storeCredential(secret);
      channel = { ...channel, authentication: { kind: 'credential', reference } };
      setDraft(channel); setSecret('');
    }
    const next = await api.save(channel, baseRevision);
    if (alive.current) { setSnapshot(next); setDraft(structuredClone(channel)); setBaseRevision(next.revision); }
  });
  const addChannel = () => {
    if (!snapshot?.types.length || !confirmDiscard()) return;
    const first = snapshot.types[0]!;
    choose({ id: crypto.randomUUID(), name: '', type: first.id, enabled: true, baseUrl: first.defaultBaseUrl ?? '', authentication: first.authentication.includes('credential') ? { kind: 'credential', reference: '' } : { kind: first.authentication[0]! } as ConnectionAuthentication, parameters: {}, models: [] });
    setTab('connection');
  };
  return <SettingsPageLayout title={t('settings.models.title')} description={t('settings.models.description')} className="max-w-[1180px]"
    headerEnd={<Button disabled={busy || !snapshot?.types.length} onClick={addChannel}><Icon name="add" className="size-4" />{t('settings.models.addChannel')}</Button>}>
    {error && !draft ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
    {snapshot?.issues?.map((issue, index) => <p key={index} role="alert" className="typography-meta text-destructive">{issue.channelId ? `${issue.channelId}: ` : ''}{issue.message}</p>)}
    {!snapshot ? error ? <Button variant="outline" disabled={busy} onClick={() => { void run(async () => setSnapshot(await api.read())); }}>{t('settings.harness.retry')}</Button> : <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : <div className="overflow-hidden rounded-xl border border-border/70 bg-background @3xl:grid @3xl:grid-cols-[220px_minmax(0,1fr)]">
      <aside className={cn('border-border/60 bg-muted/25 p-3 @3xl:border-r', draft && 'hidden @3xl:block')} aria-label={t('settings.models.services')}>
        <div className="mb-3 flex items-center justify-between gap-2"><span className="typography-micro text-muted-foreground">{t('settings.models.services')} · {snapshot.channels.length}</span></div>
        <Input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('settings.models.filterServices')} placeholder={t('settings.models.filterServices')} className="mb-3 h-8" />
        <div className="space-y-1">
          {snapshot.channels.filter(channel => `${channel.name} ${channel.type}`.toLowerCase().includes(query.toLowerCase())).map(channel => <button key={channel.id} type="button" aria-label={channel.name} aria-current={draft?.id === channel.id ? 'page' : undefined} disabled={busy} onClick={() => { if (draft?.id !== channel.id && confirmDiscard()) { choose(channel); setTab('models'); } }}
            className={cn('flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors', draft?.id === channel.id ? 'border-border/60 bg-background shadow-sm' : 'border-transparent hover:bg-interactive-hover')}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-background"><ProviderLogo providerId={channel.type} className="size-5" /></span>
            <span className="min-w-0"><span className="block truncate typography-ui-label">{channel.name}</span><span className="mt-1 block typography-micro text-muted-foreground">{t(channel.enabled ? 'settings.models.enabled' : 'settings.models.disabled')} · {channel.models.length} {t('settings.models.models')}</span></span>
          </button>)}
        </div>
      </aside>
      {draft && type ? <div key={`${draft.id}:${draft.type}:${editorGeneration}`} className="min-w-0">
        <div className="border-b border-border/60 px-4 pt-4 @xl:px-6">
          <button type="button" className="mb-3 flex items-center gap-1 typography-meta text-muted-foreground @3xl:hidden" disabled={busy} onClick={() => { if (confirmDiscard()) closeEditor(); }}><Icon name="arrow-left-s" className="size-4" />{t('settings.models.services')}</button>
          <div className="flex items-center gap-3 pb-4"><span className="flex size-10 items-center justify-center rounded-lg border border-border/60"><ProviderLogo providerId={draft.type} className="size-6" /></span><div className="min-w-0 flex-1"><h2 className="truncate text-xl font-semibold">{draft.name || t('settings.models.addChannel')}</h2><p className="mt-1 typography-micro text-muted-foreground">{type.name} · {t(savedChannel ? 'settings.models.configured' : 'settings.models.newChannel')}</p></div>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (!window.confirm(t('settings.models.removeConfirm'))) return; if (savedChannel) void run(async () => { const next = await api.remove(draft.id, baseRevision); setSnapshot(next); closeEditor(); }); else closeEditor(); }}>{t('settings.models.remove')}</Button>
          </div>
          <div role="tablist" aria-label={t('settings.models.title')} className="flex gap-5">
            {(['models', 'connection', 'advanced'] as const).map(value => <button key={value} type="button" id={`model-tab-${value}`} role="tab" aria-label={t(`settings.models.${value}`)} tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`model-channel-${value}`} onKeyDown={event => {
              const tabs = ['models', 'connection', 'advanced'] as const;
              const index = tabs.indexOf(value);
              const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
              if (next < 0) return; event.preventDefault(); setTab(tabs[next]!); setSelectedModelId(null);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
            }} onClick={() => { setTab(value); setSelectedModelId(null); }} className={cn('border-b-2 pb-3 typography-meta', tab === value ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground')}>{t(`settings.models.${value}`)}{value === 'models' ? ` · ${draft.models.length}` : ''}</button>)}
          </div>
        </div>
        <div className="@container px-4 py-5 @xl:px-6">
        <p className="mb-4 typography-micro text-muted-foreground">{t('settings.models.saveHint')}</p>
        <div id="model-channel-connection" role="tabpanel" aria-labelledby="model-tab-connection" hidden={tab !== 'connection'}>
        <SettingsSection title={t('settings.models.connection')}>
          <SettingsFieldRow label={t('settings.models.name')}><Input aria-label={t('settings.models.name')} value={draft.name} disabled={busy} onChange={event => edit({ name: event.target.value })} /></SettingsFieldRow>
          <SettingsFieldRow label={t('settings.models.type')}><Select value={draft.type} disabled={busy} onValueChange={id => {
            const next = snapshot.types.find(type => type.id === id)!;
            cancelAuthorization(); setSecret(''); setCandidates([]); setModelId(''); setInvalidFields(new Set());
            edit({ type: id, baseUrl: next.defaultBaseUrl ?? '', connection: undefined, parameters: {}, models: [], authentication: next.authentication.includes('credential') ? { kind: 'credential', reference: '' } : { kind: next.authentication[0]! } as ConnectionAuthentication });
          }}><SelectTrigger size="settings" aria-label={t('settings.models.type')}><SelectValue /></SelectTrigger><SelectContent>{snapshot.types.map(type => <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>)}</SelectContent></Select></SettingsFieldRow>
          <SettingsFieldRow label={t('settings.models.endpoint')}><Input aria-label={t('settings.models.endpoint')} value={draft.baseUrl} disabled={busy} onChange={event => edit({ baseUrl: event.target.value })} /></SettingsFieldRow>
          <SettingsFieldRow label={t('settings.models.authentication')}><Select value={draft.authentication.kind} disabled={busy} onValueChange={kind => { cancelAuthorization(); setSecret(''); edit({ authentication: kind === 'credential' ? { kind, reference: '' } : kind === 'environment' ? { kind, variable: '' } : kind === 'anthropic-federation' ? { kind, identityTokenFile: '', organizationId: '', federationRuleId: '' } : { kind } as ConnectionAuthentication }); }}>
            <SelectTrigger size="settings" aria-label={t('settings.models.authentication')}><SelectValue /></SelectTrigger><SelectContent>{type.authentication.map(kind => <SelectItem key={kind} value={kind}>{t(`settings.models.auth.${kind}`)}</SelectItem>)}</SelectContent>
          </Select></SettingsFieldRow>
          {draft.authentication.kind === 'credential' ? <SettingsFieldRow label={t('settings.models.apiKey')}><Input type="password" aria-label={t('settings.models.apiKey')} autoComplete="off" value={secret} disabled={busy} placeholder={draft.authentication.reference ? t('settings.models.credentialSaved') : ''} onChange={event => { setSecret(event.target.value); setCandidates([]); }} /></SettingsFieldRow> : null}
          {draft.authentication.kind === 'credential' && type.oauthProviders?.length ? <div className="flex flex-wrap gap-2">{type.oauthProviders.map(provider => <Button key={provider.id} variant="outline" disabled={busy || authorization?.status === 'pending'} onClick={() => { void run(async () => {
            const reference = draft.authentication.kind === 'credential' && draft.authentication.reference || `model:${draft.id}`;
            const pending = api.signIn(provider.id, reference); pendingAuthorization.current = pending;
            let state: AuthorizationState;
            try { state = await pending; } finally { if (pendingAuthorization.current === pending) pendingAuthorization.current = null; }
            if (!alive.current) { await api.cancelAuthorization(state.id); return; }
            activeAuthorization.current = state.id;
            edit({ authentication: { kind: 'credential', reference } }); setSecret('');
            const next = await api.authorization(state.id);
            if (alive.current && activeAuthorization.current === state.id) setAuthorization(next);
          }); }}>{t('settings.mcp.signIn')} · {provider.name}</Button>)}</div> : null}
          {draft.authentication.kind === 'credential' && draft.authentication.reference ? <Button size="sm" variant="ghost" disabled={busy || authorization?.status === 'pending'} onClick={() => { void run(async () => { if (draft.authentication.kind === 'credential') await api.removeCredential(draft.authentication.reference); edit({ authentication: { kind: 'credential', reference: '' } }); }); }}>{t('settings.mcp.signOut')}</Button> : null}
          {authorization ? <AuthorizationPanel key={authorization.id} state={authorization} onReply={value => api.replyAuthorization(authorization.id, value)} onCancel={async () => { await api.cancelAuthorization(authorization.id); if (alive.current) { activeAuthorization.current = undefined; setAuthorization(null); } }} /> : null}
          {draft.authentication.kind === 'environment' ? <SettingsFieldRow label={t('settings.models.environment')}><Input aria-label={t('settings.models.environment')} value={draft.authentication.variable} disabled={busy} onChange={event => edit({ authentication: { kind: 'environment', variable: event.target.value } })} /></SettingsFieldRow> : null}
          {draft.authentication.kind === 'google-adc' ? <SettingsFieldRow label={t('settings.models.credentialFile')}><Input value={draft.authentication.file ?? ''} disabled={busy} onChange={event => edit({ authentication: event.target.value ? { kind: 'google-adc', file: event.target.value } : { kind: 'google-adc' } })} /></SettingsFieldRow> : null}
          {draft.authentication.kind === 'aws-chain' ? <SettingsFieldRow label={t('settings.models.profile')}><Input value={draft.authentication.profile ?? ''} disabled={busy} onChange={event => edit({ authentication: event.target.value ? { kind: 'aws-chain', profile: event.target.value } : { kind: 'aws-chain' } })} /></SettingsFieldRow> : null}
          {draft.authentication.kind === 'anthropic-federation' ? <>
            <p className="typography-meta text-muted-foreground">{t('settings.models.federationHint')}</p>
            {(['identityTokenFile', 'organizationId', 'federationRuleId', 'serviceAccountId', 'workspaceId'] as const).map(key => {
              const authentication = draft.authentication as Extract<ConnectionAuthentication, { kind: 'anthropic-federation' }>;
              return <SettingsFieldRow key={key} label={t(`settings.models.federation.${key}`)}><Input
                value={authentication[key] ?? ''} disabled={busy} autoComplete="off" aria-label={t(`settings.models.federation.${key}`)}
                onChange={event => {
                  const next = { ...authentication };
                  if (!event.target.value && (key === 'workspaceId' || key === 'serviceAccountId')) delete next[key];
                  else next[key] = event.target.value;
                  edit({ authentication: next });
                }} /></SettingsFieldRow>;
            })}
          </> : null}
          <label className="flex items-center gap-2 typography-meta"><Checkbox checked={draft.enabled} disabled={busy} onChange={value => edit({ enabled: value })} />{t('settings.models.enabled')}</label>
        </SettingsSection>
        </div>
        <div id="model-channel-advanced" role="tabpanel" aria-labelledby="model-tab-advanced" hidden={tab !== 'advanced'}>
          <SettingsSection title={t('settings.models.advanced')}>
          <details className="space-y-3"><summary className="cursor-pointer typography-meta">{t('settings.models.network')}</summary>
            <SettingsFieldRow label={t('settings.models.proxy')}><Select value={draft.connection?.proxy?.mode ?? 'host'} disabled={busy} onValueChange={mode => editConnection({ proxy: mode === 'host' ? undefined : mode === 'direct' ? { mode } : { mode: 'proxy', url: '' } })}>
              <SelectTrigger size="settings" aria-label={t('settings.models.proxy')}><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="host">{t('settings.models.proxyHost')}</SelectItem><SelectItem value="direct">{t('settings.models.proxyDirect')}</SelectItem><SelectItem value="proxy">{t('settings.models.proxyCustom')}</SelectItem>
              </SelectContent></Select></SettingsFieldRow>
            {draft.connection?.proxy?.mode === 'proxy' ? <SettingsFieldRow label={t('settings.models.proxyUrl')}><Input aria-label={t('settings.models.proxyUrl')} value={draft.connection.proxy.url} disabled={busy} placeholder="http://127.0.0.1:8080" onChange={event => editConnection({ proxy: { mode: 'proxy', url: event.target.value } })} /></SettingsFieldRow> : null}
            <p className="typography-micro text-muted-foreground">{t('settings.models.proxyHint')}</p>
            <SettingsFieldRow label={t('settings.models.headers')}><JsonObjectField value={draft.connection?.headers} label={t('settings.models.headers')} disabled={busy} validate={headers => Object.values(headers).every(value => typeof value === 'string')} onValidityChange={valid => validity('connection:headers', valid)} onChange={headers => {
              editConnection({ headers: headers as Record<string, string> | undefined });
            }} /></SettingsFieldRow>
            <p className="typography-micro text-muted-foreground">{t('settings.models.headersHint')}</p>
            <p className="typography-micro text-muted-foreground">{t('settings.models.pathsHint')}</p>
            {type.operations.filter(operation => operation !== 'decision' || type.protocol !== 'llama-cpp-classify').map(operation => <SettingsFieldRow key={operation} label={t(`settings.models.operation.${operation}`)}><Input aria-label={`${t('settings.models.path')}: ${t(`settings.models.operation.${operation}`)}`} value={draft.connection?.paths?.[operation] ?? ''} disabled={busy} placeholder={t('settings.models.default')} onChange={event => {
              const paths = { ...draft.connection?.paths };
              if (event.target.value) paths[operation] = event.target.value; else delete paths[operation];
              editConnection({ paths: Object.keys(paths).length ? paths : undefined });
            }} /></SettingsFieldRow>)}
          </details>
          {Object.entries((type.parametersSchema.properties ?? {}) as Record<string, Record<string, JsonValue>>).map(([key, schema]) => <SettingsFieldRow key={key} label={key}>
            {Array.isArray(schema.enum) ? <Select value={String(draft.parameters[key] ?? '__unset')} disabled={busy} onValueChange={value => { const parameters = { ...draft.parameters }; if (value === '__unset') delete parameters[key]; else parameters[key] = value; edit({ parameters }); }}><SelectTrigger size="settings" aria-label={key}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__unset">{t('settings.models.default')}</SelectItem>{schema.enum.map(value => <SelectItem key={String(value)} value={String(value)}>{String(value)}</SelectItem>)}</SelectContent></Select>
              : <Input value={String(draft.parameters[key] ?? '')} disabled={busy} onChange={event => { const parameters = { ...draft.parameters }; if (event.target.value) parameters[key] = event.target.value; else delete parameters[key]; edit({ parameters }); }} />}
          </SettingsFieldRow>)}
          <details><summary className="cursor-pointer typography-meta">{t('settings.models.parameters')}</summary><JsonObjectField value={draft.parameters} label={t('settings.models.parameters')} disabled={busy} onValidityChange={valid => validity('channel', valid)} onChange={parameters => edit({ parameters: parameters ?? {} })} /></details>
          </SettingsSection>
        </div>
        <div id="model-channel-models" role="tabpanel" aria-labelledby="model-tab-models" hidden={tab !== 'models'}>
          {selectedModelId ? <Button variant="ghost" size="sm" className="mb-3" onClick={() => setSelectedModelId(null)}><Icon name="arrow-left-s" className="size-4" />{t('settings.models.models')}</Button> : null}
          <div hidden={selectedModelId !== null}>
            <div className="mb-4 flex items-start justify-between gap-3"><p className="typography-meta text-muted-foreground">{t('settings.models.availableModels')}</p>
              {type.discovery ? <Button variant="outline" size="sm" disabled={busy || discoveryDirty} onClick={() => { void run(async () => setCandidates((await api.discover(draft.id)).models)); }}><Icon name="refresh" className="size-3.5" />{t('settings.models.discover')}</Button> : null}
            </div>
            {type.discovery && discoveryDirty ? <p className="mb-3 typography-micro text-muted-foreground">{t('settings.models.discoveryHint')}</p> : null}
            <div className="divide-y divide-border/60">
              {draft.models.map((model, index) => <div key={model.id} className="flex items-center gap-3 py-4">
                <button type="button" disabled={busy} onClick={() => setSelectedModelId(model.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left"><ModelLogo modelId={model.id} requestModelId={model.requestModelId} displayName={model.name} /><span className="min-w-0"><span className="block truncate typography-ui-label">{model.name || model.id}</span><span className="mt-1 block truncate typography-micro text-muted-foreground">{model.id}</span></span></button>
                <div className="flex max-w-24 shrink-0 flex-wrap justify-end gap-1">{model.operations.map(operation => <span key={operation} className="rounded bg-muted px-1.5 py-0.5 typography-micro text-muted-foreground">{t(`settings.models.operation.${operation}`)}</span>)}</div>
                <Switch aria-label={`${t('settings.models.enabled')}: ${model.name || model.id}`} checked={model.enabled} disabled={busy} onCheckedChange={enabled => editModel(index, { enabled })} />
              </div>)}
            </div>
          </div>
        <SettingsSection title={selectedModelId ? draft.models.find(model => model.id === selectedModelId)?.name : undefined}>
          {draft.models.map((model, index) => <div key={model.id} hidden={selectedModelId !== model.id} className="space-y-5">
            <div className="flex items-center gap-2"><Checkbox ariaLabel={model.id} checked={model.enabled} disabled={busy} onChange={value => editModel(index, { enabled: value })} /><span className="flex-1 typography-meta">{model.id}</span><Button variant="ghost" size="sm" disabled={busy} onClick={() => { edit({ models: draft.models.filter((_, i) => i !== index) }); setSelectedModelId(null); setInvalidFields(previous => new Set([...previous].filter(key => !key.startsWith(`${model.id}:`)))); }}>{t('settings.models.remove')}</Button></div>
            <SettingsStackedField label={t('settings.models.name')} controlClassName="max-w-none"><Input aria-label={t('settings.models.name')} value={model.name} disabled={busy} onChange={event => editModel(index, { name: event.target.value })} /></SettingsStackedField>
            <SettingsStackedField label={t('settings.models.requestModelId')} controlClassName="max-w-none"><Input aria-label={t('settings.models.requestModelId')} placeholder={t('settings.models.requestModelId')} value={model.requestModelId ?? ''} disabled={busy} onChange={event => { const next = { ...model }; if (event.target.value) next.requestModelId = event.target.value; else delete next.requestModelId; edit({ models: draft.models.map((value, i) => i === index ? next : value) }); }} /></SettingsStackedField>
            <div className="flex flex-wrap gap-3">{type.operations.map(operation => <label key={operation} className="flex items-center gap-2 typography-meta"><Checkbox checked={model.operations.includes(operation)} disabled={busy} onChange={checked => editModel(index, { operations: checked ? [...model.operations, operation] : model.operations.filter(value => value !== operation) })} />{t(`settings.models.operation.${operation}`)}</label>)}</div>
            {model.operations.includes('chat') ? <div className="grid gap-3 @xl:grid-cols-2"><SettingsStackedField label={t('settings.models.context')}><Input type="number" aria-label={t('settings.models.context')} placeholder={t('settings.models.context')} value={model.contextWindow ?? ''} disabled={busy} onChange={event => { const next = { ...model }; if (event.target.value) next.contextWindow = Number(event.target.value); else delete next.contextWindow; edit({ models: draft.models.map((value, i) => i === index ? next : value) }); }} /></SettingsStackedField><SettingsStackedField label={t('settings.models.output')}><Input type="number" aria-label={t('settings.models.output')} placeholder={t('settings.models.output')} value={model.maxOutputTokens ?? ''} disabled={busy} onChange={event => { const next = { ...model }; if (event.target.value) next.maxOutputTokens = Number(event.target.value); else delete next.maxOutputTokens; edit({ models: draft.models.map((value, i) => i === index ? next : value) }); }} /></SettingsStackedField></div> : null}
            {model.operations.includes('chat') ? <>
              <label className="flex items-center gap-2 typography-meta"><Checkbox checked={model.input?.includes('image') ?? false} disabled={busy} onChange={checked => editModel(index, { input: checked ? [...model.input ?? ['text'], 'image'] : (model.input ?? ['text']).filter(value => value !== 'image') })} />{t('settings.models.imageInput')}</label>
              <SettingsFieldRow label={t('settings.models.reasoning')}><Select disabled={busy} value={model.reasoning === undefined ? 'unknown' : model.reasoning ? 'yes' : 'no'} onValueChange={value => { const next = { ...model }; if (value === 'unknown') delete next.reasoning; else next.reasoning = value === 'yes'; edit({ models: draft.models.map((entry, i) => i === index ? next : entry) }); }}><SelectTrigger size="settings" aria-label={t('settings.models.reasoning')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unknown">{t('settings.models.default')}</SelectItem><SelectItem value="yes">{t('settings.models.enabled')}</SelectItem><SelectItem value="no">{t('settings.models.disabled')}</SelectItem></SelectContent></Select></SettingsFieldRow>
            </> : null}
            <details><summary className="cursor-pointer typography-meta">{t('settings.models.parameters')}</summary>{(['parameters', 'compat', 'thinkingLevelMap', 'image'] as const).map(field => <SettingsFieldRow key={field} label={t(`settings.models.${field}`)}><JsonObjectField value={model[field] as Record<string, JsonValue> | undefined} label={t(`settings.models.${field}`)} disabled={busy} onValidityChange={valid => validity(`${model.id}:${field}`, valid)} onChange={value => { const next = { ...model }; if (value === undefined) delete next[field]; else Object.assign(next, { [field]: value }); edit({ models: draft.models.map((entry, i) => i === index ? next : entry) }); }} /></SettingsFieldRow>)}</details>
          </div>)}
          <div hidden={selectedModelId !== null}>
          <div className="flex gap-2"><Input aria-label={t('settings.models.modelId')} placeholder={t('settings.models.modelId')} value={modelId} disabled={busy} onChange={event => setModelId(event.target.value)} /><Button variant="outline" disabled={busy || !modelId.trim()} onClick={() => addModel(modelId)}>{t('settings.models.addModel')}</Button></div>
          {[...type.catalog ?? [], ...candidates.filter(candidate => !type.catalog?.some(model => model.id === candidate.id))].filter(candidate => !draft.models.some(model => model.id === candidate.id)).map(candidate => <Button key={candidate.id} variant="ghost" size="sm" disabled={busy} onClick={() => addModel(candidate.id, candidate.name, candidate)}>{candidate.name} +</Button>)}
          </div>
        </SettingsSection>
        </div>
        </div>
        <SettingsActionBar dirty={dirty} saving={busy} onSave={save} onCancel={() => { if (savedChannel) choose(savedChannel); else closeEditor(); }} saveDisabled={invalidFields.size > 0 || authorization?.status === 'pending' || !draft.name.trim()} saveLabel={t('settings.models.save')} error={error}>
          <Button variant="ghost" disabled={busy} onClick={() => { if (confirmDiscard()) closeEditor(); }}>{t('settings.models.close')}</Button>
        </SettingsActionBar>
      </div> : <div className="hidden min-h-80 items-center justify-center p-8 text-center typography-meta text-muted-foreground @3xl:flex">{t('settings.models.selectService')}</div>}
    </div>}
  </SettingsPageLayout>;
}
