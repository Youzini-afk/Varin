import { afterEach, beforeAll, afterAll, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { createPreviewProxyRuntime } from '../preview/proxy-runtime.js';
import { createSettingsFileStore } from '@varin/settings-store';
import { createServerBootstrapRuntime, type ServerBootstrapOptions } from './bootstrap-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes } from './core-routes.js';
import { createDesktopHostSession } from './desktop-host-session.js';
import { createDesktopLocalCredentials } from './desktop-credentials.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createClientPairingRuntime } from '../client-auth/pairing.js';
import { createTunnelAuth } from './tunnel-auth.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createTerminalRuntime } from '../terminal/runtime.js';
import { createDictationRuntime } from '../dictation/runtime.js';
import { attachObservations } from '../observations.js';
import { attachDesktopMedia } from '../computer/desktop-media.js';
import { HostSshManager } from '../connections/ssh-manager.js';
import { registerConnectionRoutes } from '../connections/connection-routes.js';
import { writeHostConnections } from '../connections/hosts.js';
import { registerStorageRoutes } from '../storage/routes.js';
import type { StartWebUiServerOptions } from '../../public-contract.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-managed-auth-'));
const priorDataDir = process.env.VARIN_DATA_DIR;
let createUiAuth: typeof import('../ui-auth/ui-auth.js').createUiAuth;
beforeAll(async () => {
  process.env.VARIN_DATA_DIR = root;
  ({ createUiAuth } = await import('../ui-auth/ui-auth.js'));
});
afterAll(() => {
  if (priorDataDir === undefined) delete process.env.VARIN_DATA_DIR; else process.env.VARIN_DATA_DIR = priorDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const stop of cleanup.splice(0).reverse()) await stop(); });

async function fixture({ managed = true, password = '', apiOnly = false } = {}) {
  const directory = await fsPromises.mkdtemp(path.join(root, 'host-'));
  const settings = createSettingsFileStore({ filePath: path.join(directory, 'settings.json') });
  const clients = createRemoteClientAuthRuntime({ fsPromises, path, crypto, storePath: path.join(directory, 'clients.json') });
  const credentials = createDesktopLocalCredentials({ read: settings.read, update: settings.update, auth: clients });
  const pairing = createClientPairingRuntime({ crypto, storePath: path.join(directory, 'pairing.json'), remoteClientAuthRuntime: clients });
  const app = express(), server = createServer(app);
  let auth!: ReturnType<typeof createUiAuth>;
  const start = async (options: StartWebUiServerOptions) => {
    const bootstrap = createServerBootstrapRuntime({ express, createUiAuth,
      registerAuthAndAccessRoutes, registerCommonRequestMiddleware, registerServerStatusRoutes,
      registerTtsRoutes() {}, registerNotificationRoutes() {}, registerVarinRoutes() {},
    });
    auth = bootstrap.setupBaseRoutes(app, {
      uiPassword: options.uiPassword, requireClientAuth: options.requireClientAuth,
      remoteClientAuthRuntime: clients, clientPairingRuntime: pairing, tunnelAuthController: createTunnelAuth(),
      readSettingsFromDisk: settings.read, normalizeTunnelSessionTtlMs: () => 60_000,
      process, varinVersion: 'test', runtimeName: 'tauri', gracefulShutdown: async () => {},
      getHealthSnapshot: () => ({ apiOnly: options.apiOnly }),
    } as unknown as ServerBootstrapOptions).uiAuthController;
    // These route owners use the production bootstrap's authentication context.
    app.get('/api/config/settings', (_req, res) => res.json({ ok: true }));
    app.post('/api/config/settings', (_req, res) => res.json({ ok: true }));
    return { getPort: () => 43123, isReady: () => true, stop: async () => {},
      getTunnelUrl: () => null, getQuitRiskStatus: async () => ({ scheduledTasks: {}, tunnel: { active: false } }),
      getDesktopLocalCredentials: credentials };
  };
  if (managed) {
    const session = createDesktopHostSession({ start, serverOptions: { apiOnly, uiPassword: password, requireClientAuth: false }, send: async () => {}, exit() {} });
    await session.start(); cleanup.push(session.stop);
  } else await start({ apiOnly, uiPassword: password });
  cleanup.push(auth.dispose);
  const { clientToken } = await credentials();
  const security = createRequestSecurityRuntime({ readSettingsFromDisk: settings.read });
  const http = request(app);
  return { app, server, auth, clients, credentials, clientToken, http, directory, security, settings };
}

