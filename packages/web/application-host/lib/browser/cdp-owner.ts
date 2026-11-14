import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserExecutionError } from '@varin/protocol';
import type { BrowserAction, BrowserActionResult, BrowserDownload, BrowserElement, BrowserEvent, BrowserObservation, BrowserOwner, BrowserPage, BrowserReadRequest, BrowserConnectionState, BrowserResourceCapability } from '@varin/protocol';
import { CdpDisconnectedError, CdpTransport, type CdpEvent, type CdpResult } from './cdp-transport.js';

type Target = { targetId: string; type: string; title: string; url: string };
type Frame = { id: string; parentId?: string; url: string; loaderId?: string };
type Reference = { backendNodeId: number; frameId?: string; generation: number };
type Entry = {
  target: Target; sessionId?: string; attaching?: Promise<void>; generation: number;
  refs: Map<string, Reference>; observations: Map<string, string>; threads: Set<string>;
  canGoBack: boolean; canGoForward: boolean; queue: Promise<unknown>; retained: boolean; created: boolean; paused: boolean; loading: boolean;
  activeAction?: string; dialog?: { type: string; message: string; defaultPrompt?: string }; crashed?: string;
  contexts: Map<string, number>; uploads: Set<string>;
};
export interface CdpBrowserOwnerOptions {
  browserId: string; endpoint: string; label?: string;
  /** Only set when the browser process shares this owner's filesystem. A remote
   * CDP socket alone cannot transfer local paths or read downloaded bytes. */
  scratchDirectory?: string;
  /** Owner-supplied authentication; never included in resource metadata. */
  headers?: Record<string, string>;
}

/** Browser process owner independent of Electron, desktop selection and workspace.
 * It attaches to the configured real browser; it never creates a second profile.
 * The registry authorizes assignments. This owner serializes each actual page. */
