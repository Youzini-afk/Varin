import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http, { type IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import express from 'express';
import { createClientPairingRuntime } from './pairing.js';
import { createRemoteClientAuthRuntime } from './remote-clients.js';
import { createPrincipalStore } from '../ui-auth/principals.js';
import { registerAuthAndAccessRoutes } from '../platform/core-routes.js';
import { createPublicIngress } from '../platform/public-ingress.js';
import { BROWSER_PAIRING_REDEEM_PATH, browserClientCookieName, browserPairingPage, buildBrowserPairingUrl } from './browser-pairing.js';

const origin = 'https://workspace.example.test';
let uiDataDir: string | undefined;
afterAll(async () => { if (uiDataDir) await fs.rm(uiDataDir, { recursive: true, force: true }); });
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function freePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No test listener address');
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function send(port: number, target: string, options: { method?: string; cookie?: string; body?: unknown; origin?: string | null } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string; json: () => Record<string, unknown> }>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request({ hostname: '127.0.0.1', port, path: target, method: options.method ?? 'GET', headers: {
      Host: new URL(origin).host,
      ...(options.origin === null ? {} : { Origin: options.origin ?? origin }),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fixture(password?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-browser-pairing-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  process.env.VARIN_DATA_DIR = uiDataDir ??= dir;
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  const port = await freePort();
  const serverId = 'stable-test-host';
  const principals = createPrincipalStore(path.join(dir, 'principals.json'));
  const options = { fsPromises: fs, path, crypto, storePath: path.join(dir, 'clients.json'), principals };
  let clients = createRemoteClientAuthRuntime(options);
  let ui = createUiAuth({ ...(password ? { password } : {}), principals, clientAuthController: clients, getServerId: async () => serverId });
  let pairing = createClientPairingRuntime({ crypto, storePath: path.join(dir, 'pairing.json'), principals, remoteClientAuthRuntime: clients });
  let ingress: ReturnType<typeof createPublicIngress>;
  function application() {
    const app = express();
    app.use(express.json());
    registerAuthAndAccessRoutes(app, {
      express, uiAuthController: ui, remoteClientAuthRuntime: clients, clientPairingRuntime: pairing,
      tunnelAuthController: { classifyRequestScope: () => 'tunnel', requireTunnelSession: (_req: express.Request, res: express.Response) => res.sendStatus(401) },
      getServerId: async () => serverId, getExternalAccessOrigin: () => origin,
      readSettingsFromDisk: async () => ({}), normalizeTunnelSessionTtlMs: () => 1000,
    });
    app.get('/api/threads/observe', (_req, res) => { res.type('text/event-stream'); res.write('event: ready\ndata: {}\n\n'); });
    app.get('/api/test-device', async (req, res) => res.json({ auth: await ui.resolveRequestAuth(req) }));
    app.use((error: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode ?? 500).json({ error: error.message }));
    return app;
  }
  function createIngress() {
    ingress = createPublicIngress({ origin, port, onRequest: application(), onUpgrade: (req, socket) => {
      void ui.resolveWebSocketAuthContext(req).then(auth => socket.end(`HTTP/1.1 ${auth ? '101 Switching Protocols' : '401 Unauthorized'}\r\nConnection: close\r\n\r\n`));
    } });
    clients.onClientRevoked(id => ingress.revokeClient(id));
    return ingress;
  }
  await createIngress().listen(); ingress!.setEnabled(true);
  cleanups.push(async () => { ui.dispose(); await ingress.close(); await clients.dispose(); });
  return {
    dir, port, serverId,
    get ui() { return ui; }, get clients() { return clients; }, get pairing() { return pairing; },
    async restart() {
      ui.dispose(); await ingress.close(); await clients.dispose();
      clients = createRemoteClientAuthRuntime(options);
      ui = createUiAuth({ ...(password ? { password } : {}), principals, clientAuthController: clients, getServerId: async () => serverId });
      pairing = createClientPairingRuntime({ crypto, storePath: path.join(dir, 'pairing.json'), principals, remoteClientAuthRuntime: clients });
      await createIngress().listen(); ingress!.setEnabled(true);
    },
  };
}

async function pairBrowser(host: Awaited<ReturnType<typeof fixture>>, expiresAt: string | null = null) {
  const created = await host.pairing.createPairingSession({ allowedClientKinds: ['browser'], clientExpiresAt: expiresAt });
  const result = await send(host.port, BROWSER_PAIRING_REDEEM_PATH, { method: 'POST', body: {
    pairingId: created.pairing.id, secret: created.pairing.secret, clientExpiresAt: null, expiresAt: null,
  } });
  expect(result.status).toBe(200);
  const cookie = result.headers['set-cookie']?.find(value => value.startsWith(browserClientCookieName(host.serverId)))?.split(';')[0];
  if (!cookie) throw new Error('Browser cookie was not issued');
  return { cookie, created, response: result };
}

describe('persistent browser pairing through the public listener', () => {
  it('GET does not consume a fragment link; POST persists one device cookie across restart and revocation invalidates derived grants', async () => {
    const host = await fixture();
    const created = await host.pairing.createPairingSession({ allowedClientKinds: ['browser'], clientExpiresAt: null });
    const url = new URL(buildBrowserPairingUrl(origin, created.pairing));
    expect(url.search).toBe('');
    const page = await send(host.port, url.pathname);
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.text).not.toContain(created.pairing.secret);
    expect(await host.pairing.listPendingSessions()).toHaveLength(1);
    const paired = await pairBrowser(host);
    expect(paired.response.text).not.toContain('varin_client_');
    expect(paired.response.headers['set-cookie']?.[0]).toMatch(/Path=\/; Secure; HttpOnly; SameSite=Strict/);
    expect(paired.response.headers['set-cookie']?.[0]).not.toContain('Domain=');
    expect(paired.response.headers['set-cookie']?.[1]).toContain('varin_ui_session=;');
    const stored = await fs.readFile(path.join(host.dir, 'clients.json'), 'utf8');
    expect(stored).not.toContain(decodeURIComponent(paired.cookie.split('=')[1]!));
    await host.restart();
    const accepted = await send(host.port, '/api/test-device', { cookie: paired.cookie });
    expect(accepted.status).toBe(200);
    const client = (await host.clients.listClients())[0]!;
    expect(accepted.json().auth).toMatchObject({ type: 'client', clientId: client.id, client: { profile: 'full-control' } });
    const grant = await send(host.port, '/auth/url-token', { method: 'POST', cookie: paired.cookie });
    expect(grant.status).toBe(200);
    await host.clients.revokeClient(client.id);
    expect((await send(host.port, '/api/test-device', { cookie: paired.cookie })).status).toBe(401);
    expect((await send(host.port, `/api/threads/observe?varin_url_token=${grant.json().token}`)).status).toBe(401);
    await host.restart();
    expect((await send(host.port, '/api/test-device', { cookie: paired.cookie })).status).toBe(401);
  });

  it('keeps browser lifetime issuer-controlled, honors expiry, and preserves the native bearer-only endpoint', async () => {
    const host = await fixture();
    const now = Date.now();
    const paired = await pairBrowser(host, new Date(now + 60_000).toISOString());
    expect((await host.clients.listClients())[0]?.expiresAt).toBe(new Date(now + 60_000).toISOString());
    expect(paired.response.headers['set-cookie']?.[0]).toMatch(/Max-Age=5[0-9]/);
    expect((await send(host.port, '/api/client-auth/pairing/redeem', { method: 'POST', body: { clientKind: 'browser' } })).status).toBe(400);
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_001);
    expect((await send(host.port, '/api/test-device', { cookie: paired.cookie })).status).toBe(401);
  });

  it('does not transfer an ordinary-listener anonymous URL grant into the dedicated external listener', async () => {
    const host = await fixture();
    let issued: unknown;
    const response = { setHeader: () => {}, status() { return this; }, json(value: unknown) { issued = value; return this; } };
    await host.ui.handleUrlAuthToken({ method: 'POST', headers: {} }, response);
    expect(issued).toMatchObject({ token: expect.any(String) });
    const token = (issued as { token: string }).token;
    const observed = await send(host.port, `/api/threads/observe?varin_url_token=${token}`);
    expect(observed.status).toBe(401);
  });

  it('rejects unpaired access and absent/cross-Origin redemption without consuming the link', async () => {
    const host = await fixture();
    expect((await send(host.port, '/auth/session')).status).toBe(401);
    expect((await send(host.port, '/api/test-device', { cookie: 'varin_ui_session=not-a-device' })).status).toBe(401);
    const created = await host.pairing.createPairingSession({ allowedClientKinds: ['browser'], clientExpiresAt: null });
    for (const otherOrigin of [null, 'https://other.example.test']) {
      expect((await send(host.port, BROWSER_PAIRING_REDEEM_PATH, { method: 'POST', origin: otherOrigin,
        body: { pairingId: created.pairing.id, secret: created.pairing.secret } })).status).toBe(403);
    }
    expect(await host.pairing.listPendingSessions()).toHaveLength(1);
    expect(await host.clients.listClients()).toHaveLength(0);
  });

  it('closes a device observation stream after committed revocation without revoking other devices', async () => {
    const host = await fixture();
    const first = await pairBrowser(host);
    const second = await pairBrowser(host);
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: host.port, path: '/api/threads/observe',
        headers: { Host: new URL(origin).host, Cookie: first.cookie } }, resolve);
      request.on('error', reject);
    });
    stream.resume();
    expect(stream.statusCode).toBe(200);
    const ended = new Promise<void>((resolve, reject) => { stream.once('end', resolve); stream.once('error', reject); });
    const device = (await host.clients.listClients()).find(client => client.pairingId === first.created.pairing.id)!;
    await host.clients.revokeClient(device.id);
    await ended;
    expect((await send(host.port, '/api/test-device', { cookie: second.cookie })).status).toBe(200);
  });

  it('logs out by revoking only the current device and clearing its cookie', async () => {
    const host = await fixture();
    const first = await pairBrowser(host);
    const second = await pairBrowser(host);
    const logout = await send(host.port, '/auth/browser-session', { method: 'DELETE', cookie: first.cookie });
    expect(logout.status).toBe(200);
    expect(logout.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    expect((await send(host.port, '/api/test-device', { cookie: first.cookie })).status).toBe(401);
    expect((await send(host.port, '/api/test-device', { cookie: second.cookie })).status).toBe(200);
  });

  it('selects the device over a prior password session and allows an explicit new password login after revoke', async () => {
    const host = await fixture('test-password');
    const login = await send(host.port, '/auth/session', { method: 'POST', body: { password: 'test-password' } });
    expect(login.status).toBe(200);
    const session = login.headers['set-cookie']?.find(value => value.startsWith('varin_ui_session='))?.split(';')[0];
    const paired = await pairBrowser(host);
    const client = (await host.clients.listClients())[0]!;
    await host.clients.revokeClient(client.id);
    expect((await send(host.port, '/api/test-device', { cookie: `${paired.cookie}; ${session}` })).status).toBe(401);
    const again = await send(host.port, '/auth/session', { method: 'POST', cookie: paired.cookie, body: { password: 'test-password' } });
    expect(again.status).toBe(200);
    expect(again.headers['set-cookie']?.find(value => value.startsWith(browserClientCookieName(host.serverId)))).toContain('Max-Age=0');
  });
});

