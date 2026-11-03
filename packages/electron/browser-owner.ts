import { BaseWindow, BrowserWindow, WebContentsView, session } from 'electron';
import { NativeBrowserOwner } from '@varin/web/server/lib/browser/native-owner.js';
import type { NativeBrowserBounds, NativeBrowserDownload, NativeBrowserHost, NativeBrowserPage, NativeBrowserPageEvent } from '@varin/web/server/lib/browser/native-page.js';
import { ElectronPageTransport } from './browser-transport.js';

/** Electron owns only native views, sessions and downloads. The shared owner owns actions. */
class ElectronBrowserHost implements NativeBrowserHost {
  private readonly browserSession: Electron.Session;
  private readonly views = new Map<string, WebContentsView>();
  private parkingWindow?: BaseWindow;
  private get parking() {
    return this.parkingWindow ??= new BaseWindow({ show: false, skipTaskbar: true, width: 1280, height: 800 });
  }
  constructor(partition?: string) { this.browserSession = session.fromPartition(partition ?? 'persist:varin-browser'); }

  subscribeDownloads(listener: (download: NativeBrowserDownload) => void) {
    const receive = (_event: Electron.Event, item: Electron.DownloadItem, contents: Electron.WebContents) => {
      const pageId = [...this.views.entries()].find(([, view]) => view.webContents === contents)?.[0];
      if (!pageId) return;
      const finished = new Promise<void>(resolve => { item.once('done', () => resolve()); });
      listener({
        pageId,
        state: () => ({ name: item.getFilename(), url: item.getURL(), receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state: item.getState() }),
        saveTo: file => item.setSavePath(file), cancel: () => item.cancel(), finished: () => finished, release: () => {},
        subscribe(update) {
          item.on('updated', update); item.on('done', update);
          return () => { item.removeListener('updated', update); item.removeListener('done', update); };
        },
      });
    };
    this.browserSession.on('will-download', receive);
    return () => this.browserSession.removeListener('will-download', receive);
  }

