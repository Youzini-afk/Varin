import { BrowserWindow, screen } from 'electron';
import type { ComputerGesture } from '@varin/protocol';
import { COMPUTER_FEEDBACK_HTML } from '../ui/src/lib/computerFeedback.js';

/** Native shell presentation only. Windows content protection excludes this layer from capture. */
export function createComputerFeedback() {
  const windows = new Map<number, { window: BrowserWindow; ready: Promise<void>; tail: Promise<unknown>; hide?: ReturnType<typeof setTimeout> }>();
  let generation = 0;
  let disposed = false;
  const clear = () => {
    generation += 1;
    for (const entry of windows.values()) {
      clearTimeout(entry.hide);
      if (!entry.window.isDestroyed()) { entry.window.hide(); void entry.window.webContents.executeJavaScript('window.computerFeedback({type:"clear"})').catch(() => {}); }
    }
  };
  return {
    show(gesture: ComputerGesture) {
      // Linux/macOS captures cannot exclude this native layer consistently. Their viewer still shows
      // the same effects; local Windows is the supported capture-safe desktop overlay.
      if (disposed || process.platform !== 'win32') return;
      if (gesture.phase === 'cancelled' || gesture.phase === 'failed') { clear(); return; }
      const point = gesture.point ? screen.screenToDipPoint(gesture.point) : undefined;
      const target = gesture.target ? screen.screenToDipRect(null, { x: Math.round(gesture.target.x), y: Math.round(gesture.target.y), width: Math.round(gesture.target.width), height: Math.round(gesture.target.height) }) : undefined;
      const to = gesture.to ? screen.screenToDipPoint(gesture.to) : undefined;
      for (const display of screen.getAllDisplays()) {
        const bounds = display.bounds;
        const relevant = point ? point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height
          : target ? target.x < bounds.x + bounds.width && target.x + target.width > bounds.x && target.y < bounds.y + bounds.height && target.y + target.height > bounds.y : windows.has(display.id);
        let entry = windows.get(display.id);
        if (!relevant) { entry?.window.hide(); continue; }
        if (!entry) {
          const window = new BrowserWindow({ ...bounds, show: false, transparent: true, frame: false, focusable: false,
            resizable: false, hasShadow: false, skipTaskbar: true, fullscreenable: false, title: 'Varin Computer feedback',
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'varin-computer-feedback' } });
          window.setIgnoreMouseEvents(true); window.setEnabled(false); window.setContentProtection(true); window.setAlwaysOnTop(true, 'floating');
          window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          window.webContents.on('will-navigate', event => event.preventDefault());
          const ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(COMPUTER_FEEDBACK_HTML)}`);
          entry = { window, ready, tail: ready }; windows.set(display.id, entry);
        }
        const view = entry;
        const admitted = generation;
        const mapped = { ...gesture, ...(point ? { point: { x: point.x - bounds.x, y: point.y - bounds.y } } : {}),
          ...(to ? { to: { x: to.x - bounds.x, y: to.y - bounds.y } } : {}),
          ...(target ? { target: { ...target, x: target.x - bounds.x, y: target.y - bounds.y } } : {}) };
        view.tail = view.tail.then(async () => {
          if (view.window.isDestroyed() || admitted !== generation) return;
          view.window.setBounds(bounds);
          const configuration = { type: 'configure', bounds: { x: 0, y: 0, width: bounds.width, height: bounds.height }, fit: false,
            labels: { type: '⌨', set_value: '⌨', scroll: '↕' } };
          await view.window.webContents.executeJavaScript(`window.computerFeedback(${JSON.stringify(configuration)});window.computerFeedback(${JSON.stringify({ type: 'gesture', gesture: mapped })})`);
          if (admitted === generation) view.window.showInactive();
        }).catch(() => { view.window.hide(); });
        clearTimeout(view.hide); delete view.hide;
        if (gesture.phase === 'completed') view.hide = setTimeout(() => { if (!view.window.isDestroyed()) view.window.hide(); }, 1100);
      }
    },
    ownsWindow(id: number) { return [...windows.values()].some(entry => entry.window.id === id); },
    dispose() { disposed = true; generation += 1; for (const entry of windows.values()) { clearTimeout(entry.hide); entry.window.destroy(); } windows.clear(); },
  };
}
