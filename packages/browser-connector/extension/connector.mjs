/** No generic CDP or website-message entry point crosses this boundary. */
export const CAPABILITIES = Object.freeze([
  'list', 'read:overview', 'read:text', 'read:structure', 'read:screenshot',
  'act:navigate', 'act:back', 'act:forward', 'act:reload', 'act:close',
  'act:click', 'act:type', 'act:press', 'activate', 'pause',
]);
const fault = (message, effect = 'none') => Object.assign(new Error(message), { effect });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const httpUrl = value => {
  if (typeof value !== 'string') throw fault('An HTTP(S) page URL is required');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fault('Only HTTP(S) pages without embedded credentials can be shared');
  return url.href;
};
const KEY_CODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };

export class TabConnector {
  constructor({ chrome, browserId, instanceId, emit = () => {}, uuid = () => crypto.randomUUID() }) {
    this.chrome = chrome; this.browserId = browserId; this.instanceId = instanceId; this.emit = emit; this.uuid = uuid;
    this.pages = new Map(); this.attaching = new Map(); this.commands = new Map(); this.receipts = new Map(); this.lastSequence = 0; this.stopped = false;
  }
  async share(tabId) {
    if (this.stopped) throw fault('Reconnect before sharing a tab');
    if (!Number.isInteger(tabId)) throw fault('Select an actual browser tab');
    const existing = [...this.pages.values()].find(page => page.tabId === tabId);
    if (existing) return this.state(existing);
    if (this.attaching.has(tabId)) return this.attaching.get(tabId);
    const pending = (async () => {
      const tab = await this.chrome.tabs.get(tabId);
      if (tab.incognito) throw fault('Private browsing tabs cannot be shared');
      httpUrl(tab.url);
      await this.chrome.debugger.attach({ tabId }, '1.3');
      try {
        if (this.stopped) throw fault('The connection stopped while sharing this tab');
        const page = { tabId, pageId: `${this.instanceId}:tab:${tabId}:${this.uuid()}`, generation: 0,
          refs: new Map(), observations: new Map(), queue: Promise.resolve(), active: 0, paused: false };
        this.pages.set(page.pageId, page);
        await this.send(page, 'Page.enable');
        await this.send(page, 'Accessibility.enable');
        const state = await this.state(page);
        this.emit({ kind: 'page', page: state });
        return state;
      } catch (error) {
        for (const [id, page] of this.pages) if (page.tabId === tabId) this.pages.delete(id);
        await this.chrome.debugger.detach({ tabId }).catch(() => {});
        throw error;
      }
    })();
    this.attaching.set(tabId, pending);
    try { return await pending; } finally { this.attaching.delete(tabId); }
  }
  require(pageId) {
    const page = this.pages.get(pageId);
    if (this.stopped || !page) throw fault('browser_page_detached: Share the intended tab again; old page IDs cannot be reused');
    return page;
  }
  send(page, method, params = {}) {
    this.require(page.pageId);
    return this.chrome.debugger.sendCommand({ tabId: page.tabId }, method, params);
  }
  async state(page) {
    this.require(page.pageId);
    const tab = await this.chrome.tabs.get(page.tabId);
    const history = await this.send(page, 'Page.getNavigationHistory');
    this.require(page.pageId);
    return { browserId: this.browserId, instanceId: this.instanceId, pageId: page.pageId,
      generation: page.generation, title: tab.title || history.entries[history.currentIndex]?.title || '', url: tab.url || history.entries[history.currentIndex]?.url || '', loading: tab.status === 'loading',
      canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1,
      retained: true, agentPaused: page.paused };
  }
  invalidate(page) { page.generation++; page.refs.clear(); page.observations.clear(); }
  async unshare(pageId, reason = 'user_detached') {
    const page = this.pages.get(pageId);
    if (!page) return;
    // Revoke admission before waiting for the browser. Never close the user's tab.
    this.pages.delete(pageId); this.invalidate(page);
    await this.chrome.debugger.detach({ tabId: page.tabId }).catch(() => {});
    this.emit({ kind: 'closed', pageId, reason });
  }
  detached(tabId, reason) {
    for (const page of this.pages.values()) if (page.tabId === tabId) {
      this.pages.delete(page.pageId); this.invalidate(page);
      this.emit({ kind: 'closed', pageId: page.pageId, reason });
    }
  }
  async stop() {
    this.stopped = true;
    await Promise.all([...this.pages.keys()].map(id => this.unshare(id, 'connection_lost')));
    await Promise.allSettled([...this.attaching.values()]);
  }
  async pause(pageId, paused) {
    const page = this.require(pageId);
    page.paused = paused; this.invalidate(page);
    // Already issued input is not undone. Host must settle its original receipt.
    this.emit({ kind: 'page', page: await this.state(page) });
  }
  onEvent(source, method, params = {}) {
    if (source.sessionId) return; // Child targets are deliberately unsupported.
    const page = [...this.pages.values()].find(value => value.tabId === source.tabId);
    if (!page) return;
    if (['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameDetached', 'Page.frameStartedLoading'].includes(method)) {
      this.invalidate(page);
      void this.state(page).then(state => this.emit({ kind: 'page', page: state })).catch(() => {});
    }
  }
  changed(tabId, change) {
    const page = [...this.pages.values()].find(value => value.tabId === tabId);
    if (!page) return;
    if (change.url || change.status === 'loading') this.invalidate(page);
    if (change.url) {
      try { httpUrl(change.url); } catch { void this.unshare(page.pageId, 'unsupported_navigation'); return; }
    }
    if (change.title || change.status || change.url) void this.state(page).then(state => this.emit({ kind: 'page', page: state })).catch(() => {});
  }
  execute(command) {
    if (!record(command) || typeof command.id !== 'string' || !command.id || command.id.length > 200) return Promise.resolve({ id: '', ok: false, error: 'Invalid command ID', effect: 'none' });
    const sequence = command.sequence;
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return Promise.resolve({ id: command.id, ok: false, error: 'A positive command sequence is required', effect: 'none' });
    const previous = this.commands.get(command.id) ?? this.receipts.get(command.id);
    if (previous) {
      if (previous.sequence !== sequence) return Promise.resolve({ id: command.id, ok: false, error: 'Command identity cannot change its sequence', effect: 'none' });
      return previous.promise;
    }
    // Settled receipt eviction never permits replay: the sequence high-water
    // mark remains for this instance, independently of the small receipt cache.
    if (sequence <= this.lastSequence) return Promise.resolve({ id: command.id, ok: false, error: 'This command sequence was already consumed; observe before issuing a new operation', effect: 'none' });
    this.lastSequence = sequence;
    const promise = this.dispatch(command).then(value => ({ id: command.id, ok: true, value }),
      error => ({ id: command.id, ok: false, error: error instanceof Error ? error.message : 'Browser operation failed', effect: error?.effect === 'unknown' ? 'unknown' : 'none' }));
    const entry = { sequence, promise };
    this.commands.set(command.id, entry);
    void promise.then(() => {
      this.commands.delete(command.id); this.receipts.set(command.id, entry);
      if (this.receipts.size > 32) this.receipts.delete(this.receipts.keys().next().value);
    });
    return promise;
  }
  async dispatch({ method, args }) {
    if (this.stopped) throw fault('The browser connection has stopped');
    if (!Array.isArray(args)) throw fault('Browser command arguments must be an array');
    if (method === 'list') return Promise.all([...this.pages.values()].map(page => this.state(page)));
    const pageId = method === 'read' ? args[0]?.pageId : args[0];
    const page = this.require(pageId);
    if (method === 'pause') {
      if (typeof args[1] !== 'boolean') throw fault('Choose whether this page is paused');
      await this.pause(pageId, args[1]); return true;
    }
    if (!['read', 'act', 'activate'].includes(method)) throw fault('This connector does not grant browser-wide or file operations');
    const run = async () => {
      this.require(pageId);
      if (page.paused && method !== 'read') throw fault('browser_user_takeover: User control is active');
      if (method === 'read') return this.read(page, args[0]);
      if (method === 'activate') {
        await this.chrome.tabs.update(page.tabId, { active: true });
        return this.state(page);
      }
      return this.act(page, args[1]);
    };
    const operation = page.queue.then(run, run);
    page.queue = operation.catch(() => {}); return operation;
  }
  async metrics(page) {
    const metrics = await this.send(page, 'Page.getLayoutMetrics');
    const value = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
    return { width: value.clientWidth, height: value.clientHeight, scale: value.scale ?? 1,
      pageX: value.pageX, pageY: value.pageY };
  }
  async read(page, input) {
    if (!record(input)) throw fault('A page read request is required');
    const view = input.view || 'overview';
    if (!['overview', 'text', 'structure', 'screenshot'].includes(view) || input.ref || input.frameId || input.query) throw fault('This connector supports top-frame overview, text, structure and screenshot reads only');
    const generation = page.generation;
    const metrics = await this.metrics(page);
    const { frameTree } = await this.send(page, 'Page.getFrameTree');
    const observationId = this.uuid();
    const result = { page: await this.state(page), observationId,
      viewport: { width: metrics.width, height: metrics.height, scale: metrics.scale },
      frames: [{ frameId: frameTree.frame.id, url: frameTree.frame.url, available: true },
        ...(frameTree.childFrames ?? []).map(child => ({ frameId: child.frame.id, parentId: frameTree.frame.id, url: child.frame.url, available: false }))] };
    if (view === 'screenshot') {
      const image = await this.send(page, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const png = Uint8Array.from(atob(image.data.slice(0, 32)), char => char.charCodeAt(0));
      if (png.length < 24 || png[0] !== 137 || String.fromCharCode(...png.slice(1, 4)) !== 'PNG') throw fault('Browser returned an invalid PNG');
      const dimensions = new DataView(png.buffer);
      result.image = { mimeType: 'image/png', base64: image.data, width: dimensions.getUint32(16), height: dimensions.getUint32(20) };
    } else {
      const { nodes } = await this.send(page, 'Accessibility.getFullAXTree', { frameId: frameTree.frame.id });
      const readable = nodes.filter(node => !node.ignored && node.role?.value !== 'none');
      const offset = Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
      const limit = Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 2000) : 500;
      const elements = readable.slice(offset, offset + limit).map(node => {
        const ref = node.backendDOMNodeId ? `${observationId}:${node.nodeId}` : undefined;
        if (ref) page.refs.set(ref, { backendNodeId: node.backendDOMNodeId, generation, role: node.role?.value });
        return { ...(ref ? { ref } : {}), frameId: frameTree.frame.id, role: String(node.role?.value ?? 'unknown'),
          ...(node.name?.value ? { name: String(node.name.value) } : {}),
          ...(node.value?.value !== undefined ? { value: String(node.value.value) } : {}) };
      });
      result.total = readable.length; result.offset = offset;
      if (offset + limit < readable.length) result.nextOffset = offset + limit;
      if (view === 'text') result.text = elements.map(element => [element.role, element.name, element.value].filter(Boolean).join(' ')).join('\n');
      else result.elements = elements;
    }
    if (page.generation !== generation) throw fault('browser_page_changed: Navigation occurred while reading; observe again');
    page.observations.set(observationId, { generation, metrics });
    // Observation IDs retain only safe freshness metadata; refs are generation scoped.
    if (page.observations.size > 32) {
      const oldest = page.observations.keys().next().value; page.observations.delete(oldest);
      for (const ref of page.refs.keys()) if (ref.startsWith(`${oldest}:`)) page.refs.delete(ref);
    }
    this.require(page.pageId); return result;
  }
  reference(page, ref) {
    const value = page.refs.get(ref);
    if (!value || value.generation !== page.generation) throw fault('browser_stale_reference: Observe this page again before input');
    return value;
  }
  async act(page, action) {
    if (!record(action) || typeof action.action !== 'string') throw fault('A typed browser action is required');
    if (!CAPABILITIES.includes(`act:${action.action}`)) throw fault(`Unsupported browser action: ${action.action}`);
    let started = false;
    let inputGeneration;
    const effect = async (method, params) => {
      this.require(page.pageId);
      if (page.paused) throw fault('browser_user_takeover: User control is active');
      if (inputGeneration !== undefined && page.generation !== inputGeneration) throw fault('browser_stale_reference: The document changed before input');
      started = true; return this.send(page, method, params);
    };
    try {
      if (action.action === 'navigate') await effect('Page.navigate', { url: httpUrl(action.url) });
      else if (action.action === 'reload') await effect('Page.reload');
      else if (action.action === 'back' || action.action === 'forward') {
        const history = await this.send(page, 'Page.getNavigationHistory');
        const entry = history.entries[history.currentIndex + (action.action === 'back' ? -1 : 1)];
        if (!entry) throw fault('No page exists in that history direction');
        await effect('Page.navigateToHistoryEntry', { entryId: entry.id });
      } else if (action.action === 'close') {
        const previous = await this.state(page);
        started = true; await this.chrome.tabs.remove(page.tabId);
        this.detached(page.tabId, 'target_closed'); return { page: previous, action: 'close', value: { closed: true } };
      } else {
        const ref = this.reference(page, action.ref);
        inputGeneration = ref.generation;
        if (action.action === 'type' && !['textbox', 'searchbox', 'combobox'].includes(ref.role)) throw fault('Text insertion requires an editable field reference');
        // Resolve the original backend node, never a copied selector or a node in another tab.
        await this.send(page, 'DOM.describeNode', { backendNodeId: ref.backendNodeId });
        if (action.action === 'click') {
          await effect('DOM.scrollIntoViewIfNeeded', { backendNodeId: ref.backendNodeId });
          const { quads } = await this.send(page, 'DOM.getContentQuads', { backendNodeId: ref.backendNodeId });
          const quad = quads?.[0];
          if (!quad || quad.length !== 8) throw fault('The referenced element has no clickable layout');
          const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
          const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
          this.reference(page, action.ref);
          await effect('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await effect('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        } else {
          if (action.action === 'type' && (typeof action.text !== 'string' || action.replace)) throw fault('Type requires text and inserts without replacement; replace is unsupported');
          const key = action.key;
          if (action.action === 'press' && (!Object.hasOwn(KEY_CODES, key) || action.modifiers?.length)) throw fault('Only named keys without modifiers are supported');
          await effect('DOM.focus', { backendNodeId: ref.backendNodeId });
          this.reference(page, action.ref);
          if (action.action === 'type') await effect('Input.insertText', { text: action.text });
          else {
            const code = KEY_CODES[key];
            await effect('Input.dispatchKeyEvent', { type: 'keyDown', key: key === 'Space' ? ' ' : key, windowsVirtualKeyCode: code });
            await effect('Input.dispatchKeyEvent', { type: 'keyUp', key: key === 'Space' ? ' ' : key, windowsVirtualKeyCode: code });
          }
        }
      }
      this.invalidate(page);
      return { page: await this.state(page), action: action.action, method: 'native-input' };
    } catch (error) { throw fault(error instanceof Error ? error.message : 'Browser action failed', started ? 'unknown' : 'none'); }
  }
}
