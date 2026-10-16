import React from 'react';
import { createMcpConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, registerRuntimeEndpointSwitchBlocker, type McpConfigurationSnapshot } from '@varin/application-client';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { McpIcon } from '@/components/icons/McpIcon';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { subscribeVarinEvents } from '@/lib/varinEvents';

interface McpDropdownContentProps {
  active: boolean; className?: string; headerAction?: React.ReactNode; listClassName?: string; hideHeader?: boolean; mobileListDensity?: boolean;
}
export function McpDropdownContent({ active, className, headerAction, listClassName, hideHeader }: McpDropdownContentProps) {
  const directory = useDirectoryStore(state => state.currentDirectory);
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  const api = React.useMemo(() => createMcpConnectionsHttpAPI(generation), [generation]);
  const [snapshot, setSnapshot] = React.useState<McpConfigurationSnapshot>();
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState<string>();
  const owner = React.useRef<{ view?: string; controller: AbortController; revision: number; busy: boolean; refresh(): void } | null>(null);
  React.useEffect(() => {
    if (!active) return;
    const current = { view: undefined as string | undefined, controller: new AbortController(), revision: 0, busy: false, refresh: () => {} };
    owner.current = current;
    const isCurrent = () => owner.current === current && !current.controller.signal.aborted && generation === getRuntimeEndpointGeneration();
    let refreshPending = false;
    current.refresh = () => {
      if (!isCurrent()) return;
      if (!current.view) { refreshPending = true; return; }
      const request = ++current.revision;
      void api.read(current.view, current.controller.signal).then(value => {
        if (isCurrent() && request === current.revision) setSnapshot(value);
      }, error => {
        if (isCurrent() && request === current.revision) setError(error instanceof Error ? error.message : String(error));
      });
    };
    setSnapshot(undefined); setError(undefined); setBusy(undefined);
    const stop = subscribeVarinEvents(event => {
      if (event.type === 'stream-ready' || (event.type === 'settings-changed' && event.owner === 'agent-settings' && event.ids.includes('mcp'))) current.refresh();
    });
    const opening = api.open(directory || undefined, current.controller.signal);
    void opening.then(value => {
      current.view = value.view;
      if (!isCurrent()) { void api.close(value.view).catch(() => {}); return; }
      setSnapshot(value);
      if (refreshPending) current.refresh();
    }, error => { if (isCurrent()) setError(error instanceof Error ? error.message : String(error)); });
    const stopSwitch = registerRuntimeEndpointSwitchBlocker(async () => {
      const opened = await opening.catch(() => undefined);
      if (opened) await api.close(opened.view);
    });
    return () => {
      if (owner.current === current) owner.current = null;
      current.controller.abort(); stop(); stopSwitch();
      if (current.view) void api.close(current.view).catch(() => {});
    };
  }, [active, api, directory, generation]);
  const command = async (name: string, action: 'connect' | 'reconnect' | 'disconnect') => {
    const current = owner.current;
    if (!current?.view || current.busy || !active || generation !== getRuntimeEndpointGeneration()) return;
    const isCurrent = () => owner.current === current && !current.controller.signal.aborted && generation === getRuntimeEndpointGeneration();
    current.busy = true;
    const request = ++current.revision;
    setBusy(name); setError(undefined);
    try { const next = await api.command(current.view, name, action, current.controller.signal); if (isCurrent() && request === current.revision) setSnapshot(next); }
    catch (error) { if (isCurrent()) setError(error instanceof Error ? error.message : String(error)); }
    finally {
      current.busy = false;
      if (isCurrent()) { setBusy(undefined); current.refresh(); }
    }
  };
  const settings = () => { const ui = useUIStore.getState(); ui.setSettingsPage('mcp-connections'); ui.setSettingsDialogOpen(true); };
  return <div className={cn('space-y-3 p-3', className)}>
    {!hideHeader && <div className="flex items-center justify-between"><span className="text-sm font-medium">MCP connections</span>{headerAction}<Button variant="ghost" size="sm" onClick={settings}>Configure</Button></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!snapshot && !error && <p role="status">Loading connections…</p>}
    <div className={cn('space-y-2', listClassName)}>{snapshot?.servers.map(server => <div key={server.name} className="rounded border p-2">
      <div className="flex items-center justify-between text-sm"><span>{server.name}</span><span className="text-muted-foreground">{server.status}</span></div>
      <p className="text-xs text-muted-foreground">{server.connectedToolCount} connected tools{server.enabled ? '' : ' · disabled'}</p>
      {server.error && <p role="status" className="text-xs">{server.error}</p>}
      <div className="mt-1 flex gap-1"><Button size="sm" variant="ghost" disabled={Boolean(busy) || !server.canConnect || server.status === 'connecting'} onClick={() => void command(server.name, server.holdsConnection ? 'reconnect' : 'connect')}>{server.status === 'connecting' ? 'Connecting…' : server.holdsConnection ? 'Reconnect' : server.status === 'connected' ? 'Use connection' : 'Connect'}</Button>
        {server.holdsConnection && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void command(server.name, 'disconnect')}>Disconnect this view</Button>}
        {server.canSignIn && <Button size="sm" variant="ghost" disabled={Boolean(busy) || !server.enabled || server.status === 'connecting'} onClick={settings}>{server.signInRequired ? 'Sign in' : 'Try sign-in'}</Button>}
      </div>
    </div>)}</div>
    {snapshot?.issues.map(issue => <p key={issue} role="status" className="text-xs">{issue}</p>)}
    {snapshot && !snapshot.servers.length && <Button variant="ghost" onClick={settings}>Configure an MCP connection</Button>}
  </div>;
}
export function McpDropdown({ headerIconButtonClass }: { headerIconButtonClass?: string }) {
  const [open, setOpen] = React.useState(false);
  return <DropdownMenu open={open} onOpenChange={setOpen}><DropdownMenuTrigger asChild><button type="button" className={headerIconButtonClass} aria-label="MCP connections"><McpIcon className="size-4" /></button></DropdownMenuTrigger>
    <DropdownMenuContent className="max-h-[70vh] w-80 overflow-y-auto" align="end"><McpDropdownContent active={open} /></DropdownMenuContent>
  </DropdownMenu>;
}