for (const apiOnly of [false, true]) {
  it(`managed no-password bootstrap rejects anonymous, invalid and revoked callers (apiOnly=${apiOnly})`, async () => {
    const f = await fixture({ apiOnly });
    expect(f.auth.enabled).toBe(false); expect(f.auth.authenticationRequired).toBe(true);
    for (const verb of ['get', 'post'] as const) {
      await f.http[verb]('/api/config/settings').expect(401);
      await f.http[verb]('/api/config/settings').set('Authorization', 'Bearer invalid').expect(401);
      await f.http[verb]('/api/config/settings').set('Cookie', 'varin_ui_session=forged').expect(401);
      await f.http[verb]('/api/config/settings').set('Authorization', `Bearer ${f.clientToken}`).expect(200);
    }
    await f.http.get('/auth/session').expect(401);
    await f.http.get('/auth/session').set('Authorization', `Bearer ${f.clientToken}`).expect(200, { authenticated: true, disabled: true, scope: 'client' });
    await f.http.post('/auth/url-token').expect(401);
    await f.http.get('/health').expect(200);
    await f.http.get('/api/version').expect(200);
    const client = await f.clients.authenticateBearerToken(f.clientToken);
    await f.clients.revokeClient(client!.clientId);
    await f.http.get('/api/config/settings').set('Authorization', `Bearer ${f.clientToken}`).expect(401);
  });

  it(`ordinary Web remains passwordless, independent of runtime label or apiOnly=${apiOnly}`, async () => {
    const f = await fixture({ managed: false, apiOnly });
    expect(f.auth.enabled).toBe(false); expect(f.auth.authenticationRequired).toBe(false);
    await f.http.get('/api/config/settings').expect(200);
    await f.http.post('/api/config/settings').expect(200);
    await f.http.post('/auth/url-token').expect(200);
  });

  it(`managed password preserves browser login and session-only security operations (apiOnly=${apiOnly})`, async () => {
    const f = await fixture({ apiOnly, password: 'synthetic-test-password' });
    expect(f.auth.enabled).toBe(true); expect(f.auth.authenticationRequired).toBe(true);
    await f.http.get('/api/config/settings').expect(401);
    await f.http.get('/api/config/settings').set('Authorization', `Bearer ${f.clientToken}`).expect(200);
    await f.http.post('/api/auth/reset').set('Authorization', `Bearer ${f.clientToken}`).expect(401);
    await f.http.post('/auth/passkey/register/options').set('Authorization', `Bearer ${f.clientToken}`).expect(401);
    const login = await f.http.post('/auth/session').send({ password: 'synthetic-test-password' }).expect(200);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    await f.http.get('/api/config/settings').set('Cookie', cookie).expect(200);
    await f.http.post('/auth/url-token').set('Cookie', cookie).expect(200);
  });
}

it.each(['custom-local-key', 'desktop-local'])('private retrieval preserves explicit API-issued policy for %s', async dedupeKey => {
  const f = await fixture();
  const policy = { profile: 'client', capabilities: ['ui:access'], allowedDirectories: [] };
  const issued = await f.http.post('/api/client-auth/clients').set('Authorization', `Bearer ${f.clientToken}`)
    .send({ label: 'Explicitly restricted local client', clientKind: 'desktop-local', dedupeKey, ...policy }).expect(201);
  await writeHostConnections(f.settings, { hosts: [], defaultHostId: null, localClientToken: issued.body.token });
  expect(await f.credentials()).toEqual({ clientToken: issued.body.token });
  const current = await f.clients.authenticateBearerToken(issued.body.token);
  expect(current?.client).toMatchObject({ id: issued.body.client.id, createdAt: issued.body.client.createdAt, ...policy });
  expect((await f.settings.read()).desktopLocalClientToken).toBe(issued.body.token);
});

it('ordinary password reissuance still applies the requested policy while preserving its deduped subject', async () => {
  const f = await fixture({ password: 'synthetic-test-password' });
  const login = { password: 'synthetic-test-password', issueClientToken: true, clientKind: 'desktop', dedupeKey: 'ordinary-password-device' };
  const first = await f.http.post('/auth/session').send({ ...login, clientProfile: 'readonly' }).expect(200);
  const second = await f.http.post('/auth/session').send({ ...login, clientProfile: 'full-control' }).expect(200);
  expect(first.body.client.profile).toBe('readonly');
  expect(second.body.client).toMatchObject({ id: first.body.client.id, profile: 'full-control', authMethod: 'password' });
  expect(second.body.client.capabilities).toContain('filesystem:delete');
  expect(await f.clients.authenticateBearerToken(first.body.clientToken)).toBeNull();
  expect((await f.clients.authenticateBearerToken(second.body.clientToken))?.clientId).toBe(first.body.client.id);
  expect((await f.clients.authenticateBearerToken(f.clientToken))?.client.clientKind).toBe('desktop-local');
});