export class CdpBrowserOwner implements BrowserOwner {
  readonly browserId: string;
  private transport: CdpTransport | undefined;
  private connecting: Promise<void> | undefined;
  private state: BrowserConnectionState = 'disconnected';
  private instanceId?: string;
  private disposed = false;
  private retryAfter = 0;
  private pages = new Map<string, Entry>();
  private listeners = new Set<(event: BrowserEvent) => void>();
  private downloadsById = new Map<string, BrowserDownload>();
  private downloadDirectory?: string;
  private fileTransfers = false;
  constructor(private readonly options: CdpBrowserOwnerOptions) { this.browserId = options.browserId; }
  subscribe(listener: (event: BrowserEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: BrowserEvent) { for (const listener of this.listeners) listener(event); }
  private connection(state: BrowserConnectionState) {
    this.state = state;
    if (state === 'interrupted') this.retryAfter = Date.now() + 1_000;
    this.emit({ kind: 'connection', browserId: this.browserId, ...(this.instanceId ? { instanceId: this.instanceId } : {}), state });
  }
  async resource() {
    if (!this.disposed && (this.state === 'disconnected' || this.state === 'interrupted' && Date.now() >= this.retryAfter)) try { await this.connect(); } catch { /* The registration remains discoverable offline. */ }
    const capabilities: BrowserResourceCapability[] = ['tabs', 'open', 'read', 'screenshot', 'act', 'activate'];
    if (this.fileTransfers) capabilities.push('upload', 'download');
    return { ...(this.instanceId ? { instanceId: this.instanceId } : {}), state: this.state, capabilities, operations: ['list', 'open', 'read', 'activate', ...['navigate', 'back', 'forward', 'reload', 'close', 'click', 'double_click', 'hover', 'scroll', 'type', 'press', 'select', 'check', 'drag', 'dialog', 'evaluate', 'wait'].map(action => `act:${action}`), ...(this.fileTransfers ? ['upload', 'downloads', 'readDownload', 'releaseDownload'] : [])] };
  }
  async connect(): Promise<void> {
    if (this.disposed) throw new Error('This browser owner has ended');
    if (this.transport) return;
    if (this.connecting) return this.connecting;
    this.connection('connecting');
    const connecting = (async () => {
      const transport = await CdpTransport.connect(this.options.endpoint, this.options.headers);
      if (this.disposed) { transport.close(); throw new Error('This browser owner has ended'); }
      const previousInstance = this.instanceId;
      this.transport = transport;
      this.instanceId = transport.instanceId;
      transport.onEvent(event => this.event(event));
      transport.onClose(() => {
        if (this.transport !== transport) return;
        this.transport = undefined; this.fileTransfers = false;
        for (const entry of this.pages.values()) { delete entry.sessionId; entry.contexts.clear(); this.invalidate(entry); }
        if (!this.disposed) this.connection('interrupted');
      });
      try {
        await transport.command('Browser.getVersion');
        await transport.command('Target.setDiscoverTargets', { discover: true });
        const { targetInfos } = await transport.command('Target.getTargets');
        if (previousInstance && previousInstance !== transport.instanceId) {
          for (const entry of this.pages.values()) this.emit({ kind: 'closed', pageId: entry.target.targetId });
          this.pages.clear(); this.downloadsById.clear();
        }
        const seen = new Set<string>();
        for (const target of (targetInfos ?? []) as Target[]) if (target.type === 'page') { seen.add(target.targetId); this.updateTarget(target); }
        for (const pageId of this.pages.keys()) if (!seen.has(pageId)) this.closed(pageId);
        if (this.options.scratchDirectory) {
          await mkdir(this.options.scratchDirectory, { recursive: true });
          this.downloadDirectory ??= await mkdtemp(path.join(this.options.scratchDirectory, 'cdp-download-'));
          await transport.command('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.downloadDirectory, eventsEnabled: true });
          this.fileTransfers = true;
        }
        this.connection('online');
      } catch (error) { transport.close(); throw error; }
    })();
    this.connecting = connecting;
    try { await connecting; }
    catch (error) { if (this.state === 'connecting') this.connection('interrupted'); throw error; }
    finally { if (this.connecting === connecting) this.connecting = undefined; }
  }
  private socket() { if (!this.transport) throw new CdpDisconnectedError(); return this.transport; }
  private updateTarget(target: Target) {
    let entry = this.pages.get(target.targetId);
    if (entry) { if (entry.target.url !== target.url) this.invalidate(entry); entry.target = target; }
    else {
      entry = { target, generation: 0, refs: new Map(), observations: new Map(), threads: new Set(), queue: Promise.resolve(), retained: true, canGoBack: false, canGoForward: false,
        created: false, paused: false, loading: false, contexts: new Map(), uploads: new Set() };
      this.pages.set(target.targetId, entry);
    }
    this.changed(entry); return entry;
  }
  private page(entry: Entry): BrowserPage {
    return { browserId: this.browserId, ...(this.instanceId ? { instanceId: this.instanceId } : {}), generation: entry.generation, pageId: entry.target.targetId, title: entry.target.title, url: entry.target.url,
      loading: entry.loading, canGoBack: entry.canGoBack, canGoForward: entry.canGoForward, retained: entry.retained,
      agentPaused: entry.paused, ...(entry.activeAction ? { activeAction: entry.activeAction } : {}),
      ...(entry.dialog ? { dialog: entry.dialog } : {}), ...(entry.crashed ? { crashed: entry.crashed } : {}) };
  }
  private changed(entry: Entry) { this.emit({ kind: 'page', page: this.page(entry) }); }
  private invalidate(entry: Entry) { entry.generation++; entry.refs.clear(); entry.observations.clear(); }
  private closed(pageId: string) {
    const entry = this.pages.get(pageId); if (!entry) return;
    this.invalidate(entry); this.pages.delete(pageId); this.emit({ kind: 'closed', pageId });
    // Files already submitted to a page remain until the actual page closes.
    for (const directory of entry.uploads) void rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  private event(event: CdpEvent) {
    const { method, params } = event;
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      if (params.targetInfo?.type === 'page') this.updateTarget(params.targetInfo as Target); return;
    }
    if (method === 'Target.targetDestroyed') { this.closed(params.targetId); return; }
    if (method === 'Target.targetCrashed') { const page = this.pages.get(params.targetId); if (page) { page.crashed = 'The browser page crashed'; this.invalidate(page); this.changed(page); } return; }
    const entry = [...this.pages.values()].find(page => page.sessionId === (event.sessionId ?? params.sessionId));
    if (method === 'Target.detachedFromTarget' && entry) { delete entry.sessionId; this.invalidate(entry); entry.crashed = 'The browser detached this page; reconnect and observe before continuing'; this.changed(entry); return; }
    if (method === 'Browser.downloadWillBegin') {
      // Only a frame observed in a connected page supplies ownership.
      const page = [...this.pages.values()].find(item => item.contexts.has(params.frameId));
      if (!page || !this.fileTransfers) return;
      const download: BrowserDownload = { downloadId: params.guid, pageId: page.target.targetId, name: path.basename(params.suggestedFilename || 'download'), url: params.url, receivedBytes: 0, state: 'progressing' };
      this.downloadsById.set(download.downloadId, download); this.emit({ kind: 'download', download }); return;
    }
    if (method === 'Browser.downloadProgress') {
      const download = this.downloadsById.get(params.guid); if (!download) return;
      download.receivedBytes = params.receivedBytes; download.totalBytes = params.totalBytes;
      download.state = params.state === 'completed' ? 'completed' : params.state === 'canceled' ? 'cancelled' : 'progressing';
      this.emit({ kind: 'download', download: { ...download } }); return;
    }
    if (!entry) return;
    if (method === 'Page.frameNavigated') { this.invalidate(entry); if (!params.frame?.parentId) entry.target.url = params.frame?.url ?? entry.target.url; }
    if (method === 'Page.navigatedWithinDocument') { this.invalidate(entry); entry.target.url = params.url ?? entry.target.url; }
    if (method === 'Runtime.executionContextsCleared') { entry.contexts.clear(); this.invalidate(entry); }
    if (method === 'Runtime.executionContextCreated' && params.context?.auxData?.isDefault) entry.contexts.set(params.context.auxData.frameId, params.context.id);
    if (method === 'Runtime.executionContextDestroyed') for (const [frame, context] of entry.contexts) if (context === params.executionContextId) entry.contexts.delete(frame);
    if (method === 'Page.frameStartedLoading') entry.loading = true;
    if (method === 'Page.frameStoppedLoading') entry.loading = false;
    if (method === 'Inspector.targetCrashed') { entry.crashed = 'The browser page crashed'; this.invalidate(entry); }
    if (method === 'Page.javascriptDialogOpening') {
      entry.dialog = { type: params.type, message: params.message, ...(params.defaultPrompt ? { defaultPrompt: params.defaultPrompt } : {}) };
      this.emit({ kind: 'dialog', pageId: entry.target.targetId, ...entry.dialog });
    }
    if (method === 'Page.javascriptDialogClosed') delete entry.dialog;
    if (['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameStartedLoading', 'Page.frameStoppedLoading', 'Inspector.targetCrashed', 'Page.javascriptDialogOpening', 'Page.javascriptDialogClosed'].includes(method)) this.changed(entry);
  }
  private require(pageId: string) {
    const entry = this.pages.get(pageId);
    if (!entry) throw new Error('browser_page_closed: The selected page is no longer available; list the browser tabs again');
    return entry;
  }
  private async attach(entry: Entry) {
    if (entry.sessionId) return;
    if (entry.attaching) return entry.attaching;
    const transport = this.socket();
    const attaching = (async () => {
      const { sessionId } = await transport.command('Target.attachToTarget', { targetId: entry.target.targetId, flatten: true });
      if (typeof sessionId !== 'string') throw new Error('The browser did not provide a page session');
      entry.sessionId = sessionId; delete entry.crashed;
      await Promise.all(['Page.enable', 'Runtime.enable', 'DOM.enable', 'Accessibility.enable'].map(method => transport.command(method, {}, sessionId)));
    })();
    entry.attaching = attaching;
    try { await attaching; } catch (error) { delete entry.sessionId; throw error; } finally { delete entry.attaching; }
  }
  private async command(entry: Entry, method: string, params: Record<string, unknown> = {}) { await this.attach(entry); return this.socket().command(method, params, entry.sessionId); }
  async list() { await this.connect(); return [...this.pages.values()].map(entry => this.page(entry)); }
  private url(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && value !== 'about:blank') throw new Error('This browser accepts HTTP(S) pages and about:blank; local files use the file owner.');
    return url.href;
  }
  async open(input: { url: string; pageId?: string; retained?: boolean }, scope: { threadId?: string; signal?: AbortSignal }) {
    let sent = false;
    try {
    scope.signal?.throwIfAborted();
    const url = this.url(input.url);
    await this.connect();
    if (input.pageId) { const entry = this.require(input.pageId); if (scope.threadId) entry.threads.add(scope.threadId); if (input.retained !== undefined) entry.retained = input.retained; await this.act(input.pageId, { action: 'navigate', url }, scope.signal); return this.page(entry); }
      scope.signal?.throwIfAborted(); sent = true;
      const { targetId } = await this.socket().command('Target.createTarget', { url });
      if (typeof targetId !== 'string') throw new Error('The browser did not return the new page identity');
      const entry = this.pages.get(targetId) ?? this.updateTarget({ targetId, type: 'page', title: '', url });
      entry.created = true; entry.retained = input.retained ?? false; if (scope.threadId) entry.threads.add(scope.threadId);
      this.changed(entry); return this.page(entry);
    } catch (error) { throw this.failure(error, sent); }
  }
  private async frames(entry: Entry): Promise<Frame[]> {
    const { frameTree } = await this.command(entry, 'Page.getFrameTree');
    const frames: Frame[] = [];
    const walk = (tree: CdpResult) => { if (tree?.frame) frames.push(tree.frame as Frame); for (const child of tree?.childFrames ?? []) walk(child); };
    walk(frameTree); return frames;
  }
  private async viewport(entry: Entry) {
    const metrics = await this.command(entry, 'Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport ?? metrics.cssLayoutViewport ?? metrics.layoutViewport;
    if (!viewport) throw new Error('The browser did not return a page viewport');
    return { width: viewport.clientWidth, height: viewport.clientHeight, scale: viewport.scale ?? 1, x: viewport.pageX ?? 0, y: viewport.pageY ?? 0 };
  }
  private async coordinateState(entry: Entry) { return JSON.stringify([entry.generation, await this.viewport(entry)]); }
  private async coordinateCheck(entry: Entry, id: string) {
    const state = entry.observations.get(id);
    if (!state || state !== await this.coordinateState(entry)) throw new Error('browser_observation_stale: The page navigated, scrolled, resized or changed control; read a fresh screenshot');
  }
  private reference(entry: Entry, ref: string) {
    const reference = entry.refs.get(ref);
    if (!reference || reference.generation !== entry.generation) throw new Error('browser_ref_stale: Read the current page before acting on this element');
    return reference;
  }
  async read(input: BrowserReadRequest, signal?: AbortSignal): Promise<BrowserObservation> {
    signal?.throwIfAborted(); await this.connect(); const entry = this.require(input.pageId); await this.attach(entry);
    const frames = await this.frames(entry), generation = entry.generation;
    const { x: _x, y: _y, ...viewport } = await this.viewport(entry);
    const result: BrowserObservation = { page: this.page(entry), observationId: randomUUID(), viewport, frames: frames.map(frame => ({ frameId: frame.id, url: frame.url, ...(frame.parentId ? { parentId: frame.parentId } : {}), available: entry.contexts.has(frame.id) })) };
    if (entry.dialog) return { ...result, text: entry.dialog.message };
    const history = await this.command(entry, 'Page.getNavigationHistory');
    entry.canGoBack = result.page.canGoBack = history.currentIndex > 0; entry.canGoForward = result.page.canGoForward = history.currentIndex + 1 < (history.entries?.length ?? 0);
    if (input.view === 'screenshot') {
      const before = await this.coordinateState(entry);
      const { data } = await this.command(entry, 'Page.captureScreenshot', { format: 'png' });
      const after = await this.coordinateState(entry); signal?.throwIfAborted();
      if (before !== after || typeof data !== 'string') throw new Error('The page moved during capture or did not produce an image; read it again');
      entry.observations.set(result.observationId, after);
      const pixels = Buffer.from(data, 'base64');
      if (pixels.length < 24 || pixels.toString('ascii', 12, 16) !== 'IHDR') throw new Error('The browser returned an invalid PNG screenshot');
      return { ...result, image: { mimeType: 'image/png', base64: data, width: pixels.readUInt32BE(16), height: pixels.readUInt32BE(20) } };
    }
    let rows: BrowserElement[] = [];
    const referenced = input.ref ? this.reference(entry, input.ref) : undefined;
    const selected = frames.filter(frame => !input.frameId || frame.id === input.frameId);
    if (input.frameId && !selected.length) throw new Error('browser_frame_stale: The selected frame is no longer available');
    for (const frame of selected) {
      if (referenced?.frameId && referenced.frameId !== frame.id) continue;
      if (!entry.contexts.has(frame.id)) {
        if (input.frameId || referenced) throw new Error('This frame is not attached to the browser session; select an available frame');
        continue;
      }
      signal?.throwIfAborted();
      const { nodes } = await this.command(entry, referenced ? 'Accessibility.getPartialAXTree' : 'Accessibility.getFullAXTree', referenced ? { backendNodeId: referenced.backendNodeId, fetchRelatives: true } : { frameId: frame.id });
      for (const node of nodes ?? []) {
        if (node.ignored) continue;
        const ref = node.backendDOMNodeId ? randomUUID() : undefined;
        if (ref) entry.refs.set(ref, { backendNodeId: node.backendDOMNodeId, frameId: frame.id, generation });
        const state: Record<string, string | number | boolean> = {};
        for (const property of node.properties ?? []) if (['string', 'number', 'boolean'].includes(typeof property.value?.value)) state[property.name] = property.value.value;
        rows.push({ role: String(node.role?.value ?? 'node'), frameId: frame.id, ...(ref ? { ref } : {}), ...(node.name?.value ? { name: String(node.name.value) } : {}),
          ...(node.value?.value !== undefined ? { value: String(node.value.value) } : {}), ...(node.description?.value ? { description: String(node.description.value) } : {}), ...(Object.keys(state).length ? { state } : {}) });
      }
    }
    signal?.throwIfAborted();
    if (generation !== entry.generation) throw new Error('The page changed during observation; read it again');
    if (input.view === 'find') rows = rows.filter(row => `${row.name ?? ''}\n${row.value ?? ''}\n${row.description ?? ''}`.toLocaleLowerCase().includes((input.query ?? '').toLocaleLowerCase()));
    const offset = input.offset ?? 0, limit = input.limit ?? 80, slice = rows.slice(offset, offset + limit);
    return { ...result, total: rows.length, offset, ...(offset + slice.length < rows.length ? { nextOffset: offset + slice.length } : {}), ...(input.view === 'text' ? { text: slice.map(row => row.name || row.value || '').filter(Boolean).join('\n') } : { elements: slice }) };
  }
  private failure(error: unknown, dispatched: boolean): BrowserExecutionError {
    if (error instanceof BrowserExecutionError) return error;
    return new BrowserExecutionError(error, dispatched ? 'unknown' : 'none', !dispatched || !(error instanceof CdpDisconnectedError));
  }
  private async queued<T>(entry: Entry, name: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const operation = entry.queue.catch(() => undefined).then(async () => {
      signal?.throwIfAborted(); this.socket();
      if (this.pages.get(entry.target.targetId) !== entry) throw new Error('The original browser page ended');
      if (entry.paused) throw new Error('browser_user_control: The user is operating this page');
      entry.activeAction = name; this.changed(entry);
      try { return await run(); }
      finally { delete entry.activeAction; entry.observations.clear(); this.changed(entry); }
    });
    // Once sent, await its actual response or transport loss. Cancellation never
    // releases the page lane while an acknowledged-but-running effect continues.
    entry.queue = operation.catch(async error => { if (error instanceof BrowserExecutionError && error.completion) await error.completion; }); return operation;
  }
  private async object(entry: Entry, ref: string) {
    const value = this.reference(entry, ref);
    const { object } = await this.command(entry, 'DOM.resolveNode', { backendNodeId: value.backendNodeId });
    if (!object?.objectId) throw new Error('browser_ref_stale: The element no longer exists');
    try {
      const connected = await this.command(entry, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){return this.isConnected}', returnByValue: true });
      if (!connected.result?.value || value.generation !== entry.generation) throw new Error('browser_ref_stale: The element was detached');
      return { ...value, objectId: object.objectId as string };
    } catch (error) { void this.command(entry, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined); throw error; }
  }
  private async point(entry: Entry, reference: Reference) {
    await this.command(entry, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: reference.backendNodeId });
    const { quads } = await this.command(entry, 'DOM.getContentQuads', { backendNodeId: reference.backendNodeId });
    const quad = quads?.[0];
    if (!quad || quad.length !== 8) throw new Error('The element has no clickable layout');
    return { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
  }
  private async inputReceipt(entry: Entry, submit: () => Promise<CdpResult>): Promise<CdpResult> {
    let stop: (() => void) | undefined;
    const dialog = new Promise<CdpResult>(resolve => { stop = this.subscribe(event => {
      if (event.kind === 'dialog' && event.pageId === entry.target.targetId) resolve({});
    }); });
    // CDP can withhold input acknowledgements while a JavaScript dialog is
    // open. The dialog event proves delivery; expose it so the caller can
    // answer it instead of deadlocking behind the original click/key receipt.
    try { return await Promise.race([submit(), dialog]); } finally { stop?.(); }
  }
  async act(pageId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult> {
    let dispatched = false;
    try {
      signal?.throwIfAborted(); const entry = this.require(pageId); this.socket();
      const execute = async () => {
        await this.attach(entry); signal?.throwIfAborted();
        if (entry.dialog && action.action !== 'dialog') throw new Error('browser_dialog_open: Answer the current page dialog first');
        let method: BrowserActionResult['method'] = 'native-input', value: unknown;
        const send = async (name: string, params: Record<string, unknown> = {}) => { signal?.throwIfAborted(); if (reference && reference.generation !== entry.generation) throw new Error('browser_ref_stale: The document changed before input'); dispatched = true; return name.startsWith('Input.') || name === 'DOM.focus'
          ? this.inputReceipt(entry, () => this.command(entry, name, params)) : this.command(entry, name, params); };
        const reference = 'ref' in action && action.ref ? await this.object(entry, action.ref) : undefined;
        const call = async (functionDeclaration: string, args: unknown[] = []) => send('Runtime.callFunctionOn', { objectId: reference!.objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true });
        try {
          switch (action.action) {
            case 'navigate': {
              const result = await send('Page.navigate', { url: this.url(action.url) }); if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`); break;
            }
            case 'back': case 'forward': {
              const history = await this.command(entry, 'Page.getNavigationHistory');
              const item = history.entries?.[history.currentIndex + (action.action === 'back' ? -1 : 1)];
              if (item) await send('Page.navigateToHistoryEntry', { entryId: item.id }); break;
            }
            case 'reload': delete entry.crashed; await send('Page.reload'); break;
            case 'close': {
              dispatched = true; const result = await this.socket().command('Target.closeTarget', { targetId: pageId });
              if (result.success !== true) throw new Error('The browser did not close the selected page'); this.closed(pageId); break;
            }
            case 'click': case 'double_click': case 'hover': {
              const point = reference ? await this.point(entry, reference) : 'point' in action ? action.point : undefined;
              if (!point) throw new Error('Pointer input requires a current reference or screenshot point');
              if (!reference && 'observationId' in action) await this.coordinateCheck(entry, action.observationId);
              await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
              if (action.action !== 'hover') {
                // Send the complete down/up pair before awaiting: dialogs can hold
                // the first acknowledgement and must not leave the button pressed.
                for (let count = 1; count <= (action.action === 'double_click' ? 2 : 1); count++) await Promise.all([
                  send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: count }),
                  send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: count }),
                ]);
              } break;
            }
            case 'scroll': {
              if (action.point) { if (!action.observationId) throw new Error('Coordinate scrolling requires its screenshot observationId'); await this.coordinateCheck(entry, action.observationId); }
              const point = reference ? await this.point(entry, reference) : action.point ?? { x: 0, y: 0 };
              await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: action.deltaX ?? 0, deltaY: action.deltaY }); break;
            }
            case 'type': {
              if (reference) await send('DOM.focus', { backendNodeId: reference.backendNodeId });
              if (action.replace) {
                const platform = await this.command(entry, 'Runtime.evaluate', { expression: 'navigator.platform', returnByValue: true });
                const modifiers = /Mac/i.test(String(platform.result?.value)) ? 4 : 2;
                await Promise.all([send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers, commands: ['selectAll'] }), send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers })]);
              }
              await send('Input.insertText', { text: action.text }); break;
            }
            case 'press': {
              if (reference) await send('DOM.focus', { backendNodeId: reference.backendNodeId });
              const modifiers = (action.modifiers ?? []).reduce((mask, name) => mask | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[name]), 0);
              const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
              const keyCode = codes[action.key] ?? (action.key.length === 1 ? action.key.toUpperCase().charCodeAt(0) : undefined);
              await Promise.all([send('Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, modifiers, ...(keyCode ? { windowsVirtualKeyCode: keyCode } : {}), ...(action.key === 'Enter' ? { text: '\r' } : action.key.length === 1 && !modifiers ? { text: action.key } : {}) }), send('Input.dispatchKeyEvent', { type: 'keyUp', key: action.key, modifiers, ...(keyCode ? { windowsVirtualKeyCode: keyCode } : {}) })]); break;
            }
            case 'select': {
              const result = await call('function(values){if(this.tagName!=="SELECT")throw Error("Reference is not a select control"); for(const o of this.options)o.selected=values.includes(o.value);this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));return Array.from(this.selectedOptions,o=>o.value)}', [action.values]);
              if (result.exceptionDetails) throw new Error('The page rejected the selected values'); value = result.result?.value; method = 'dom-control'; break;
            }
            case 'check': {
              const current = await this.command(entry, 'Runtime.callFunctionOn', { objectId: reference!.objectId, functionDeclaration: 'function(){return typeof this.checked==="boolean"?this.checked:this.getAttribute("aria-checked")}', returnByValue: true });
              if (current.result?.value !== action.checked && current.result?.value !== String(action.checked)) {
                const point = await this.point(entry, reference!);
                await Promise.all([send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }), send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })]);
              } value = { requestedChecked: action.checked }; break;
            }
            case 'drag': {
              await this.coordinateCheck(entry, action.observationId);
              await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...action.from });
              await Promise.all([send('Input.dispatchMouseEvent', { type: 'mousePressed', ...action.from, button: 'left', buttons: 1 }), send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...action.to, button: 'left', buttons: 1 }), send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...action.to, button: 'left', buttons: 0 })]); break;
            }
            case 'dialog': if (!entry.dialog) throw new Error('The page has no open dialog'); await send('Page.handleJavaScriptDialog', { accept: action.accept, ...(action.text !== undefined ? { promptText: action.text } : {}) }); break;
            case 'evaluate': {
              const contextId = action.frameId ? entry.contexts.get(action.frameId) : undefined;
              if (action.frameId && contextId === undefined) throw new Error('browser_frame_stale: The selected frame has no accessible execution context');
              const execution = send('Runtime.evaluate', { expression: action.script, awaitPromise: true, returnByValue: true, ...(contextId !== undefined ? { contextId } : {}) });
              let finished = false;
              const completion = execution.then(() => { finished = true; }, () => { finished = true; });
              let abort: (() => void) | undefined;
              const cancelled = new Promise<never>((_resolve, reject) => {
                abort = () => {
                  void this.command(entry, 'Runtime.terminateExecution').then(() => reject(new BrowserExecutionError(signal?.reason, 'unknown', finished, finished ? undefined : completion)), error => reject(new BrowserExecutionError(error, 'unknown', false, completion)));
                };
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
              });
              let result: CdpResult;
              try { result = await Promise.race([execution, cancelled]); }
              finally { if (abort) signal?.removeEventListener('abort', abort); }
              if (result.exceptionDetails) throw new Error('The page script raised an exception; inspect the page before repeating it'); value = result.result?.value; method = 'page-script'; break;
            }
            case 'wait': await this.wait(entry, action, signal); break;
          }
          return { page: this.page(entry), action: action.action, method, ...(value !== undefined ? { value } : {}), downloads: await this.downloads(pageId) };
        } finally { if (reference) void this.command(entry, 'Runtime.releaseObject', { objectId: reference.objectId }).catch(() => undefined); }
      };
      // Dialog handling has its own lane because its predecessor can be blocked
      // waiting for this exact response. It still obeys the user's input gate.
      if (action.action === 'dialog') { if (entry.paused) throw new Error('The user is handling this page'); return await execute(); }
      return await this.queued(entry, action.action, signal, execute);
    } catch (error) { throw this.failure(error, dispatched); }
  }
  private async wait(entry: Entry, action: Extract<BrowserAction, { action: 'wait' }>, signal?: AbortSignal) {
    const deadline = action.timeoutMs ? Date.now() + action.timeoutMs : Infinity;
    while (true) {
      signal?.throwIfAborted(); this.socket(); this.require(entry.target.targetId);
      let complete = false;
      if (action.condition === 'download') {
        const download = this.downloadsById.get(action.downloadId ?? '');
        if (!download || download.pageId !== entry.target.targetId) throw new Error('The selected download is unavailable');
        if (download.state === 'cancelled' || download.state === 'interrupted') throw new Error(`The download ${download.state}`);
        complete = download.state === 'completed';
      } else if (action.condition === 'element') {
        if (!action.ref) throw new Error('Waiting for an element requires an observed ref');
        const object = await this.object(entry, action.ref);
        try { const result = await this.command(entry, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){return !!this.getClientRects().length}', returnByValue: true }); complete = !!result.result?.value; }
        finally { void this.command(entry, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined); }
      } else {
        const expression = action.condition === 'loaded' ? 'document.readyState === "complete"' : `location.href === ${JSON.stringify(action.url)}`;
        const result = await this.command(entry, 'Runtime.evaluate', { expression, returnByValue: true }); complete = !!result.result?.value;
      }
      if (complete) return; if (Date.now() >= deadline) throw new Error('The browser wait timed out');
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  }
  async activate(pageId: string) { this.require(pageId); await this.socket().command('Target.activateTarget', { targetId: pageId }); }
  takeControl(pageId: string, paused: boolean) { const entry = this.require(pageId); entry.paused = paused; this.invalidate(entry); this.changed(entry); return this.page(entry); }
  retainForThread(pageId: string, threadId: string) { this.require(pageId).threads.add(threadId); }
  async releaseThread(threadId: string) {
    for (const entry of this.pages.values()) if (entry.threads.delete(threadId) && !entry.threads.size && entry.created && !entry.retained) await this.act(entry.target.targetId, { action: 'close' });
  }
  async downloads(pageId: string) { return [...this.downloadsById.values()].filter(download => download.pageId === pageId).map(download => ({ ...download })); }
  async readDownload(pageId: string, downloadId: string, signal?: AbortSignal) {
    const download = this.downloadsById.get(downloadId);
    if (!download || download.pageId !== pageId || !this.downloadDirectory) throw new Error('The download does not belong to this page owner');
    if (download.state !== 'completed') throw new Error(`The download is ${download.state}; wait until it completes`);
    // Download IDs are emitted by Chromium. Never use a filename supplied by a
    // page or caller as a local authority path.
    if (path.basename(downloadId) !== downloadId || downloadId === '.' || downloadId === '..') throw new Error('Invalid browser download identity');
    return { name: download.name, bytes: await readFile(path.join(this.downloadDirectory, downloadId), { signal }) };
  }
  async releaseDownload(pageId: string, downloadId: string) {
    const download = this.downloadsById.get(downloadId); if (!download || download.pageId !== pageId || !this.downloadDirectory) return;
    if (download.state === 'progressing') await this.socket().command('Browser.cancelDownload', { guid: downloadId });
    if (path.basename(downloadId) !== downloadId || downloadId === '.' || downloadId === '..') throw new Error('Invalid browser download identity');
    await rm(path.join(this.downloadDirectory, downloadId), { force: true }); this.downloadsById.delete(downloadId);
  }
  async upload(pageId: string, ref: string, files: { name: string; bytes: Uint8Array }[], signal?: AbortSignal): Promise<BrowserActionResult> {
    let dispatched = false;
    try {
      if (!this.fileTransfers || !this.options.scratchDirectory) throw new Error('This CDP connection has no browser-device file transport; attach an owner on the browser device for file transfer');
      const entry = this.require(pageId);
      return await this.queued(entry, 'upload', signal, async () => {
        const reference = await this.object(entry, ref);
        try {
          const kind = await this.command(entry, 'Runtime.callFunctionOn', { objectId: reference.objectId, functionDeclaration: 'function(){return this.tagName==="INPUT"&&this.type==="file"}', returnByValue: true });
          if (!kind.result?.value) throw new Error('Upload requires an observed file input');
          const directory = await mkdtemp(path.join(this.options.scratchDirectory!, 'cdp-upload-')); entry.uploads.add(directory);
          const filenames: string[] = [];
          for (const [index, file] of files.entries()) {
            signal?.throwIfAborted(); const folder = path.join(directory, String(index)); await mkdir(folder);
            const filename = path.join(folder, path.basename(file.name) || 'attachment'); await writeFile(filename, file.bytes, { signal }); filenames.push(filename);
          }
          signal?.throwIfAborted(); dispatched = true;
          await this.command(entry, 'DOM.setFileInputFiles', { backendNodeId: reference.backendNodeId, files: filenames });
          return { page: this.page(entry), action: 'upload', method: 'dom-control', value: { files: files.map(file => ({ name: file.name, byteLength: file.bytes.byteLength })) } };
        } finally { void this.command(entry, 'Runtime.releaseObject', { objectId: reference.objectId }).catch(() => undefined); }
      });
    } catch (error) { throw this.failure(error, dispatched); }
  }
  async dispose() {
    this.disposed = true; this.connection('ended'); this.transport?.close();
    // A connection owner does not own the user's browser process or its tabs.
    // In particular, shutdown never sends Browser.close or deletes its profile.
    this.listeners.clear();
  }
}
export function createCdpBrowserOwner(options: CdpBrowserOwnerOptions): CdpBrowserOwner { return new CdpBrowserOwner(options); }
