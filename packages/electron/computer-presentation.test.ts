import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComputerControlState, ComputerGesture } from '@varin/protocol';
import { createComputerControls } from './computer-controls.js';
import { createComputerFeedback } from './computer-feedback.js';
import { createQuitLifecycle } from './quit-lifecycle.js';

const desktop = vi.hoisted(() => ({ windows: [] as MockWindow[] }));
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(bounds: { x: number; y: number; width: number; height: number }) { return new MockWindow(bounds); }
    static getAllWindows() { return MockWindow.getAllWindows(); }
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
    screenToDipPoint: (point: unknown) => point,
  },
}));
vi.mock('./native-i18n.js', () => ({ getNativeLocale: () => 'en', nativeText: (text: string) => text }));

class MockWindow extends EventEmitter {
  static getAllWindows() { return desktop.windows.filter(window => !window.destroyed); }
  readonly id = desktop.windows.length + 1;
  readonly webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn(async () => undefined),
  });
  destroyed = false;
  visible = false;
  protected = false;
  constructor(public bounds: { x: number; y: number; width: number; height: number }) {
    super(); desktop.windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isContentProtected() { return this.protected; }
  setContentProtection(value: boolean) { this.protected = value; }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  setEnabled() {}
  setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
  getBounds() { return this.bounds; }
  getNativeWindowHandle() { return Buffer.from([this.id, 0, 0, 0]); }
  async loadURL() {}
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
}

const control: ComputerControlState = { desktopId: 'local-console', owner: 'human', holderId: 'user', reachable: true, since: '2026-11-08T00:00:00Z', automationEpoch: 'epoch-1' };
const gesture: ComputerGesture = { id: 'gesture', desktopId: 'local-console', phase: 'target', kind: 'click', at: '2026-11-08T00:00:00Z', point: { x: 10, y: 10 } };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  desktop.windows.length = 0;
  Object.defineProperty(process, 'platform', { value: 'win32' });
});
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform));

const fixture = () => {
  const controls = createComputerControls(), feedback = createComputerFeedback();
  const commands = { holderId: 'user', takeover: vi.fn(async () => {}), handback: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
  controls.bind(commands);
  const events = new EventEmitter();
  const state = { quitRequested: false, quitConfirmed: false, quitInProgress: false,
    quitConfirmationPending: false, installingUpdate: false };
  let blockUnload = false;
  const app = {
    on: events.on.bind(events), exit: vi.fn(),
    quit() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      events.emit('before-quit', event);
      if (event.defaultPrevented) return;
      // Electron can already have closed utility windows when a renderer vetoes quitting.
      for (const window of MockWindow.getAllWindows()) window.destroy();
      if (blockUnload) { lifecycle.cancel(); return; }
      events.emit('will-quit', { preventDefault() {} });
    },
  };
  const prepare = vi.fn(async () => { feedback.dispose(); controls.dispose(); });
  const requestConfirmation = vi.fn();
  const lifecycle = createQuitLifecycle({ app, state, prepare, requestConfirmation, reportError: error => { throw error; } });
  const show = async () => { controls.update(control); feedback.show(gesture); await turn(); };
  return { app, lifecycle, prepare, requestConfirmation, commands, show,
    blockUnload(value: boolean) { blockUnload = value; },
    dispose() { controls.dispose(); feedback.dispose(); },
  };
};

it('keeps Computer controls and feedback usable when the background-work quit confirmation is cancelled', async () => {
  const f = fixture();
  try {
    await f.show();
    f.app.quit(); // The user cancels the confirmation: confirm() is never called.
    expect(f.requestConfirmation).toHaveBeenCalledOnce();
    expect(f.prepare).not.toHaveBeenCalled();
    await f.show();
    expect(MockWindow.getAllWindows()).toHaveLength(2);
    expect(MockWindow.getAllWindows().every(window => window.visible)).toBe(true);
    desktop.windows[0]!.webContents.emit('will-navigate', { preventDefault() {} }, 'varin-computer-control:handback');
    await turn();
    expect(f.commands.handback).toHaveBeenCalledOnce();
    f.lifecycle.confirm();
    await turn();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    await f.show();
    expect(MockWindow.getAllWindows()).toHaveLength(0);
  } finally { f.dispose(); }
});

it('recreates closed Computer windows after a renderer veto and disposes only on a later committed quit', async () => {
  const f = fixture();
  try {
    await f.show();
    f.blockUnload(true);
    f.lifecycle.confirm();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(MockWindow.getAllWindows()).toHaveLength(0);
    await f.show();
    expect(MockWindow.getAllWindows()).toHaveLength(2);
    expect(MockWindow.getAllWindows().every(window => window.visible)).toBe(true);
    f.blockUnload(false);
    f.lifecycle.confirm();
    await turn();
    expect(f.prepare).toHaveBeenCalledOnce();
    await f.show();
    expect(MockWindow.getAllWindows()).toHaveLength(0);
  } finally { f.dispose(); }
});
