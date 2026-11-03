import { afterEach, expect, test, vi } from 'vitest';
import { initializeRuntimeEndpoint } from '@varin/application-client';
import { installTauriDesktop, type DesktopBootstrapTarget } from '../../../tauri/src/bootstrap';
import type { DesktopNativeTransport } from '../../../tauri/src/bridge';
import {
  canRequestNativeDirectoryAccess, canUseDesktopIPC, getDesktopPlatform,
  isDesktopShell, isElectronShell, startDesktopWindowDrag, usesFramelessDesktopChrome,
} from './desktop';
import { getDesktopRuntime } from './desktopRuntime';
import { getInjectedBootOutcome, resolveDesktopBootView } from './desktopBoot';
import { detectInitialLocale } from './i18n/runtime';

afterEach(() => { vi.unstubAllGlobals(); });

test('Tauri bootstrap drives existing UI chrome, locale, boot and window actions without Electron identity', async () => {
  const target = Object.assign(new EventTarget(), {
    document: { documentElement: { toggleAttribute: vi.fn() } },
    location: { origin: 'tauri://localhost' },
    localStorage: { getItem: () => null },
  }) as unknown as DesktopBootstrapTarget;
  vi.stubGlobal('window', target);
  const requests: unknown[] = [];
  const transport: DesktopNativeTransport = {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      requests.push({ command, args });
      return (command === 'varin_bootstrap' ? {
        version: 1, runtime: 'tauri', platform: 'linux', arch: 'arm64', windowRole: 'main',
        localPage: true, localOrigin: 'http://127.0.0.1:19001', apiBaseUrl: 'https://remote.example',
        clientToken: 'window-remote-token', requestHeaders: {}, homeDirectory: '/home/local', relayHostId: 'remote-one',
        macosMajor: 0, macVibrancy: false, trayEnabled: true, locale: 'zh-CN',
        bootOutcome: { target: 'remote', status: 'unreachable', hostId: 'remote-one', url: 'https://remote.example', localAvailable: false },
      } : null) as T;
    },
    listen: async () => () => {},
  };
  const dispose = await installTauriDesktop(target, transport);
  initializeRuntimeEndpoint({ apiBaseUrl: 'https://remote.example', runtimeKey: 'host:remote-one' });
  expect(isDesktopShell()).toBe(true);
  expect(isElectronShell()).toBe(false);
  expect(canUseDesktopIPC()).toBe(true);
  expect(getDesktopPlatform()).toBe('linux');
  expect(usesFramelessDesktopChrome()).toBe(true);
  expect(detectInitialLocale()).toBe('zh-CN');
  expect(getDesktopRuntime()?.arch).toBe('arm64');
  expect(canRequestNativeDirectoryAccess()).toBe(false);
  expect(resolveDesktopBootView({ isDesktopShell: isDesktopShell(), bootOutcome: getInjectedBootOutcome() })).toEqual({
    screen: 'recovery', variant: 'remote-unreachable', hostId: 'remote-one', url: 'https://remote.example', localAvailable: false,
  });
  expect(await startDesktopWindowDrag()).toBe(true);
  expect(requests.at(-1)).toEqual({ command: 'varin_invoke', args: { command: 'desktop_start_window_drag', args: {} } });
  dispose?.();
  expect(await startDesktopWindowDrag()).toBe(false);
});

test('Electron compatibility and ordinary Web detection do not require Tauri globals', () => {
  vi.stubGlobal('window', { __VARIN_ELECTRON__: { runtime: 'electron', locale: 'fr', arch: 'x64' }, __VARIN_PLATFORM__: 'darwin' });
  expect(isDesktopShell()).toBe(true);
  expect(isElectronShell()).toBe(true);
  expect(detectInitialLocale()).toBe('fr');
  expect(usesFramelessDesktopChrome()).toBe(false);
  expect(canUseDesktopIPC()).toBe(false);
  vi.stubGlobal('window', {});
  expect(isDesktopShell()).toBe(false);
  expect(getDesktopRuntime()).toBeNull();
});