it('the actual private desktop token manages clients, pairing, connections and storage; paired clients do not gain operator authority', async () => {
  const f = await fixture();
  const ssh = new HostSshManager({ settingsFilePath: f.settings.filePath, appVersion: 'test', emit() {}, spawn: () => { throw new Error('Unexpected process dispatch'); } });
  cleanup.push(() => ssh.shutdownAll());
  registerConnectionRoutes(f.app, ssh, f.auth.requireAuth);
  const inventory = vi.fn(async () => ({ canCleanup: true }));
  registerStorageRoutes(f.app, { device: { id: 'test-host' }, inventory } as unknown as Parameters<typeof registerStorageRoutes>[1], f.auth.requireAuth);
  await f.http.post('/api/client-auth/clients').set('Authorization', `Bearer ${f.clientToken}`).send({ label: 'Phone', clientKind: 'mobile' }).expect(201);
  const pair = await f.http.post('/api/client-auth/pairing/sessions').set('Authorization', `Bearer ${f.clientToken}`).send({ label: 'Phone', allowedClientKinds: ['mobile'] }).expect(201);
  for (const clientKind of ['mobile', 'desktop']) {
    await f.http.post('/api/client-auth/pairing/redeem').send({ pairingId: pair.body.pairing.id,
      secret: pair.body.pairing.secret, clientKind, dedupeKey: '  desktop-local  ' }).expect(400);
  }
  // Invalid self-asserted local kind keeps the existing mobile normalization,
  // never the private desktop's operator rights.
  const redeemed = await f.http.post('/api/client-auth/pairing/redeem').send({ pairingId: pair.body.pairing.id, secret: pair.body.pairing.secret, clientKind: 'desktop-local', clientLabel: 'Phone' }).expect(200);
  expect(redeemed.body.client.clientKind).toBe('mobile');
  const paired = redeemed.body.clientToken;
  await f.http.post('/api/client-auth/clients').set('Authorization', `Bearer ${paired}`).send({ label: 'Other' }).expect(403);
  await f.http.post('/api/client-auth/pairing/sessions').set('Authorization', `Bearer ${paired}`).send({}).expect(403);
  await f.http.get('/api/connections/hosts').set('Authorization', `Bearer ${f.clientToken}`).expect(200);
  await f.http.get('/api/connections/hosts').set('Authorization', `Bearer ${paired}`).expect(403);
  await f.http.post('/api/storage/inventory').set('Authorization', `Bearer ${f.clientToken}`).send({ scope: { kind: 'all' } }).expect(200);
  await f.http.post('/api/storage/inventory').set('Authorization', `Bearer ${paired}`).send({ scope: { kind: 'all' } }).expect(403);
  expect(inventory).toHaveBeenCalledTimes(1);
});

const listen = async (server: Server) => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
};
const upgrade = (url: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve, reject) => {
  const socket = new WebSocket(url.replace('http:', 'ws:'), { headers });
  cleanup.push(() => socket.terminate());
  socket.on('error', () => {});
  socket.once('open', () => { socket.close(); resolve(101); });
  socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); socket.terminate(); });
  socket.once('close', code => { if (code !== 1000 && code !== 1006) reject(new Error(`Unexpected close ${code}`)); });
});

