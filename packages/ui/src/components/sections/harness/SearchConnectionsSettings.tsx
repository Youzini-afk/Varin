import React from 'react';
import { parseHarnessWebSearchSettings, type HarnessWebSearchConfiguration, type HarnessWebSearchConnection, type HarnessWebSearchProvider } from '@varin/protocol';
import { getRuntimeKey, runtimeFetch } from '@varin/application-client';
import { SettingsSection, SettingsFieldRow, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import type { HarnessSettingsPageProps } from './harness-settings-state';


const providers = ['brave', 'exa', 'tavily', 'jina', 'searxng'] as const;
const providerName = (provider: HarnessWebSearchProvider) => provider === 'searxng' ? 'SearXNG' : provider[0]!.toUpperCase() + provider.slice(1);

function SearchCredential({ connectionId, onChanged }: { connectionId: string; onChanged(): void }) {
  const { t } = useI18n();
  const changed = React.useRef(onChanged); changed.current = onChanged;
  const [configured, setConfigured] = React.useState<boolean | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [key, setKey] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const state = React.useRef({ key: '', dirty: false, active: false, mounted: true, runtime: getRuntimeKey() });
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const url = `/api/harness/web-search/connections/${encodeURIComponent(connectionId)}/credential`;
  React.useEffect(() => {
    const lifecycle = state.current;
    lifecycle.mounted = true;
    const abort = new AbortController();
    void runtimeFetch(url, { cache: 'no-store', signal: abort.signal }).then(async (response) => {
      if (!response.ok) throw new Error(t('settings.harness.credentialFailed'));
      const result = await response.json() as { configured: boolean };
      if (!abort.signal.aborted) setConfigured(result.configured);
    }).catch((failure) => { if (!abort.signal.aborted) setError(String(failure)); });
    return () => { lifecycle.mounted = false; abort.abort(); };
  }, [url, t, attempt]);

  const save = React.useCallback(async () => {
    clearTimeout(timer.current);
    const pending = state.current;
    if (pending.active || !pending.dirty || !pending.key.trim()) return;
    pending.active = true;
    if (pending.mounted) { setBusy(true); setError(null); }
    try {
      while (pending.dirty) {
        if (getRuntimeKey() !== pending.runtime) throw new Error(t('settings.harness.credentialFailed'));
        const sent = pending.key;
        const response = await runtimeFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: sent.trim() }) });
        if (!response.ok) throw new Error(t('settings.harness.credentialFailed'));
        if (pending.key === sent) {
          // Keep the text while focused: a typing pause must not erase the
          // prefix before the user continues entering the same credential.
          pending.dirty = false;
        }
        if (pending.mounted) { setConfigured(true); changed.current(); }
      }
    } catch (failure) { if (pending.mounted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { pending.active = false; if (pending.mounted) setBusy(false); }
  }, [url, t]);
  React.useEffect(() => () => { clearTimeout(timer.current); void save(); }, [save]);

  return <SettingsFieldRow label={t('settings.page.harness.web.search.apiKey')} controlClassName="@xl:flex-1 @xl:max-w-80">
    <div className="w-full space-y-2">
      {configured && !editing ? <div className="flex flex-wrap items-center gap-2">
        <span className="typography-meta text-muted-foreground">{t('settings.page.harness.web.search.configured')}</span>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{t('settings.harness.replace')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
          setBusy(true); setError(null);
          void runtimeFetch(url, { method: 'DELETE' }).then((response) => {
            if (!response.ok) throw new Error(t('settings.harness.credentialFailed'));
            setConfigured(false); changed.current();
          }).catch((failure) => setError(String(failure))).finally(() => setBusy(false));
        }}>{t('settings.harness.rules.remove')}</Button>
      </div> : <Input type="password" autoComplete="new-password" aria-label={t('settings.page.harness.web.search.apiKey')}
        value={key} placeholder={t('settings.page.harness.web.search.notConfigured')}
        onChange={(event) => {
          const value = event.target.value; setEditing(true); setKey(value); state.current.key = value; state.current.dirty = Boolean(value.trim());
          clearTimeout(timer.current); if (!(event.nativeEvent as InputEvent).isComposing) timer.current = setTimeout(() => { void save(); }, 650);
        }} onCompositionEnd={() => { clearTimeout(timer.current); timer.current = setTimeout(() => { void save(); }, 650); }}
        onBlur={() => { void save().then(() => { if (state.current.mounted && !state.current.dirty) { setEditing(false); setKey(''); state.current.key = ''; } }); }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } }} />}
      <p className="typography-meta text-muted-foreground">{t(busy ? 'settings.common.actions.saving' : 'settings.page.harness.web.search.apiKey.description')}</p>
      {error ? <div role="alert" className="typography-meta text-destructive">{error} <Button variant="ghost" size="sm" onClick={() => { if (state.current.dirty) void save(); else { setError(null); setAttempt((value) => value + 1); } }}>{t('settings.harness.retry')}</Button></div> : null}
    </div>
  </SettingsFieldRow>;
}


