import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import {
  clearRuntimeAuthCredentialProvider, configureRuntimeUrlResolver, runtimeFetch,
  setRuntimeBearerToken, setRuntimeExtraHeaders, setRuntimeUrlAuthToken,
  type ObservationServerMessage,
} from '@varin/application-client';
import { attachObservations } from './observations.js';
import { createUiAuth } from './ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from './security/request-security.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
});

const startHost = async (route: (req: express.Request, res: express.Response) => void, bindAddress = '127.0.0.1') => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  const auth = createUiAuth({
    password: '', requireClientAuth: true,
    clientAuthController: { authenticateBearerToken: async (token) => token === 'viewer' ? { ok: true, clientId: 'device' } : null },
  });
  app.post('/auth/url-token', (req, res) => auth.handleUrlAuthToken(req, res));
  app.use(auth.requireAuth);
  app.use(route);
  const server = http.createServer(app);
  const security = createRequestSecurityRuntime({ readSettingsFromDisk: async () => ({}) });
  const runtime = attachObservations({
    server,
    authenticate: async (request) => Boolean(await auth.resolveWebSocketAuthContext(request)),
    isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
  });
  await new Promise<void>((resolve) => server.listen(0, bindAddress, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  const origin = `http://${bindAddress}:${address.port}`;
  cleanup.push(async () => {
    runtime.stop(); auth.dispose?.(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { origin, runtime };
};

const connect = async (origin: string, headers: Record<string, string> = {}, query = '') => {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/varin/observations/ws${query}`, {
    headers: { Origin: origin, Authorization: 'Bearer viewer', ...headers },
  });
  cleanup.push(() => { socket.terminate(); });
  const received: ObservationServerMessage[] = [];
  const queued: ObservationServerMessage[] = [];
  const listeners = new Set<() => void>();
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as ObservationServerMessage;
    received.push(message); queued.push(message);
    for (const listener of listeners) listener();
  });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const next = (id: number, type?: ObservationServerMessage['type']): Promise<ObservationServerMessage> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing ${type ?? 'message'} for channel ${id}`)); }, 2500);
    const check = () => {
      const index = queued.findIndex((item) => item.id === id && (!type || item.type === type));
      if (index < 0) return;
      const item = queued.splice(index, 1)[0]!;
      listeners.delete(check); clearTimeout(timer); resolve(item);
    };
    listeners.add(check); check();
  });
  const send = (message: unknown) => socket.send(JSON.stringify(message));
  const open = (id: number, path = '/api/threads/observe', extra: Record<string, unknown> = {}) => {
    send({ type: 'open', id, path, method: 'GET', headers: { accept: 'text/event-stream' }, ...extra });
  };
  const body = async (id: number) => {
    let text = '';
    for (;;) {
      send({ type: 'pull', id });
      const item = await next(id);
      if (item.type === 'end') return text;
      if (item.type !== 'data') throw new Error(`Unexpected ${item.type}`);
      text += Buffer.from(item.data, 'base64').toString();
    }
  };
  return { socket, received, next, send, open, body };
};

