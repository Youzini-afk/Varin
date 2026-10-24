import { BaseWindow, BrowserWindow, WebContentsView, session, type DownloadItem } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import type { Accessibility, Browser, CDPSession, Dialog, ElementHandle, Frame, KeyInput, Page, SerializedAXNode } from 'puppeteer-core';
import { BrowserExecutionError } from '@varin/protocol';
import type { BrowserAction, BrowserActionResult, BrowserDownload, BrowserElement, BrowserEvent, BrowserObservation, BrowserOwner, BrowserPage, BrowserReadRequest } from '@varin/protocol';
import { ElectronPageTransport } from './browser-transport.js';

type Reference = { node: SerializedAXNode; frame: Frame };
type CoordinateObservation = { navigation: number; viewport: string; scroll: string };
type Download = { state: BrowserDownload; item: DownloadItem; file: string; directory: string };
type OwnedPage = {
  id: string; view: WebContentsView; browser: Browser; page: Page; threads: Set<string>; retained: boolean;
  refs: Map<string, Reference>; refKeys: Map<string, string>; frameIds: WeakMap<Frame, string>;
  observations: Map<string, CoordinateObservation>; navigation: number; queue: Promise<unknown>;
  actions: Set<AbortController>; agentPaused: boolean; activeAction?: string; dialog?: Dialog; crashed?: string;
  inputAcknowledgements: Set<Promise<unknown>>;
  pendingScripts: Set<Promise<void>>;
  presentation?: { window: BrowserWindow; viewId: string }; uploadDirectories: Set<string>;
};

