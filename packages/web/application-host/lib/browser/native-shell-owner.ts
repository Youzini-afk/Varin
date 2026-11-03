import { BrowserDeviceService } from './device-service.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'puppeteer-core';
import type { BrowserDownload } from '@varin/protocol';
import { NativeBrowserOwner } from './native-owner.js';
import { invokeNativeBrowserCommand } from './desktop-invoke.js';
import { renderNativeWebPage } from './web-render.js';
import { NativePageTransport, type NativePageDebugger } from './native-page-transport.js';
import type { NativeBrowserDownload, NativeBrowserHost, NativeBrowserPage, NativeBrowserPageEvent, NativeBrowserPageState } from './native-page.js';

/** An inherited private pipe. Never install this port in a renderer or expose it over HTTP. */
export interface NativeBrowserShellPort {
  request(method: string, params: unknown): Promise<unknown>;
  subscribe(listener: (event: string, payload: unknown) => void): () => void;
}

type PageRecord = {
  state: NativeBrowserPageState;
  viewport: { width: number; height: number; scale: number };
  listeners: Set<(event: NativeBrowserPageEvent) => void>;
  cdp: Set<(method: string, params: unknown, sessionId?: string) => void>;
  closed: Set<() => void>;
  closing?: Promise<void>;
};
type DownloadRecord = { pageId: string; state: Omit<BrowserDownload, 'downloadId' | 'pageId'>; listeners: Set<() => void>; finished: Promise<void>; finish(): void; fail(error: Error): void };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native browser receipt');
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => { if (typeof value !== 'string') throw new Error('Invalid native browser string'); return value; };
const finite = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid native browser number'); return value; };
const state = (value: unknown): NativeBrowserPageState => {
  const input = record(value);
  for (const key of ['loading', 'canGoBack', 'canGoForward', 'destroyed']) if (typeof input[key] !== 'boolean') throw new Error('Invalid native browser state');
  return { title: string(input.title), url: string(input.url), loading: input.loading as boolean, canGoBack: input.canGoBack as boolean,
    canGoForward: input.canGoForward as boolean, destroyed: input.destroyed as boolean };
};
const viewport = (value: unknown) => {
  const input = record(value);
  const result = { width: finite(input.width), height: finite(input.height), scale: finite(input.scale) };
  if (result.width <= 0 || result.height <= 0 || result.scale <= 0) throw new Error('Invalid native browser viewport');
  return result;
};
const downloadState = (value: unknown): Omit<BrowserDownload, 'downloadId' | 'pageId'> => {
  const input = record(value), downloadState = string(input.state);
  if (!['progressing', 'completed', 'cancelled', 'interrupted'].includes(downloadState)) throw new Error('Invalid native download state');
  return { name: string(input.name), url: string(input.url), receivedBytes: finite(input.receivedBytes),
    ...(input.totalBytes === undefined ? {} : { totalBytes: finite(input.totalBytes) }), state: downloadState as BrowserDownload['state'] };
};