  async create(pageId: string): Promise<NativeBrowserPage> {
    const view = new WebContentsView({ webPreferences: { session: this.browserSession, sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false, webSecurity: true } });
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    this.parking.contentView.addChildView(view);
    this.views.set(pageId, view);
    const contents = view.webContents;
    let presentation: { window: BrowserWindow; viewId: string } | undefined;
    const windows = new Map<BrowserWindow, () => void>();
    const asWindow = (value: unknown): BrowserWindow => {
      if (!(value instanceof BrowserWindow) || value.isDestroyed()) throw new Error('Browser presentation window is unavailable');
      return value;
    };
    const place = (window: BrowserWindow, bounds: NativeBrowserBounds, visible: boolean) => {
      const target = visible ? window : this.parking, other = visible ? this.parking : window;
      if (!other.isDestroyed() && other.contentView.children.includes(view)) other.contentView.removeChildView(view);
      if (!target.contentView.children.includes(view)) target.contentView.addChildView(view);
      view.setBounds(visible ? bounds : { ...bounds, x: 0, y: 0 }); view.setVisible(true);
      contents.setBackgroundThrottling(false);
    };
    try {
      await contents.loadURL('about:blank'); contents.setBackgroundThrottling(false);
      const { connect } = await import('puppeteer-core');
      const browser = await connect({ transport: new ElectronPageTransport(contents), defaultViewport: null });
      const page = (await browser.pages())[0];
      if (!page) throw new Error('The native browser did not expose its page');
      contents.setWindowOpenHandler(({ url: raw }) => {
        try { const url = new URL(raw); if (['http:', 'https:'].includes(url.protocol) || raw === 'about:blank') void contents.loadURL(url.href).catch(() => undefined); }
        catch { /* Unsupported external schemes never escape this browser session. */ }
        return { action: 'deny' };
      });
      return {
        browser, page,
        state: () => ({ destroyed: contents.isDestroyed(), title: contents.isDestroyed() ? '' : contents.getTitle(),
          url: contents.isDestroyed() ? '' : contents.getURL(), loading: !contents.isDestroyed() && contents.isLoading(),
          canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(), canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward() }),
        viewport: () => ({ width: view.getBounds().width, height: view.getBounds().height, scale: contents.getZoomFactor() }),
        subscribe(listener: (event: NativeBrowserPageEvent) => void) {
          const changed = () => listener({ kind: 'changed' });
          const key = (_event: Electron.Event, input: Electron.Input) => { if (input.type === 'keyDown') listener({ kind: 'input' }); };
          const mouse = (_event: Electron.Event, input: Electron.MouseInputEvent) => { if (input.type === 'mouseDown' || input.type === 'mouseWheel') listener({ kind: 'input' }); };
          const crashed = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => listener({ kind: 'crashed', reason: details.reason });
          const closed = () => listener({ kind: 'closed' });
          contents.on('did-start-loading', changed); contents.on('did-stop-loading', changed);
          contents.on('did-navigate-in-page', changed); contents.on('page-title-updated', changed);
          contents.on('before-input-event', key); contents.on('before-mouse-event', mouse);
          contents.on('render-process-gone', crashed); contents.on('destroyed', closed);
          return () => {
            contents.removeListener('did-start-loading', changed); contents.removeListener('did-stop-loading', changed);
            contents.removeListener('did-navigate-in-page', changed); contents.removeListener('page-title-updated', changed);
            contents.removeListener('before-input-event', key); contents.removeListener('before-mouse-event', mouse);
            contents.removeListener('render-process-gone', crashed); contents.removeListener('destroyed', closed);
          };
        },
        load: url => contents.loadURL(url), stop: () => contents.stop(),
        back: () => contents.navigationHistory.goBack(), forward: () => contents.navigationHistory.goForward(), reload: () => contents.reload(),
        capture: async () => {
          const image = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
          if (image.isEmpty()) throw new Error('The browser has not produced a frame for this page yet');
          return { base64: image.toPNG().toString('base64'), ...image.getSize() };
        },
        present: (viewId, target, bounds, visible) => {
          const window = asWindow(target);
          if (presentation && (presentation.window !== window || presentation.viewId !== viewId) && !presentation.window.isDestroyed()) presentation.window.contentView.removeChildView(view);
          presentation = { window, viewId };
          if (!windows.has(window)) {
            const closed = () => {
              windows.delete(window);
              if (presentation?.window !== window || contents.isDestroyed()) return;
              this.parking.contentView.addChildView(view); view.setVisible(true); contents.setBackgroundThrottling(false); presentation = undefined;
            };
            windows.set(window, closed); window.once('closed', closed);
          }
          place(window, bounds, visible);
        },
        layout: (viewId, target, bounds, visible) => { if (presentation && presentation.window === target && presentation.viewId === viewId) place(presentation.window, bounds, visible); },
        detach: (viewId, target) => { if (presentation && presentation.window === target && presentation.viewId === viewId) { place(presentation.window, view.getBounds(), false); presentation = undefined; } },
        close: async () => {
          const destroyed = contents.isDestroyed() ? Promise.resolve() : new Promise<void>(resolve => { contents.once('destroyed', () => resolve()); });
          this.views.delete(pageId);
          for (const [window, closed] of windows) window.removeListener('closed', closed);
          windows.clear();
          if (presentation && !presentation.window.isDestroyed()) presentation.window.contentView.removeChildView(view);
          if (this.parking.contentView.children.includes(view)) this.parking.contentView.removeChildView(view);
          if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
          await destroyed;
        },
      };
    } catch (error) { this.views.delete(pageId); if (!contents.isDestroyed()) contents.close(); throw error; }
  }

  dispose() { if (this.parkingWindow && !this.parkingWindow.isDestroyed()) this.parkingWindow.destroy(); }
}

export class ElectronBrowserOwner extends NativeBrowserOwner {
  constructor(options: { scratchDirectory: string; partition?: string }) {
    super({ scratchDirectory: options.scratchDirectory, native: new ElectronBrowserHost(options.partition) });
  }
}
