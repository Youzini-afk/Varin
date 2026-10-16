import { afterEach, expect, test, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { FULL_CONTROL_CAPABILITIES } from '../client-auth/remote-clients.js';
import type { VarinAuthenticatedClient, VarinRequestAuthContext } from '../client-auth/request-context.js';
import { HostSshManager } from './ssh-manager.js';
import { writeHostConnections } from './hosts.js';
import { registerConnectionRoutes } from './connection-routes.js';
import { attachConnectionProxy } from './host-proxy.js';

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const stop of cleanup.reverse()) await stop(); cleanup.length = 0; });
const listen = async (server: Server) => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
};
const fixture = async (requireClientAuth = true) => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-connection-access-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const spawn = vi.fn(() => { throw new Error('Unexpected SSH process'); });
  const ssh = new HostSshManager({ settingsFilePath: join(directory, 'settings.json'), appVersion: 'fixture', emit: () => {}, spawn });
  cleanup.push(() => ssh.shutdownAll());
  const clients = new Map<string, VarinAuthenticatedClient>([
    ['readonly', { id: 'readonly', capabilities: ['instance:read', 'config:read', 'logs:read', 'filesystem:read'] }],
    ['configuration', { id: 'configuration', capabilities: ['instance:*', 'config:*'] }],
    ['full', { id: 'full', capabilities: [...FULL_CONTROL_CAPABILITIES] }],
    ['scoped', { id: 'scoped', capabilities: ['admin'], allowedDirectories: ['/permitted'] }],
    ['admin', { id: 'admin', capabilities: ['admin'] }],
  ]);
  const auth = createUiAuth({ requireClientAuth, clientAuthController: {
    authenticateBearerToken: async token => { const client = clients.get(token); return client ? { ok: true, clientId: client.id, client } : null; },
  } });
  const app = express(); app.use(express.json());
  const resolve: RequestHandler = async (request, response, next) => {
    const context = await auth.resolveAuthContext(request, response);
    if (context) request.varinAuth = context as VarinRequestAuthContext;
    next();
  };
  app.use(resolve);
  app.post('/auth/url-token', auth.handleUrlAuthToken);
  registerConnectionRoutes(app, ssh, auth.requireAuth);
  const server = createServer(app), url = await listen(server);
  const gateway = attachConnectionProxy({ app, server, settings: ssh.settingsStore, requireAuth: auth.requireAuth,
    authenticateUpgrade: request => auth.resolveAuthContext(request, null), originAllowed: () => true });
  cleanup.push(gateway.stop);
  const request = (path: string, token: string, method = 'GET', body?: unknown) => fetch(`${url}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const mint = async (token: string) => {
    const response = await request('/auth/url-token', token, 'POST'); expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  };
  return { app, url, request, mint, ssh, clients, spawn };
};
const wsDenied = (url: string) => new Promise<number>((resolve, reject) => {
  const socket = new WebSocket(url); cleanup.push(() => socket.terminate());
  socket.on('open', () => reject(new Error('Unauthorized peer connection opened')));
  socket.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); socket.terminate(); });
  socket.on('error', () => {});
});

test('actual Host management routes reject read-only, missing-capability and directory-scoped clients before exposing credentials or touching SSH', async () => {
  const f = await fixture();
  await writeHostConnections(f.ssh.settingsStore, { hosts: [{ id: 'peer', label: 'Peer', url: 'https://peer.invalid', clientToken: 'fixture-peer-secret' }], defaultHostId: 'peer' });
  const before = f.ssh.settingsStore.readSync();
  for (const token of ['readonly', 'scoped']) {
    for (const [path, method, body] of [
      ['/hosts', 'GET'], ['/ssh', 'GET'], ['/ssh/import', 'GET'], ['/ssh/status', 'GET'], ['/ssh/peer/logs', 'GET'],
      ['/hosts', 'PUT', { hosts: [], defaultHostId: null }], ['/ssh', 'PUT', { instances: [] }],
      ['/ssh/peer/connect', 'POST'], ['/ssh/peer/disconnect', 'POST'], ['/ssh/peer/logs', 'DELETE'],
      ['/hosts/probe', 'POST', { url: f.url }],
    ] as const) {
      const response = await f.request(`/api/connections${path}`, token, method, body);
      expect(response.status, `${token} ${method} ${path}`).toBe(403);
      expect(await response.text()).not.toContain('fixture-peer-secret');
    }
  }
  const spoofedSession = await fetch(`${f.url}/api/connections/hosts`, { headers: { authorization: 'Bearer readonly', cookie: 'varin_ui_session=not-a-session' } });
  expect(spoofedSession.status).toBe(403);
  expect(f.ssh.settingsStore.readSync()).toEqual(before); expect(f.spawn).not.toHaveBeenCalled();
  expect((await f.request('/api/connections/hosts', 'missing')).status).toBe(401);
  expect((await f.request('/api/connections/ssh/peer/connect', 'configuration', 'POST')).status).toBe(403);
  for (const token of ['full', 'admin', 'configuration']) {
    const response = await f.request('/api/connections/hosts', token);
    expect(response.status).toBe(200); expect((await response.json()).hosts[0].clientToken).toBe('fixture-peer-secret');
  }
  expect((await f.request('/api/connections/hosts', 'full', 'PUT', { hosts: [], defaultHostId: null })).status).toBe(200);
  expect(f.ssh.settingsStore.readSync().desktopHosts).toEqual([]);
});

test('gateway rejects credential delegation over HTTP and real URL-token WebSockets, while full control keeps working and revocation takes effect', async () => {
  const f = await fixture();
  let peerRequests = 0;
  const peerApp = express(); peerApp.use((_request, response) => { peerRequests += 1; response.json({ ok: true }); });
  const peer = createServer(peerApp), peerUrl = await listen(peer);
  const peerWs = new WebSocketServer({ server: peer });
  cleanup.push(() => { for (const client of peerWs.clients) client.terminate(); peerWs.close(); });
  peerWs.on('connection', (socket, request) => { peerRequests += 1; socket.on('message', () => socket.send(JSON.stringify({ credential: request.headers.authorization, url: request.url }))); });
  await writeHostConnections(f.ssh.settingsStore, { hosts: [{ id: 'peer', label: 'Peer', url: peerUrl, clientToken: 'fixture-peer-secret' }], defaultHostId: null });
  const base = '/api/connections/hosts/peer/proxy';
  for (const token of ['readonly', 'configuration', 'scoped']) {
    expect((await f.request(`${base}/api/config/settings`, token)).status).toBe(403);
    expect((await f.request(`${base}/auth/url-token`, token, 'POST')).status).toBe(403);
    const grant = await f.mint(token);
    expect((await fetch(`${f.url}${base}/api/varin/events?varin_url_token=${grant}`)).status).toBe(403);
    expect(await wsDenied(`${f.url.replace('http:', 'ws:')}${base}/api/terminal/ws?varin_url_token=${grant}`)).toBe(403);
  }
  expect(peerRequests).toBe(0);
  const grant = await f.mint('full');
  expect((await fetch(`${f.url}${base}/api/varin/events?varin_url_token=${grant}`)).status).toBe(200);
  expect((await fetch(`${f.url}${base}/api/config/settings?varin_url_token=${grant}`)).status).toBe(401);
  expect(await wsDenied(`${f.url.replace('http:', 'ws:')}${base}/api/not-allowed/ws?varin_url_token=${grant}`)).toBe(401);
  const socket = new WebSocket(`${f.url.replace('http:', 'ws:')}${base}/api/terminal/ws?varin_url_token=${grant}`);
  cleanup.push(() => socket.terminate()); await once(socket, 'open'); socket.send('hello');
  const [data] = await once(socket, 'message');
  expect(JSON.parse(String(data))).toEqual({ credential: 'Bearer fixture-peer-secret', url: '/api/terminal/ws' });
  expect(peerRequests).toBe(2);
  f.clients.set('full', { id: 'full', capabilities: ['config:read'] });
  expect(await wsDenied(`${f.url.replace('http:', 'ws:')}${base}/api/terminal/ws?varin_url_token=${grant}`)).toBe(403);
  f.clients.delete('full');
  expect(await wsDenied(`${f.url.replace('http:', 'ws:')}${base}/api/terminal/ws?varin_url_token=${grant}`)).toBe(401);
  expect(peerRequests).toBe(2);
});


test('local UI-session grants preserve trusted session authority without treating URL tokens as anonymous clients', async () => {
  const f = await fixture(false);
  const peer = createServer(); const peerUrl = await listen(peer);
  const peerWs = new WebSocketServer({ server: peer });
  cleanup.push(() => { for (const client of peerWs.clients) client.terminate(); peerWs.close(); });
  peerWs.on('connection', socket => socket.on('message', () => socket.send('session accepted')));
  await writeHostConnections(f.ssh.settingsStore, { hosts: [{ id: 'peer', label: 'Peer', url: peerUrl }], defaultHostId: null });
  const grant = await f.mint('not-a-client');
  const socket = new WebSocket(`${f.url.replace('http:', 'ws:')}/api/connections/hosts/peer/proxy/api/terminal/ws?varin_url_token=${grant}`);
  cleanup.push(() => socket.terminate()); await once(socket, 'open'); socket.send('hello');
  const [data] = await once(socket, 'message'); expect(String(data)).toBe('session accepted');
});