export function SearchConnectionsSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const config = harness.web?.search === undefined ? undefined : parseHarnessWebSearchSettings(harness.web.search);
  const current = React.useRef(config);
  current.current = config;
  const [newProvider, setNewProvider] = React.useState<HarnessWebSearchProvider>('exa');
  const [credentialRevision, setCredentialRevision] = React.useState(0);
  const credentialChanged = React.useCallback(() => setCredentialRevision(value => value + 1), []);
  const save = (value: HarnessWebSearchConfiguration) => {
    current.current = value;
    update({ web: { search: { provider: undefined, endpoint: undefined, credentialRef: undefined, defaultConnectionId: undefined, ...value } } });
  };
  const edit = (id: string, patch: Partial<HarnessWebSearchConnection>) => {
    const value = current.current;
    if (!value?.connections.some(connection => connection.id === id)) return;
    save({ ...value, connections: value.connections.map(connection => connection.id === id ? { ...connection, ...patch } : connection) });
  };
  return <SettingsSection title={t('settings.page.harness.section.web')} settingsItem="harness.web.search" contentClassName="space-y-5">
    <SettingsCheckboxRow checked={harness.tools.websearch !== false} onChange={enabled => update({ tools: { websearch: enabled } })}
      ariaLabel={t('settings.page.harness.web.search.enabled')} label={t('settings.page.harness.web.search.enabled')} />
    {config === undefined ? <p className="typography-meta text-muted-foreground">{t('settings.page.harness.web.search.default.description')}</p> : null}
    {config === null ? <p role="alert" className="typography-meta text-destructive">{t('settings.webConnections.invalid')}</p> : null}
    {config ? <>
      <SettingsCheckboxRow checked={config.enabled !== false} onChange={enabled => save({ ...config, enabled })}
        ariaLabel={t('settings.webConnections.enabled')} label={t('settings.webConnections.enabled')} />
      <SettingsFieldRow label={t('settings.webConnections.default')}>
        <Select value={config.defaultConnectionId ?? 'none'} onValueChange={id => save({ ...config, ...(id === 'none' ? { defaultConnectionId: undefined } : { defaultConnectionId: id }) } as HarnessWebSearchConfiguration)}>
          <SelectTrigger size="settings" className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="none">{t('settings.webConnections.firstEnabled')}</SelectItem>{config.connections.map(connection => <SelectItem key={connection.id} value={connection.id}>{connection.name}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      {config.connections.map(connection => <div key={connection.id} className="space-y-4 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{connection.name} · {providerName(connection.provider)}</span>
          <Button variant="ghost" size="sm" onClick={() => {
            const value = current.current;
            if (!value) return;
            const { defaultConnectionId, ...rest } = value;
            save({ ...rest, connections: value.connections.filter(item => item.id !== connection.id), fallbackConnectionIds: value.fallbackConnectionIds.filter(id => id !== connection.id),
              ...(defaultConnectionId && defaultConnectionId !== connection.id ? { defaultConnectionId } : {}) });
          }}>{t('settings.harness.rules.remove')}</Button>
        </div>
        <p className="typography-meta text-muted-foreground">{connection.id}</p>
        <SettingsCheckboxRow checked={connection.enabled} onChange={enabled => edit(connection.id, { enabled })}
          ariaLabel={`${connection.name}: ${t('settings.webConnections.enabled')}`} label={t('settings.webConnections.enabled')} />
        <SettingsFieldRow label={t('settings.webConnections.name')}><AutoSaveInput value={connection.name} onCommit={name => edit(connection.id, { name: name.trim() || connection.name })} /></SettingsFieldRow>
        <SettingsFieldRow label={t('settings.webConnections.description')}><AutoSaveInput value={connection.description ?? ''} onCommit={description => edit(connection.id, { description })} /></SettingsFieldRow>
        <SettingsFieldRow label={t('settings.webConnections.endpoint')}>
          <AutoSaveInput value={connection.endpoint ?? ''} placeholder={connection.provider === 'searxng' ? 'https://search.example.com' : t('settings.webConnections.providerDefault')}
            validate={value => { if (!value.trim() && connection.provider !== 'searxng') return null; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? null : t('settings.harness.validUrl'); } catch { return t('settings.harness.validUrl'); } }}
            onCommit={endpoint => { const value = current.current; if (!value) return; save({ ...value, connections: value.connections.map(item => { if (item.id !== connection.id) return item; const { endpoint: _old, ...rest } = item; return { ...rest, ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}) }; }) }); }} />
        </SettingsFieldRow>
        <SearchCredential connectionId={connection.id} onChanged={credentialChanged} />
        <SettingsCheckboxRow checked={config.fallbackConnectionIds.includes(connection.id)} onChange={enabled => {
          const value = current.current; if (!value) return;
          save({ ...value, fallbackConnectionIds: enabled ? [...value.fallbackConnectionIds, connection.id] : value.fallbackConnectionIds.filter(id => id !== connection.id) });
        }} ariaLabel={`${connection.name}: ${t('settings.webConnections.fallback')}`} label={t('settings.webConnections.fallback')} />
        {config.fallbackConnectionIds.includes(connection.id) ? <div className="flex items-center gap-2">
          <span className="typography-meta">{t('settings.webConnections.fallbackOrder')} {config.fallbackConnectionIds.indexOf(connection.id) + 1}</span>
          <Button size="sm" variant="ghost" disabled={config.fallbackConnectionIds.indexOf(connection.id) === 0} onClick={() => {
            const value = current.current; if (!value) return;
            const ids = [...value.fallbackConnectionIds]; const index = ids.indexOf(connection.id);
            if (index > 0) { [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]; save({ ...value, fallbackConnectionIds: ids }); }
          }}>{t('settings.webConnections.moveEarlier')}</Button>
        </div> : null}
        <ConnectionTest connectionId={connection.id} generation={JSON.stringify([connection, credentialRevision])} />
      </div>)}
      {!config.connections.length ? <p className="typography-meta text-muted-foreground">{t('settings.webConnections.empty')}</p> : null}
      <Button variant="ghost" onClick={() => update({ web: { search: undefined } })}>{t('settings.webConnections.restoreDefault')}</Button>
    </> : null}
    <div className="flex flex-wrap items-center gap-2">
      <Select value={newProvider} onValueChange={value => setNewProvider(value as HarnessWebSearchProvider)}>
        <SelectTrigger size="settings" className="w-40" aria-label={t('settings.page.harness.web.search.provider')}><SelectValue /></SelectTrigger>
        <SelectContent>{providers.map(provider => <SelectItem key={provider} value={provider}>{providerName(provider)}</SelectItem>)}</SelectContent>
      </Select>
      <Button variant="outline" onClick={() => {
        const id = `${newProvider}-${crypto.randomUUID()}`;
        const value = current.current ?? { connections: [], fallbackConnectionIds: [] };
        save({ ...value, connections: [...value.connections, { id, name: providerName(newProvider), provider: newProvider, enabled: true, credentialRef: `varin-web-search-connection-${id}` }],
          ...(value.defaultConnectionId ? {} : { defaultConnectionId: id }) });
      }}>{t('settings.webConnections.add')}</Button>
    </div>
  </SettingsSection>;
}

