import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(), restart: vi.fn(), translate: (key: string) => key,
  settings: { desktopLanAccessEnabled: false, desktopUiPassword: '', desktopLanAccessActive: false },
}));
vi.mock('@varin/application-client', () => ({ runtimeFetch: fixture.fetch, getRuntimeApiBaseUrl: () => 'http://127.0.0.1:57123', registerRuntimeEndpointSwitchBlocker: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.translate }) }));
vi.mock('@/lib/desktop', () => ({
  isDesktopShell: () => true, isDesktopLocalOriginActive: () => true, restartDesktopApp: fixture.restart,
  getDesktopLanAddress: async () => '192.168.1.10',
  getDesktopKeepAwake: async () => null, getDesktopLaunchAtLogin: async () => null, getDesktopMinimizeToTray: async () => null,
  setDesktopKeepAwake: vi.fn(), setDesktopLaunchAtLogin: vi.fn(), setDesktopMinimizeToTray: vi.fn(),
}));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={event => onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>)} /> }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({
  SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section>,
  SettingsStackedField: ({ children, label }: React.PropsWithChildren<{ label: React.ReactNode }>) => <div>{label}{children}</div>,
  SettingsCheckboxRow: ({ checked, disabled, onChange, label, description }: {
    checked: boolean; disabled: boolean; onChange(checked: boolean): void; label: string; description: React.ReactNode;
  }) => <div><button role="checkbox" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>{label}</button>{description}</div>,
  SETTINGS_OPTION_STACK_CLASS: '', SETTINGS_ICON_BUTTON_CLASS: '',
}));
import { DesktopNetworkSettings } from './DesktopNetworkSettings';

let root: Root, container: HTMLDivElement;
const previous = new Map<string, PropertyDescriptor | undefined>();
const password = () => container.querySelector<HTMLInputElement>('#desktop-ui-password')!;
const lan = () => container.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
const save = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'settings.varin.desktopNetwork.actions.saveAndRestart')!;
const writes = () => fixture.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');

beforeEach(() => {
  vi.clearAllMocks();
  fixture.settings = { desktopLanAccessEnabled: false, desktopUiPassword: '', desktopLanAccessActive: false };
  fixture.fetch.mockImplementation(async () => Response.json(fixture.settings));
  fixture.restart.mockResolvedValue(true);
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  for (const [key, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  container = window.document.querySelector('#app') as HTMLDivElement;
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  previous.clear();
});

it('saves and restarts with LAN access enabled and no password', async () => {
  await act(async () => root.render(<DesktopNetworkSettings section="access" />));
  await act(async () => lan().click());
  expect(password().hasAttribute('required')).toBe(false);
  expect(password().getAttribute('aria-invalid')).toBeNull();
  expect(save().disabled).toBe(false);
  expect(container.textContent).toContain('settings.varin.desktopNetwork.field.warning');
  await act(async () => save().click());
  expect(JSON.parse(writes()[0][1].body)).toEqual({ desktopLanAccessEnabled: true, desktopUiPassword: '' });
  expect(fixture.restart).toHaveBeenCalledOnce();
});

it('clears the password without changing the saved LAN choice', async () => {
  fixture.settings = { desktopLanAccessEnabled: true, desktopUiPassword: 'old-password', desktopLanAccessActive: true };
  await act(async () => root.render(<DesktopNetworkSettings section="access" />));
  await act(async () => {
    password().value = '';
    password().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  expect(lan().getAttribute('aria-checked')).toBe('true');
  expect(save().disabled).toBe(false);
  await act(async () => save().click());
  expect(JSON.parse(writes()[0][1].body)).toEqual({ desktopLanAccessEnabled: true, desktopUiPassword: '' });
  expect(fixture.restart).toHaveBeenCalledOnce();
});
