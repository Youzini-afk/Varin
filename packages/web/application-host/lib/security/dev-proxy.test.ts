import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http, { type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile, type ProxyOptions } from 'vite';
import { WebSocket } from 'ws';
import type { ObservationServerMessage } from '@varin/application-client';
import { attachObservations } from '../observations.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from './request-security.js';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function startProxy() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-dev-proxy-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const auth = createUiAuth({
    password: '', requireClientAuth: true,
    principals: { ownerId: async () => 'owner', resolve: async () => 'owner', isOwner: async () => true },
    clientAuthController: { authenticateBearerToken: async token => token === 'viewer'
      ? { ok: true, clientId: 'device', principalId: 'owner' } : null },
  });
  const app = express();
  const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  app.use((req, _res, next) => { seen.push({ path: req.path, headers: req.headers }); next(); });
  app.get('/health', (_req, res) => res.json({ ready: true }));
  app.get('/auth/session', (req, res) => {
    res.setHeader('Set-Cookie', 'proxy-fixture=value; HttpOnly; Path=/');
    return auth.handleSessionStatus(req, res);
  });
  app.use(auth.requireAuth);
  app.get('/api/threads/observe', (req, res) => res.json(req.headers));
  const backend = http.createServer(app);
  const security = createRequestSecurityRuntime({ readSettingsFromDisk: async () => ({}) });
  const observations = attachObservations({
    server: backend,
    authenticate: async request => Boolean(await auth.resolveWebSocketAuthContext(request)),
    isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
  });
  cleanup.push(async () => {
    observations.stop(); auth.dispose?.(); backend.closeAllConnections();
    await new Promise<void>(resolve => backend.close(() => resolve()));
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  if (!address || typeof address === 'string') throw new Error('Missing Host address');
  const target = `http://127.0.0.1:${address.port}`;
  // Load the shipped config, replacing only the listener target. No copied
  // proxy flags: a config regression must fail a real upgrade through Vite.
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' },
    fileURLToPath(new URL('../../../vite.config.ts', import.meta.url)));
  const proxy = Object.fromEntries(Object.entries(loaded?.config.server?.proxy ?? {}).map(([route, options]) => {
    if (typeof options === 'string') throw new Error('Expected explicit development proxy options');
    return [route, { ...options, target } satisfies ProxyOptions];
  }));
  const vite = await createServer({
    configFile: false, root, publicDir: false, appType: 'custom', logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy, allowedHosts: ['varin.example.test'] },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  cleanup.push(() => vite.close());
  await vite.listen();
  const listener = vite.httpServer?.address();
  if (!listener || typeof listener === 'string') throw new Error('Missing Vite address');
  const origin = `http://127.0.0.1:${listener.port}`;

  async function connect(headers: Record<string, string>) {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/varin/observations/ws`, { headers });
    cleanup.push(() => { socket.terminate(); });
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('open', () => resolve(101));
      socket.once('error', reject);
      socket.once('unexpected-response', (_request, response) => {
        response.resume(); resolve(response.statusCode ?? 0);
      });
    });
    return { socket, status };
  }
  async function request(route: string, headers: Record<string, string>) {
    return await new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http.get(`${origin}${route}`, { headers }, response => {
        let body = '';
        response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
        response.on('error', reject);
      }).on('error', reject);
    });
  }
  return { origin, port: listener.port, seen, connect, request };
}

async function observe(socket: WebSocket): Promise<IncomingHttpHeaders> {
  return await new Promise((resolve, reject) => {
    let body = '';
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()) as ObservationServerMessage;
      if (message.type === 'headers') {
        if (message.status !== 200) { reject(new Error(`Observation status ${message.status}`)); return; }
      } else if (message.type === 'data') body += Buffer.from(message.data, 'base64').toString();
      else if (message.type === 'end') { resolve(JSON.parse(body)); return; }
      else { reject(new Error(message.message)); return; }
      socket.send(JSON.stringify({ type: 'pull', id: 1 }));
    });
    socket.once('error', reject);
    socket.send(JSON.stringify({ type: 'open', id: 1, method: 'GET', path: '/api/threads/observe', headers: {} }));
  });
}

const authenticated = { Authorization: 'Bearer viewer', Cookie: 'client-preference=value' };
const forwarded = {
  Host: 'varin.example.test:8443', Origin: 'https://varin.example.test:8443',
  'X-Forwarded-Host': 'varin.example.test:8443', 'X-Forwarded-Proto': 'https',
};

describe('development proxy browser authority', () => {
  it('preserves HTTP authority, credentials and response cookies on all proxy routes', async () => {
    const proxy = await startProxy();
    for (const authority of [{ Host: `localhost:${proxy.port}`, Origin: `http://localhost:${proxy.port}` }, forwarded]) {
      const headers = { ...authenticated, ...authority };
      for (const route of ['/auth/session', '/health', '/api/threads/observe']) {
        const response = await proxy.request(route, headers);
        expect(response.status).toBe(200);
        expect(proxy.seen.at(-1)).toMatchObject({ path: route, headers: Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
        ) });
        if (route === '/auth/session') {
          expect(JSON.parse(response.body)).toMatchObject({ authenticated: true });
          expect(response.headers['set-cookie']).toEqual(['proxy-fixture=value; HttpOnly; Path=/']);
        }
      }
    }
  });

  it('keeps localhost and loopback UI ports through authenticated WebSocket observations', async () => {
    const proxy = await startProxy();
    for (const hostname of ['localhost', '127.0.0.1']) {
      const origin = `http://${hostname}:${proxy.port}`;
      const client = await proxy.connect({ ...authenticated, Host: `${hostname}:${proxy.port}`, Origin: origin });
      expect(client.status).toBe(101);
      expect(await observe(client.socket)).toMatchObject({ host: `${hostname}:${proxy.port}`, origin,
        authorization: authenticated.Authorization, cookie: authenticated.Cookie });
      client.socket.close();
    }
  });

  it('keeps TLS-terminated forwarded authority and multi-proxy chains during observations', async () => {
    const proxy = await startProxy();
    for (const headers of [forwarded, { ...forwarded, Host: `127.0.0.1:${proxy.port}`,
      'X-Forwarded-Host': `${forwarded['X-Forwarded-Host']}, internal-proxy`, 'X-Forwarded-Proto': 'https, http' }]) {
      const client = await proxy.connect({ ...authenticated, ...headers });
      expect(client.status).toBe(101);
      expect(await observe(client.socket)).toMatchObject({ host: headers.Host, origin: headers.Origin,
        'x-forwarded-host': headers['X-Forwarded-Host'], 'x-forwarded-proto': headers['X-Forwarded-Proto'] });
      client.socket.close();
    }
  });

  it('does not turn missing, foreign or mismatched origins into trusted requests or bypass auth', async () => {
    const proxy = await startProxy();
    for (const headers of [
      { ...authenticated },
      { ...authenticated, Origin: 'null' },
      { ...authenticated, Origin: 'https://other.example.test' },
      { ...authenticated, ...forwarded, Origin: 'https://other.example.test' },
      { ...authenticated, ...forwarded, 'X-Forwarded-Host': 'other.example.test' },
      { ...authenticated, Host: forwarded.Host, Origin: forwarded.Origin },
    ]) expect((await proxy.connect(headers)).status).toBe(403);
    expect((await proxy.connect({ Origin: proxy.origin })).status).toBe(401);
    expect((await proxy.connect({ ...forwarded, Authorization: 'Bearer wrong' })).status).toBe(401);
  });
});
