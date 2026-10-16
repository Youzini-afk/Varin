import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { McpConfigurationSnapshot, McpConfigurationServer } from '@varin/application-client';
const fixture = vi.hoisted(() => ({ version: 0, host: 1, trust: true, multisource: false, hostListeners: new Set<() => void>(), listeners: new Set<() => void>(), blockers: new Set<() => Promise<void>>(), api: { open: vi.fn(), close: vi.fn(), read: vi.fn(), readDocument: vi.fn(), saveDocument: vi.fn(), command: vi.fn(), signIn: vi.fn(), authorization: vi.fn() } }));
vi.mock('@varin/application-client', () => ({ createMcpConnectionsHttpAPI: () => fixture.api, registerRuntimeEndpointSwitchBlocker: (listener: () => Promise<void>) => { fixture.blockers.add(listener); return () => fixture.blockers.delete(listener); }, getRuntimeEndpointGeneration: () => fixture.host, subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.hostListeners.add(listener); return () => fixture.hostListeners.delete(listener); } }));
vi.mock('@/lib/projectTrust', () => ({ getProjectTrustGeneration: () => fixture.version,
  subscribeProjectTrustChanges: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); } }));
vi.mock('@/components/sections/shared/ProjectTrustSettings', () => ({ ProjectTrustSettings: () => <div>Trust controls</div> }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: { currentDirectory: string }) => unknown) => select({ currentDirectory: '/project' }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('../shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('../shared/SettingsSection', () => ({ SettingsSection: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SettingsFieldRow: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
vi.mock('../shared/AuthorizationPanel', () => ({ AuthorizationPanel: () => null }));
vi.mock('./McpStructuredConfigEditor', () => ({ McpStructuredConfigEditor: ({ content, disabled, onChange }: { content: string; disabled: boolean; onChange(value: string): void }) => <textarea aria-label="Configuration draft" data-content={content} value={content} readOnly={disabled} onInput={event => onChange(event.currentTarget.value)} /> }));
vi.mock('@/components/ui/CodeMirrorEditor', () => ({ CodeMirrorEditor: () => null }));
vi.mock('@/components/ui/select', () => {
  const Selection = React.createContext((_value: string) => {});
  return { Select: ({ children, onValueChange }: React.PropsWithChildren<{ onValueChange(value: string): void }>) => <Selection.Provider value={onValueChange}>{children}</Selection.Provider>, SelectContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectValue: () => null,
    SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => { const select = React.useContext(Selection); return <button onClick={() => select(value)}>{children}</button>; } };
});
import { McpConnectionsPage } from './McpConnectionsPage';
import { SettingsNavigationContext } from '../shared/settings-context';
import { finishSettingsNavigation, stayInSettings } from '@/lib/settings/drafts';
let root: Root, container: HTMLDivElement, viewNumber: number;
let servers: McpConfigurationServer[];
const snapshot = (view = `view:${viewNumber}`): McpConfigurationSnapshot => ({ view, sources: fixture.trust ? [{ path: '/project/.mcp.json', scope: 'project' }, ...(fixture.multisource ? [{ path: '/user/mcp.json', scope: 'global' as const }] : [])] : [{ path: '/user/mcp.json', scope: 'global' }], servers, issues: [] });
beforeEach(() => {
  servers = []; fixture.trust = true; fixture.multisource = false; fixture.version += 1; fixture.host += 1; viewNumber = 0; vi.clearAllMocks();
  fixture.api.open.mockImplementation(async () => snapshot(`view:${++viewNumber}`)); fixture.api.close.mockResolvedValue(undefined);
  fixture.api.read.mockImplementation(async (view: string) => snapshot(view));
  fixture.api.readDocument.mockImplementation(async (_view: string, path: string) => ({ path, content: '{}', revision: 'original', exists: true }));
  fixture.api.saveDocument.mockImplementation(async (_view: string, path: string, content: string) => ({ path, content, revision: 'saved', exists: true }));
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); stayInSettings(); container.remove(); vi.unstubAllGlobals(); });
const editor = () => container.querySelector<HTMLTextAreaElement>('[aria-label="Configuration draft"]')!;
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === text)!;
const changeTrust = (trusted: boolean) => act(async () => { fixture.trust = trusted; fixture.version += 1; for (const listener of fixture.listeners) listener(); });

