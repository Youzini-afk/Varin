import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DesktopCompanionLibrary, DesktopCompanionLibraryAction } from '@varin/application-client';
import { CompanionSettings } from './CompanionSettings';

const state = vi.hoisted(() => ({
  library: null as unknown as DesktopCompanionLibrary,
  changed: undefined as (() => void) | undefined,
  invoke: vi.fn(), unlisten: vi.fn(),
}));
vi.mock('@/lib/desktop', () => ({
  isDesktopShell: () => true, isDesktopLocalOriginActive: () => true,
  invokeDesktop: state.invoke,
  subscribeDesktopCompanionLibrary: async (handler: () => void) => { state.changed = handler; return state.unlisten; },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/sections/shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children }: React.PropsWithChildren) => <main>{children}</main> }));
vi.mock('@/components/sections/shared/SettingsSection', () => ({ SettingsSection: ({ children }: React.PropsWithChildren) => <section>{children}</section> }));
vi.mock('@/components/motion/SwapText', () => ({ SwapText: ({ text }: { text: string }) => <span>{text}</span> }));

let root: Root, host: HTMLElement;
beforeEach(async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.unlisten.mockClear(); state.invoke.mockReset(); state.changed = undefined;
  state.library = { enabled: false, visible: false, selectedPackId: null, packs: [{ id: 'varin', name: 'Varin', version: 'v1',
    installedVersion: null, installedBytes: 0, downloadBytes: 100, download: null }] };
  state.invoke.mockImplementation(async (command: string, args: DesktopCompanionLibraryAction | { enabled: boolean }) => {
    if (command === 'desktop_set_companion' && 'enabled' in args) { state.library.enabled = args.enabled; state.library.visible = args.enabled; }
    if (command === 'desktop_companion_library' && 'action' in args && args.action === 'download') {
      state.library.packs[0]!.download = { state: 'downloading', receivedBytes: 0, totalBytes: 100 };
    }
    return structuredClone(state.library);
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<CompanionSettings />));
});
afterEach(async () => { await act(async () => root.unmount()); expect(state.unlisten).toHaveBeenCalledOnce(); vi.unstubAllGlobals(); });
const button = (key: string) => [...host.querySelectorAll('button')].find(node => node.textContent === key)!;

test('downloads on request, observes real progress and wakes or sleeps independently of downloading', async () => {
  expect(button('companion.library.wake').disabled).toBe(true);
  expect(state.invoke).toHaveBeenCalledTimes(1);
  await act(async () => button('companion.library.download').click());
  expect(state.invoke).toHaveBeenCalledWith('desktop_companion_library', { action: 'download', id: 'varin' });
  expect(host.querySelector('[role=progressbar]')).not.toBeNull();
  state.library.packs[0]!.download!.receivedBytes = 50;
  await act(async () => state.changed?.());
  expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('50');
  state.library.packs[0]!.download = null; state.library.packs[0]!.installedVersion = 'v1';
  state.library.packs[0]!.installedBytes = 100; state.library.selectedPackId = 'varin';
  await act(async () => state.changed?.());
  expect(button('companion.library.wake').disabled).toBe(false);
  await act(async () => button('companion.library.wake').click());
  expect(state.invoke).toHaveBeenCalledWith('desktop_set_companion', { enabled: true });
  await act(async () => button('companion.library.sleep').click());
  expect(state.invoke).toHaveBeenCalledWith('desktop_set_companion', { enabled: false });
});

test('offers retry and cache reclamation after failure without inventing an installed appearance', async () => {
  state.library.packs[0]!.download = { state: 'failed', receivedBytes: 20, totalBytes: 100, error: 'Connection interrupted' };
  await act(async () => state.changed?.());
  expect(host.textContent).toContain('Connection interrupted');
  expect(button('companion.library.wake').disabled).toBe(true);
  expect(button('companion.library.clear')).toBeDefined();
  await act(async () => button('companion.library.retry').click());
  expect(state.invoke).toHaveBeenCalledWith('desktop_companion_library', { action: 'download', id: 'varin' });
});
