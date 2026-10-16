import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ host: 1, workspace: 'workspace-a', listeners: new Set<() => void>(), api: {} as Record<string, ReturnType<typeof vi.fn>>, global: {} as Record<string, unknown>, status: {} as Record<string, unknown>, navigate: vi.fn() }));
vi.mock('@varin/application-client', () => ({ getRuntimeEndpointGeneration: () => fixture.host, subscribeRuntimeEndpointChanged: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); }, registerRuntimeEndpointSwitchBlocker: () => () => undefined }));
vi.mock('@/lib/recovery/workspaceRecovery', () => ({ getWorkspaceRecoveryAPI: () => fixture.api, requireWorkspaceRecoveryResult: (result: {status: string; failure?: {message: string}}) => { if (result.status === 'failed') throw new Error(result.failure?.message); return result; } }));
vi.mock('@/lib/extensions/workbench-workspace', () => ({ useWorkbenchWorkspaceId: () => fixture.workspace }));
vi.mock('../storage/storage-navigation', () => ({ openStorageSettings: () => fixture.navigate('storage') }));
vi.mock('./WorkspaceEditRecovery', () => ({ WorkspaceEditRecovery: () => null }));
vi.mock('@/components/session/DirectoryExplorerDialog', () => ({ DirectoryExplorerDialog: () => null }));
vi.mock('@/lib/desktop', () => ({ canRequestNativeDirectoryAccess: () => false, requestDirectoryAccess: vi.fn() }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (value: unknown) => unknown) => select({ setSettingsPage: fixture.navigate, recoveryPreference: 'conversation', setRecoveryPreference: vi.fn() }) }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={event => onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>)} /> }));
const { RecoverySettings } = await import('./RecoverySettings');
let root: Root, container: HTMLElement;
const click = async (label: string, index = 0) => act(async () => { const button = [...container.querySelectorAll('button')].filter(item => item.textContent === label)[index]; expect(button, label).toBeTruthy(); button.click(); });
const type = async (field: HTMLInputElement, value: string) => act(async () => { field.value = value; field.dispatchEvent(new Event('input', { bubbles: true })); });
const retentionInput = () => container.querySelector<HTMLInputElement>('input[type="number"]')!;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('Event', window.Event); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.host = 1; fixture.workspace = 'workspace-a'; fixture.navigate.mockReset();
  fixture.global = { location: { mode: 'application-data' }, locationSource: 'global', scope: 'host', byteLength: 0, checkpointCount: 0, readyCheckpointCount: 0, objectCount: 0, registryRevision: 1, catalog: { state: 'ready', root: '/fixture' }, encryption: { enabled: false, available: false }, state: 'ready' };
  fixture.status = { status: 'ready', capabilities: { retention: true, storageManagement: true }, storage: { ...fixture.global, scope: 'workspace' }, identity: {}, failures: [], retention: { policy: { maxCheckpointCount: 10, maxAgeDays: null, maxOperationCount: null, maxByteLength: null }, eligibleCheckpointCount: 0, protectedCheckpointCount: 0, protectedOperationCount: 0 } };
  fixture.api = {
    storageStatus: vi.fn(async () => ({ status: 'ready', storage: fixture.global })), status: vi.fn(async () => fixture.status), listStorageWorkspaces: vi.fn(async () => ({ status: 'ready', workspaces: [] })),
    setDefaultStorageLocation: vi.fn(async (location) => { fixture.global = { ...fixture.global, location }; return { status: 'ready' }; }),
    setRetentionPolicy: vi.fn(async ({ policy }) => { fixture.status = { ...fixture.status, retention: { ...(fixture.status.retention as object), policy } }; return { status: 'ready' }; }), cleanupStorage: vi.fn(),
  };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
test('saving a recovery location preserves an independent retention draft until its own acknowledgment', async () => {
  await act(async () => root.render(<RecoverySettings />));
  await type(retentionInput(), '27'); await click('settings.varin.recovery.storage.workspaceAdjacent'); await click('settings.varin.recovery.storage.saveGlobal');
  expect(fixture.api.setDefaultStorageLocation).toHaveBeenCalledWith({ mode: 'workspace-adjacent' }); expect(retentionInput().value).toBe('27'); expect(fixture.api.setRetentionPolicy).not.toHaveBeenCalled();
  await click('settings.varin.recovery.retention.save');
  expect(fixture.api.setRetentionPolicy).toHaveBeenCalledWith({ workspaceId: 'workspace-a', policy: { maxCheckpointCount: 27, maxAgeDays: null, maxOperationCount: null, maxByteLength: null } });
  expect(container.textContent).not.toContain('assistant.unsaved');
});
test('failed save keeps the draft and cancel restores the last acknowledged policy', async () => {
  await act(async () => root.render(<RecoverySettings />)); await type(retentionInput(), '29');
  fixture.api.setRetentionPolicy.mockResolvedValue({ status: 'failed', failure: { message: 'owner rejected' } }); await click('settings.varin.recovery.retention.save'); expect(retentionInput().value).toBe('29');
  await click('settings.common.actions.cancel'); expect(retentionInput().value).toBe('10'); expect(container.textContent).not.toContain('assistant.unsaved');
});
test('storage links open preview management without directly calling cleanup', async () => {
  await act(async () => root.render(<RecoverySettings />)); await click('Open storage'); expect(fixture.navigate).toHaveBeenCalledWith('storage'); expect(fixture.api.cleanupStorage).not.toHaveBeenCalled();
});

test('a failed refresh preserves both acknowledged baselines and unsaved retention', async () => {
  await act(async () => root.render(<RecoverySettings />)); await type(retentionInput(), '23');
  fixture.api.status.mockRejectedValue(new Error('offline')); fixture.api.storageStatus.mockRejectedValue(new Error('offline'));
  await click('settings.varin.recovery.actions.refresh');
  expect(retentionInput().value).toBe('23'); expect(container.textContent).toContain('assistant.unsaved');
  await click('settings.common.actions.cancel'); expect(retentionInput().value).toBe('10');
});