it('retains an unsaved project draft read-only after revocation, then saves it only through the fresh trusted view', async () => {
  await act(async () => root.render(<McpConnectionsPage />));
  await act(async () => { editor().value = '{"mcpServers": {"unsaved": {"command": "review-me"}}}'; editor().dispatchEvent(new window.Event('input', { bubbles: true })); });
  const draft = editor().value;
  await changeTrust(false);
  expect(fixture.api.close).toHaveBeenCalledWith('view:1');
  expect(editor().value).toBe(draft); expect(editor().hasAttribute('readOnly')).toBe(true);
  expect(button('settings.common.actions.saveChanges').disabled).toBe(true); expect(fixture.api.readDocument).toHaveBeenCalledOnce();
  await changeTrust(true);
  expect(editor().value).toBe(draft); expect(editor().hasAttribute('readOnly')).toBe(false);
  await act(async () => button('settings.common.actions.saveChanges').click());
  expect(fixture.api.saveDocument).toHaveBeenCalledWith('view:3', '/project/.mcp.json', draft, 'original', expect.any(AbortSignal));
});

it('does not let a late read from the revoked view replace the new untrusted view', async () => {
  let complete!: (value: unknown) => void;
  fixture.api.readDocument.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => root.render(<McpConnectionsPage />)); await changeTrust(false);
  await act(async () => complete({ path: '/project/.mcp.json', content: '{"revoked":true}', revision: 'old', exists: true }));
  expect(editor().getAttribute('data-content')).toBe('{}'); expect(container.textContent).not.toContain('revoked');
  expect(fixture.api.saveDocument).not.toHaveBeenCalled();
});

it('loads the selected source after discarding a draft retained across a trust refresh', async () => {
  fixture.multisource = true;
  fixture.api.readDocument.mockImplementation(async (_view: string, path: string) => ({ path, content: JSON.stringify({ source: path }), revision: path, exists: true }));
  await act(async () => root.render(<SettingsNavigationContext.Provider value><McpConnectionsPage /></SettingsNavigationContext.Provider>));
  await act(async () => { editor().value = '{"unsaved":true}'; editor().dispatchEvent(new window.Event('input', { bubbles: true })); });
  await changeTrust(false); await changeTrust(true);
  await act(async () => button('/user/mcp.json').click());
  expect(fixture.api.readDocument).toHaveBeenCalledTimes(1);
  await act(async () => { expect(await finishSettingsNavigation(false)).toBe(true); });
  expect(fixture.api.readDocument).toHaveBeenLastCalledWith('view:3', '/user/mcp.json', expect.any(AbortSignal));
  expect(editor().getAttribute('data-content')).toBe('{"source":"/user/mcp.json"}');
  await act(async () => { editor().value = '{"global":true}'; editor().dispatchEvent(new window.Event('input', { bubbles: true })); });
  await act(async () => button('settings.common.actions.saveChanges').click());
  expect(fixture.api.saveDocument).toHaveBeenLastCalledWith('view:3', '/user/mcp.json', '{"global":true}', '/user/mcp.json', expect.any(AbortSignal));
});

it('rejects a late old-Host document response and saves only the new Host document', async () => {
  let complete!: (value: unknown) => void;
  fixture.api.readDocument.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => root.render(<McpConnectionsPage />));
  await act(async () => { fixture.host += 1; for (const listener of fixture.hostListeners) listener(); });
  await act(async () => complete({ path: '/old-host/config.json', content: '{"oldHost":true}', revision: 'old', exists: true }));
  expect(editor().getAttribute('data-content')).toBe('{}');
  await act(async () => { editor().value = '{"newHost":true}'; editor().dispatchEvent(new window.Event('input', { bubbles: true })); });
  await act(async () => button('settings.common.actions.saveChanges').click());
  expect(fixture.api.saveDocument).toHaveBeenLastCalledWith('view:2', '/project/.mcp.json', '{"newHost":true}', 'original', expect.any(AbortSignal));
});


it('releases the original settings view before switching Hosts', async () => {
  await act(async () => root.render(<McpConnectionsPage />));
  await act(async () => { await Promise.all([...fixture.blockers].map(blocker => blocker())); });
  expect(fixture.api.close).toHaveBeenCalledWith('view:1');
});


