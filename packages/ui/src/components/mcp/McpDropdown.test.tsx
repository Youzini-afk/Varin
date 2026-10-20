import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { McpConfigurationServer, McpConfigurationSnapshot } from '@varin/application-client';
import type { VarinEvent } from '@/lib/varinEvents';

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(), generation: 1, directory: '/project/first',
  hosts: new Set<() => void>(), events: new Set<(event: VarinEvent) => void>(), blockers: new Set<() => Promise<void>>(),
  api: { open: vi.fn(), read: vi.fn(), command: vi.fn(), close: vi.fn() },
}));
vi.mock('@varin/application-client', () => ({
  createMcpConnectionsHttpAPI: () => fixture.api,
  getRuntimeEndpointGeneration: () => fixture.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.hosts.add(listener); return () => fixture.hosts.delete(listener); },
  registerRuntimeEndpointSwitchBlocker: (listener: () => Promise<void>) => { fixture.blockers.add(listener); return () => fixture.blockers.delete(listener); },
}));
vi.mock('./mcp-settings-navigation', () => ({ openMcpSettings: (...args: unknown[]) => fixture.navigate(...args) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => { fixture.events.add(listener); return () => fixture.events.delete(listener); } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: { currentDirectory: string }) => unknown) => select({ currentDirectory: fixture.directory }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setSettingsPage: vi.fn(), setSettingsDialogOpen: vi.fn() }) } }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('@/components/icons/McpIcon', () => ({ McpIcon: () => null }));
import { McpDropdownContent } from './McpDropdown';
import { I18nProvider } from '@/lib/i18n';

let root: Root, container: HTMLDivElement, viewNumber: number;
const snapshot = (view: string, patch: Partial<McpConfigurationServer> = {}): McpConfigurationSnapshot => ({
  view, sources: [], issues: [], servers: [{ name: 'test', source: '/user/mcp.json', enabled: true, exposure: 'codemode', status: 'connected',
    cachedToolCount: 0, connectedToolCount: 0, holdsConnection: false, canConnect: true, canSignIn: true, signInRequired: false, canSignOut: false, ...patch }],
});
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!;
const emit = (event: VarinEvent = { type: 'settings-changed', owner: 'agent-settings', ids: ['mcp'], scope: 'host', revision: 'next' }) => act(async () => { for (const listener of fixture.events) listener(event); });
const expand = () => act(async () => { container.querySelector<HTMLButtonElement>('button[aria-expanded=false]')?.click(); });
const render = async (active = true) => { await act(async () => root.render(<I18nProvider><McpDropdownContent active={active} /></I18nProvider>)); if (active) await expand(); };
const replaceView = async (boundary: 'close' | 'directory' | 'host') => {
  if (boundary === 'close') { await render(false); await render(); }
  else if (boundary === 'directory') { fixture.directory = '/project/second'; await render(); }
  else { await act(async () => { fixture.generation++; for (const listener of fixture.hosts) listener(); }); await expand(); }
};

