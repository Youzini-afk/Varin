import React from 'react';
import { createMcpConnectionsHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type McpConfigurationSnapshot } from '@varin/application-client';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { McpIcon } from '@/components/icons/McpIcon';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

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
  React.useEffect(() => {
    if (!active) return;
    let alive = true; let view: string | undefined;
    setSnapshot(undefined); setError(undefined); setBusy(undefined);
    void api.open(directory || undefined).then(value => { view = value.view; if (alive) setSnapshot(value); else void api.close(value.view).catch(() => {}); }, error => { if (alive) setError(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; if (view) void api.close(view).catch(() => {}); };
  }, [active, api, directory]);
  const command = async (name: string, action: 'connect' | 'reconnect' | 'disconnect') => {
    if (!snapshot || busy) return;
    setBusy(name); setError(undefined);
    try { const next = await api.command(snapshot.view, name, action); if (generation === getRuntimeEndpointGeneration()) setSnapshot(next); }
    catch (error) { if (generation === getRuntimeEndpointGeneration()) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === getRuntimeEndpointGeneration()) setBusy(undefined); }
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
      <div className="mt-1 flex gap-1"><Button size="sm" variant="ghost" disabled={Boolean(busy) || !server.enabled} onClick={() => void command(server.name, server.status === 'connected' ? 'reconnect' : 'connect')}>{server.status === 'connected' ? 'Reconnect' : 'Connect'}</Button>
        <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void command(server.name, 'disconnect')}>Disconnect</Button>
        {server.canSignIn && <Button size="sm" variant="ghost" onClick={settings}>Sign in</Button>}
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
