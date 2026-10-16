import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopLocalHostMode } from '@varin/application-client';
const fixture = vi.hoisted(() => ({ invoke: vi.fn(), fetch: vi.fn(), translate: (key: string) => key, mode: {} as DesktopLocalHostMode }));
vi.mock('@varin/application-client', () => ({ registerRuntimeEndpointSwitchBlocker: vi.fn(), runtimeFetch: fixture.fetch }));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: fixture.invoke, hasDesktopInvoke: () => true, isDesktopShell: () => true, restartDesktopApp: vi.fn(), startDesktopWindowDrag: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.translate }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/dialog', () => {
  const Wrapper = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
    DialogContent: Wrapper, DialogHeader: Wrapper, DialogTitle: Wrapper, DialogDescription: Wrapper, DialogFooter: Wrapper };
});
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section> }));
vi.mock('@/lib/desktopHosts', () => ({ desktopHostsGet: vi.fn(), desktopHostsSet: vi.fn() }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: { getState: () => ({ loadCatalog: vi.fn() }) } }));
vi.mock('@/components/onboarding/RemoteConnectionForm', () => ({ RemoteConnectionForm: () => <p>Remote form remains available</p> }));
vi.mock('@/components/onboarding/LocalRuntimeCard', () => ({ LocalRuntimeCard: () => null }));
vi.mock('@/components/onboarding/DesktopConnectionRecovery', () => ({ DesktopConnectionRecovery: ({ footer }: { footer: React.ReactNode }) => <main>{footer}</main> }));
import { DesktopLocalHostSettings, LocalHostRecovery } from '@/components/sections/connections/DesktopLocalHostSettings';
import { ChooserScreen } from '@/components/onboarding/ChooserScreen';
import { RecoveryScreen } from '@/components/onboarding/RecoveryScreen';
import { SettingsNavigationContext } from '@/components/sections/shared/settings-context';
import { finishSettingsNavigation, requestSettingsNavigation, stayInSettings, getPendingSettingsNavigation } from '@/lib/settings/drafts';
let root: Root, container: HTMLDivElement;
let frames: Array<() => void>;
const mode = (overrides: Partial<DesktopLocalHostMode> = {}): DesktopLocalHostMode => ({ enabled: true, effectiveEnabled: true, environmentDisabled: false, environmentRemoteTarget: false, canDisable: true, runtime: 'embedded', requiresRestart: false, ...overrides });
const button = (key: string, inDialog = false) => [...(inDialog ? container.querySelector('[role="dialog"]')! : container).querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === key)!;
const click = (key: string, inDialog = false) => act(async () => { const target = button(key, inDialog); expect(target, key).toBeTruthy(); target.click(); });
const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const change = (checked: boolean) => act(async () => { checkbox().checked = checked; checkbox().dispatchEvent(new window.Event('click', { bubbles: true })); });
const writes = () => fixture.invoke.mock.calls.filter(([name]) => name === 'desktop_set_local_host_mode');
const render = (element: React.ReactNode = <DesktopLocalHostSettings />) => act(async () => root.render(<SettingsNavigationContext.Provider value>{element}</SettingsNavigationContext.Provider>));
beforeEach(() => {
  vi.clearAllMocks(); fixture.mode = mode(); frames = [];
  fixture.invoke.mockImplementation(async (name: string, input?: { enabled: boolean; selectLocalOnRestart?: boolean }) => {
    if (name === 'desktop_get_local_host_mode') return fixture.mode;
    if (name === 'desktop_set_local_host_mode') return fixture.mode = mode({ ...fixture.mode, enabled: input!.enabled, effectiveEnabled: input!.enabled, requiresRestart: input!.enabled !== true });
    if (name === 'desktop_restart_without_update') return null;
    throw new Error(`Unexpected native command: ${name}`);
  });
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('Event', window.Event); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length; });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); stayInSettings(); container.remove(); vi.unstubAllGlobals(); });