describe('same-Host observation transport', () => {
  it('uses a specifically bound listener address instead of assuming the default loopback address', async () => {
    const host = await startHost((req, res) => {
      expect(req.socket.localAddress).toBe('127.0.0.2');
      res.end('same listener');
    }, '127.0.0.2');
    const client = await connect(host.origin);
    client.open(1);
    expect(await client.next(1, 'headers')).toMatchObject({ status: 200 });
    expect(await client.body(1)).toBe('same listener');
  });

  it('multiplexes real HTTP streams, isolates cancellation, and releases every remaining observer on socket close', async () => {
    const active = new Map<string, express.Response>();
    const closed: string[] = [];
    const host = await startHost((req, res) => {
      const id = String(req.query.channel);
      active.set(id, res);
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${id}\n\n`);
      res.once('close', () => { active.delete(id); closed.push(id); });
    });
    const client = await connect(host.origin);
    for (let id = 1; id <= 8; id += 1) client.open(id, `/api/threads/observe?channel=${id}&cursor=42`);
    for (let id = 1; id <= 8; id += 1) expect(await client.next(id, 'headers')).toMatchObject({ status: 200 });
    expect(active.size).toBe(8);
    expect(client.received.some((item) => item.type === 'data')).toBe(false);
    client.send({ type: 'pull', id: 1 });
    expect(await client.next(1, 'data')).toMatchObject({ data: Buffer.from('data: 1\n\n').toString('base64') });
    client.send({ type: 'cancel', id: 1 });
    await expect.poll(() => closed).toEqual(['1']);
    client.send({ type: 'pull', id: 2 });
    expect(await client.next(2, 'data')).toMatchObject({ data: Buffer.from('data: 2\n\n').toString('base64') });
    expect(active.size).toBe(7);
    client.socket.close();
    await expect.poll(() => active.size).toBe(0);
  });

  it('keeps POST long-poll bodies, HTTP failures, decoded bytes and redirects at their original route', async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const host = await startHost((req, res) => {
      requests.push({ method: req.method, url: req.url, body: req.body });
      if (req.query.redirect) { res.redirect(307, '/api/config/settings'); return; }
      const body = JSON.stringify({ error: { code: 'stale_revision' }, request: req.body });
      res.status(409).set({
        'Content-Type': 'application/json', 'Content-Encoding': 'gzip',
        'Set-Cookie': 'private=value; HttpOnly', 'X-Next-Cursor': 'cursor-9',
      }).end(gzipSync(body));
    });
    const client = await connect(host.origin);
    client.open(1, '/api/varin/extensions/v1/host-state/wait?cursor=9', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"revision":9}',
    });
    const headers = await client.next(1, 'headers');
    expect(headers).toMatchObject({ status: 409, headers: { 'x-next-cursor': 'cursor-9' } });
    if (headers.type !== 'headers') throw new Error('Expected headers');
    expect(headers.headers).not.toHaveProperty('set-cookie');
    expect(headers.headers).not.toHaveProperty('content-encoding');
    expect(headers.headers).not.toHaveProperty('content-length');
    expect(JSON.parse(await client.body(1))).toEqual({ error: { code: 'stale_revision' }, request: { revision: 9 } });
    client.open(2, '/api/threads/observe?redirect=1');
    expect(await client.next(2, 'headers')).toMatchObject({ status: 307, headers: { location: '/api/config/settings' } });
    await client.body(2);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({ method: 'POST', url: '/api/varin/extensions/v1/host-state/wait?cursor=9', body: { revision: 9 } });
  });

  it('rejects untrusted origins and unauthenticated upgrades before opening any route', async () => {
    const route = vi.fn((_req, res) => res.end());
    const host = await startHost(route);
    for (const [headers, expected] of [
      [{ Origin: host.origin }, 401],
      [{ Origin: 'https://untrusted.example', Authorization: 'Bearer viewer' }, 403],
    ] as const) {
      const socket = new WebSocket(`${host.origin.replace('http:', 'ws:')}/api/varin/observations/ws`, { headers });
      socket.on('error', () => {});
      const status = await new Promise<number | undefined>((resolve, reject) => {
        socket.once('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); });
        socket.once('open', () => reject(new Error('Unexpected accepted upgrade')));
      });
      socket.terminate();
      expect(status).toBe(expected);
    }
    expect(route).not.toHaveBeenCalled();
  });

  it('rejects write paths, cross-Host targets, recursion and frame-injected transport headers', async () => {
    const route = vi.fn((_req, res) => res.end());
    const host = await startHost(route);
    const client = await connect(host.origin);
    const invalid = [
      { path: '/api/config/settings' }, { path: '/api/varin/observations/ws' },
      { path: 'http://outside.example/api/threads/observe' }, { path: '//outside.example/api/threads/observe' },
      { path: '/api/threads/observe', method: 'POST' },
      ...['host', 'cookie', 'connection', 'origin', 'x-forwarded-host', 'x-forwarded-for'].map((header) => ({ headers: { [header]: 'injected' } })),
    ];
    for (const [index, extra] of invalid.entries()) {
      client.open(index + 1, '/api/threads/observe', extra);
      expect(await client.next(index + 1, 'error')).toMatchObject({ message: 'Observation request is not allowed' });
    }
    expect(route).not.toHaveBeenCalled();
  });

  it('retains the original Host/proxy scope and audits while authenticating each channel at the real route', async () => {
    const requests: Array<{ hostname: string; ip: string | undefined; cookie: string | undefined }> = [];
    const host = await startHost((req, res) => {
      requests.push({ hostname: req.hostname, ip: req.ip, cookie: req.headers.cookie });
      if (req.hostname === 'remote.example') { res.status(401).json({ error: 'Tunnel authentication required' }); return; }
      res.end('unexpected local authority');
    });
    const client = await connect(host.origin, {
      Host: 'remote.example', Origin: 'https://remote.example', 'X-Forwarded-Proto': 'https',
      'X-Forwarded-For': '192.0.2.12', Cookie: 'original=value',
    });
    client.open(1);
    expect(await client.next(1, 'headers')).toMatchObject({ status: 401 });
    expect(await client.body(1)).toContain('Tunnel authentication required');
    expect(requests).toEqual([{ hostname: 'remote.example', ip: '192.0.2.12', cookie: 'original=value' }]);
    client.open(2, '/api/threads/observe', { headers: { authorization: 'Bearer revoked' } });
    expect(await client.next(2, 'headers')).toMatchObject({ status: 401 });
    await client.body(2);
    expect(requests).toHaveLength(1);
  });

  it('does not turn a handshake URL token into wider route authority', async () => {
    const route = vi.fn((_req, res) => res.end('observed'));
    const host = await startHost(route);
    const minted = await fetch(`${host.origin}/auth/url-token`, { method: 'POST', headers: { Authorization: 'Bearer viewer' } });
    const { token } = await minted.json() as { token: string };
    const client = await connect(host.origin, { Authorization: '' }, `?varin_url_token=${encodeURIComponent(token)}`);
    client.open(1);
    expect(await client.next(1, 'headers')).toMatchObject({ status: 200 });
    expect(await client.body(1)).toBe('observed');
    client.open(2, '/api/documents/watch');
    expect(await client.next(2, 'headers')).toMatchObject({ status: 401 });
    await client.body(2);
    expect(route).toHaveBeenCalledTimes(1);
    client.open(3, '/api/threads/observe', { headers: { authorization: 'Bearer revoked' } });
    expect(await client.next(3, 'headers')).toMatchObject({ status: 401 });
    await client.body(3);
    client.open(4, '/api/threads/observe?varin_url_token=revoked');
    expect(await client.next(4, 'headers')).toMatchObject({ status: 401 });
    await client.body(4);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('disposes pending leases and does not replay duplicate opens or upstream failures', async () => {
    const requests: IncomingMessage[] = [];
    const responses: ServerResponse[] = [];
    const host = await startHost((req, res) => {
      requests.push(req); responses.push(res);
      res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders();
    });
    const client = await connect(host.origin);
    client.open(1, '/api/varin/extensions/v1/services/lease', { method: 'POST', body: '{}' });
    await client.next(1, 'headers');
    client.send({ type: 'pull', id: 1 });
    responses[0]!.destroy();
    expect(await client.next(1, 'error')).toMatchObject({ message: 'Observation response interrupted' });
    client.open(2, '/api/varin/extensions/v1/services/lease', { method: 'POST', body: '{}' });
    await client.next(2, 'headers');
    client.open(2);
    await expect.poll(() => client.socket.readyState).toBe(WebSocket.CLOSED);
    await expect.poll(() => responses.every((res) => res.destroyed)).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it('waits for pull credits and the socket send callback before reading another body chunk', async () => {
    const host = await startHost((_req, res) => res.end());
    let reads = 0;
    let finishWrite: (() => void) | undefined;
    const originalSend = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, ...args: Parameters<WebSocket['send']>) {
      const [data, options, callback] = args;
      const done = typeof options === 'function' ? options : callback;
      if (typeof data === 'string' && JSON.parse(data).type === 'data') {
        finishWrite = () => done?.();
        return originalSend.call(this, data, {});
      }
      return originalSend.apply(this, args);
    });
    vi.spyOn(Readable, 'toWeb').mockReturnValue(new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1; controller.enqueue(Buffer.from(String(reads))); },
    }, { highWaterMark: 0 }));
    const client = await connect(host.origin);
    client.open(1);
    await client.next(1, 'headers');
    expect(reads).toBe(0);
    client.send({ type: 'pull', id: 1 }); client.send({ type: 'pull', id: 1 });
    await client.next(1, 'data');
    expect(reads).toBe(1);
    finishWrite?.();
    await client.next(1, 'data');
    expect(reads).toBe(2);
    finishWrite?.();
    client.send({ type: 'cancel', id: 1 });
  });

  it('aborts a pending long poll before headers when the adapter stops', async () => {
    let waiting = 0;
    const host = await startHost((_req, res) => {
      waiting += 1;
      res.once('close', () => { waiting -= 1; });
    });
    const client = await connect(host.origin);
    client.open(1, '/api/varin/extensions/v1/host-state/wait', { method: 'POST', body: '{}' });
    await expect.poll(() => waiting).toBe(1);
    host.runtime.stop();
    await expect.poll(() => waiting).toBe(0);
    await expect.poll(() => client.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('runs the real application-client fetch decoder and cancellation through one authenticated socket', async () => {
    let observers = 0;
    const host = await startHost((req, res) => {
      expect(req.headers['cf-access-client-secret']).toBeUndefined();
      expect(req.headers['x-varin-application-token']).toBeUndefined();
      if (req.path === '/api/varin/extensions/v1/host-state/wait') {
        res.status(409).json({ error: { code: 'stale_revision' }, revision: req.body.revision });
        return;
      }
      observers += 1;
      res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders();
      res.once('close', () => { observers -= 1; });
    });
    const minted = await fetch(`${host.origin}/auth/url-token`, { method: 'POST', headers: { Authorization: 'Bearer viewer' } });
    const { token, expiresAt } = await minted.json() as { token: string; expiresAt: number };
    const sockets: WebSocket[] = [];
    vi.stubGlobal('window', { location: { origin: host.origin, href: `${host.origin}/` } });
    vi.stubGlobal('WebSocket', class extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { Origin: host.origin } });
        sockets.push(this);
      }
    });
    configureRuntimeUrlResolver({ apiBaseUrl: host.origin });
    setRuntimeBearerToken('viewer');
    setRuntimeUrlAuthToken(token, expiresAt);
    setRuntimeExtraHeaders({ 'CF-Access-Client-Secret': 'gateway-only' });
    cleanup.push(() => {
      for (const socket of sockets) socket.terminate();
      setRuntimeExtraHeaders(null); clearRuntimeAuthCredentialProvider(); configureRuntimeUrlResolver({});
    });
    const streams = await Promise.all(Array.from({ length: 8 }, () => runtimeFetch('/api/threads/observe')));
    expect(sockets).toHaveLength(1);
    expect(observers).toBe(8);
    const failed = await runtimeFetch('/api/varin/extensions/v1/host-state/wait', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"revision":17}',
    });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toEqual({ error: { code: 'stale_revision' }, revision: 17 });
    await streams[0]!.body?.cancel();
    await expect.poll(() => observers).toBe(7);
    await Promise.all(streams.slice(1).map((response) => response.body?.cancel()));
    await expect.poll(() => observers).toBe(0);
    expect(sockets).toHaveLength(1);
  });
});