/** The Chromium page outlives its React view. Only explicit close/task cleanup destroys it. */
export class ElectronBrowserOwner implements BrowserOwner {
  readonly browserId = 'varin:embedded';
  private readonly pages = new Map<string, OwnedPage>();
  private readonly creating = new Map<string, Promise<OwnedPage>>();
  private readonly downloadsById = new Map<string, Download>();
  private readonly listeners = new Set<(event: BrowserEvent) => void>();
  private readonly browserSession: Electron.Session;
  private parkingWindow?: BaseWindow;
  private get parking() {
    return this.parkingWindow ??= new BaseWindow({ show: false, skipTaskbar: true, width: 1280, height: 800 });
  }
  private readonly presentationWindows = new WeakSet<BrowserWindow>();
  private readonly closedPages = new Set<string>();
  private disposed = false;
  private scratchReady?: Promise<void>;
  constructor(private readonly options: { scratchDirectory: string; partition?: string }) {
    this.browserSession = session.fromPartition(options.partition ?? 'persist:varin-browser');
    // Detached native views do not receive a normal compositor/layout lifecycle.
    // Keep background pages in an unshown host window so input/AX/screenshot work
    // without displaying or focusing them on the user's desktop.
    this.browserSession.on('will-download', this.willDownload);
  }
  subscribe(listener: (event: BrowserEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: BrowserEvent) { for (const listener of this.listeners) listener(event); }
  private state(entry: OwnedPage): BrowserPage {
    const contents = entry.view.webContents;
    return { browserId: this.browserId, pageId: entry.id, title: contents.isDestroyed() ? '' : contents.getTitle(),
      url: contents.isDestroyed() ? '' : contents.getURL(), loading: !contents.isDestroyed() && contents.isLoading(),
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(), canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(), retained: entry.retained,
      ...(entry.crashed ? { crashed: entry.crashed } : {}), agentPaused: entry.agentPaused,
      ...(entry.activeAction ? { activeAction: entry.activeAction } : {}),
      ...(entry.pendingScripts.size ? { scriptPending: true } : {}),
      ...(entry.dialog ? { dialog: { type: entry.dialog.type(), message: entry.dialog.message(), defaultPrompt: entry.dialog.defaultValue() } } : {}) };
  }
  private changed(entry: OwnedPage) { if (this.pages.has(entry.id)) this.emit({ kind: 'page', page: this.state(entry) }); }
  private require(pageId: string) {
    const entry = this.pages.get(pageId);
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error('browser_page_closed: This page no longer exists. Use browser_tabs to select an available page.');
    if (entry.crashed) throw new Error(`browser_page_crashed: ${entry.crashed}. Reload this page before continuing.`);
    return entry;
  }
  async list() { return [...this.pages.values()].map(entry => this.state(entry)); }
  retainForThread(pageId: string, threadId: string) { this.require(pageId).threads.add(threadId); }
  private url(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && value !== 'about:blank') throw new Error('This browser accepts HTTP(S) pages and about:blank; local files use the file owner.');
    return url.href;
  }
  private async create(id: string): Promise<OwnedPage> {
    if (this.disposed) throw new Error('The browser owner has stopped');
    if (this.closedPages.has(id)) throw new Error('browser_page_closed: Open a new browser page to continue.');
    const existing = this.pages.get(id); if (existing) return existing;
    const pending = this.creating.get(id); if (pending) return pending;
    const creating = (async () => {
      await (this.scratchReady ??= (async () => {
        // This directory belongs exclusively to the embedded browser owner.
        // Saved workspace files are elsewhere; unclaimed transfer staging from a
        // previous application process has no remaining page or input consumer.
        await mkdir(this.options.scratchDirectory, { recursive: true });
        for (const entry of await readdir(this.options.scratchDirectory, { withFileTypes: true })) {
          if (entry.isDirectory() && /^(download|upload)-[A-Za-z0-9]+$/.test(entry.name)) {
            try { await rm(path.join(this.options.scratchDirectory, entry.name), { recursive: true, force: true }); }
            catch { console.warn('[Browser] An earlier private transfer could not be released'); }
          }
        }
      })());
      const view = new WebContentsView({ webPreferences: { session: this.browserSession, sandbox: true, contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, webSecurity: true } });
      view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
      this.parking.contentView.addChildView(view);
      try {
        await view.webContents.loadURL('about:blank');
        view.webContents.setBackgroundThrottling(false);
        const { connect } = await import('puppeteer-core');
        const browser = await connect({ transport: new ElectronPageTransport(view.webContents), defaultViewport: null });
        const page = (await browser.pages())[0];
        if (!page) throw new Error('The embedded browser did not expose its page');
        // The original invocation owns cancellation. Page navigation and explicit wait
        // use their actual signal; no hidden library timer truncates a long operation.
        page.setDefaultTimeout(0); page.setDefaultNavigationTimeout(0);
        const entry: OwnedPage = { id, view, browser, page, threads: new Set(), retained: false, refs: new Map(), refKeys: new Map(),
          frameIds: new WeakMap(), observations: new Map(), navigation: 0, queue: Promise.resolve(), actions: new Set(), inputAcknowledgements: new Set(), pendingScripts: new Set(), agentPaused: false, uploadDirectories: new Set() };
        this.pages.set(id, entry);
        const changed = () => this.changed(entry);
        view.webContents.on('did-start-loading', changed); view.webContents.on('did-stop-loading', changed);
        view.webContents.on('did-navigate-in-page', changed); view.webContents.on('page-title-updated', changed);
        const userInput = () => { if (!entry.activeAction) { entry.navigation++; entry.observations.clear(); } };
        view.webContents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown') userInput(); });
        view.webContents.on('before-mouse-event', (_event, input) => { if (input.type === 'mouseDown' || input.type === 'mouseWheel') userInput(); });
        page.on('framenavigated', frame => {
          for (const [ref, value] of entry.refs) if (value.frame === frame) entry.refs.delete(ref);
          entry.refKeys.clear(); entry.navigation++; entry.observations.clear(); changed();
        });
        page.on('framedetached', frame => { for (const [ref, value] of entry.refs) if (value.frame === frame) entry.refs.delete(ref); });
        page.on('dialog', dialog => { entry.dialog = dialog; changed(); this.emit({ kind: 'dialog', pageId: id, type: dialog.type(), message: dialog.message(), defaultPrompt: dialog.defaultValue() }); });
        view.webContents.on('render-process-gone', (_event, details) => { entry.crashed = details.reason; changed(); });
        view.webContents.once('destroyed', () => { this.pages.delete(id); this.emit({ kind: 'closed', pageId: id }); });
        // Keep popup navigation inside this owned page, preserving existing embedded-browser behavior.
        view.webContents.setWindowOpenHandler(({ url }) => {
          try { void view.webContents.loadURL(this.url(url)).catch(() => undefined); } catch { /* unsupported external scheme */ }
          return { action: 'deny' };
        });
        changed(); return entry;
      } catch (error) { view.webContents.close(); throw error; }
    })();
    this.creating.set(id, creating);
    try { return await creating; } finally { this.creating.delete(id); }
  }
  async open(input: { url: string; pageId?: string; retained?: boolean }, scope: { threadId?: string; signal?: AbortSignal } = {}) {
    let started = false;
    try {
    const url = this.url(input.url); scope.signal?.throwIfAborted();
    if (input.pageId) this.require(input.pageId);
    started = !input.pageId;
    const entry = input.pageId ? this.require(input.pageId) : await this.create(randomUUID());
    if (scope.threadId) entry.threads.add(scope.threadId);
    if (input.retained !== undefined) entry.retained = input.retained;
    await this.act(entry.id, { action: 'navigate', url }, scope.signal);
    return this.state(entry);
    } catch (error) { throw error instanceof BrowserExecutionError && !started ? error : new BrowserExecutionError(error, started ? 'unknown' : 'none'); }
  }
  /** Called by a trusted local UI. Reopening a mounted page never reloads its URL. */
  async present(input: { pageId: string; viewId: string; url: string; bounds: Electron.Rectangle; visible: boolean }, window: BrowserWindow) {
    const existing = this.pages.get(input.pageId);
    const entry = existing ?? await this.create(input.pageId);
    entry.retained = true;
    if (!existing && input.url !== 'about:blank') void entry.view.webContents.loadURL(this.url(input.url)).catch(() => this.changed(entry));
    if (entry.presentation && (entry.presentation.window !== window || entry.presentation.viewId !== input.viewId))
      entry.presentation.window.contentView.removeChildView(entry.view);
    entry.presentation = { window, viewId: input.viewId };
    if (!this.presentationWindows.has(window)) {
      this.presentationWindows.add(window);
      window.once('closed', () => {
        if (this.disposed) return;
        for (const page of this.pages.values()) if (page.presentation?.window === window) {
          this.parking.contentView.addChildView(page.view); page.view.setVisible(true); page.view.webContents.setBackgroundThrottling(false); delete page.presentation;
        }
      });
    }
    this.place(entry, window, input.bounds, input.visible);
    this.changed(entry); return this.state(entry);
  }
  layout(pageId: string, viewId: string, window: BrowserWindow, bounds: Electron.Rectangle, visible: boolean) {
    const entry = this.pages.get(pageId);
    if (entry?.presentation?.viewId !== viewId || entry.presentation.window !== window) return;
    this.place(entry, window, bounds, visible);
  }
  detach(pageId: string, viewId: string, window: BrowserWindow) {
    const entry = this.pages.get(pageId);
    if (entry?.presentation?.viewId !== viewId || entry.presentation.window !== window) return;
    this.place(entry, window, entry.view.getBounds(), false); delete entry.presentation;
  }
  private place(entry: OwnedPage, window: BrowserWindow, bounds: Electron.Rectangle, visible: boolean) {
    const target = visible ? window : this.parking, other = visible ? this.parking : window;
    if (!other.isDestroyed() && other.contentView.children.includes(entry.view)) other.contentView.removeChildView(entry.view);
    if (!target.contentView.children.includes(entry.view)) target.contentView.addChildView(entry.view);
    entry.view.setBounds(visible ? bounds : { ...bounds, x: 0, y: 0 }); entry.view.setVisible(true);
    entry.view.webContents.setBackgroundThrottling(false);
  }
  takeControl(pageId: string, paused: boolean) {
    const entry = this.require(pageId); entry.agentPaused = paused;
    if (paused) for (const action of entry.actions) action.abort(new Error('The user took control of this page'));
    entry.navigation++; entry.observations.clear(); this.changed(entry); return this.state(entry);
  }
  private frameId(entry: OwnedPage, frame: Frame) {
    let id = entry.frameIds.get(frame); if (!id) { id = randomUUID(); entry.frameIds.set(frame, id); } return id;
  }
  private frame(entry: OwnedPage, id?: string) {
    const frame = id ? entry.page.frames().find(frame => this.frameId(entry, frame) === id) : entry.page.mainFrame();
    if (!frame || frame.detached) throw new Error('browser_frame_stale: Read the page again to select an available frame.');
    return frame;
  }
  private async element(entry: OwnedPage, ref: string): Promise<ElementHandle<Element>> {
    const value = entry.refs.get(ref);
    if (!value || value.frame.detached) throw new Error('browser_ref_stale: This element reference is no longer available. Read the page again.');
    const handle = await value.node.elementHandle();
    if (!handle || !await handle.evaluate(element => element.isConnected)) { await handle?.dispose(); throw new Error('browser_ref_stale: The element was replaced or its document navigated. Read the current page.'); }
    return handle;
  }
  private async coordinateState(entry: OwnedPage): Promise<CoordinateObservation> {
    const state = await entry.page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio, x: scrollX, y: scrollY }));
    return { navigation: entry.navigation, viewport: JSON.stringify([state.width, state.height, state.scale]), scroll: JSON.stringify([state.x, state.y]) };
  }
  private async coordinates(entry: OwnedPage, observationId: string) {
    const observed = entry.observations.get(observationId), current = await this.coordinateState(entry);
    if (!observed || JSON.stringify(observed) !== JSON.stringify(current)) throw new Error('browser_observation_stale: The page navigated, scrolled, resized or changed control. Take a new screenshot before coordinate input.');
  }
  private async pointerPoint(handle: ElementHandle<Element>) {
    if (!await handle.isIntersectingViewport({ threshold: 1 })) await handle.scrollIntoView();
    return handle.clickablePoint();
  }
  async read(input: BrowserReadRequest, signal?: AbortSignal): Promise<BrowserObservation> {
    signal?.throwIfAborted(); const entry = this.require(input.pageId), page = entry.page;
    const observationId = randomUUID();
    if (entry.dialog) {
      const bounds = entry.view.getBounds();
      return { page: this.state(entry), observationId, viewport: { width: bounds.width, height: bounds.height, scale: entry.view.webContents.getZoomFactor() },
        frames: page.frames().map(frame => ({ frameId: this.frameId(entry, frame), url: frame.url(), available: !frame.detached })), text: entry.dialog.message() };
    }
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
    const frames = page.frames().map(frame => ({ frameId: this.frameId(entry, frame), ...(frame.parentFrame() ? { parentId: this.frameId(entry, frame.parentFrame()!) } : {}), url: frame.url(), available: !frame.detached }));
    const result: BrowserObservation = { page: this.state(entry), observationId, viewport, frames };
    if (input.view === 'screenshot') {
      const before = await this.coordinateState(entry);
      const captured = await entry.view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (captured.isEmpty()) throw new Error('The browser has not produced a frame for this page yet');
      const pixels = captured.toPNG().toString('base64');
      signal?.throwIfAborted();
      const after = await this.coordinateState(entry);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('The viewport moved during capture; take another screenshot.');
      entry.observations.set(observationId, after);
      return { ...result, image: { mimeType: 'image/png', base64: pixels, width: captured.getSize().width, height: captured.getSize().height } };
    }
    const referencedFrame = input.ref ? entry.refs.get(input.ref)?.frame : undefined;
    if (input.ref && !referencedFrame) throw new Error('browser_ref_stale: Read the current page before selecting this element.');
    if (referencedFrame && input.frameId && this.frame(entry, input.frameId) !== referencedFrame) throw new Error('The selected element belongs to another frame');
    const selectedFrames = referencedFrame ? [referencedFrame] : input.frameId ? [this.frame(entry, input.frameId)] : page.frames();
    const rows: BrowserElement[] = [];
    for (const frame of selectedFrames) {
      signal?.throwIfAborted();
      if (frame.detached) continue;
      const root = input.ref ? await this.element(entry, input.ref) : undefined;
      try {
        // Puppeteer's page snapshot uses this same per-frame accessibility owner.
        // Keep frame selection here so cross-origin frame identity stays explicit.
        const tree = await (frame as Frame & { accessibility: Accessibility }).accessibility.snapshot({ interestingOnly: input.view !== 'structure', ...(root ? { root } : {}) });
        const walk = (node: SerializedAXNode, depth: number) => {
          // Puppeteer supplies these CDP identity fields alongside its public handle
          // resolver. References never depend on a node's position in the snapshot.
          const identity = node as SerializedAXNode & { backendNodeId?: number; loaderId?: string };
          const key = identity.backendNodeId ? `${this.frameId(entry, frame)}:${identity.loaderId}:${identity.backendNodeId}` : undefined;
          const ref = key ? entry.refKeys.get(key) ?? randomUUID() : undefined;
          if (key && ref) { entry.refKeys.set(key, ref); entry.refs.set(ref, { node, frame }); }
          const state: Record<string, string | number | boolean> = {};
          for (const field of ['disabled', 'expanded', 'focused', 'modal', 'multiline', 'multiselectable', 'readonly', 'required', 'selected', 'checked', 'pressed', 'busy', 'url', 'valuemin', 'valuemax'] as const)
            if (node[field] !== undefined) state[field] = node[field]!;
          rows.push({ role: node.role, frameId: this.frameId(entry, frame), ...(ref ? { ref } : {}),
            ...(node.name ? { name: node.name } : {}), ...(node.value !== undefined ? { value: String(node.value) } : {}),
            ...(node.description ? { description: node.description } : {}), level: node.level ?? depth, ...(Object.keys(state).length ? { state } : {}) });
          for (const child of node.children ?? []) walk(child, depth + 1);
        };
        if (tree) walk(tree, 0);
      } catch (error) {
        if (!frame.detached) throw error;
        const row = result.frames.find(item => item.frameId === this.frameId(entry, frame)); if (row) row.available = false;
      } finally { await root?.dispose(); }
      if (input.ref) break;
    }
    signal?.throwIfAborted();
    const matches = input.view === 'find' ? rows.filter(row => `${row.name ?? ''}\n${row.value ?? ''}\n${row.description ?? ''}`.toLocaleLowerCase().includes((input.query ?? '').toLocaleLowerCase())) : rows;
    const offset = input.offset ?? 0, limit = input.limit ?? 80, slice = matches.slice(offset, offset + limit);
    return { ...result, offset, total: matches.length, ...(offset + slice.length < matches.length ? { nextOffset: offset + slice.length } : {}),
      ...(input.view === 'text' ? { text: slice.map(row => row.name || row.value || '').filter(Boolean).join('\n') } : { elements: slice }) };
  }
  private async queued<T>(entry: OwnedPage, name: string, signal: AbortSignal | undefined, effect: (signal: AbortSignal) => Promise<T>, user = false): Promise<T> {
    const userNavigation = user && ['navigate', 'reload', 'back', 'forward'].includes(name);
    if (userNavigation && (entry.actions.size || entry.pendingScripts.size)) this.takeControl(entry.id, true);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    entry.actions.add(controller);
    let started = false;
    let cancelQueued: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelQueued = () => { if (!started) reject(new BrowserExecutionError(controller.signal.reason, 'none')); };
      controller.signal.addEventListener('abort', cancelQueued, { once: true });
      if (controller.signal.aborted) cancelQueued();
    });
    const run = (userNavigation ? Promise.resolve() : entry.queue.catch(() => undefined)).then(async () => {
      controller.signal.throwIfAborted();
      if (entry.agentPaused && !user) throw new Error('browser_user_control: The user is working on this page. Read its current state; wait for the user to allow Agent input again.');
      started = true; entry.activeAction = name; this.changed(entry);
      try { return await effect(controller.signal); }
      finally {
        if (name !== 'wait') { entry.navigation++; entry.observations.clear(); }
        delete entry.activeAction; this.changed(entry);
      }
    });
    entry.queue = run.catch(async error => {
      if (error instanceof BrowserExecutionError && error.completion) await error.completion;
    });
    try { return await Promise.race([run, cancelled]); } finally { entry.actions.delete(controller); signal?.removeEventListener('abort', abort); if (cancelQueued) controller.signal.removeEventListener('abort', cancelQueued); }
  }
  /** Mouse.click submits its complete move/down/up batch before awaiting CDP replies.
   * A JavaScript dialog can hold those replies after input delivery. The browser
   * retains their acknowledgements; the caller can now answer the observed dialog.
   * No further input is scheduled by this continuation. */
  private async mouseInput(entry: OwnedPage, input: () => Promise<void>): Promise<void> {
    let stop: (() => void) | undefined;
    const dialog = new Promise<void>(resolve => { stop = this.subscribe(event => { if (event.kind === 'dialog' && event.pageId === entry.id) resolve(); }); });
    const acknowledged = input(); entry.inputAcknowledgements.add(acknowledged);
    void acknowledged.then(() => entry.inputAcknowledgements.delete(acknowledged), () => entry.inputAcknowledgements.delete(acknowledged));
    try { await Promise.race([acknowledged, dialog]); } finally { stop?.(); }
  }
  async act(pageId: string, action: BrowserAction, signal?: AbortSignal, user = false): Promise<BrowserActionResult> {
    let dispatched = false;
    const dispatch = () => { dispatched = true; };
    try {
    const entry = action.action === 'reload' ? this.pages.get(pageId) ?? this.require(pageId) : this.require(pageId);
    // User annotation installs a promise that resolves on the user's click. Its
    // cancellation and viewport reads must remain usable while that promise waits.
    if (user && action.action === 'evaluate') return { page: this.state(entry), action: 'evaluate', method: 'page-script',
      value: await this.frame(entry, action.frameId).evaluate(action.script) };
    if (action.action === 'close') {
      signal?.throwIfAborted();
      const previous = this.state(entry); dispatch(); await this.close(pageId); return { page: previous, action: 'close' };
    }
    // A dialog may block the command that opened it. Its response must bypass
    // that command's input queue, while still respecting user control.
    if (action.action === 'dialog') {
      signal?.throwIfAborted();
      if (entry.agentPaused && !user) throw new Error('browser_user_control: The user is handling this page');
      if (!entry.dialog) throw new Error('There is no open page dialog');
      dispatch(); if (action.accept) await entry.dialog.accept(action.text); else await entry.dialog.dismiss();
      delete entry.dialog; this.changed(entry); return { page: this.state(entry), action: 'dialog', method: 'native-input' };
    }
    if (entry.dialog) throw new Error('browser_dialog_open: Answer the current dialog before sending more page input. browser_read returns its message.');
    return await this.queued(entry, action.action, signal, async active => {
      const page = entry.page;
      let method: BrowserActionResult['method'] = 'native-input', value: unknown;
      const handle = 'ref' in action && action.ref ? await this.element(entry, action.ref) : undefined;
      try {
        active.throwIfAborted();
        switch (action.action) {
          case 'navigate': {
            const target = this.url(action.url);
            const stop = () => { if (!entry.view.webContents.isDestroyed()) entry.view.webContents.stop(); };
            active.addEventListener('abort', stop, { once: true });
            try { dispatch(); await page.goto(target, { waitUntil: 'domcontentloaded' }); entry.view.webContents.setBackgroundThrottling(false); active.throwIfAborted(); }
            finally { active.removeEventListener('abort', stop); } break;
          }
          case 'back': if (entry.view.webContents.navigationHistory.canGoBack()) { dispatch(); entry.view.webContents.navigationHistory.goBack(); } break;
          case 'forward': if (entry.view.webContents.navigationHistory.canGoForward()) { dispatch(); entry.view.webContents.navigationHistory.goForward(); } break;
          case 'reload': dispatch(); delete entry.crashed; entry.view.webContents.reload(); break;
          case 'click': case 'double_click': case 'hover': {
            if (handle) {
              const point = await this.pointerPoint(handle); active.throwIfAborted();
              dispatch();
              if (action.action === 'hover') await this.mouseInput(entry, () => page.mouse.move(point.x, point.y));
              else await this.mouseInput(entry, () => page.mouse.click(point.x, point.y, { count: action.action === 'double_click' ? 2 : 1 }));
            } else if ('point' in action) {
              await this.coordinates(entry, action.observationId); active.throwIfAborted();
              dispatch();
              if (action.action === 'hover') await page.mouse.move(action.point.x, action.point.y);
              else await this.mouseInput(entry, () => page.mouse.click(action.point.x, action.point.y, { count: action.action === 'double_click' ? 2 : 1 }));
            } break;
          }
          case 'scroll':
            if (handle) { const point = await this.pointerPoint(handle); active.throwIfAborted(); dispatch(); await this.mouseInput(entry, () => page.mouse.move(point.x, point.y)); }
            else if (action.point) { if (!action.observationId) throw new Error('Coordinate scrolling requires its screenshot observationId'); await this.coordinates(entry, action.observationId); active.throwIfAborted(); dispatch(); await this.mouseInput(entry, () => page.mouse.move(action.point!.x, action.point!.y)); }
            if (entry.dialog) break;
            active.throwIfAborted(); dispatch(); await this.mouseInput(entry, () => page.mouse.wheel({ deltaX: action.deltaX ?? 0, deltaY: action.deltaY })); break;
          case 'type':
            if (handle) { dispatch(); await this.mouseInput(entry, () => handle.focus()); if (entry.dialog) break; }
            active.throwIfAborted(); dispatch();
            await this.mouseInput(entry, async () => {
              const keys: Promise<unknown>[] = [];
              if (action.replace) {
                const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
                keys.push(page.keyboard.down(modifier), page.keyboard.down('A'), page.keyboard.up('A'), page.keyboard.up(modifier));
              }
              keys.push(page.keyboard.sendCharacter(action.text)); await Promise.all(keys);
            }); break;
          case 'press':
            if (handle) { dispatch(); await this.mouseInput(entry, () => handle.focus()); if (entry.dialog) break; }
            active.throwIfAborted(); dispatch();
            await this.mouseInput(entry, async () => {
              const keys: Promise<unknown>[] = (action.modifiers ?? []).map(key => page.keyboard.down(key));
              keys.push(page.keyboard.down(action.key as KeyInput), page.keyboard.up(action.key as KeyInput));
              keys.push(...[...action.modifiers ?? []].reverse().map(key => page.keyboard.up(key)));
              await Promise.all(keys);
            }); break;
          case 'select': dispatch(); await this.mouseInput(entry, async () => { value = await handle!.select(...action.values); }); method = 'dom-control'; break;
          case 'check': {
            const checked = await handle!.evaluate(element => element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? element.checked : element.getAttribute('aria-checked'));
            if (checked !== action.checked && checked !== String(action.checked)) {
              const point = await this.pointerPoint(handle!); active.throwIfAborted(); dispatch(); await this.mouseInput(entry, () => page.mouse.click(point.x, point.y));
            }
            value = { requestedChecked: action.checked }; break;
          }
          case 'drag':
            await this.coordinates(entry, action.observationId); active.throwIfAborted(); dispatch();
            await this.mouseInput(entry, () => page.mouse.move(action.from.x, action.from.y)); if (entry.dialog) break;
            active.throwIfAborted();
            await this.mouseInput(entry, async () => { await Promise.all([page.mouse.down(), page.mouse.move(action.to.x, action.to.y, { steps: 8 }), page.mouse.up()]); }); break;
          case 'evaluate': {
            const frame = this.frame(entry, action.frameId);
            // The same frame's CDP client terminates the actual execution, including
            // an infinite script. Keep waiting for that execution's own rejection.
            const client = (frame as Frame & { client: CDPSession }).client;
            active.throwIfAborted(); dispatch();
            const execution = frame.evaluate(action.script);
            let finished = false;
            const completion = execution.then(() => { finished = true; }, () => { finished = true; });
            entry.inputAcknowledgements.add(completion);
            void completion.then(() => { entry.inputAcknowledgements.delete(completion); entry.pendingScripts.delete(completion); this.changed(entry); });
            let rejectCancellation: (error: unknown) => void = () => {};
            const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
            let stopping: Promise<unknown> | undefined;
            const stop = () => {
              stopping ??= client.send('Runtime.terminateExecution').then(() => {
                // Chromium terminates active JavaScript, but cannot cancel an
                // already pending page Promise. Its original callback stays owned
                // until it settles or the page closes; cancellation is not a stop receipt.
                if (!finished) { entry.pendingScripts.add(completion); this.changed(entry); }
                rejectCancellation(new BrowserExecutionError(active.reason, 'unknown', finished, finished ? undefined : completion));
              }, error => rejectCancellation(new BrowserExecutionError(error, 'unknown', finished, finished ? undefined : completion)));
            };
            active.addEventListener('abort', stop, { once: true });
            try { if (active.aborted) stop(); value = await Promise.race([execution, cancellation]); active.throwIfAborted(); }
            finally { active.removeEventListener('abort', stop); if (stopping) await stopping; }
            method = 'page-script'; break;
          }
          case 'wait': await this.wait(entry, action, active); break;
        }
        return { page: this.state(entry), action: action.action, method, ...(value !== undefined ? { value } : {}), downloads: await this.downloads(pageId) };
      } finally {
        if (handle && entry.dialog && entry.inputAcknowledgements.size) {
          const cleanup = Promise.allSettled([...entry.inputAcknowledgements]).then(() => handle.dispose());
          entry.inputAcknowledgements.add(cleanup);
          void cleanup.then(() => entry.inputAcknowledgements.delete(cleanup), () => entry.inputAcknowledgements.delete(cleanup));
        } else await handle?.dispose();
      }
    }, user);
    } catch (error) { throw error instanceof BrowserExecutionError ? error : new BrowserExecutionError(error, dispatched ? 'unknown' : 'none'); }
  }
  private async wait(entry: OwnedPage, request: Extract<BrowserAction, { action: 'wait' }>, signal: AbortSignal) {
    if (request.condition === 'element') {
      if (!request.ref) throw new Error('Waiting for an element requires its observed ref');
      const handle = await this.element(entry, request.ref);
      try { await handle.frame.waitForFunction(element => element.isConnected && !!element.getClientRects().length, { signal, timeout: request.timeoutMs ?? 0 }, handle); }
      finally { await handle.dispose(); } return;
    }
    if (request.condition === 'url') {
      if (!request.url) throw new Error('Waiting for a URL requires url');
      await entry.page.waitForFunction(url => location.href === url, { signal, timeout: request.timeoutMs ?? 0 }, request.url); return;
    }
    if (request.condition === 'loaded') {
      await entry.page.waitForFunction(() => document.readyState === 'complete', { signal, timeout: request.timeoutMs ?? 0 }); return;
    }
    if (!request.downloadId) throw new Error('Waiting for a download requires downloadId');
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { stop(); signal.removeEventListener('abort', abort); if (timer) clearTimeout(timer); };
      const check = () => {
        const download = this.downloadsById.get(request.downloadId!);
        if (!download || download.state.pageId !== entry.id) { cleanup(); reject(new Error('The selected download is unavailable')); }
        else if (download.state.state !== 'progressing') { cleanup(); download.state.state === 'completed' ? resolve() : reject(new Error(`Download ${download.state.state}`)); }
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      const stop = this.subscribe(event => { if (event.kind === 'download' && event.download.downloadId === request.downloadId) check(); });
      signal.addEventListener('abort', abort, { once: true });
      if (request.timeoutMs) timer = setTimeout(() => { cleanup(); reject(new Error('The requested download wait timed out')); }, request.timeoutMs);
      if (signal.aborted) abort(); else check();
    });
  }
  private willDownload = (_event: Electron.Event, item: DownloadItem, contents: Electron.WebContents) => {
    const entry = [...this.pages.values()].find(page => page.view.webContents === contents); if (!entry) return;
    try {
      // setSavePath is valid synchronously inside will-download, before Electron
      // decides whether to show its native save dialog.
      mkdirSync(this.options.scratchDirectory, { recursive: true });
      const directory = mkdtempSync(path.join(this.options.scratchDirectory, 'download-'));
      const downloadId = randomUUID(), file = path.join(directory, 'content'); item.setSavePath(file);
      const download: Download = { item, directory, file, state: { downloadId, pageId: entry.id, name: path.basename(item.getFilename()), url: item.getURL(), receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state: 'progressing' } };
      this.downloadsById.set(downloadId, download);
      const update = () => { download.state = { ...download.state, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state: item.getState() }; this.emit({ kind: 'download', download: download.state }); };
      item.on('updated', update); item.once('done', update); update();
      if (!this.pages.has(entry.id) || this.disposed) { item.cancel(); void this.releaseDownload(entry.id, downloadId); }
    } catch { item.cancel(); }
    // Electron owns the download stream. This handler only assigns its private
    // staging path; saving into a workspace goes through native File authority.
  };
  async downloads(pageId: string) { return [...this.downloadsById.values()].filter(item => item.state.pageId === pageId).map(item => ({ ...item.state })); }
  async readDownload(pageId: string, downloadId: string, signal?: AbortSignal) {
    const download = this.downloadsById.get(downloadId);
    if (!download || download.state.pageId !== pageId) throw new Error('The download does not belong to this page');
    if (download.state.state !== 'completed') throw new Error(`The download is ${download.state.state}; wait for completion before using it`);
    return { name: download.state.name, bytes: await readFile(download.file, { signal }) };
  }
  async releaseDownload(pageId: string, downloadId: string) {
    const download = this.downloadsById.get(downloadId); if (!download || download.state.pageId !== pageId) return;
    if (download.state.state === 'progressing') download.item.cancel();
    await rm(download.directory, { recursive: true, force: true }); this.downloadsById.delete(downloadId);
  }
  async upload(pageId: string, ref: string, files: { name: string; bytes: Uint8Array }[], signal?: AbortSignal): Promise<BrowserActionResult> {
    let dispatched = false;
    try {
    const entry = this.require(pageId);
    return await this.queued(entry, 'upload', signal, async active => {
      const handle = await this.element(entry, ref);
      try {
        if (!await handle.evaluate(element => element instanceof HTMLInputElement && element.type === 'file')) throw new Error('Upload requires a file input reference');
        await mkdir(this.options.scratchDirectory, { recursive: true });
        const directory = await mkdtemp(path.join(this.options.scratchDirectory, 'upload-')); entry.uploadDirectories.add(directory);
        const paths: string[] = [];
        for (const [index, file] of files.entries()) {
          active.throwIfAborted(); const folder = path.join(directory, String(index)); await mkdir(folder);
          const target = path.join(folder, path.basename(file.name) || 'attachment'); await writeFile(target, file.bytes, { signal: active }); paths.push(target);
        }
        active.throwIfAborted(); dispatched = true;
        await this.mouseInput(entry, () => (handle as ElementHandle<HTMLInputElement>).uploadFile(...paths));
        return { page: this.state(entry), action: 'upload', method: 'dom-control', value: { files: files.map(file => ({ name: file.name, byteLength: file.bytes.byteLength })) } };
      } finally {
        if (entry.dialog) { const cleanup = Promise.allSettled([...entry.inputAcknowledgements]).then(() => handle.dispose()); void cleanup.catch(() => undefined); }
        else await handle.dispose();
      }
    });
    } catch (error) { throw error instanceof BrowserExecutionError ? error : new BrowserExecutionError(error, dispatched ? 'unknown' : 'none'); }
  }
  async close(pageId: string) {
    const entry = this.pages.get(pageId); if (!entry) return;
    for (const action of entry.actions) action.abort(new Error('The browser page was closed'));
    if (entry.presentation && !entry.presentation.window.isDestroyed()) entry.presentation.window.contentView.removeChildView(entry.view);
    if (this.parking.contentView.children.includes(entry.view)) this.parking.contentView.removeChildView(entry.view);
    this.pages.delete(pageId); this.closedPages.add(pageId); await entry.browser.disconnect();
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false });
    await Promise.allSettled([...entry.inputAcknowledgements]);
    for (const download of await this.downloads(pageId)) await this.releaseDownload(pageId, download.downloadId);
    for (const directory of entry.uploadDirectories) await rm(directory, { recursive: true, force: true });
    this.emit({ kind: 'closed', pageId });
  }
  async releaseThread(threadId: string) {
    for (const entry of this.pages.values()) if (entry.threads.delete(threadId) && !entry.threads.size && !entry.retained) await this.close(entry.id);
  }
  async dispose() {
    this.disposed = true; this.browserSession.removeListener('will-download', this.willDownload);
    await Promise.allSettled([...this.creating.values()]);
    for (const pageId of [...this.pages.keys()]) await this.close(pageId);
    if (this.parkingWindow && !this.parkingWindow.isDestroyed()) this.parkingWindow.destroy();
    this.listeners.clear();
  }
}
