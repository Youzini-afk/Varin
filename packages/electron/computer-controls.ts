import { BrowserWindow, screen } from 'electron';
import { getNativeLocale, nativeText } from './native-i18n.js';
import type { ComputerControlState, ComputerGesture } from '@varin/protocol';

type Commands = { holderId: string; takeover(): Promise<void>; handback(): Promise<void>; cancel(): Promise<void> };
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:#e9e9e9;font:13px system-ui}main{margin:5px;display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid #ffffff18;border-radius:14px;background:#242525f5;box-shadow:0 2px 10px #0005}#state{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}a{color:inherit;text-decoration:none;white-space:nowrap;padding:7px 10px;border-radius:8px;background:#ffffff12}a:first-of-type{background:#e6ecee;color:#182024}a[aria-disabled=true]{pointer-events:none;opacity:.45}#error{color:#ffbcb2;display:none;max-width:100%;padding:0 12px 6px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body><main><span id="state"></span><a id="handoff"></a><a id="cancel" href="varin-computer-control:cancel"></a></main><div id="error"></div><script>
window.setComputerControl=s=>{document.documentElement.lang=s.locale;const state=document.getElementById('state'),handoff=document.getElementById('handoff'),cancel=document.getElementById('cancel'),error=document.getElementById('error');state.textContent=s.text;handoff.textContent=s.handoff;handoff.href='varin-computer-control:'+s.command;cancel.textContent=s.cancel;cancel.style.display=s.cancelVisible?'':'none';for(const a of [handoff,cancel])a.setAttribute('aria-disabled',String(s.busy));error.textContent=s.error||'';error.style.display=s.error?'block':'none'};
</script></body></html>`;

/** Native control surface only. Its fixed commands call the owning Host directly. */
export function createComputerControls() {
  let window: BrowserWindow | undefined;
  let ready: Promise<void> = Promise.resolve();
  let commands: Commands | undefined;
  let control: ComputerControlState | undefined;
  let busy = false, disposed = false, error = '';
  const protectedWindows = new Map<BrowserWindow, boolean>();
  const protect = (active: boolean) => {
    if (process.platform !== 'win32') return;
    for (const candidate of BrowserWindow.getAllWindows()) {
      if (candidate === window || candidate.isDestroyed()) continue;
      if (active && !protectedWindows.has(candidate)) {
        protectedWindows.set(candidate, candidate.isContentProtected()); candidate.setContentProtection(true);
      }
    }
    if (!active) {
      for (const [candidate, prior] of protectedWindows) if (!candidate.isDestroyed()) candidate.setContentProtection(prior);
      protectedWindows.clear();
    }
  };
  const bounds = () => {
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(560, area.width - 24), height = error ? 91 : 68;
    return { x: Math.round(area.x + (area.width - width) / 2), y: area.y + area.height - height - 12, width, height };
  };
  const render = () => {
    if (disposed || process.platform !== 'win32') return;
    const visible = Boolean(control?.operator || control?.owner === 'human' || control?.transitioning || busy);
    protect(visible);
    if (!visible) { window?.hide(); error = ''; return; }
    if (!window) {
      window = new BrowserWindow({ ...bounds(), show: false, frame: false, transparent: true, focusable: false,
        resizable: false, skipTaskbar: true, hasShadow: false, fullscreenable: false, title: nativeText('Varin Computer controls'),
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'varin-computer-controls' } });
      const created = window;
      created.on('closed', () => { if (window === created) window = undefined; });
      window.setAlwaysOnTop(true, 'floating'); window.setContentProtection(true);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        const command = url.slice('varin-computer-control:'.length);
        if (!url.startsWith('varin-computer-control:') || !['takeover', 'handback', 'cancel'].includes(command) || busy || !commands) return;
        busy = true; error = ''; render();
        void commands[command as 'takeover' | 'handback' | 'cancel']().catch(cause => { error = cause instanceof Error ? cause.message : String(cause); })
          .finally(() => { busy = false; render(); });
      });
      ready = window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
    }
    const current = window;
    ready = ready.then(async () => {
      if (disposed || current.isDestroyed() || (!control?.operator && control?.owner !== 'human' && !control?.transitioning && !busy)) return;
      const human = control?.owner === 'human';
      const labels = { agent: nativeText('Varin is using this computer'), human: nativeText('You are using this computer'),
        takeover: nativeText('Take over'), handback: nativeText('Hand back to Varin'), cancel: nativeText('Cancel computer work'),
        changing: nativeText('Transferring control…'), cancelling: nativeText('Cancelling…'), unconfirmed: nativeText('Input release is unconfirmed') };
      const weHoldControl = human && control?.holderId === commands?.holderId;
      const text = control?.workStatus === 'cancelling' ? labels.cancelling : control?.workStatus === 'cancel-unconfirmed' ? labels.unconfirmed
        : control?.transitioning || busy ? labels.changing : human ? labels.human : labels.agent;
      const state = { locale: getNativeLocale(), text: `${text}${control?.activity?.status === 'running' ? ` · ${control.activity.app}` : ''}`,
        handoff: weHoldControl ? labels.handback : labels.takeover, command: weHoldControl ? 'handback' : 'takeover', cancel: labels.cancel,
        busy: busy || control?.transitioning || control?.workStatus === 'cancelling', cancelVisible: Boolean(control?.operator), error };
      current.setBounds({ ...current.getBounds(), height: error ? 91 : 68 });
      await current.webContents.executeJavaScript(`window.setComputerControl(${JSON.stringify(state)})`);
      if (!disposed && (control?.operator || control?.owner === 'human' || control?.transitioning || busy)) current.showInactive();
    }).catch(() => { if (!current.isDestroyed()) current.hide(); });
  };
  return {
    refreshLocale() { if (window && !window.isDestroyed()) window.setTitle(nativeText('Varin Computer controls')); render(); },
    bind(value: Commands) { commands = value; },
    update(value: ComputerControlState) { if (value.desktopId !== 'local-console') return; control = value; render(); },
    avoid(gesture: ComputerGesture) {
      if (!window || !gesture.point || gesture.phase !== 'target' || !window.isVisible()) return;
      const point = screen.screenToDipPoint({ x: Math.round(gesture.point.x), y: Math.round(gesture.point.y) });
      const current = window.getBounds();
      if (point.x < current.x || point.x >= current.x + current.width || point.y < current.y || point.y >= current.y + current.height) return;
      const area = screen.getDisplayNearestPoint(point).workArea;
      window.setPosition(area.x + 12, point.y < area.y + area.height / 2 ? area.y + area.height - current.height - 12 : area.y + 12);
    },
    ownsWindow(id: number) { return window?.id === id; },
    handles() {
      if (process.platform !== 'win32') return [];
      return BrowserWindow.getAllWindows().filter(candidate => !candidate.isDestroyed()).map(candidate => {
        const handle = candidate.getNativeWindowHandle(); return handle.length >= 8 ? Number(handle.readBigUInt64LE()) : handle.readUInt32LE();
      }).filter(Number.isSafeInteger);
    },
    dispose() { disposed = true; protect(false); window?.destroy(); window = undefined; },
  };
}
