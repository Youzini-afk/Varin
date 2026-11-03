import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { attachObservations } from '../observations.js';
import type { createUiAuth } from '../ui-auth/ui-auth.js';
import { clientCors } from './client-cors.js';
import { createRequestSecurityRuntime } from './request-security.js';

const tauriOrigin = 'http://tauri.localhost';
const rejectedOrigins = [
  undefined, 'null', 'https://unrelated.example',
  'http://tauri.localhost:123', 'https://tauri.localhost',
  'http://tauri.localhost.evil.example', 'http://tauri.localhost@evil.example',
  'http://localhost.evil.example:5173', 'http://127.0.0.1.evil.example:5173',
];
let directory: string;
let clientToken: string;
let auth: ReturnType<typeof createUiAuth>;

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-client-cors-'));
  vi.stubEnv('VARIN_DATA_DIR', directory);
  vi.stubEnv('VARIN_JWT_SECRET', 'varin-cors-test-only-signing-key');
  const clients = createRemoteClientAuthRuntime({ fsPromises: fs, crypto, path, storePath: path.join(directory, 'remote-clients.json') });
  clientToken = (await clients.createClient({ clientKind: 'desktop-local', label: 'CORS test client' })).token;
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  auth = createUiAuth({ password: 'test-only-host-password', clientAuthController: clients });
});

afterAll(async () => {
  auth?.dispose();
  vi.unstubAllEnvs();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

// Real Express middleware and Node HTTP request/response objects, with only the
// wire kept in memory. No Host/kernel startup or network listener is required.
async function request(app: express.Express, method: string, headers: Record<string, string>, body?: unknown) {
  const chunks: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
  });
  const req = new IncomingMessage(socket as Socket);
  req.method = method;
  req.url = '/api/cors-test';
  req.headers = { ...headers };
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (bytes) {
    req.headers['content-type'] = 'application/json';
    req.headers['content-length'] = String(bytes.length);
  }
  const res = new ServerResponse(req);
  res.assignSocket(socket as Socket);
  try {
    return await new Promise<{ status: number; headers: ReturnType<typeof res.getHeaders>; body: string }>((resolve, reject) => {
      res.once('error', reject);
      res.once('finish', () => {
        const wire = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.getHeaders(), body: wire.slice(wire.indexOf('\r\n\r\n') + 4) });
      });
      app(req, res);
      if (bytes) req.push(bytes);
      req.complete = true;
      req.push(null);
    });
  } finally {
    req.destroy();
    socket.destroy();
  }
}

function createApp() {
  const app = express();
  const reached = vi.fn();
  app.use(clientCors);
  app.use(express.json());
  app.use(auth.requireAuth);
  app.get('/api/cors-test', (_req, res) => {
    reached();
    res.setHeader('x-next-cursor', 'next-page');
    res.json({ read: true });
  });
  app.post('/api/cors-test', (req, res) => {
    reached();
    res.json({ saved: req.body });
  });
  app.use((_req, res) => { res.status(404).end(); });
  return { app, reached };
}

