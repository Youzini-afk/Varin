import React from 'react';
import { json } from '@codemirror/lang-json';
import { parse, type ParseError } from 'jsonc-parser';
import { createMcpConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type McpConfigurationSnapshot, type McpConfigurationDocument, type AuthorizationState } from '@varin/application-client';
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
  const active = React.useRef<{ view: string; signal: AbortSignal } | null>(null);
  const authId = React.useRef<string | undefined>(undefined);
  const revision = React.useRef(0);
  const extensions = React.useMemo(() => [json()], []);
  const dirty = document !== null && draft !== document.content;
  const valid = React.useMemo(() => { const errors: ParseError[] = []; const value = parse(draft, errors, { allowTrailingComma: true }); return errors.length === 0 && value !== null && typeof value === 'object' && !Array.isArray(value); }, [draft]);
  React.useEffect(() => {
    const controller = new AbortController();
    active.current = null; authId.current = undefined; revision.current += 1;
    setSnapshot(null); setDocument(null); setDraft(''); setPath(''); setError(''); setAuthorization(null);
    void api.open(cwd || undefined, controller.signal).then(value => {
      if (controller.signal.aborted) { void api.close(value.view).catch(() => {}); return; }
      active.current = { view: value.view, signal: controller.signal }; setSnapshot(value); setPath(value.sources[0]?.path ?? '');
    }, error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    const stop = subscribeVarinEvents(event => {
      if (event.type !== 'settings-changed' || event.owner !== 'agent-settings' || !event.ids.includes('mcp')) return;
      const current = active.current; if (!current || current.signal !== controller.signal) return;
      void api.read(current.view, current.signal).then(setSnapshot, error => { if (!controller.signal.aborted) setError(String(error)); });
      if (authId.current) void api.authorization(current.view, authId.current, current.signal).then(setAuthorization, error => { if (!controller.signal.aborted) setError(String(error)); });
    });
    return () => { const current = active.current; active.current = null; controller.abort(); stop(); if (current) void api.close(current.view).catch(() => {}); };
  }, [api, cwd]);
  const load = React.useCallback(async () => {
    const current = active.current; if (!current || !path) return;
    const request = ++revision.current;
    setDocument(null); setBusy(true); setError('');
    try {
      const next = await api.readDocument(current.view, path, current.signal);
      if (request === revision.current && active.current === current) { setDocument(next); setDraft(next.content); }
    } catch (error) { if (!current.signal.aborted && request === revision.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (request === revision.current) setBusy(false); }
  }, [api, path]);
  React.useEffect(() => { void load(); }, [load, snapshot?.view]);
  const run = async (action: (current: NonNullable<typeof active.current>) => Promise<void>) => {
    const current = active.current; if (!current) return;
    setBusy(true); setError('');
    try { await action(current); } catch (error) { if (!current.signal.aborted) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (active.current === current) setBusy(false); }
  };
  return <SettingsPageLayout title={t('settings.mcp.title')}>
    {error ? <p role="alert" className="typography-meta text-destructive">{error}</p> : null}
    {snapshot?.issues.map((issue, index) => <p key={index} role="alert" className="typography-meta text-destructive">{issue}</p>)}
    {snapshot ? <>
      <SettingsSection title={t('settings.mcp.servers')}>
        {snapshot.servers.map(server => <div key={server.name} className="space-y-2 border-b border-border/60 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 typography-ui-label">{server.name}</span>
            <span className="typography-meta text-muted-foreground">{text(`settings.mcp.status.${server.status}`)} · {t('settings.mcp.toolCounts', { cached: server.cachedToolCount, connected: server.connectedToolCount })}</span>
            {(['connect', 'reconnect', 'disconnect'] as const).map(command => <Button key={command} size="sm" variant="ghost" disabled={busy || !server.enabled} onClick={() => { void run(async current => setSnapshot(await api.command(current.view, server.name, command, current.signal))); }}>{t(`settings.mcp.${command}`)}</Button>)}
            {server.canSignIn ? <><Button size="sm" variant="ghost" disabled={busy || !server.enabled || authorization?.status === 'pending'} onClick={() => { void run(async current => { const state = await api.signIn(current.view, server.name, current.signal); authId.current = state.id; setAuthorization(await api.authorization(current.view, state.id, current.signal)); }); }}>{t('settings.mcp.signIn')}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(async current => setSnapshot(await api.command(current.view, server.name, 'sign-out', current.signal))); }}>{t('settings.mcp.signOut')}</Button></> : null}
            <Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => { setPath(server.source); setSelection({ mode: 'server', name: server.name }); }}>{t('settings.mcp.edit')}</Button>
          </div>
          <p className="break-all font-mono typography-micro text-muted-foreground">{server.source}{server.override ? ` → ${server.override}` : ''}</p>
          {server.error ? <p className="typography-meta text-destructive">{server.error}</p> : null}
        </div>)}
        <div className="flex gap-2"><Button variant="outline" disabled={busy || dirty} onClick={() => setSelection({ mode: 'new' })}>{t('settings.mcp.add')}</Button><Button variant="ghost" disabled={busy || dirty} onClick={() => setSelection({ mode: 'settings' })}>{t('settings.mcp.configuration')}</Button></div>
      </SettingsSection>
      {authorization ? <AuthorizationPanel state={authorization} onReply={value => api.reply(snapshot.view, authorization.id, value)} onCancel={() => api.cancelAuthorization(snapshot.view, authorization.id)} /> : null}
      <SettingsSection title={t('settings.mcp.configuration')}>
        <SettingsFieldRow label={text('settings.varin.mcp.config.source.label')}>
          <Select value={path} disabled={busy || dirty} onValueChange={value => { setPath(value); setSelection({ mode: 'settings' }); }}><SelectTrigger size="settings" aria-label={text('settings.varin.mcp.config.source.label')}><SelectValue /></SelectTrigger><SelectContent>{snapshot.sources.map(source => <SelectItem key={source.path} value={source.path}>{source.path}</SelectItem>)}</SelectContent></Select>
        </SettingsFieldRow>
        {document ? <>
          {valid ? <McpStructuredConfigEditor native project={snapshot.sources.find(source => source.path === path)?.scope === 'project'} content={draft} mode={selection.mode} serverName={selection.name} disabled={busy} onChange={setDraft} /> : null}
          <Button variant="ghost" onClick={() => setRaw(value => !value)}>{text(raw ? 'settings.varin.mcp.config.raw.hide' : 'settings.varin.mcp.config.raw.show')}</Button>
          {raw || !valid ? <div className="h-80 overflow-hidden rounded-md border border-border/60"><CodeMirrorEditor value={draft} onChange={setDraft} extensions={extensions} readOnly={busy} className="h-full" /></div> : null}
          <div className="flex gap-2"><Button disabled={busy || !dirty || !valid} onClick={() => { void run(async current => { const saved = await api.saveDocument(current.view, document.path, draft, document.revision, current.signal); if (active.current === current) { setDocument(saved); setDraft(saved.content); setSnapshot(await api.read(current.view, current.signal)); } }); }}>{t('settings.models.save')}</Button><Button variant="outline" disabled={busy} onClick={() => { void load(); }}>{text(dirty ? 'settings.varin.mcp.config.actions.reloadDiscard' : 'settings.varin.mcp.config.actions.reload')}</Button></div>
        </> : null}
      </SettingsSection>
    </> : null}
  </SettingsPageLayout>;
}