beforeEach(() => {
  vi.resetAllMocks(); fixture.generation = 1; fixture.directory = '/project/first'; viewNumber = 0;
  fixture.hosts.clear(); fixture.events.clear(); fixture.blockers.clear();
  fixture.api.open.mockImplementation(async () => snapshot(`view:${++viewNumber}`));
  fixture.api.read.mockImplementation(async (view: string) => snapshot(view)); fixture.api.close.mockResolvedValue(undefined);
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('updates connecting actions from owner events and ignores unrelated settings changes', async () => {
  fixture.api.open.mockResolvedValueOnce(snapshot('view:1', { status: 'connecting' }));
  await render();
  expect(button('Connecting').disabled).toBe(true); expect(button('Sign in').disabled).toBe(true);
  await emit({ type: 'settings-changed', owner: 'client', ids: ['mcp'], scope: 'client', revision: 'other-owner' });
  await emit({ type: 'settings-changed', owner: 'agent-settings', ids: ['models'], scope: 'host', revision: 'other-domain' });
  expect(fixture.api.read).not.toHaveBeenCalled();
  await emit();
  expect(fixture.api.read).toHaveBeenCalledWith('view:1', expect.any(AbortSignal));
  expect(button('Reconnect').disabled).toBe(false); expect(button('Sign in').disabled).toBe(false);
  expect(button('Disconnect this view')).toBeUndefined();
  fixture.api.read.mockResolvedValueOnce(snapshot('view:1', { status: 'needs-auth', signInRequired: true }));
  await emit({ type: 'stream-ready' });
  expect(button('Sign in').disabled).toBe(false);
});

it('refreshes changes received while the initial view is still opening', async () => {
  const opening = deferred<McpConfigurationSnapshot>(); fixture.api.open.mockReturnValueOnce(opening.promise);
  await render(); await emit();
  expect(fixture.api.read).not.toHaveBeenCalled();
  await act(async () => opening.resolve(snapshot('opening', { status: 'connecting' }))); await expand();
  expect(fixture.api.read).toHaveBeenCalledWith('opening', expect.any(AbortSignal));
  expect(button('Reconnect').disabled).toBe(false); expect(button('Connecting')).toBeUndefined();
});

it('keeps the newer owner observation when reads finish out of order', async () => {
  const older = deferred<McpConfigurationSnapshot>();
  await render(); fixture.api.read.mockReturnValueOnce(older.promise);
  await emit();
  fixture.api.read.mockResolvedValueOnce(snapshot('view:1', { status: 'needs-auth', signInRequired: true }));
  await emit();
  await act(async () => older.resolve(snapshot('view:1', { status: 'connecting' })));
  expect(button('Sign in').disabled).toBe(false); expect(button('Connecting')).toBeUndefined();
});

it('refreshes the completed command after an overlapping event read and rejects repeated clicks', async () => {
  const command = deferred<McpConfigurationSnapshot>(), duringCommand = deferred<McpConfigurationSnapshot>();
  await render(); fixture.api.command.mockReturnValueOnce(command.promise);
  await act(async () => { button('Reconnect').click(); button('Reconnect').click(); });
  expect(fixture.api.command).toHaveBeenCalledOnce();
  fixture.api.read.mockReturnValueOnce(duringCommand.promise); await emit();
  fixture.api.read.mockResolvedValueOnce(snapshot('view:1', { holdsConnection: true }));
  await act(async () => command.resolve(snapshot('view:1', { holdsConnection: true })));
  await act(async () => duringCommand.resolve(snapshot('view:1', { status: 'connecting' })));
  expect(button('Reconnect').disabled).toBe(false);
  expect(button('Connecting')).toBeUndefined();
});

it.each(['close', 'directory', 'host'] as const)('isolates late commands and reads after a %s transition', async boundary => {
  const oldRead = deferred<McpConfigurationSnapshot>(), oldCommand = deferred<McpConfigurationSnapshot>(), newCommand = deferred<McpConfigurationSnapshot>();
  await render();
  fixture.api.read.mockReturnValueOnce(oldRead.promise); await emit();
  const oldSignal = fixture.api.read.mock.calls[0]![1] as AbortSignal;
  fixture.api.command.mockReturnValueOnce(oldCommand.promise).mockReturnValueOnce(newCommand.promise);
  await act(async () => button('Reconnect').click());
  await replaceView(boundary);
  expect(oldSignal.aborted).toBe(true); expect(fixture.api.close).toHaveBeenCalledWith('view:1');
  expect(button('Reconnect').disabled).toBe(false);
  await act(async () => button('Reconnect').click());
  await act(async () => {
    oldRead.resolve(snapshot('view:1', { name: 'stale-read', status: 'connecting' }));
    oldCommand.resolve(snapshot('view:1', { name: 'stale-command', holdsConnection: true }));
  });
  expect(container.textContent).not.toContain('stale-'); expect(button('Connecting').disabled).toBe(true);
  expect(fixture.api.read).toHaveBeenCalledOnce();
  fixture.api.read.mockResolvedValueOnce(snapshot('view:2', { holdsConnection: true }));
  await act(async () => newCommand.resolve(snapshot('view:2', { holdsConnection: true })));
  expect(fixture.api.command).toHaveBeenLastCalledWith('view:2', 'test', 'connect', expect.any(AbortSignal));
  expect(button('Reconnect').disabled).toBe(false);
  expect(fixture.events.size).toBe(1);
});

it.each(['close', 'directory', 'host'] as const)('releases a late opening without replacing the new %s view', async boundary => {
  const opening = deferred<McpConfigurationSnapshot>(); fixture.api.open.mockReturnValueOnce(opening.promise);
  await render(); const signal = fixture.api.open.mock.calls[0]![1] as AbortSignal;
  await replaceView(boundary);
  await act(async () => opening.resolve(snapshot('late-open', { name: 'stale-open', status: 'connecting' })));
  expect(signal.aborted).toBe(true); expect(fixture.api.close).toHaveBeenCalledWith('late-open');
  expect(container.textContent).not.toContain('stale-open'); expect(button('Reconnect').disabled).toBe(false);
});

it('ignores read and command errors from the previous view', async () => {
  const oldRead = deferred<McpConfigurationSnapshot>(), oldCommand = deferred<McpConfigurationSnapshot>();
  await render(); fixture.api.read.mockReturnValueOnce(oldRead.promise); await emit();
  fixture.api.command.mockReturnValueOnce(oldCommand.promise);
  await act(async () => button('Reconnect').click()); await replaceView('directory');
  await act(async () => { oldRead.reject(new Error('stale read error')); oldCommand.reject(new Error('stale command error')); });
  expect(container.querySelector('[role="alert"]')).toBeNull(); expect(button('Reconnect').disabled).toBe(false);
});

it('releases the original view before a Host switch and removes subscriptions when closed', async () => {
  await render();
  await act(async () => { await Promise.all([...fixture.blockers].map(blocker => blocker())); });
  expect(fixture.api.close).toHaveBeenCalledWith('view:1');
  await render(false);
  expect(fixture.events.size).toBe(0); expect(fixture.blockers.size).toBe(0);
  await emit(); expect(fixture.api.read).not.toHaveBeenCalled();
});

it('shows real scopes and directs sign-in to the selected connection', async () => {
  const value = snapshot('view:1', { name: 'notion', signInRequired: true, status: 'needs-auth', override: '/project/.mcp.json' });
  value.sources = [{ path: '/user/mcp.json', scope: 'global' }, { path: '/project/.mcp.json', scope: 'project' }];
  fixture.api.open.mockResolvedValueOnce(value);
  await render();
  expect(container.textContent).toContain('This project');
  expect(container.textContent).toContain('1 need attention');
  await act(async () => button('Sign in').click());
  expect(fixture.navigate).toHaveBeenCalledWith({ mode: 'server', name: 'notion', signIn: true }, undefined);
});

it('offers one add action in the empty state and can retry a failed initial open', async () => {
  fixture.api.open.mockRejectedValueOnce(new Error('Connection list unavailable'));
  await render();
  fixture.api.open.mockResolvedValueOnce({ view: 'empty', sources: [], servers: [], issues: [] });
  await act(async () => button('Retry').click());
  expect(fixture.api.open).toHaveBeenCalledTimes(2);
  expect([...container.querySelectorAll('button')].filter(value => value.textContent === 'Add MCP')).toHaveLength(1);
  expect(button('Manage connections')).toBeUndefined();
  await act(async () => button('Add MCP').click());
  expect(fixture.navigate).toHaveBeenCalledWith({ mode: 'new' }, undefined);
});