export class NativeShellBrowserHost implements NativeBrowserHost {
  private readonly pages = new Map<string, PageRecord>();
  private readonly downloads = new Map<string, DownloadRecord>();
  private readonly downloadListeners = new Set<(download: NativeBrowserDownload) => void>();
  private readonly unsubscribe: () => void;
  private connected = true;
  constructor(private readonly options: { port: NativeBrowserShellPort; scratchDirectory: string; requestContext?: 'interactive' | 'web-render' }) {
    this.unsubscribe = options.port.subscribe((event, payload) => {
      if (event === 'browser.native.disconnected') { this.disconnect(); return; }
      if (event !== 'browser.native') return;
      try { this.receive(record(payload)); }
      catch { this.disconnect(); }
    });
  }
  private request(method: string, params: unknown) {
    if (!this.connected) return Promise.reject(new Error('Native browser disconnected; action was not dispatched'));
    return this.options.port.request(method, params);
  }
  private disconnect() {
    if (!this.connected) return;
    this.connected = false;
    for (const download of this.downloads.values()) download.fail(new Error('Native download transport was lost; writer termination is unknown'));
    for (const page of this.pages.values()) {
      page.state = { ...page.state, disconnected: true };
      for (const listener of page.listeners) listener({ kind: 'crashed', reason: 'Native browser transport disconnected; earlier action outcomes are unknown' });
      for (const closed of [...page.closed]) closed();
    }
  }
  private receive(event: Record<string, unknown>) {
    const kind = string(event.kind);
    if (kind === 'download-start') {
      const pageId = string(event.pageId), downloadId = string(event.downloadId);
      if (!this.pages.has(pageId)) return;
      if (this.downloads.has(downloadId)) throw new Error('Duplicate native download');
      if (!this.downloadListeners.size) { void this.request('browser.download.cancel', { downloadId }).catch(() => undefined); return; }
      let finish!: () => void, fail!: (error: Error) => void;
      const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      void finished.catch(() => {});
      const download: DownloadRecord = { pageId, state: downloadState(event), listeners: new Set(), finished, finish, fail };
      this.downloads.set(downloadId, download);
      for (const listener of this.downloadListeners) listener({
        pageId, state: () => ({ ...download.state }),
        saveTo: async filePath => { await this.request('browser.download.save', { downloadId, filePath }); },
        cancel: async () => { await this.request('browser.download.cancel', { downloadId }); },
        finished: () => download.finished,
        release: async () => { await this.request('browser.download.release', { downloadId }); },
        subscribe(update) { download.listeners.add(update); return () => { download.listeners.delete(update); }; },
      });
      return;
    }
    if (kind === 'download-progress') {
      const download = this.downloads.get(string(event.downloadId));
      if (!download) return;
      download.state = downloadState({ ...download.state, ...event });
      for (const listener of download.listeners) listener();
      if (event.terminal === true) {
        if (download.state.state === 'progressing') throw new Error('Native terminal download is still progressing');
        download.finish(); this.downloads.delete(string(event.downloadId));
      }
      return;
    }
    const page = this.pages.get(string(event.pageId));
    if (!page) return;
    if (kind === 'cdp') {
      for (const listener of page.cdp) listener(string(event.method), event.params, event.sessionId === undefined ? undefined : string(event.sessionId));
      return;
    }
    if (kind === 'changed') {
      if (event.state !== undefined) page.state = state(event.state);
      if (event.viewport !== undefined) page.viewport = viewport(event.viewport);
      for (const listener of page.listeners) listener({ kind });
    } else if (kind === 'crashed') {
      for (const listener of page.listeners) listener({ kind, reason: string(event.reason) });
    } else if (kind === 'input') {
      for (const listener of page.listeners) listener({ kind });
    } else if (kind === 'closed') {
      page.state = { ...page.state, destroyed: true };
      for (const listener of page.listeners) listener({ kind });
      for (const closed of [...page.closed]) closed();
    } else throw new Error('Unknown native browser event');
  }
  subscribeDownloads(listener: (download: NativeBrowserDownload) => void) {
    this.downloadListeners.add(listener); return () => { this.downloadListeners.delete(listener); };
  }
  async create(pageId: string): Promise<NativeBrowserPage> {
    if (this.pages.has(pageId)) throw new Error('Native page already exists');
    const entry: PageRecord = { state: { title: '', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false, destroyed: false },
      viewport: { width: 1280, height: 800, scale: 1 }, listeners: new Set(), cdp: new Set(), closed: new Set() };
    this.pages.set(pageId, entry);
    let transport: NativePageTransport | undefined;
    try {
      const requestContext = this.options.requestContext ?? 'interactive';
      const created = record(await this.request('browser.create', { pageId, requestContext }));
      if (created.requestContext !== requestContext) throw new Error('Native browser did not confirm the isolated request context');
      entry.state = state(created.state); entry.viewport = viewport(created.viewport);
      const version = record(created.version);
      const nativeVersion: NativePageDebugger['version'] = { protocolVersion: string(version.protocolVersion), product: string(version.product),
        revision: string(version.revision), userAgent: string(version.userAgent), jsVersion: string(version.jsVersion) };
      transport = new NativePageTransport({
        id: pageId, title: () => entry.state.title, url: () => entry.state.url, version: nativeVersion,
        send: (method, params, sessionId) => this.request('browser.command', { pageId, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }),
        subscribe(message, closed) {
          entry.cdp.add(message); entry.closed.add(closed);
          return () => { entry.cdp.delete(message); entry.closed.delete(closed); };
        },
        disconnect: () => {},
      });
      const browser = await connect({ transport, defaultViewport: null });
      const page = (await browser.pages())[0];
      if (!page) throw new Error('The native browser did not expose its page');
      const windowLabel = (window: unknown) => {
        if (typeof window !== 'string' || !window) throw new Error('Native browser presentation requires a trusted window label');
        return window;
      };
      return {
        browser, page, state: () => ({ ...entry.state }), viewport: () => ({ ...entry.viewport }),
        subscribe(listener) { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; },
        load: async url => { await this.request('browser.load', { pageId, url }); },
        stop: async () => { await this.request('browser.stop', { pageId }); },
        back: async () => { await this.request('browser.back', { pageId }); },
        forward: async () => { await this.request('browser.forward', { pageId }); },
        reload: async () => { await this.request('browser.reload', { pageId }); },
        capture: () => this.capture(pageId),
        present: async (viewId, window, bounds, visible) => { await this.request('browser.present', { pageId, viewId, windowLabel: windowLabel(window), bounds, visible }); },
        layout: async (viewId, window, bounds, visible) => { await this.request('browser.layout', { pageId, viewId, windowLabel: windowLabel(window), bounds, visible }); },
        detach: async (viewId, window) => { await this.request('browser.detach', { pageId, viewId, windowLabel: windowLabel(window) }); },
        close: () => this.closePage(pageId, entry),
      };
    } catch (error) {
      transport?.close();
      try { await this.request('browser.close', { pageId }); } catch { /* Original error remains; no creation retry. */ }
      this.pages.delete(pageId);
      throw error;
    }
  }
  private async capture(pageId: string) {
    const result = record(await this.request('browser.capture', { pageId }));
    const captureId = string(result.captureId);
    try {
      const file = path.resolve(string(result.file));
      if (path.dirname(file) !== path.resolve(this.options.scratchDirectory)) throw new Error('Native capture escaped its private transfer directory');
      const size = finite(result.size), width = finite(result.width), height = finite(result.height), sha256 = string(result.sha256);
      if (!Number.isSafeInteger(size) || size <= 0 || width <= 0 || height <= 0 || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('Invalid native capture receipt');
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== size) throw new Error('Native capture length changed');
        const bytes = await handle.readFile();
        if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha256.toLowerCase()) throw new Error('Native capture integrity mismatch');
        if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw new Error('Native capture dimensions are inconsistent');
        return { base64: bytes.toString('base64'), width, height };
      } finally { await handle.close(); }
    } finally { await this.request('browser.releaseCapture', { captureId }); }
  }
  private closePage(pageId: string, entry: PageRecord): Promise<void> {
    return entry.closing ??= (async () => {
      if (!entry.state.destroyed) await this.request('browser.close', { pageId });
      entry.state = { ...entry.state, destroyed: true }; this.pages.delete(pageId);
    })();
  }
  async dispose() {
    for (const [pageId, entry] of this.pages) await this.closePage(pageId, entry);
    this.unsubscribe(); this.downloadListeners.clear(); this.downloads.clear();
  }
}

