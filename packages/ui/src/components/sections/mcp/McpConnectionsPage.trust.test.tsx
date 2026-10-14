import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { McpConfigurationSnapshot } from '@varin/application-client';
const fixture = vi.hoisted(() => ({ version: 0, trust: true, listeners: new Set<() => void>(), api: { open: vi.fn(), close: vi.fn(), read: vi.fn(), readDocument: vi.fn(), saveDocument: vi.fn() } }));
vi.mock('@varin/application-client', () => ({ createMcpConnectionsHttpAPI: () => fixture.api, getRuntimeEndpointGeneration: () => 1, subscribeRuntimeEndpointChanged: () => () => {} }));
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
vi.mock('@/components/ui/select', () => ({ Select: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>, SelectValue: () => null, SelectItem: ({ children }: React.PropsWithChildren) => <span>{children}</span> }));
import { McpConnectionsPage } from './McpConnectionsPage';
let root: Root, container: HTMLDivElement, viewNumber: number;
const snapshot = (view = `view:${viewNumber}`): McpConfigurationSnapshot => ({ view, sources: fixture.trust ? [{ path: '/project/.mcp.json', scope: 'project' }] : [{ path: '/user/mcp.json', scope: 'global' }], servers: [], issues: [] });
beforeEach(() => {
  fixture.trust = true; fixture.version += 1; viewNumber = 0; vi.clearAllMocks();
  fixture.api.open.mockImplementation(async () => snapshot(`view:${++viewNumber}`)); fixture.api.close.mockResolvedValue(undefined);
  fixture.api.read.mockImplementation(async (view: string) => snapshot(view));
  fixture.api.readDocument.mockImplementation(async (_view: string, path: string) => ({ path, content: '{}', revision: 'original', exists: true }));
  fixture.api.saveDocument.mockImplementation(async (_view: string, path: string, content: string) => ({ path, content, revision: 'saved', exists: true }));
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
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
  expect(button('settings.models.save').disabled).toBe(true); expect(fixture.api.readDocument).toHaveBeenCalledOnce();
  await changeTrust(true);
  expect(editor().value).toBe(draft); expect(editor().hasAttribute('readOnly')).toBe(false);
  await act(async () => button('settings.models.save').click());
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