it('real terminal, dictation, observation and VNC upgrade handlers require auth and exact accepted origins before admission', async () => {
  const f = await fixture();
  const origin = await listen(f.server);
  const terminal = createTerminalRuntime({ app: f.app, server: f.server, fs, path, uiAuthController: f.auth,
    buildAugmentedPath: () => '', searchPathFor: () => null, isExecutable: () => false,
    isRequestOriginAllowed: f.security.isRequestOriginAllowed, rejectWebSocketUpgrade: f.security.rejectWebSocketUpgrade,
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000 });
  cleanup.push(() => terminal.shutdown());
  const dictation = createDictationRuntime({ app: f.app, server: f.server, express, uiAuthController: f.auth,
    modelsDir: path.join(f.directory, 'models'), isRequestOriginAllowed: f.security.isRequestOriginAllowed, rejectWebSocketUpgrade: f.security.rejectWebSocketUpgrade });
  cleanup.push(dictation.stop);
  const observations = attachObservations({ server: f.server, authenticate: async req => Boolean(await f.auth.resolveWebSocketAuthContext(req)),
    isRequestOriginAllowed: f.security.isRequestOriginAllowed, rejectWebSocketUpgrade: f.security.rejectWebSocketUpgrade });
  cleanup.push(observations.stop);
  const peer = new WebSocketServer({ noServer: true });
  const upstream = createServer(); upstream.on('upgrade', (req, socket, head) => peer.handleUpgrade(req, socket, head, ws => peer.emit('connection', ws, req)));
  const peerOrigin = await listen(upstream);
  cleanup.push(() => { for (const socket of peer.clients) socket.terminate(); peer.close(); });
  const mediaTarget = vi.fn(async () => ({ url: peerOrigin.replace('http:', 'ws:'), headers: {} }));
  const media = attachDesktopMedia({ server: f.server, hostId: 'test-host', computers: { mediaTarget },
    authenticate: async req => Boolean(await f.auth.ensureSessionToken(req, { setHeader() {} })), originAllowed: f.security.isRequestOriginAllowed });
  cleanup.push(media.stop);
  const grant = (await f.http.post('/auth/url-token').set('Authorization', `Bearer ${f.clientToken}`).expect(200)).body.token;
  const routes = ['/api/terminal/ws', '/api/dictation/ws', '/api/varin/observations/ws', '/api/computers/desktops/managed-linux/vnc'];
  for (const route of routes) {
    expect(await upgrade(`${origin}${route}`, { Origin: 'http://tauri.localhost' })).toBe(401);
    expect(await upgrade(`${origin}${route}`, { Origin: 'http://tauri.localhost', Authorization: 'Bearer invalid', Cookie: 'varin_ui_session=forged' })).toBe(401);
    for (const wrongOrigin of [undefined, 'http://tauri.localhost:80', 'https://tauri.localhost', 'http://tauri.localhost.evil']) {
      expect(await upgrade(`${origin}${route}?varin_url_token=${grant}`, wrongOrigin ? { Origin: wrongOrigin } : {})).toBeGreaterThanOrEqual(400);
    }
    expect(await upgrade(`${origin}${route}?varin_url_token=${grant}`, { Origin: 'http://tauri.localhost' })).toBe(101);
  }
  expect(mediaTarget).toHaveBeenCalledTimes(1);
  for (const pathname of ['/api/arbitrary/ws', '/api/computers/desktops/nested/id/vnc', '/api/computers/desktops/id/vnc/']) {
    expect(await f.auth.resolveWebSocketAuthContext({ url: `${pathname}?varin_url_token=${grant}`, method: 'GET', headers: { upgrade: 'websocket' } })).toBeNull();
  }
  expect(await upgrade(`${origin}${routes[3]}?token=${f.clientToken}`, { Origin: 'http://tauri.localhost' })).toBe(401);
  const expiring = (await f.http.post('/auth/url-token').set('Authorization', `Bearer ${f.clientToken}`).expect(200)).body.token;
  const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  for (const route of routes) expect(await upgrade(`${origin}${route}?varin_url_token=${expiring}`, { Origin: 'http://tauri.localhost' })).toBe(401);
  time.mockRestore();
  const client = await f.clients.authenticateBearerToken(f.clientToken);
  await f.clients.revokeClient(client!.clientId);
  for (const route of routes) expect(await upgrade(`${origin}${route}?varin_url_token=${grant}`, { Origin: 'http://tauri.localhost' })).toBe(401);
  expect(mediaTarget).toHaveBeenCalledTimes(1);
});


it('preview creation requires managed auth while preview HTTP and HMR retain their separate target capability and TTL', async () => {
  const f = await fixture();
  const upstream = createServer((_req, res) => res.end('preview-content'));
  const peer = new WebSocketServer({ server: upstream });
  const peerOrigin = await listen(upstream);
  cleanup.push(() => { for (const socket of peer.clients) socket.terminate(); peer.close(); });
  const preview = createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware, responseInterceptor });
  preview.attach(f.app, { server: f.server, express, uiAuthController: f.auth,
    isRequestOriginAllowed: f.security.isRequestOriginAllowed, rejectWebSocketUpgrade: f.security.rejectWebSocketUpgrade });
  const origin = await listen(f.server);
  await f.http.post('/api/preview/targets').send({ url: peerOrigin }).expect(401);
  await f.http.post('/api/preview/targets').set('Authorization', `Bearer ${f.clientToken}`).send({ url: peerOrigin }).expect(403);
  const target = (await f.http.post('/api/preview/targets').set('Authorization', `Bearer ${f.clientToken}`)
    .set('Origin', 'http://tauri.localhost').send({ url: peerOrigin, ttlMs: 180_000 }).expect(200)).body;
  const url = `/api/preview/proxy/${target.id}/?varin_preview_token=${target.previewToken}`;
  await f.http.get(url).expect(200, 'preview-content');
  await f.http.get(`/api/preview/proxy/${target.id}/?varin_preview_token=invalid`).set('Authorization', `Bearer ${f.clientToken}`).expect(403);
  await f.http.get(`/api/preview/proxy/${target.id}/`).set('Authorization', `Bearer ${f.clientToken}`).expect(403);
  expect(await upgrade(`${origin}${url}`, { Origin: 'http://tauri.localhost.evil' })).toBe(403);
  const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  await f.http.get(url).expect(200, 'preview-content');
  expect(await upgrade(`${origin}${url}`, { Origin: 'http://tauri.localhost' })).toBe(101);
  time.mockReturnValue(target.expiresAt + 1);
  await f.http.get(url).expect(404);
  time.mockRestore();
});