const server = (patch: Partial<McpConfigurationServer> = {}): McpConfigurationServer => ({ name: 'test', source: '/user/mcp.json', enabled: true, exposure: 'codemode', status: 'connected', cachedToolCount: 0, connectedToolCount: 0, holdsConnection: false, canConnect: true, canSignIn: true, signInRequired: false, canSignOut: false, ...patch });
it('acquires a shared connection before exposing reconnect and release-this-view actions', async () => {
  servers = [server()];
  fixture.api.command.mockImplementation(async (view: string, _name: string, command: string) => { servers = [server({ holdsConnection: command !== 'disconnect' })]; return snapshot(view); });
  await act(async () => root.render(<McpConnectionsPage />));
  expect(button('settings.mcp.reconnect')).toBeUndefined(); expect(button('settings.mcp.disconnect')).toBeUndefined();
  expect(button('settings.mcp.signOut')).toBeUndefined(); expect(button('settings.mcp.trySignIn')).toBeDefined();
  expect(container.textContent).toContain('settings.mcp.signInDiscoveryHint');
  await act(async () => button('settings.mcp.useConnection').click());
  expect(fixture.api.command).toHaveBeenLastCalledWith('view:1', 'test', 'connect', expect.any(AbortSignal));
  expect(button('settings.mcp.useConnection')).toBeUndefined(); expect(button('settings.mcp.connect')).toBeUndefined();
  expect(container.textContent).toContain('settings.mcp.disconnectHint');
  await act(async () => button('settings.mcp.reconnect').click());
  expect(fixture.api.command).toHaveBeenLastCalledWith('view:1', 'test', 'reconnect', expect.any(AbortSignal));
  await act(async () => button('settings.mcp.disconnect').click());
  expect(fixture.api.command).toHaveBeenLastCalledWith('view:1', 'test', 'disconnect', expect.any(AbortSignal));
  expect(button('settings.mcp.useConnection')).toBeDefined(); expect(button('settings.mcp.disconnect')).toBeUndefined();
});

it.each(['connecting', 'failed', 'disconnected'])('adapts owned connection actions to %s state', async status => {
  servers = [server({ status, holdsConnection: true })];
  await act(async () => root.render(<McpConnectionsPage />));
  expect(button('settings.mcp.connect')).toBeUndefined();
  expect(button('settings.mcp.disconnect').disabled).toBe(false);
  if (status === 'connecting') {
    expect(button('settings.mcp.status.connecting').disabled).toBe(true);
    expect(button('settings.mcp.trySignIn').disabled).toBe(true);
    expect(button('settings.mcp.reconnect')).toBeUndefined();
  } else expect(button('settings.mcp.reconnect').disabled).toBe(false);
});

it('only exposes sign-out for an existing grant and preserves challenged sign-in recovery', async () => {
  servers = [server({ canSignIn: false, canSignOut: true })];
  fixture.api.command.mockImplementation(async (view: string) => { servers = [server()]; return snapshot(view); });
  await act(async () => root.render(<McpConnectionsPage />));
  expect(button('settings.mcp.trySignIn')).toBeUndefined(); expect(button('settings.mcp.signIn')).toBeUndefined();
  await act(async () => button('settings.mcp.signOut').click());
  expect(fixture.api.command).toHaveBeenLastCalledWith('view:1', 'test', 'sign-out', expect.any(AbortSignal));
  expect(button('settings.mcp.signOut')).toBeUndefined(); expect(button('settings.mcp.trySignIn')).toBeDefined();
  servers = [server({ status: 'needs-auth', signInRequired: true, canSignOut: true })];
  await changeTrust(false);
  expect(button('settings.mcp.signIn')).toBeDefined(); expect(button('settings.mcp.signOut')).toBeDefined();
  expect(button('settings.mcp.trySignIn')).toBeUndefined();
});


it('blocks credential-dependent actions when credentials are unknown but can still release this view', async () => {
  servers = [server({ holdsConnection: true, canConnect: false, canSignIn: false, canSignOut: false, error: 'MCP credentials are unavailable.' })];
  await act(async () => root.render(<McpConnectionsPage />));
  expect(button('settings.mcp.reconnect').disabled).toBe(true);
  expect(button('settings.mcp.disconnect').disabled).toBe(false);
  expect(button('settings.mcp.signIn')).toBeUndefined(); expect(button('settings.mcp.signOut')).toBeUndefined();
  expect(container.textContent).toContain('MCP credentials are unavailable.');
});
