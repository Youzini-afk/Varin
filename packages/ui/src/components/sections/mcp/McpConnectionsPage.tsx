import React from 'react';
import { SettingsActionBar } from '../shared/SettingsActionBar';
import { requestSettingsNavigation } from '@/lib/settings/drafts';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { ProjectTrustSettings } from '@/components/sections/shared/ProjectTrustSettings';
import { getProjectTrustGeneration, subscribeProjectTrustChanges } from '@/lib/projectTrust';
import { json } from '@codemirror/lang-json';
import { parse, type ParseError } from 'jsonc-parser';
import { createMcpConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, registerRuntimeEndpointSwitchBlocker, type McpConfigurationSnapshot, type McpConfigurationDocument, type AuthorizationState } from '@varin/application-client';
import { SettingsPageLayout } from '../shared/SettingsPageLayout';
import { SettingsSection, SettingsFieldRow } from '../shared/SettingsSection';
import { AuthorizationPanel } from '../shared/AuthorizationPanel';
import { McpStructuredConfigEditor } from './McpStructuredConfigEditor';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export function McpConnectionsPage() {
  const { t } = useI18n();
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
  const [showDetail, setShowDetail] = React.useState(false);
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
  const run = async (action: (current: NonNullable<typeof active.current>) => Promise<void>) => {
    const current = active.current; if (!current) return;
    setBusy(true); setError('');
    try { await action(current); return true; } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { if (active.current === current) setBusy(false); }
  };
  const select = (next: typeof selection, nextPath = path) => requestSettingsNavigation(() => {
    if (nextPath !== path) preservedDraft.current = false;
    setSelection(next); setPath(nextPath); setShowDetail(true); setRaw(false);
  });
  const selectedServer = selection.mode === 'server' ? snapshot?.servers.find(server => server.name === selection.name) : undefined;
  const save = () => !document ? Promise.resolve(false) : run(async current => {
    const saved = await api.saveDocument(current.view, document.path, draft, document.revision, current.signal);
    if (active.current === current) {
      setDocument(saved); setDraft(saved.content);
      const next = await api.read(current.view, current.signal);
      if (active.current === current) setSnapshot(next);
    }
  });
  return <SettingsPageLayout title={t('settings.mcp.title')} description={t('settings.mcp.managementHint')}>
    <ProjectTrustSettings />
    {error ? <p role="alert" className="mb-4 typography-meta text-destructive">{error}</p> : null}
    {snapshot?.issues.map((issue, index) => <p key={index} role="alert" className="typography-meta text-destructive">{issue}</p>)}
    {!snapshot && !error ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {snapshot ? <div className="grid min-w-0 gap-6 @3xl:grid-cols-[210px_minmax(0,1fr)]">
      <aside className={cn('min-w-0 space-y-3 @3xl:block', showDetail && 'hidden')}>
        <div className="flex items-center justify-between gap-2"><h2 className="typography-ui-label">{t('settings.mcp.servers')} <span className="ml-1 text-muted-foreground">{snapshot.servers.length}</span></h2>
          <Button variant="ghost" size="sm" aria-label={t('settings.mcp.add')} disabled={busy} onClick={() => select({ mode: 'new' })}><Icon name="add" className="size-4" /></Button>
        </div>
        <Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('settings.mcp.search')} aria-label={t('settings.mcp.search')} />
        <div className="space-y-1">{snapshot.servers.filter(server => server.name.toLowerCase().includes(query.toLowerCase())).map(server => <button type="button" key={server.name}
          className={cn('w-full rounded-lg border border-transparent px-3 py-3 text-left hover:bg-interactive-hover', selection.name === server.name && 'border-border/60 bg-muted/50')}
          onClick={() => select({ mode: 'server', name: server.name }, server.source)}>
          <span className="flex items-center gap-2"><Icon name="plug-2" className="size-4 shrink-0 text-muted-foreground" /><span className="truncate typography-ui-label">{server.name}</span></span>
          <span className="mt-1 block typography-meta text-muted-foreground">{text(`settings.mcp.status.${server.status}`)}</span>
        </button>)}</div>
        {!snapshot.servers.length ? <p className="py-4 typography-meta text-muted-foreground">{t('settings.mcp.empty')}</p> : null}
        <Button variant="ghost" className="w-full justify-start" onClick={() => select({ mode: 'settings' })}>{t('settings.mcp.configuration')}</Button>
      </aside>
      <div className={cn('min-w-0 @3xl:block', !showDetail && 'hidden')}>
        <Button variant="ghost" size="sm" className="mb-4 @3xl:hidden" onClick={() => setShowDetail(false)}><Icon name="arrow-left-s" className="size-4" />{t('settings.mcp.servers')}</Button>
        {selectedServer ? <SettingsSection title={selectedServer.name} description={t('settings.mcp.toolCounts', { cached: selectedServer.cachedToolCount, connected: selectedServer.connectedToolCount })} divider={false}>
          <div className="mb-3 flex flex-wrap items-center gap-2"><span className="mr-auto rounded-full bg-muted px-2.5 py-1 typography-meta">{text(`settings.mcp.status.${selectedServer.status}`)}</span>
            <Button size="sm" disabled={busy || !selectedServer.canConnect || selectedServer.status === 'connecting'} onClick={() => { void run(async current => { const next = await api.command(current.view, selectedServer.name, selectedServer.holdsConnection ? 'reconnect' : 'connect', current.signal); if (active.current === current) setSnapshot(next); }); }}>{t(selectedServer.status === 'connecting' ? 'settings.mcp.status.connecting' : selectedServer.holdsConnection ? 'settings.mcp.reconnect' : selectedServer.status === 'connected' ? 'settings.mcp.useConnection' : 'settings.mcp.connect')}</Button>
            {selectedServer.holdsConnection ? <Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(async current => { const next = await api.command(current.view, selectedServer.name, 'disconnect', current.signal); if (active.current === current) setSnapshot(next); }); }}>{t('settings.mcp.disconnect')}</Button> : null}
            {selectedServer.canSignIn ? <Button size="sm" variant="outline" disabled={busy || !selectedServer.enabled || selectedServer.status === 'connecting' || authorization?.status === 'pending'} onClick={() => { void run(async current => { const state = await api.signIn(current.view, selectedServer.name, current.signal); if (active.current !== current) return; authId.current = state.id; const next = await api.authorization(current.view, state.id, current.signal); if (active.current === current && authId.current === state.id) setAuthorization(next); }); }}>{t(selectedServer.signInRequired ? 'settings.mcp.signIn' : 'settings.mcp.trySignIn')}</Button> : null}
            {selectedServer.canSignOut ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(async current => { const next = await api.command(current.view, selectedServer.name, 'sign-out', current.signal); if (active.current === current) setSnapshot(next); }); }}>{t('settings.mcp.signOut')}</Button> : null}
          </div>
          {selectedServer.holdsConnection ? <p className="typography-meta text-muted-foreground">{t('settings.mcp.disconnectHint')}</p> : null}
          {selectedServer.canSignIn && !selectedServer.signInRequired ? <p className="typography-meta text-muted-foreground">{t('settings.mcp.signInDiscoveryHint')}</p> : null}
          {selectedServer.error ? <p role="alert" className="typography-meta text-destructive">{selectedServer.error}</p> : null}
          <p className="mt-3 break-all font-mono typography-micro text-muted-foreground">{selectedServer.source}{selectedServer.override ? ` → ${selectedServer.override}` : ''}</p>
        </SettingsSection> : null}
        {authorization ? <AuthorizationPanel key={authorization.id} state={authorization} onReply={value => api.reply(snapshot.view, authorization.id, value)} onCancel={() => api.cancelAuthorization(snapshot.view, authorization.id)} /> : null}
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
          </> : null}
        </SettingsSection>
      </div>
      {document ? <SettingsActionBar dirty={dirty} saving={busy} saveDisabled={!valid || !documentAllowed} onSave={save} onCancel={() => { setDraft(document.content); setError(''); }} error={error} /> : null}
    </div> : null}
  </SettingsPageLayout>;
}
