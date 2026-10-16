import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { DesktopHostsConfig } from '@varin/application-client';

const fixture = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), navigate: vi.fn(), t: (key: string) => key }));
vi.mock('@varin/application-client', async importOriginal => ({ ...await importOriginal<typeof import('@varin/application-client')>(),
  createHostConnectionsHttpAPI: () => ({ assertOwner: () => {}, hosts: { get: fixture.get, set: fixture.set, probe: async () => ({ status: 'ok', latencyMs: 1 }) }, ssh: {
    get: async () => ({ instances: [] }), set: async () => {}, imports: async () => [], status: async () => [], connect: async () => {}, disconnect: async () => {}, logs: async () => [], clearLogs: async () => {},
  } }),
}));
vi.mock('@/lib/desktop', () => ({ hasDesktopInvoke: () => true, isDesktopShell: () => true, isDesktopLocalOriginActive: () => false }));
vi.mock('@/lib/desktopHosts', () => ({ desktopHostsGet: () => { throw new Error('Client IPC must not be used'); }, desktopHostsSet: () => { throw new Error('Client IPC must not be used'); }, desktopHostProbe: () => { throw new Error('Client IPC must not be used'); },
  getDesktopHostApiUrl: (host: { url: string }) => host.url, normalizeHostUrl: (value: string) => value,
  redactSensitiveUrl: (value: string) => value, resolveDesktopHostUrl: (value: string) => ({ persistedUrl: value, redeemUrl: null }),
}));
vi.mock('@/lib/desktopSsh', () => {
  const noClientIPC = () => { throw new Error('Client IPC must not be used'); };
  return { createDesktopSshInstance: (id: string, sshCommand: string) => ({ id, sshCommand }), parseDesktopSshStatus: (status: unknown) => status,
    desktopSshInstancesGet: noClientIPC, desktopSshInstancesSet: noClientIPC, desktopSshImportHosts: noClientIPC, desktopSshStatus: noClientIPC,
    desktopSshConnect: noClientIPC, desktopSshDisconnect: noClientIPC, listenDesktopSshStatus: noClientIPC, desktopSshLogs: noClientIPC, desktopSshLogsClear: noClientIPC,
  };
});
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({}) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (selector: (state: object) => unknown) => selector({ timeFormatPreference: '24h', settingsRemoteInstancesSelectedId: null, setSettingsRemoteInstancesSelectedId: () => {} }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.t }) }));
vi.mock('@/lib/settings/drafts', () => ({ requestSettingsNavigation: (proceed: () => void) => fixture.navigate(proceed) }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/sections/shared/SettingsActionBar', () => ({ SettingsActionBar: ({ dirty, saving, saveDisabled, onSave, onCancel, error }: { dirty: boolean; saving: boolean; saveDisabled: boolean; onSave(): unknown; onCancel(): void; error?: string }) => <footer>{error}<button disabled={!dirty || saving || saveDisabled} onClick={() => void onSave()}>Save draft</button><button onClick={onCancel}>Cancel draft</button></footer> }));
vi.mock('@/components/sections/shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children }: React.PropsWithChildren) => <main>{children}</main> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsSection: ({ children, headerAction }: React.PropsWithChildren<{ headerAction?: React.ReactNode }>) => <section>{headerAction}{children}</section>, SettingsGroupTitle: ({ children }: React.PropsWithChildren) => <h3>{children}</h3> }));
vi.mock('@/components/sections/shared/SettingsInfoHint', () => ({ SettingsInfoHint: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ size: _size, variant: _variant, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} /> }));
vi.mock('@/components/ui/dialog', () => ({ Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <aside>{children}</aside> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>, DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
import { RemoteInstancesPage } from './RemoteInstancesPage';

let root: Root, container: HTMLDivElement;
const existing: DesktopHostsConfig = { hosts: [{ id: 'kept', label: 'Existing resource', url: 'https://existing.example', apiUrl: 'https://existing.example' }], defaultHostId: 'kept', initialHostChoiceCompleted: false };
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;
const change = (placeholder: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  const key = Object.keys(input).find(key => key.startsWith('__reactProps'))!;
  (input as unknown as Record<string, { onChange(event: { target: { value: string } }): void }>)[key].onChange({ target: { value } });
};
beforeEach(() => {
  vi.clearAllMocks(); fixture.get.mockResolvedValue(structuredClone(existing)); fixture.set.mockResolvedValue(undefined);
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  Object.defineProperty(window, 'location', { value: new URL('http://127.0.0.1:5181'), configurable: true });
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('cannot replace an unread Host connection collection, then preserves the loaded baseline on add', async () => {
  let finish!: (value: DesktopHostsConfig) => void;
  fixture.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<RemoteInstancesPage view="resources" />));
  expect(button('settings.remoteInstances.direct.actions.add').disabled).toBe(true);
  expect(fixture.set).not.toHaveBeenCalled();
  await act(async () => finish(structuredClone(existing)));
  expect(button('settings.remoteInstances.direct.actions.add').disabled).toBe(false);
  await act(async () => button('settings.remoteInstances.direct.actions.add').click());
  await act(async () => { change('settings.remoteInstances.direct.field.labelPlaceholder', 'New resource'); change('settings.remoteInstances.direct.field.urlPlaceholder', 'https://new.example'); });
  await act(async () => button('Save draft').click());
  expect(fixture.set).toHaveBeenCalledOnce();
  expect(fixture.set.mock.calls[0][0]).toMatchObject({ defaultHostId: 'kept', initialHostChoiceCompleted: false, hosts: [{ label: 'New resource' }, existing.hosts[0]] });
});

it('keeps read failure distinct from an empty collection and preserves form text when a write fails', async () => {
  fixture.get.mockRejectedValueOnce(new Error('Host denied configuration read'));
  await act(async () => root.render(<RemoteInstancesPage view="resources" />));
  expect(button('settings.remoteInstances.direct.actions.add').disabled).toBe(true);
  expect(container.textContent).toContain('Host denied configuration read');
  expect(container.textContent).not.toContain('settings.remoteInstances.direct.state.empty');
  await act(async () => button('settings.common.actions.refresh').click());
  await act(async () => button('settings.remoteInstances.direct.actions.add').click());
  await act(async () => { change('settings.remoteInstances.direct.field.labelPlaceholder', 'Unsaved resource'); change('settings.remoteInstances.direct.field.urlPlaceholder', 'https://new.example'); });
  fixture.set.mockRejectedValueOnce(new Error('Host refused write'));
  await act(async () => button('Save draft').click());
  expect(container.querySelector<HTMLInputElement>('input[placeholder="settings.remoteInstances.direct.field.labelPlaceholder"]')?.value).toBe('Unsaved resource');
  expect(container.textContent).toContain('Host refused write');
  expect(container.textContent).toContain('Save draft');
});