describe('browser pairing page', () => {
  it('erases the secret before interaction and only sends one same-origin POST after a click', async () => {
    const pairing = { id: 'pair_test', secret: 'one-time-test-secret', expiresAt: '2099-01-01T00:00:00.000Z', fingerprint: 'ABCD-1234' };
    const url = new URL(buildBrowserPairingUrl(origin, pairing));
    const history = { replaceState: vi.fn() };
    const status = { textContent: '' };
    let click: (() => Promise<void>) | undefined;
    const button = { hidden: true, disabled: false, addEventListener: (_event: string, handler: () => Promise<void>) => { click = handler; } };
    const fetch = vi.fn(async () => ({ ok: true }));
    const location = { hash: url.hash, pathname: url.pathname, host: url.host, replace: vi.fn() };
    const code = browserPairingPage.html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    if (!code) throw new Error('No pairing script');
    vm.runInNewContext(code, { location, history, URLSearchParams, TextDecoder, Uint8Array, atob,
      document: { getElementById: (id: string) => id === 'status' ? status : button },
      navigator: { userAgent: 'Test browser', platform: 'Test platform' }, fetch });
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/pair');
    expect(fetch).not.toHaveBeenCalled();
    expect(button.hidden).toBe(false);
    await click!();
    expect(button.disabled).toBe(true);
    expect(fetch).toHaveBeenCalledWith(BROWSER_PAIRING_REDEEM_PATH, expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    expect(location.replace).toHaveBeenCalledWith('/');
  });
});
