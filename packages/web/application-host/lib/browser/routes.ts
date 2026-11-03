import { createHash } from 'node:crypto';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { raw as rawBody } from 'express';
import type { Express, Request, RequestHandler, Response } from 'express';
import { WebSocketServer } from 'ws';
import { encodeBrowserPacket, isBrowserExecutionError } from '@varin/protocol';
import { browserActor } from './remote-owner.js';
import { BrowserRegistry, presentationOwner } from './registry.js';
import { object, text, browserMediaMaxPayload, BROWSER_TRANSFER_BYTES } from './device-wire.js';
import { parseBrowserAction, parseBrowserRead } from './desktop-invoke.js';
import { parseBrowserInput } from './input-validation.js';

/** Browser authority is explicit and independent of Computer permissions. */
export function browserPrincipal(value: unknown): string {
  const auth = object(value);
  if (auth.type === 'session' && typeof auth.token === 'string' && auth.token) return `session:${createHash('sha256').update(auth.token).digest('hex')}`;
  if (auth.type !== 'client') throw new Error('Browser access requires an authenticated user');
  const client = object(auth.client), capabilities = new Set(Array.isArray(client.capabilities) ? client.capabilities : []);
  if (client.allowedDirectories !== undefined && (!Array.isArray(client.allowedDirectories) || client.allowedDirectories.length)) throw new Error('Directory-scoped credentials cannot access an interactive browser profile');
  const regularUi = client.profile === 'client' && capabilities.has('ui:access');
  const fullControl = client.profile === 'full-control' && ['config:read', 'config:write', 'process:control'].every(capability => capabilities.has(capability) || capabilities.has('*') || capabilities.has('admin'));
  if (!regularUi && !fullControl && !capabilities.has('browser:use')) throw new Error('This client does not have Browser profile access');
  return `client:${text(auth.clientId ?? client.id)}`;
}
function sendError(response: Response, error: unknown) {
  if (response.headersSent) { response.destroy(); return; }
  response.status(isBrowserExecutionError(error) && error.effect === 'unknown' ? 502 : 409).json({ error: error instanceof Error ? error.message : 'Browser operation failed',
    ...(isBrowserExecutionError(error) ? { browserExecution: { effect: error.effect, executorStopped: error.executorStopped } } : {}) });
}
export function registerBrowserRoutes(app: Express, options: {
  browsers: BrowserRegistry; requireAuth: RequestHandler;
  authenticate(request: Request, response: Response): Promise<unknown>;
}) {
  const { browsers } = options;
  const authorized: RequestHandler = (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Varin-Browser-Host', browsers.hostId);
    const expected = request.get('X-Varin-Browser-Host');
    if (expected && expected !== browsers.hostId) { response.status(409).json({ error: 'This connection reaches a different Browser Host' }); return; }
    void options.authenticate(request, response).then(auth => {
      const principalId = browserPrincipal(auth); browserActor.run({ kind: 'user', principalId }, next);
    }).catch(error => response.status(403).json({ error: error instanceof Error ? error.message : 'Browser authentication failed' }));
  };
  app.use('/api/browsers', options.requireAuth, authorized);
  const route = (method: 'get' | 'post', suffix: string, handle: (request: Request, response: Response) => unknown | Promise<unknown>) => {
    app[method](`/api/browsers${suffix}`, async (request, response) => {
      try { const result = await handle(request, response); if (!response.headersSent) response.json(result ?? { ok: true }); }
      catch (error) { sendError(response, error); }
    });
  };
  route('get', '', () => browsers.catalog());
  route('post', '/device-challenges', request => browsers.challenge((browserActor.getStore() as { principalId: string }).principalId, request.body));
  route('post', '/device-grants', request => browsers.issueGrant(browserActor.getStore()!.kind === 'user' ? (browserActor.getStore() as { principalId: string }).principalId : '', request.body));
  route('post', '/default', request => { const id = object(request.body).browserId; if (id !== null) text(id); browsers.select(id as string | null); return { defaultBrowserId: id }; });
  route('post', '/devices/:browserId/revoke', request => browsers.revoke(String(request.params.browserId)));
  route('post', '/pages', request => {
    const input = object(request.body); return browsers.open({ url: text(input.url), retained: true }, {});
  });
  route('post', '/pages/:pageId/action', request => browsers.userAction(String(request.params.pageId), parseBrowserAction(request.body)));
  route('post', '/pages/:pageId/read', request => browsers.read(parseBrowserRead({ ...object(request.body), pageId: String(request.params.pageId) })));
  route('post', '/pages/:pageId/control', async request => {
    const input = object(request.body); if (typeof input.paused !== 'boolean') throw new Error('Browser control requires paused');
    browsers.assertViewer(String(request.params.pageId), text(input.streamId));
    return presentationOwner(await browsers.owner(String(request.params.pageId))).takeControl(String(request.params.pageId), input.paused, text(input.streamId));
  });
  route('post', '/pages/:pageId/input', request => browsers.input(parseBrowserInput({ ...object(request.body), pageId: String(request.params.pageId) })));
  route('post', '/pages/:pageId/resize', async request => {
    const input = object(request.body); if (typeof input.width !== 'number' || typeof input.height !== 'number') throw new Error('Invalid browser viewport');
    browsers.assertViewer(String(request.params.pageId), text(input.streamId));
    return presentationOwner(await browsers.owner(String(request.params.pageId))).resize(String(request.params.pageId), text(input.streamId), input.width, input.height);
  });
  route('get', '/pages/:pageId/downloads', request => browsers.downloads(String(request.params.pageId)));
  route('get', '/pages/:pageId/downloads/:downloadId', async (request, response) => {
    const download = await browsers.readDownload(String(request.params.pageId), String(request.params.downloadId));
    response.type('application/octet-stream').attachment(download.name).send(Buffer.from(download.bytes));
  });
  route('post', '/pages/:pageId/choose-files', async request => {
    const input = object(request.body);
    if (!Array.isArray(input.files) || input.files.some(raw => { const file = object(raw); return typeof file.name !== 'string' || typeof file.data !== 'string'; })) throw new Error('Invalid browser file chooser upload');
    // Browser file selection uses the existing multipart upload parser below;
    // this JSON route is cancellation only, never a base64 file transport.
    if (input.files.length) throw new Error('Use binary Browser file upload');
    await browsers.assertChooser(String(request.params.pageId), text(input.chooserId));
    return presentationOwner(await browsers.owner(String(request.params.pageId))).chooseFiles(String(request.params.pageId), text(input.chooserId), []);
  });
  app.post('/api/browsers/pages/:pageId/upload', rawBody({ type: 'application/x-varin-browser-files', limit: BROWSER_TRANSFER_BYTES + 16 * 1024 + 4 }), async (request, response) => {
    try {
      const bytes: unknown = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.byteLength < 4) throw new Error('A binary browser upload is required');
      const length = bytes.readUInt32BE(0);
      if (!length || length > 16 * 1024 || length + 4 > bytes.byteLength) throw new Error('Invalid browser upload header');
      const input = object(JSON.parse(bytes.subarray(4, 4 + length).toString('utf8')));
      if (!Array.isArray(input.files)) throw new Error('Browser upload requires a file manifest');
      let offset = 4 + length;
      const files = input.files.map(raw => {
        const file = object(raw);
        if (typeof file.byteLength !== 'number' || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || offset + file.byteLength > bytes.byteLength) throw new Error('Browser upload length changed');
        const data = bytes.subarray(offset, offset + file.byteLength); offset += file.byteLength;
        return { name: text(file.name), bytes: data };
      });
      if (offset !== bytes.byteLength) throw new Error('Unexpected browser upload bytes');
      await browsers.assertChooser(String(request.params.pageId), text(input.chooserId));
      await presentationOwner(await browsers.owner(String(request.params.pageId))).chooseFiles(String(request.params.pageId), text(input.chooserId), files);
      response.json({ ok: true });
    } catch (error) { sendError(response, error); }
  });
  route('get', '/pages/:pageId/events', async (request, response) => {
    const pageId = String(request.params.pageId); await browsers.owner(pageId);
    response.setHeader('Content-Type', 'text/event-stream'); response.flushHeaders();
    const stop = browsers.subscribe(event => {
      const id = event.kind === 'page' ? event.page.pageId : event.kind === 'download' ? event.download.pageId : event.pageId;
      if (id !== pageId || response.destroyed) return;
      if (response.writableLength > 1024 * 1024) { response.destroy(); return; }
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    response.once('close', stop);
  });
  route('get', '/pages/:pageId/frames', async (request, response) => {
    const pageId = String(request.params.pageId), streamId = text(request.query.streamId);
    let closed = false; const stopped = { stop: undefined as (() => Promise<void>) | undefined };
    response.once('close', () => { closed = true; void stopped.stop?.().catch(() => {}); });
    // Stream and control requests have independent transport/backpressure.
    // Subscriber loss does not abort its page or the Host's original task.
    let pending: import('@varin/protocol').BrowserFrame | undefined;
    const flush = () => {
      if (closed || response.writableNeedDrain || !pending) return;
      if (!response.headersSent) { response.setHeader('Content-Type', 'application/x-varin-browser-frames'); response.flushHeaders(); }
      const { bytes, ...metadata } = pending; pending = undefined; response.write(encodeBrowserPacket({ kind: 'frame', ...metadata }, bytes));
    };
    response.on('drain', flush);
    const release = await browsers.subscribeFrames(pageId, streamId, frame => { if (!closed) { pending = frame; flush(); } });
    stopped.stop = release;
    if (closed) await release();
    else if (!response.headersSent) { response.setHeader('Content-Type', 'application/x-varin-browser-frames'); response.flushHeaders(); }
  });
}
export function attachBrowserDevices(options: {
  server: Server; browsers: BrowserRegistry;
  authenticate(request: IncomingMessage): Promise<unknown>;
  originAllowed(request: IncomingMessage): boolean | Promise<boolean>;
}) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: browserMediaMaxPayload, perMessageDeflate: false });
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/api\/browsers\/devices\/(control|media)$/u.exec(new URL(request.url ?? '/', 'http://local').pathname);
    if (!match) return;
    void (async () => {
      if (request.headers['x-varin-browser-host'] !== options.browsers.hostId || !await options.originAllowed(request)) throw new Error('Browser Host identity or origin mismatch');
      const principalId = browserPrincipal(await options.authenticate(request));
      const accept = options.browsers.admitSocket(principalId, match[1] as 'control' | 'media', text(request.headers['x-varin-browser-grant']));
      if (socket.destroyed) return;
      sockets.handleUpgrade(request, socket, head, accept);
    })().catch(() => { if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  };
  options.server.on('upgrade', upgrade);
  return { stop() { options.server.off('upgrade', upgrade); options.browsers.stop(); for (const socket of sockets.clients) socket.terminate(); sockets.close(); } };
}