function ConnectionTest({ connectionId, generation }: { connectionId: string; generation: string }) {
  const { t } = useI18n();
  const [result, setResult] = React.useState<{ checkedAt: number; status: string; resultCount: number; failure?: { message: string } } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [configuration, setConfiguration] = React.useState<{ available: boolean; detail?: string; capabilities: Record<string, unknown> } | null>(null);
  const active = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    active.current?.abort(); setResult(null); setError(null); setBusy(false); setConfiguration(null);
    const abort = new AbortController();
    void runtimeFetch(`/api/harness/web-search/connections/${encodeURIComponent(connectionId)}`, { signal: abort.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) return; const value = await response.json(); if (!abort.signal.aborted) setConfiguration(value); }).catch(() => {});
    return () => { abort.abort(); active.current?.abort(); };
  }, [connectionId, generation]);
  return <div className="space-y-2">
    {configuration ? <>
      <p className="typography-meta">{t(configuration.available ? 'settings.webConnections.ready' : 'settings.webConnections.incomplete')}{configuration.detail ? ` · ${configuration.detail}` : ''}</p>
      <p className="typography-meta text-muted-foreground">{t('settings.webConnections.capabilities')}: {Object.entries(configuration.capabilities).map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}</p>
    </> : null}
    <Button variant="outline" size="sm" disabled={busy} onClick={() => {
      const abort = new AbortController(); active.current = abort; setBusy(true); setError(null);
      void runtimeFetch(`/api/harness/web-search/connections/${encodeURIComponent(connectionId)}/test`, { method: 'POST', signal: abort.signal }).then(async response => {
        if (!response.ok) throw new Error(t('settings.webConnections.testFailed'));
        const next = await response.json(); if (!abort.signal.aborted) setResult(next);
      }).catch(failure => { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); })
        .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    }}>{t(busy ? 'settings.webConnections.testing' : 'settings.webConnections.test')}</Button>
    <p className="typography-meta text-muted-foreground">{t('settings.webConnections.testDescription')}</p>
    {result ? <p role="status" className="typography-meta">{new Date(result.checkedAt).toLocaleString()} · {result.status} · {result.resultCount} {t('settings.webConnections.results')}{result.failure ? ` · ${result.failure.message}` : ''}</p> : null}
    {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
  </div>;
}