/** Creating the owner is lazy: no browser, Catalog or Application Host is started. */
export function createNativeShellBrowserOwner(options: { port: NativeBrowserShellPort; scratchDirectory: string }) {
  const owner = new NativeBrowserOwner({ scratchDirectory: options.scratchDirectory, native: new NativeShellBrowserHost(options) });
  const devices = new BrowserDeviceService({ owner, identityFile: path.join(path.dirname(options.scratchDirectory), 'browser-device.json') });
  const rendering = new NativeShellBrowserHost({ ...options, requestContext: 'web-render' });
  const disposeOwner = owner.dispose.bind(owner);
  const renderWebPage = (url: string, input?: { timeoutMs?: number; signal?: AbortSignal }) => renderNativeWebPage(rendering, url, input);
  return Object.assign(owner, {
    renderWebPage,
    invoke(input: unknown): Promise<unknown> {
      const request = record(input);
      if (request.command === 'desktop_browser_device') return devices.invoke(input);
      if (request.command === 'desktop_web_render') {
        const args = record(request.args);
        if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs))) throw new Error('Invalid web render timeout');
        return renderWebPage(string(args.url), args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs as number });
      }
      return invokeNativeBrowserCommand(owner, input);
    },
    async dispose() {
      await devices.dispose();
      const results = await Promise.allSettled([disposeOwner(), rendering.dispose()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    },
  });
}
