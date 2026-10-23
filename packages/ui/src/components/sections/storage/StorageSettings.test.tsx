import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRuntimeEndpointGeneration, StorageRequestError, type StorageCleanupPreview, type StorageInventory, type StorageTarget } from '@varin/application-client';
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
const select = async (label: string, value: string) => act(async () => {
  const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  Object.defineProperty(element, 'value', { configurable: true, value });
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
});
function inventory(): StorageInventory { return { device: { id: 'host', name: 'Host fixture', current: true, state: 'ready' }, devices: [{ id: 'host', name: 'Host fixture', current: true, state: 'ready' }], scope: { kind: 'all' }, scannedAt: '2026-10-16T00:00:00Z', state: 'ready', canCleanup: true, measurement: 'logical-file-length', root: '/fixture-only', bytes: 17, hostBytes: 17, sharedBytes: 17,
  categories: [{ id: 'recovery', bytes: 17 }, ...(['copies', 'conversations', 'embeddings', 'models', 'other'] as const).map(id => ({ id, bytes: 0 }))], workspaces: [], issues: [], volumes: [] }; }
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
const target: StorageTarget = { id: 'connection:b', hostId: 'resource-b', endpointIdentity: `sha256-${'b'.repeat(64)}` };
function remoteFixture(): StorageInventory {
  const base = inventory();
  return { ...base, devices: [...base.devices, { id: target.id, name: 'Resource B', current: false, state: 'ready', target }] };
}
it('selects resource Host B and its workspace without switching the Agent endpoint or navigating to A history', async () => {
  const generation = getRuntimeEndpointGeneration(), local = remoteFixture();
  mocks.inventory.mockImplementation(async (scope, _signal, requestedTarget) => requestedTarget ? { ...local, device: local.devices[1], scope, bytes: 29, root: '/resource-b', workspaces: [{ id: 'b-project', name: 'B project', path: '/b/project', bytes: 29 }] } : local);
  mocks.preview.mockResolvedValue({ id: 'b-preview', deviceId: target.id, scope: { kind: 'workspace', workspaceId: 'b-project' }, candidates: [{ id: 'b-cache', kind: 'unreferenced-objects', bytes: 12, count: 1, location: '/resource-b/cache' }], issues: [] });
  mocks.cleanup.mockResolvedValue({ previewId: 'b-preview', state: 'complete', bytesReclaimed: 12, objectsDeleted: 1, completed: ['b-cache'], failures: [] });
  await act(async () => root.render(<StorageSettings />));
  await select('Device', target.id);
  expect(mocks.inventory).toHaveBeenLastCalledWith({ kind: 'all' }, expect.any(AbortSignal), target);
  expect(container.querySelector('.storage-settings-total')?.textContent).toBe('29 B');
  expect(button('History and recovery').disabled).toBe(true);
  await select('View', 'workspace:b-project');
  await act(async () => button('Inspect cleanup candidates').click());
  expect(mocks.preview).toHaveBeenCalledWith({ kind: 'workspace', workspaceId: 'b-project' }, undefined, target);
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Resource B');
  await act(async () => button('Confirm cleanup').click());
  expect(mocks.cleanup).toHaveBeenCalledWith('b-preview', ['b-cache']);
  expect(container.querySelector('.storage-settings-receipt')?.textContent).toContain('Resource B · B project');
  expect(getRuntimeEndpointGeneration()).toBe(generation); expect(mocks.navigate).not.toHaveBeenCalled();
});
it('never shows an old device measurement or workspace selector while a new target scan is pending', async () => {
  const local = remoteFixture(); let finish!: (value: StorageInventory) => void;
  mocks.inventory.mockImplementation(async (_scope, _signal, requestedTarget) => requestedTarget ? new Promise(resolve => { finish = resolve; }) : local);
  await act(async () => root.render(<StorageSettings />)); await select('Device', target.id);
  expect(container.querySelector('.storage-settings-total')?.textContent).toBe('—');
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="View"]')?.disabled).toBe(true);
  await select('Device', 'host');
  await act(async () => finish({ ...local, device: local.devices[1]!, bytes: 999 }));
  expect(container.querySelector('.storage-settings-total')?.textContent).toBe('17 B');
  expect(container.querySelector('.storage-settings-location')?.textContent).toContain('/fixture-only');
});
it('shows an unavailable resource honestly and offers an explicit return-and-recheck action', async () => {
  const local = remoteFixture(); local.devices[1] = { ...local.devices[1]!, state: 'offline' };
  mocks.inventory.mockResolvedValue(local);
  await act(async () => root.render(<StorageSettings />)); await select('Device', target.id);
  expect(mocks.inventory).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('This device is not connected'); expect(container.querySelector('.storage-settings-total')).toBeNull();
  await act(async () => button('Return to current Host and recheck devices').click());
  expect(mocks.inventory).toHaveBeenCalledTimes(2); expect(container.querySelector('.storage-settings-total')?.textContent).toBe('17 B');
});
it('locks the confirmed selection after a lost receipt and retries that original confirmation', async () => {
  mocks.inventory.mockResolvedValue(inventory());
  mocks.preview.mockResolvedValue({ id: 'original-preview', deviceId: 'host', scope: { kind: 'all' }, candidates: [{ id: 'original-cache', kind: 'unreferenced-objects', bytes: 17, count: 1, location: '/fixture-only/cache' }], issues: [] });
  mocks.cleanup.mockRejectedValueOnce(new Error('Lost response')).mockResolvedValueOnce({ previewId: 'original-preview', state: 'complete', bytesReclaimed: 17, objectsDeleted: 1, completed: ['original-cache'], failures: [] });
  await act(async () => root.render(<StorageSettings />)); await act(async () => button('Inspect cleanup candidates').click());
  await act(async () => button('Confirm cleanup').click());
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);
  expect(container.textContent).toContain('operation may have taken effect');
  await act(async () => button('Retry original confirmation').click());
  expect(mocks.cleanup.mock.calls).toEqual([['original-preview', ['original-cache']], ['original-preview', ['original-cache']]]);
  expect(container.querySelector('.storage-settings-receipt')?.textContent).toContain('17 B file bytes removed');
});