it('keeps edits local until save, cancel restores the native baseline, and failed saves keep navigation guarded', async () => {
  await render(); await change(false);
  expect(button('settings.common.actions.saveChanges').disabled).toBe(false); expect(writes()).toHaveLength(0);
  await click('settings.common.actions.cancel'); expect(checkbox().checked).toBe(true);
  await change(false);
  const proceed = vi.fn(); act(() => requestSettingsNavigation(proceed)); expect(getPendingSettingsNavigation()).not.toBeNull();
  fixture.invoke.mockRejectedValueOnce(new Error('native settings write failed'));
  await act(async () => { expect(await finishSettingsNavigation(true)).toBe(false); });
  expect(proceed).not.toHaveBeenCalled(); expect(checkbox().checked).toBe(false); expect(container.textContent).toContain('native settings write failed');
  let finished!: Promise<boolean>;
  await act(async () => { finished = finishSettingsNavigation(true); });
  await act(async () => { for (const callback of frames.splice(0)) callback(); expect(await finished).toBe(true); });
  expect(proceed).toHaveBeenCalledOnce(); expect(writes().at(-1)).toEqual(['desktop_set_local_host_mode', { enabled: false }]);
  expect(fixture.fetch).not.toHaveBeenCalled(); expect(container.textContent).toContain('settings.connections.localHost.runtime.embedded');
  expect(container.textContent).toContain('settings.connections.localHost.nextFrontend');
});

it('saving does not restart; restart is explicit, cancellable, and uses the ordinary native command', async () => {
  await render(); await change(false); await click('settings.common.actions.saveChanges');
  expect(fixture.invoke.mock.calls.some(([name]) => name.startsWith('desktop_restart'))).toBe(false);
  await click('settings.connections.localHost.restart'); expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await click('settings.common.actions.cancel', true); expect(container.querySelector('[role="dialog"]')).toBeNull();
  await click('settings.connections.localHost.restart'); await click('settings.connections.localHost.restart', true);
  expect(fixture.invoke).toHaveBeenCalledWith('desktop_restart_without_update'); expect(fixture.invoke).not.toHaveBeenCalledWith('desktop_restart');
});

it('environment mode and missing bundled UI cannot be changed to frontend-only through the GUI', async () => {
  fixture.mode = mode({ environmentDisabled: true, effectiveEnabled: false, runtime: 'stopped' }); await render();
  expect(checkbox().disabled).toBe(true); expect(container.textContent).toContain('settings.connections.localHost.environmentDisabled');
  await act(async () => root.render(<DesktopLocalHostSettings key="development" />));
  // Next native load belongs to a build with no independent recovery shell.
  fixture.mode = mode({ canDisable: false }); await act(async () => root.render(<DesktopLocalHostSettings key="development-next" />));
  expect(checkbox().disabled).toBe(true); expect(container.textContent).toContain('settings.connections.localHost.bundledRequired'); expect(writes()).toHaveLength(0);
});

it('offline recovery confirms before atomically enabling and selecting local startup, then restarts without an update', async () => {
  fixture.mode = mode({ enabled: false, effectiveEnabled: false, runtime: 'stopped' }); await render(<LocalHostRecovery />);
  await click('settings.connections.localHost.restore'); expect(writes()).toHaveLength(0);
  await click('settings.common.actions.cancel', true); expect(writes()).toHaveLength(0);
  await click('settings.connections.localHost.restore'); await click('settings.connections.localHost.restart', true);
  expect(fixture.invoke.mock.calls.slice(-2)).toEqual([['desktop_set_local_host_mode', { enabled: true, selectLocalOnRestart: true }], ['desktop_restart_without_update']]);
});

it('failed offline restore never restarts or writes a client connection directory separately', async () => {
  fixture.mode = mode({ enabled: false, effectiveEnabled: false, runtime: 'stopped' }); await render(<LocalHostRecovery />);
  await click('settings.connections.localHost.restore'); fixture.invoke.mockRejectedValueOnce(new Error('cannot persist local mode'));
  await click('settings.connections.localHost.restart', true);
  expect(fixture.invoke).not.toHaveBeenCalledWith('desktop_restart_without_update'); expect(container.textContent).toContain('cannot persist local mode');
});

it('first-launch and lost-remote screens retain the local recovery action without a running Host', async () => {
  fixture.mode = mode({ enabled: false, effectiveEnabled: false, runtime: 'stopped' }); await render(<ChooserScreen localAvailable={false} />);
  expect(button('settings.connections.localHost.restore')).toBeTruthy(); expect(container.textContent).toContain('Remote form remains available');
  await render(<RecoveryScreen variant="remote-unreachable" localAvailable={false} />); expect(button('settings.connections.localHost.restore')).toBeTruthy();
  await render(<RecoveryScreen variant="remote-unreachable" localAvailable={false} showRemoteForm />); expect(button('settings.connections.localHost.restore')).toBeTruthy();
});
