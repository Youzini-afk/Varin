import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { BrowserExecutionError, type BrowserEvent } from '@varin/protocol';
import type { CdpResult } from './cdp-transport.js';
import { createCdpBrowserOwner, type CdpBrowserOwner } from './cdp-owner.js';

type Command = { id: number; method: string; params: CdpResult; sessionId?: string };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6c98AAAAASUVORK5CYII=';

/** The fixture is a CDP peer, not an alternate BrowserOwner. Assertions run the
 * owner's real WebSocket correlation, events, navigation refs and queue. */
class BrowserPeer {
  server = createServer((request, response) => {
    if (request.url !== '/json/version') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ Browser: 'CDP fixture', webSocketDebuggerUrl: `${this.endpoint.replace('http:', 'ws:')}/devtools/browser/${this.identity}` }));
  });
  websocket = new WebSocketServer({ server: this.server });
  sockets = new Set<WebSocket>();
  requests: Command[] = [];
  identity = 'process-1';
  endpoint = '';
  downloadPath?: string;
  dialogOnClick = false;
  inputHeld?: { socket: WebSocket; command: Command };
  held = new Map<string, { socket: WebSocket; command: Command }>();
  targets = new Map([['tab-1', { targetId: 'tab-1', type: 'page', title: 'Original', url: 'https://example.test/' }], ['tab-2', { targetId: 'tab-2', type: 'page', title: 'Other', url: 'https://other.test/' }]]);
  constructor() {
    this.websocket.on('connection', socket => {
      this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket));
      socket.on('message', data => {
        const command = JSON.parse(data.toString()) as Command; this.requests.push(command);
        if (command.method === 'Runtime.evaluate' && command.params.expression === 'pending') { this.held.set(command.sessionId!, { socket, command }); return; }
        if (command.method === 'Runtime.evaluate' && command.params.expression === 'disconnect') { socket.terminate(); return; }
        if (command.method === 'Input.dispatchMouseEvent' && command.params.type === 'mousePressed' && this.dialogOnClick) {
          this.inputHeld = { socket, command };
          this.event('Page.javascriptDialogOpening', { type: 'alert', message: 'Confirm this input' }, command.sessionId); return;
        }
        let result: object = {};
        switch (command.method) {
          case 'Browser.getVersion': result = { product: 'Fixture' }; break;
          case 'Target.getTargets': result = { targetInfos: [...this.targets.values()] }; break;
          case 'Target.attachToTarget': result = { sessionId: `session:${command.params.targetId}` }; break;
          case 'Target.createTarget': {
            const targetId = `created-${this.targets.size}`;
            const target = { targetId, type: 'page', title: 'New', url: command.params.url };
            this.targets.set(targetId, target); this.event('Target.targetCreated', { targetInfo: target }); result = { targetId }; break;
          }
          case 'Target.closeTarget': this.targets.delete(command.params.targetId); this.event('Target.targetDestroyed', { targetId: command.params.targetId }); result = { success: true }; break;
          case 'Runtime.enable': this.event('Runtime.executionContextCreated', { context: { id: 7, auxData: { frameId: command.sessionId, isDefault: true } } }, command.sessionId); break;
          case 'Page.getFrameTree': result = { frameTree: { frame: { id: command.sessionId, url: 'https://example.test/', loaderId: 'loader-1' } } }; break;
          case 'Page.getLayoutMetrics': result = { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0, scale: 1 } }; break;
          case 'Page.getNavigationHistory': result = { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] }; break;
          case 'Page.captureScreenshot': result = { data: png }; break;
          case 'Accessibility.getFullAXTree': result = { nodes: [{ nodeId: 'node', backendDOMNodeId: 15, role: { value: 'button' }, name: { value: 'Submit' } }] }; break;
          case 'DOM.resolveNode': result = { object: { objectId: 'node-object' } }; break;
          case 'DOM.getContentQuads': result = { quads: [[10, 10, 30, 10, 30, 30, 10, 30]] }; break;
          case 'Runtime.callFunctionOn': result = { result: { value: true } }; break;
          case 'Runtime.evaluate': result = { result: { value: command.params.expression === 'navigator.platform' ? 'Linux' : 'observed' } }; break;
          case 'Page.navigate': this.navigate(command.sessionId!); result = { frameId: command.sessionId }; break;
          case 'Page.handleJavaScriptDialog':
            this.event('Page.javascriptDialogClosed', {}, command.sessionId);
            if (this.inputHeld) { this.respond(this.inputHeld.socket, this.inputHeld.command, {}); delete this.inputHeld; } break;
          case 'Browser.setDownloadBehavior': this.downloadPath = command.params.downloadPath; break;
        }
        this.respond(socket, command, result);
      });
    });
  }
  async start() { await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve)); const address = this.server.address(); this.endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`; }
  respond(socket: WebSocket, command: Command, result: object) { socket.send(JSON.stringify({ id: command.id, result, ...(command.sessionId ? { sessionId: command.sessionId } : {}) })); }
  finish(sessionId: string) { const held = this.held.get(sessionId)!; this.held.delete(sessionId); this.respond(held.socket, held.command, { result: { value: 'finished' } }); }
  event(method: string, params: object, sessionId?: string) { for (const socket of this.sockets) socket.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) })); }
  navigate(sessionId = 'session:tab-1') { this.event('Page.frameNavigated', { frame: { id: sessionId, url: 'https://example.test/new', loaderId: 'new' } }, sessionId); }
  async stop() { for (const socket of this.sockets) socket.terminate(); await new Promise<void>(resolve => this.websocket.close(() => resolve())); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}

let peer: BrowserPeer, owner: CdpBrowserOwner, scratch: string;
beforeEach(async () => { peer = new BrowserPeer(); await peer.start(); scratch = await mkdtemp(path.join(tmpdir(), 'varin-cdp-test-')); owner = createCdpBrowserOwner({ browserId: 'office', endpoint: peer.endpoint }); });
afterEach(async () => { await owner.dispose(); await peer.stop(); await rm(scratch, { recursive: true, force: true }); });

describe('independent CDP browser owner', () => {
  it('observes and controls the real target identity, invalidates stale refs and reports native tab events', async () => {
    const events: BrowserEvent[] = []; owner.subscribe(event => events.push(event));
    const pages = await owner.list(); expect(pages.map(page => page.pageId)).toEqual(['tab-1', 'tab-2']);
    const observation = await owner.read({ pageId: 'tab-1' });
    expect(observation.page.canGoBack).toBe(true);
    expect(observation.elements?.[0]).toMatchObject({ name: 'Submit', frameId: 'session:tab-1' });
    await owner.act('tab-1', { action: 'click', ref: observation.elements![0]!.ref! });
    expect(peer.requests.filter(request => request.method === 'Input.dispatchMouseEvent').map(request => request.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    const screenshot = await owner.read({ pageId: 'tab-1', view: 'screenshot' });
    expect(screenshot.image).toMatchObject({ width: 1, height: 1 });
    peer.navigate(); await expect.poll(() => events.some(event => event.kind === 'page' && event.page.url === 'https://example.test/new')).toBe(true);
    const before = peer.requests.filter(request => request.method.startsWith('Input.')).length;
    await expect(owner.act('tab-1', { action: 'click', ref: observation.elements![0]!.ref! })).rejects.toMatchObject({ effect: 'none' });
    await expect(owner.act('tab-1', { action: 'click', point: { x: 1, y: 1 }, observationId: screenshot.observationId })).rejects.toMatchObject({ effect: 'none' });
    expect(peer.requests.filter(request => request.method.startsWith('Input.')).length).toBe(before);
    await owner.activate('tab-2'); expect(peer.requests.at(-1)).toMatchObject({ method: 'Target.activateTarget', params: { targetId: 'tab-2' } });
    peer.event('Target.targetDestroyed', { targetId: 'tab-1' }); await expect.poll(() => events.some(event => event.kind === 'closed')).toBe(true);
    await expect(owner.read({ pageId: 'tab-1' })).rejects.toThrow('browser_page_closed');
  });
  it('exposes a native dialog without deadlocking behind its original input acknowledgement', async () => {
    await owner.list(); const observation = await owner.read({ pageId: 'tab-1' }); peer.dialogOnClick = true;
    const clicked = await owner.act('tab-1', { action: 'click', ref: observation.elements![0]!.ref! });
    expect(clicked.page.dialog).toMatchObject({ type: 'alert', message: 'Confirm this input' });
    expect(peer.inputHeld).toBeDefined();
    await expect(owner.act('tab-1', { action: 'type', text: 'must not dispatch' })).rejects.toMatchObject({ effect: 'none' });
    expect(peer.requests.some(request => request.method === 'Input.insertText')).toBe(false);
    await owner.act('tab-1', { action: 'dialog', accept: true });
    expect(peer.inputHeld).toBeUndefined();
  });
  it('automatically rechecks a disconnected resource without replaying operations', async () => {
    await owner.list(); const initial = await owner.resource();
    for (const socket of peer.sockets) socket.terminate();
    await expect.poll(async () => (await owner.resource()).state).toBe('interrupted');
    await new Promise(resolve => setTimeout(resolve, 1_020));
    expect(await owner.resource()).toMatchObject({ instanceId: initial.instanceId, state: 'online' });
    expect(peer.requests.some(request => request.method.startsWith('Input.'))).toBe(false);
  });
  it('keeps model navigation in the existing HTTP(S) browser boundary rather than treating local files as URLs', async () => {
    await expect(owner.open({ url: 'file:///etc/passwd' }, {})).rejects.toMatchObject({ effect: 'none' });
    await owner.list();
    await expect(owner.act('tab-1', { action: 'navigate', url: 'javascript:alert(1)' })).rejects.toMatchObject({ effect: 'none' });
    expect(peer.requests.some(request => request.method === 'Page.navigate' || request.method === 'Target.createTarget')).toBe(false);
    expect((await owner.open({ url: 'about:blank' }, {})).url).toBe('about:blank');
  });
  it('serializes one page, admits other pages, and rejects queued cancellation before dispatch', async () => {
    await owner.list(); const evaluation = owner.act('tab-1', { action: 'evaluate', script: 'pending' });
    await expect.poll(() => peer.held.size).toBe(1);
    const controller = new AbortController(); const cancelled = owner.act('tab-1', { action: 'type', text: 'cancelled' }, controller.signal).catch(error => error); controller.abort();
    await owner.act('tab-2', { action: 'type', text: 'other page' });
    expect(peer.requests.filter(request => request.method === 'Input.insertText').map(request => request.params.text)).toEqual(['other page']);
    peer.finish('session:tab-1'); await evaluation;
    expect(await cancelled).toMatchObject({ effect: 'none' });
  });
  it('keeps an interrupted effect unknown, never replays it, and verifies instance continuity on reconnect', async () => {
    await owner.list(); const initial = await owner.resource();
    const read = await owner.read({ pageId: 'tab-1' });
    await expect(owner.act('tab-1', { action: 'evaluate', script: 'disconnect' })).rejects.toMatchObject({ effect: 'unknown', executorStopped: false });
    expect(await owner.resource()).toMatchObject({ instanceId: initial.instanceId, state: 'interrupted' });
    await owner.connect(); expect(await owner.resource()).toMatchObject({ instanceId: initial.instanceId, state: 'online' });
    await expect(owner.act('tab-1', { action: 'click', ref: read.elements![0]!.ref! })).rejects.toMatchObject({ effect: 'none' });
    expect(peer.requests.filter(request => request.params.expression === 'disconnect')).toHaveLength(1);
    for (const socket of peer.sockets) socket.terminate(); await expect.poll(async () => (await owner.resource()).state).toBe('interrupted');
    peer.identity = 'replacement-process'; await owner.connect(); expect((await owner.resource()).instanceId).not.toBe(initial.instanceId);
  });
  it('retains a cancelled unresolved script until its original completion instead of releasing the page lane', async () => {
    await owner.list(); const controller = new AbortController();
    const evaluation = owner.act('tab-1', { action: 'evaluate', script: 'pending' }, controller.signal).catch(error => error as BrowserExecutionError);
    await expect.poll(() => peer.held.size).toBe(1); controller.abort(new Error('cancel'));
    const error = await evaluation as BrowserExecutionError; expect(error).toMatchObject({ effect: 'unknown', executorStopped: false }); expect(error.completion).toBeInstanceOf(Promise);
    const next = owner.act('tab-1', { action: 'type', text: 'after actual completion' });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(peer.requests.some(request => request.method === 'Input.insertText')).toBe(false);
    peer.finish('session:tab-1'); await error.completion; await next;
  });
  it('preserves existing user tabs on thread release and owner shutdown', async () => {
    await owner.list(); owner.retainForThread('tab-1', 'work'); await owner.releaseThread('work');
    expect(peer.requests.some(request => request.method === 'Target.closeTarget')).toBe(false);
    const created = await owner.open({ url: 'https://example.test/new' }, { threadId: 'work' }); await owner.releaseThread('work');
    expect(peer.requests.some(request => request.method === 'Target.closeTarget' && request.params.targetId === created.pageId)).toBe(true);
    await owner.dispose(); expect(peer.requests.some(request => request.method === 'Browser.close')).toBe(false);
  });
  it('does not claim file transfer from a remote socket alone, and uses private device staging only when explicitly configured', async () => {
    await owner.list(); expect((await owner.resource()).capabilities).not.toContain('upload');
    await expect(owner.upload('tab-1', 'ref', [])).rejects.toMatchObject({ effect: 'none' });
    await owner.dispose(); owner = createCdpBrowserOwner({ browserId: 'office', endpoint: peer.endpoint, scratchDirectory: scratch });
    await owner.list(); expect((await owner.resource()).capabilities).toContain('upload');
    const read = await owner.read({ pageId: 'tab-1' });
    await owner.upload('tab-1', read.elements![0]!.ref!, [{ name: '../../hello.txt', bytes: Buffer.from('actual file') }]);
    const upload = peer.requests.find(request => request.method === 'DOM.setFileInputFiles')!;
    expect(await readFile(upload.params.files[0], 'utf8')).toBe('actual file'); expect(path.basename(upload.params.files[0])).toBe('hello.txt');
    peer.event('Browser.downloadWillBegin', { guid: 'download-guid', frameId: 'session:tab-1', suggestedFilename: 'receipt.txt', url: 'https://example.test/receipt' });
    peer.event('Browser.downloadProgress', { guid: 'download-guid', state: 'completed', receivedBytes: 7, totalBytes: 7 });
    await writeFile(path.join(peer.downloadPath!, 'download-guid'), 'receipt');
    await expect.poll(async () => (await owner.downloads('tab-1'))[0]?.state).toBe('completed');
    expect(Buffer.from((await owner.readDownload('tab-1', 'download-guid')).bytes).toString()).toBe('receipt');
    await expect(owner.readDownload('tab-2', 'download-guid')).rejects.toThrow('does not belong');
    await owner.releaseDownload('tab-1', 'download-guid'); await expect(readFile(path.join(peer.downloadPath!, 'download-guid'))).rejects.toThrow();
  });
});
