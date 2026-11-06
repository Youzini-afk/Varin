import { afterEach, expect, test, vi } from 'vitest';
import type { VarinDesktopBridge } from '@varin/application-client/desktop';

const shell = vi.hoisted(() => ({
  globals: new Map<string, unknown>(),
  events: new Map<string, (event: unknown, payload: unknown) => void>(),
  invoke: vi.fn(),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, value: unknown) => shell.globals.set(name, value) },
  ipcRenderer: {
    sendSync: () => ({ localPage: true }),
    on: (name: string, listener: (event: unknown, payload: unknown) => void) => shell.events.set(name, listener),
    invoke: shell.invoke,
  },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

test('cold and warm desktop plugin links remain navigation events without invoking an install', async () => {
  vi.stubGlobal('window', new EventTarget());
  await import('./preload.js');
  const bridge = shell.globals.get('__VARIN_DESKTOP__') as VarinDesktopBridge;
  const emit = (url: string) => shell.events.get('varin:emit')?.(null, {
    event: 'varin:plugin-install-link', detail: { url },
  });
  emit('varin://extensions/install?source=first');
  emit('varin://extensions/install?source=latest');
  const listener = vi.fn();
  const remove = await bridge.listen('varin:plugin-install-link', listener);
  expect(listener).toHaveBeenCalledExactlyOnceWith({ payload: { url: 'varin://extensions/install?source=latest' } });
  emit('varin://extensions/install?source=warm');
  expect(listener).toHaveBeenLastCalledWith({ payload: { url: 'varin://extensions/install?source=warm' } });
  remove();
  emit('varin://extensions/install?source=remount');
  expect(listener).toHaveBeenCalledTimes(2);
  const remounted = vi.fn();
  const removeAgain = await bridge.listen('varin:plugin-install-link', remounted);
  expect(remounted).toHaveBeenCalledExactlyOnceWith({ payload: { url: 'varin://extensions/install?source=remount' } });
  removeAgain();
  expect(shell.invoke).not.toHaveBeenCalled();
});
