import React from 'react';
import { SettingsTabs } from '../shared/SettingsTabs';
import { SettingsDisclosure } from '../shared/SettingsDisclosure';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { getProjectTrustGeneration, subscribeProjectTrustChanges } from '@/lib/projectTrust';
import { json } from '@codemirror/lang-json';
import { parse, type ParseError } from 'jsonc-parser';
import { createMcpConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, registerRuntimeEndpointSwitchBlocker, type McpConfigurationSnapshot, type McpConfigurationDocument, type AuthorizationState } from '@varin/application-client';
import { Av, Catalog, CatalogGroup, CatalogItem, Dot, Loading, Note, ObjectHeader, useSettingsShell } from '../shared/kit';
import { SettingsScopeLabel } from '../shared/SettingsScope';
import { SettingsSection, SettingsFieldRow } from '../shared/SettingsSection';
import { AuthorizationPanel } from '../shared/AuthorizationPanel';
import { McpStructuredConfigEditor } from './McpStructuredConfigEditor';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMcpSettingsTarget } from '@/components/mcp/mcp-settings-navigation';

export function McpConnectionsPage() {
  const { t } = useI18n();
  const { setCatalogStage } = useSettingsShell();
  const text = (key: string) => t(key as never);
  const cwd = useDirectoryStore(state => state.currentDirectory);
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const trustVersion = React.useSyncExternalStore(subscribeProjectTrustChanges, getProjectTrustGeneration, getProjectTrustGeneration);
  const api = React.useMemo(() => createMcpConnectionsHttpAPI(host), [host]);
  const [snapshot, setSnapshot] = React.useState<McpConfigurationSnapshot | null>(null);
  const [path, setPath] = React.useState('');
  const [document, setDocument] = React.useState<McpConfigurationDocument | null>(null);
  const [draft, setDraft] = React.useState('');
  const [selection, setSelection] = React.useState<{ mode: 'server' | 'new' | 'settings'; name?: string }>({ mode: 'settings' });
  const [authorization, setAuthorization] = React.useState<AuthorizationState | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [raw, setRaw] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [toolQuery, setToolQuery] = React.useState('');
  const [tab, setTab] = React.useState<'tools' | 'configuration' | 'diagnostics'>('tools');
  const active = React.useRef<{ view: string; signal: AbortSignal } | null>(null);
  const authId = React.useRef<string | undefined>(undefined);
  const revision = React.useRef(0);
  const extensions = React.useMemo(() => [json()], []);
  const dirty = document !== null && draft !== document.content;
  const openedOwner = React.useRef<string | null>(null);
  const preservedDraft = React.useRef(false);
  const latestDraft = React.useRef({ dirty, path }); latestDraft.current = { dirty, path };
  const documentAllowed = !!snapshot?.sources.some(source => source.path === document?.path);
  const valid = React.useMemo(() => { const errors: ParseError[] = []; const value = parse(draft, errors, { allowTrailingComma: true }); return errors.length === 0 && value !== null && typeof value === 'object' && !Array.isArray(value); }, [draft]);
  React.useEffect(() => {
    const controller = new AbortController();
    const ownerKey = JSON.stringify([host, cwd]);
    const keepDraft = openedOwner.current === ownerKey && latestDraft.current.dirty;
    openedOwner.current = ownerKey; preservedDraft.current = keepDraft;
    const retainedPath = latestDraft.current.path;
    active.current = null; authId.current = undefined; revision.current += 1;
    setSnapshot(null); setBusy(false); setError(''); setAuthorization(null);
    if (!keepDraft) { setDocument(null); setDraft(''); setPath(''); }
    const opening = api.open(cwd || undefined, controller.signal);
    void opening.then(value => {
      if (controller.signal.aborted) { void api.close(value.view).catch(() => {}); return; }
      active.current = { view: value.view, signal: controller.signal }; setSnapshot(value); setPath(keepDraft ? retainedPath : value.servers[0]?.source ?? value.sources[0]?.path ?? '');
      if (!keepDraft) setSelection(value.servers[0] ? { mode: 'server', name: value.servers[0].name } : { mode: 'new' });
    }, error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    const stop = subscribeVarinEvents(event => {
      if (event.type !== 'settings-changed' || event.owner !== 'agent-settings' || !event.ids.includes('mcp')) return;
      const current = active.current; if (!current || current.signal !== controller.signal) return;
      void api.read(current.view, current.signal).then(value => { if (active.current === current) setSnapshot(value); }, error => { if (!controller.signal.aborted) setError(String(error)); });
      const id = authId.current;
      if (id) void api.authorization(current.view, id, current.signal).then(value => { if (active.current === current && authId.current === id) setAuthorization(value); }, error => { if (!controller.signal.aborted && authId.current === id) setError(String(error)); });
    });
    const stopSwitch = registerRuntimeEndpointSwitchBlocker(async () => {
      const opened = await opening.catch(() => undefined);
      if (opened) await api.close(opened.view);
    });
    return () => { stopSwitch(); const current = active.current; active.current = null; controller.abort(); stop(); if (current) void api.close(current.view).catch(() => {}); };
  }, [api, cwd, host, trustVersion]);
  const load = React.useCallback(async () => {
    const current = active.current; if (!current || !path) return;
    const request = ++revision.current;
    setDocument(null); setBusy(true); setError('');
    try {
      const next = await api.readDocument(current.view, path, current.signal);
      if (request === revision.current && active.current === current) { preservedDraft.current = false; setDocument(next); setDraft(next.content); }
    } catch (error) { if (!current.signal.aborted && request === revision.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (request === revision.current) setBusy(false); }
  }, [api, path]);
  React.useEffect(() => { if (!preservedDraft.current) void load(); }, [load, snapshot?.view]);
  const run = React.useCallback(async (action: (current: NonNullable<typeof active.current>) => Promise<void>) => {
    const current = active.current; if (!current) return;
    setBusy(true); setError('');
    try { await action(current); return true; } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { if (active.current === current) setBusy(false); }
  }, []);
  const signIn = React.useCallback(async (current: NonNullable<typeof active.current>, name: string) => {
    const state = await api.signIn(current.view, name, current.signal);
    if (active.current !== current) return;
    authId.current = state.id;
    const next = await api.authorization(current.view, state.id, current.signal);
    if (active.current === current && authId.current === state.id) setAuthorization(next);
  }, [api]);
  const select = (next: typeof selection, nextPath = path) => requestSettingsNavigation(() => {
    if (nextPath !== path) { preservedDraft.current = false; revision.current += 1; setDocument(null); setDraft(''); }
    setSelection(next); setPath(nextPath); setCatalogStage('detail'); setRaw(false); setTab(next.mode === 'server' ? 'tools' : 'configuration'); setToolQuery('');
  });
  const selectedServer = selection.mode === 'server' ? snapshot?.servers.find(server => server.name === selection.name) : undefined;
  const navigation = useMcpSettingsTarget(state => state.target);
  React.useEffect(() => {
    if (!snapshot || !navigation) return;
    if (navigation.host !== host || navigation.directory !== cwd) { useMcpSettingsTarget.setState({ target: undefined }); return; }
    const server = navigation.selection.mode === 'server' ? snapshot.servers.find(server => server.name === navigation.selection.name) : undefined;
    if (navigation.selection.mode === 'server' && !server) { useMcpSettingsTarget.setState({ target: undefined }); return; }
    const nextPath = server?.source ?? snapshot.sources[0]?.path ?? '';
    setSelection(previous => previous.mode === navigation.selection.mode && previous.name === navigation.selection.name ? previous : navigation.selection);
    setPath(nextPath);
    setCatalogStage('detail'); setRaw(false); setTab(navigation.selection.mode === 'server' ? 'tools' : 'configuration');
    if (navigation.selection.signIn && server) {
      if (busy || document?.path !== nextPath) return;
      useMcpSettingsTarget.setState({ target: undefined });
      if (server.canSignIn && server.enabled) void run(current => signIn(current, server.name));
    } else useMcpSettingsTarget.setState({ target: undefined });
  }, [navigation, snapshot, host, cwd, busy, document?.path, run, signIn, setCatalogStage]);
  const save = () => !document ? Promise.resolve(false) : run(async current => {
    const saved = await api.saveDocument(current.view, document.path, draft, document.revision, current.signal);
    if (active.current === current) {
      setDocument(saved); setDraft(saved.content);
      const next = await api.read(current.view, current.signal);
      if (active.current === current) setSnapshot(next);
    }
  });
  const avatar = (icon: 'file-text' | 'plug-2') => <Av><Icon name={icon} className="size-4" /></Av>;
  return <Catalog title={t('settings.mcp.title')} description={t('settings.mcp.managementHint')}
    scope={<SettingsScopeLabel kind="hostProject" />}
    filter={{ value: query, onChange: setQuery, placeholder: t('settings.mcp.search') }}
    headActions={snapshot ? <Button variant="ghost" size="sm" aria-label={t('settings.mcp.add')} disabled={busy} onClick={() => select({ mode: 'new' })}><Icon name="add" className="size-4" /></Button> : null}
    detailKey={selection.mode === 'server' ? selection.name : selection.mode}
    items={snapshot ? <>
        <CatalogItem pinned selected={selection.mode === 'settings'} name={t('settings.mcp.files')} lead={avatar('file-text')}
          opensDetail={false} onSelect={() => select({ mode: 'settings' }, snapshot.sources[0]?.path ?? '')} />
        {(['global', 'project', 'unknown'] as const).map(scope => {
          // The Host resolves precedence. Group the effective server by its actual source, not its name or directory prefix.
          const servers = snapshot.servers.filter(server => (snapshot.sources.find(source => source.path === server.source)?.scope ?? 'unknown') === scope && server.name.toLowerCase().includes(query.trim().toLowerCase()));
          return servers.length ? <section key={scope} aria-label={t(`settings.mcp.scope.${scope}`)}>
            <CatalogGroup label={t(`settings.mcp.scope.${scope}`)} count={servers.length} />
            {servers.map(server => <CatalogItem key={server.name} name={server.name} lead={avatar('plug-2')}
              meta={<><Dot state={server.status === 'connected' ? 'ok' : server.signInRequired ? 'warn' : 'off'} />{text(`settings.mcp.status.${server.status}`)}</>}
              selected={selection.mode === 'server' && selection.name === server.name} dim={!server.enabled} opensDetail={false}
              onSelect={() => select({ mode: 'server', name: server.name }, server.source)} />)}
          </section> : null;
        })}
        {!snapshot.servers.length ? <p className="py-4 typography-meta text-muted-foreground">{t('settings.mcp.empty')}</p> : null}
      </> : !error ? <Loading /> : <Note kind="err">{error}</Note>}
    detail={<>
      {error ? <Note kind="err">{error}</Note> : null}
      {snapshot?.issues.map((issue, index) => <Note key={index} kind="warn">{issue}</Note>)}
      {snapshot ? <>
        <ObjectHeader avatar={avatar(selectedServer ? 'plug-2' : 'file-text')}
          title={selectedServer?.name ?? t(selection.mode === 'new' ? 'settings.mcp.add' : 'settings.mcp.files')}
          sub={selectedServer ? <><Dot state={selectedServer.status === 'connected' ? 'ok' : selectedServer.signInRequired ? 'warn' : 'off'} />{text(`settings.mcp.status.${selectedServer.status}`)} · {t('settings.mcp.toolCounts', { cached: selectedServer.cachedToolCount, connected: selectedServer.connectedToolCount })}</> : undefined} />
        {selectedServer ? <SettingsSection>
          <div className="sk-pad flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy || !selectedServer.canConnect || selectedServer.status === 'connecting'} onClick={() => { void run(async current => { const next = await api.command(current.view, selectedServer.name, selectedServer.holdsConnection ? 'reconnect' : 'connect', current.signal); if (active.current === current) setSnapshot(next); }); }}>{t(selectedServer.status === 'connecting' ? 'settings.mcp.status.connecting' : selectedServer.holdsConnection ? 'settings.mcp.reconnect' : selectedServer.status === 'connected' ? 'settings.mcp.useConnection' : 'settings.mcp.connect')}</Button>
            {selectedServer.holdsConnection ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(async current => { const next = await api.command(current.view, selectedServer.name, 'disconnect', current.signal); if (active.current === current) setSnapshot(next); }); }}>{t('settings.mcp.disconnect')}</Button> : null}
            {selectedServer.canSignIn ? <Button size="sm" variant="outline" disabled={busy || !selectedServer.enabled || selectedServer.status === 'connecting' || authorization?.status === 'pending'} onClick={() => { void run(current => signIn(current, selectedServer.name)); }}>{t(selectedServer.signInRequired ? 'settings.mcp.signIn' : 'settings.mcp.trySignIn')}</Button> : null}
            {selectedServer.canSignOut ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(async current => { const next = await api.command(current.view, selectedServer.name, 'sign-out', current.signal); if (active.current === current) setSnapshot(next); }); }}>{t('settings.mcp.signOut')}</Button> : null}
          </div>
          {selectedServer.holdsConnection ? <p className="typography-meta text-muted-foreground">{t('settings.mcp.disconnectHint')}</p> : null}
          {selectedServer.canSignIn && !selectedServer.signInRequired ? <p className="typography-meta text-muted-foreground">{t('settings.mcp.signInDiscoveryHint')}</p> : null}
          {selectedServer.error ? <p role="alert" className="typography-meta text-destructive">{selectedServer.error}</p> : null}

        </SettingsSection> : null}
        {authorization ? <AuthorizationPanel key={authorization.id} state={authorization} onReply={value => api.reply(snapshot.view, authorization.id, value)} onCancel={() => api.cancelAuthorization(snapshot.view, authorization.id)} /> : null}
        {selectedServer ? <SettingsTabs label={selectedServer.name} value={tab} onChange={setTab} items={[
          { value: 'tools', label: t('settings.experience.toolsDirectory') },
          { value: 'configuration', label: t('settings.mcp.configuration') },
          { value: 'diagnostics', label: t('settings.experience.diagnostics') },
        ]} /> : null}
        {selectedServer && tab === 'tools' ? <div className="space-y-4">
          <p className="typography-meta text-muted-foreground">{t(selectedServer.toolsSource === 'connection' ? 'settings.experience.liveTools' : 'settings.experience.cachedTools')}</p>
          <Input value={toolQuery} onChange={event => setToolQuery(event.target.value)} placeholder={t('settings.experience.searchTools')} aria-label={t('settings.experience.searchTools')} />
          {(selectedServer.tools ?? []).filter(tool => (tool.name + ' ' + tool.description).toLowerCase().includes(toolQuery.toLowerCase())).map(tool => <SettingsDisclosure key={tool.name} title={tool.name}>
            <p className="whitespace-pre-wrap typography-meta text-muted-foreground">{tool.description}</p>
            <pre className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 typography-micro">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
          </SettingsDisclosure>)}
          {!selectedServer.tools?.length ? <p className="py-6 typography-meta text-muted-foreground">{t('settings.experience.noToolDeclarations')}</p> : null}
        </div> : null}
        {selectedServer && tab === 'diagnostics' ? <dl className="settings-object-list">
          <div className="py-4"><dt className="typography-ui-label">{t('settings.varin.mcp.config.source.label')}</dt><dd className="mt-2 break-all font-mono typography-meta text-muted-foreground">{selectedServer.source}</dd></div>
          {selectedServer.override ? <div className="py-4"><dt className="typography-ui-label">{t('settings.experience.overriddenSource')}</dt><dd className="mt-2 break-all font-mono typography-meta text-muted-foreground">{selectedServer.override}</dd></div> : null}
          <div className="py-4"><dt className="typography-ui-label">{t('settings.experience.toolsDirectory')}</dt><dd className="mt-2 typography-meta text-muted-foreground">{t('settings.mcp.toolCounts', { cached: selectedServer.cachedToolCount, connected: selectedServer.connectedToolCount })} · {selectedServer.exposure}</dd></div>
        </dl> : null}
        <div hidden={!!selectedServer && tab !== 'configuration'}>
        <SettingsSection title={t(selection.mode === 'new' ? 'settings.mcp.add' : 'settings.mcp.configuration')}>
          <SettingsFieldRow label={text('settings.varin.mcp.config.source.label')}>
            <Select value={path} disabled={busy} onValueChange={value => select({ mode: selection.mode === 'new' ? 'new' : 'settings' }, value)}><SelectTrigger size="settings" aria-label={text('settings.varin.mcp.config.source.label')}><SelectValue /></SelectTrigger><SelectContent>{snapshot.sources.map(source => <SelectItem key={source.path} value={source.path}>{source.path}</SelectItem>)}</SelectContent></Select>
          </SettingsFieldRow>
          {document ? <>
            {!documentAllowed ? <p role="status" className="typography-meta text-muted-foreground">{t('settings.varin.mcp.config.untrusted')}</p> : null}
            {valid ? <McpStructuredConfigEditor key={JSON.stringify([host, cwd, path, selection.mode, selection.name])} project={snapshot.sources.find(source => source.path === path)?.scope === 'project'} content={draft} mode={selection.mode} serverName={selection.name} disabled={busy || !documentAllowed} onChange={setDraft} /> : null}
            <div className="mt-5 border-t border-border/60 pt-3"><Button variant="ghost" onClick={() => setRaw(value => !value)}>{text(raw ? 'settings.varin.mcp.config.raw.hide' : 'settings.varin.mcp.config.raw.show')}</Button></div>
            {raw || !valid ? <div className="mt-3 h-80 overflow-hidden rounded-md border border-border/60"><CodeMirrorEditor value={draft} onChange={setDraft} extensions={extensions} readOnly={busy || !documentAllowed} className="h-full" /></div> : null}
            <Button className="mt-3" size="sm" variant="ghost" disabled={busy} onClick={() => requestSettingsNavigation(() => { void load(); })}>{text('settings.varin.mcp.config.actions.reload')}</Button>
            <SettingsActionBar placement="inline" dirty={dirty} saving={busy} saveDisabled={!valid || !documentAllowed} onSave={save} onCancel={() => { setDraft(document.content); setError(''); }} error={error} />
          </> : null}
        </SettingsSection>
        </div>
      </> : !error ? <Loading /> : null}
    </>}
  />;
}
