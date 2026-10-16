import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StorageRequestError, type StorageCleanupPreview, type StorageInventory } from '@varin/application-client';
import { StorageSettings } from './StorageSettings';
import { openStorageSettings } from './storage-navigation';
const mocks = vi.hoisted(() => ({ inventory: vi.fn(), preview: vi.fn(), cleanup: vi.fn(), navigate: vi.fn(), listeners: new Set<() => void>() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createStorageHttpAPI: () => mocks,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en-US', t: (key: string) => key }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: Object.assign((select: (state: unknown) => unknown) => select({ setSettingsPage: mocks.navigate }), { getState: () => ({ setSettingsPage: mocks.navigate }) }) }));
vi.mock('@/lib/settings/drafts', () => ({ requestSettingsNavigation: (proceed: () => void) => proceed() }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsSection: ({ title, children }: React.PropsWithChildren<{ title: string }>) => <section><h2>{title}</h2>{children}</section>, SettingsFieldRow: ({ label, children }: React.PropsWithChildren<{ label: string }>) => <div>{label}{children}</div> }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div> }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  mocks.inventory.mockReset(); mocks.preview.mockReset(); mocks.cleanup.mockReset(); mocks.navigate.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
function inventory(): StorageInventory { return { device: { id: 'host', name: 'Host fixture', current: true, state: 'ready' }, devices: [{ id: 'host', name: 'Host fixture', current: true, state: 'ready' }], scope: { kind: 'all' }, scannedAt: '2026-10-16T00:00:00Z', state: 'ready', canCleanup: true, measurement: 'logical-file-length', root: '/fixture-only', bytes: 17, hostBytes: 17, sharedBytes: 17,
  categories: [{ id: 'recovery', bytes: 17 }, ...(['copies', 'conversations', 'indexes', 'models', 'other'] as const).map(id => ({ id, bytes: 0 }))], workspaces: [], issues: [], volumes: [] }; }
it('shows unknown rather than zero when the managed root cannot be read', async () => {
  mocks.inventory.mockResolvedValue({ ...inventory(), state: 'partial', bytes: 0, categories: inventory().categories.map(item => ({ ...item, bytes: 0 })), issues: ['EACCES: /fixture-only'] });
  await act(async () => root.render(<StorageSettings />));
  expect(container.querySelector('.storage-settings-total')?.textContent).toBe('—');
  expect(container.textContent).toContain('Incomplete scan');
  expect(container.textContent).toContain('EACCES');
});
it('opens an exact preview and sends only selected candidate identities after confirmation', async () => {
  mocks.inventory.mockResolvedValue(inventory());
  const preview: StorageCleanupPreview = { id: 'preview', deviceId: 'host', scope: { kind: 'all' }, createdAt: '', expiresAt: '', candidates: [{ id: 'candidate', kind: 'unreferenced-objects', bytes: 17, count: 1, location: '/fixture-only' }], issues: [] };
  mocks.preview.mockResolvedValue(preview); mocks.cleanup.mockResolvedValue({ previewId: 'preview', state: 'complete', bytesReclaimed: 12, objectsDeleted: 1, completed: ['candidate'], failures: [] });
  await act(async () => root.render(<StorageSettings />));
  await act(async () => button('Inspect cleanup candidates').click());
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Host fixture');
  expect(mocks.cleanup).not.toHaveBeenCalled();
  await act(async () => button('Confirm cleanup').click());
  expect(mocks.cleanup).toHaveBeenCalledWith('preview', ['candidate']);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('12 B file bytes removed');
});
it('discards the old Host preview when the runtime endpoint changes', async () => {
  mocks.inventory.mockResolvedValue(inventory());
  mocks.preview.mockResolvedValue({ id: 'old-preview', deviceId: 'host', scope: { kind: 'all' }, candidates: [], issues: [] });
  await act(async () => root.render(<StorageSettings />));
  await act(async () => button('Inspect cleanup candidates').click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => { for (const listener of mocks.listeners) listener(); });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.cleanup).not.toHaveBeenCalled();
});
it('consumes a workspace navigation target once, including StrictMode remount checks', async () => {
  mocks.inventory.mockResolvedValue({ ...inventory(), scope: { kind: 'workspace', workspaceId: 'project-one' }, workspaces: [{ id: 'project-one', name: 'One', path: '/fixture-project', bytes: 17 }] });
  openStorageSettings('project-one');
  expect(mocks.navigate).toHaveBeenCalledWith('storage');
  await act(async () => root.render(<React.StrictMode><StorageSettings /></React.StrictMode>));
  expect(mocks.inventory).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: 'project-one' }, expect.any(AbortSignal));
  expect(mocks.inventory.mock.calls.every(([scope]) => scope.kind === 'workspace')).toBe(true);
  await act(async () => root.render(<div />));
  mocks.inventory.mockClear(); mocks.inventory.mockResolvedValue(inventory());
  await act(async () => root.render(<StorageSettings />));
  expect(mocks.inventory).toHaveBeenCalledWith({ kind: 'all' }, expect.any(AbortSignal));
});
it('keeps an unavailable requested workspace visible without silently scanning the whole Host', async () => {
  mocks.inventory.mockRejectedValue(new StorageRequestError(404, 'workspace-unavailable', 'Workspace is no longer registered'));
  openStorageSettings('removed-project');
  await act(async () => root.render(<StorageSettings />));
  expect(container.textContent).toContain('Requested workspace: removed-project');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Workspace is no longer registered');
  expect(container.querySelector('.storage-settings-total')?.textContent).toBe('—');
  expect(mocks.inventory.mock.calls.every(([scope]) => scope.workspaceId === 'removed-project')).toBe(true);
  expect(button('Inspect cleanup candidates').disabled).toBe(true);
  mocks.inventory.mockResolvedValue(inventory());
  await act(async () => button('All workspaces and shared data').click());
  expect(mocks.inventory).toHaveBeenLastCalledWith({ kind: 'all' }, expect.any(AbortSignal));
});
it('keeps cleanup disabled for a read-only storage capability', async () => {
  mocks.inventory.mockResolvedValue({ ...inventory(), canCleanup: false });
  await act(async () => root.render(<StorageSettings />));
  expect(button('Inspect cleanup candidates').disabled).toBe(true);
  expect(container.textContent).toContain('cannot clean it');
});
it('freezes every scope shortcut while previewing and discards a superseded navigation response', async () => {
  mocks.inventory.mockImplementation(async scope => ({ ...inventory(), scope, workspaces: [{ id: 'one', name: 'One', path: '/fixture-one', bytes: 17 }] }));
  let finish!: (value: StorageCleanupPreview) => void;
  mocks.preview.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<StorageSettings />));
  await act(async () => button('Inspect cleanup candidates').click());
  const shortcuts = [...container.querySelectorAll<HTMLButtonElement>('.storage-settings-workspace')];
  expect(shortcuts.length).toBe(2);
  expect(shortcuts.every(item => item.disabled)).toBe(true);
  await act(async () => shortcuts[0]!.click());
  expect(mocks.inventory).toHaveBeenCalledTimes(1);
  await act(async () => openStorageSettings('one'));
  await act(async () => finish({ id: 'old-all', deviceId: 'host', scope: { kind: 'all' }, createdAt: '', expiresAt: '', candidates: [], issues: [] }));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.inventory).toHaveBeenLastCalledWith({ kind: 'workspace', workspaceId: 'one' }, expect.any(AbortSignal));
});