describe.each(['127.0.0.1:40777', 'remote.example'])('packaged browser HTTP to %s', (host) => {
  it.each([
    tauriOrigin, 'varin-ui://app', 'capacitor://localhost', 'https://localhost',
    'http://localhost', 'http://localhost:5173', 'https://127.0.0.1:5173',
  ])('accepts an unauthenticated browser preflight from %s without running a route', async (origin) => {
    const { app, reached } = createApp();
    const response = await request(app, 'OPTIONS', {
      host, origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization,x-varin-application-token,x-varin-directory,x-varin-directory-encoding',
    });
    expect(response.status).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(String(response.headers['access-control-allow-methods']).split(',')).toContain('POST');
    expect(String(response.headers['access-control-allow-headers']).toLowerCase().split(',')).toEqual(expect.arrayContaining([
      'content-type', 'authorization', 'x-varin-application-token', 'x-varin-directory', 'x-varin-directory-encoding',
    ]));
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(reached).not.toHaveBeenCalled();
  });

  it('preserves authenticated GET/POST CORS with the original bearer credential', async () => {
    const { app, reached } = createApp();
    const headers = { host, origin: tauriOrigin, authorization: `Bearer ${clientToken}` };
    const read = await request(app, 'GET', headers);
    const write = await request(app, 'POST', headers, { value: 'saved by original route' });
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body)).toEqual({ read: true });
    expect(read.headers['x-next-cursor']).toBe('next-page');
    expect(read.headers['access-control-expose-headers']).toBe('x-next-cursor');
    expect(write.status).toBe(200);
    expect(JSON.parse(write.body)).toEqual({ saved: { value: 'saved by original route' } });
    for (const response of [read, write]) {
      expect(response.headers['access-control-allow-origin']).toBe(tauriOrigin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers.vary).toBe('Origin');
    }
    expect(reached).toHaveBeenCalledTimes(2);
  });

  it.each(['GET', 'POST'])('does not turn an allowed origin into authentication for %s', async (method) => {
    const { app, reached } = createApp();
    for (const origin of [tauriOrigin, 'http://localhost:5173']) {
      for (const credential of [undefined, 'Bearer invalid-client']) {
        const response = await request(app, method, { host, origin, ...(credential ? { authorization: credential } : {}) });
        expect(response.status).toBe(401);
        expect(response.headers['access-control-allow-origin']).toBe(origin);
        expect(JSON.parse(response.body)).toEqual({ error: 'UI authentication required', locked: true });
      }
    }
    expect(reached).not.toHaveBeenCalled();
  });

  it.each(rejectedOrigins)('does not grant CORS to %s, even with a valid credential', async (origin) => {
    const { app } = createApp();
    const headers = { host, ...(origin === undefined ? {} : { origin }) };
    const preflight = await request(app, 'OPTIONS', { ...headers, 'access-control-request-method': 'POST' });
    expect(preflight.status).toBe(404);
    const unauthenticated = await request(app, 'GET', headers);
    expect(unauthenticated.status).toBe(401);
    // CORS controls browser access, not bearer validity or non-browser callers.
    const authenticated = await request(app, 'GET', { ...headers, authorization: `Bearer ${clientToken}` });
    expect(authenticated.status).toBe(200);
    for (const response of [preflight, unauthenticated, authenticated]) {
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });
});

async function upgrade(host: string, origin: string | undefined, authenticated: boolean) {
  const server = createServer();
  const security = createRequestSecurityRuntime({ readSettingsFromDisk: async () => ({}) });
  const originAllowed = vi.fn(security.isRequestOriginAllowed);
  const runtime = attachObservations({
    server,
    authenticate: async (req) => Boolean(await auth.resolveWebSocketAuthContext(req)),
    isRequestOriginAllowed: originAllowed,
    rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
  });
  const chunks: Buffer[] = [];
  let onHeaders: (status: number) => void;
  const result = new Promise<number>((resolve) => { onHeaders = resolve; });
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      const wire = Buffer.concat(chunks).toString();
      if (wire.includes('\r\n\r\n')) onHeaders(Number(wire.split(' ')[1]));
      done();
    },
  });
  const req = new IncomingMessage(socket as Socket);
  req.method = 'GET';
  req.url = '/api/varin/observations/ws';
  req.headers = {
    host, ...(origin === undefined ? {} : { origin }),
    ...(authenticated ? { authorization: `Bearer ${clientToken}` } : {}),
    connection: 'Upgrade', upgrade: 'websocket',
    'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
  };
  try {
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    return { status: await result, originChecks: originAllowed.mock.calls.length };
  } finally {
    runtime.stop();
    req.destroy();
    socket.destroy();
  }
}

describe.each(['127.0.0.1:40777', 'remote.example'])('production observation upgrade to %s', (host) => {
  it.each([tauriOrigin, 'varin-ui://app', 'capacitor://localhost', 'https://localhost'])('retains authenticated packaged access from %s', async (origin) => {
    expect(await upgrade(host, origin, true)).toEqual({ status: 101, originChecks: 1 });
  });

  it('retains same-Host browser access', async () => {
    expect(await upgrade(host, `http://${host}`, true)).toEqual({ status: 101, originChecks: 1 });
  });

  it.each([tauriOrigin, 'http://localhost:5173', 'https://unrelated.example'])('requires authentication before checking origin %s', async (origin) => {
    expect(await upgrade(host, origin, false)).toEqual({ status: 401, originChecks: 0 });
  });

  it.each([...rejectedOrigins, 'http://localhost', 'http://localhost:5173'])('rejects authenticated upgrades from %s', async (origin) => {
    expect(await upgrade(host, origin, true)).toEqual({ status: 403, originChecks: 1 });
  });
});
