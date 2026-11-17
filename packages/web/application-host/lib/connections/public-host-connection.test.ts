import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { nativeHostRequestInit } from '../../../../electron/runtime-request-headers.js';
import { createClientPairingRuntime } from '../client-auth/pairing.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createPrincipalStore } from '../ui-auth/principals.js';
import { registerAuthAndAccessRoutes, registerServerStatusRoutes } from '../platform/core-routes.js';
import { createPublicIngress } from '../platform/public-ingress.js';
import { createManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import { createManagedRemoteExecutionService } from '../harness/managed-remote-service.js';
import { registerManagedRemoteRoutes } from '../harness/managed-remote-routes.js';
import { createManagedSourceService } from '../harness/managed-source-service.js';

const origin = 'https://work.example.test:8443';
const hostId = 'original-work-host';
const coordinatorHostId = 'coordinator-host';
const base = '/api/harness/managed-execution/v1';
const cleanup: Array<() => Promise<unknown> | void> = [];
let authDataDir: string | undefined;
afterAll(async () => { vi.unstubAllEnvs(); if (authDataDir) await rm(authDataDir, { recursive: true, force: true }); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(password?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'varin-public-host-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const principals = createPrincipalStore(join(directory, 'principals.json'));
  const clients = createRemoteClientAuthRuntime({ crypto, fsPromises: fs, path, storePath: join(directory, 'clients.json'), principals });
  cleanup.push(() => clients.dispose());
  const pairing = createClientPairingRuntime({ crypto, storePath: join(directory, 'pairing.json'), principals, remoteClientAuthRuntime: clients });
  vi.stubEnv('VARIN_DATA_DIR', authDataDir ??= await mkdtemp(join(tmpdir(), 'varin-public-host-auth-')));
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  const ui = createUiAuth({ ...(password ? { password } : {}), principals, clientAuthController: clients, getServerId: async () => hostId });
  cleanup.push(ui.dispose);
  const sourceRequest = vi.fn(async () => ({ tools: [], grantCapabilities: [], clientCapabilities: [], unavailable: [] }));
  const sourceOwner = createManagedSourceService({ hostId,
    kernel: { start: async () => {}, sourceRequest } as never,
    documents: {} as never, validateLiveSource: vi.fn(), prepareSource: vi.fn(),
  });
  const service = createManagedRemoteExecutionService({ hostId, client: {} as never, sourceOwner,
    resources: { getMachine: async () => ({ machineId: 'local', kind: 'local', state: 'available' }) } as never });
  const app = express();
  app.use(express.json());
  registerServerStatusRoutes(app, { express, varinVersion: 'test', runtimeName: 'web', getServerId: async () => hostId,
    getHealthSnapshot: () => ({ ready: true }) });
  registerAuthAndAccessRoutes(app, { express, uiAuthController: ui, clientPairingRuntime: pairing, remoteClientAuthRuntime: clients,
    tunnelAuthController: { classifyRequestScope: () => 'tunnel' }, getServerId: async () => hostId,
    getExternalAccessOrigin: () => origin, readSettingsFromDisk: async () => ({}), normalizeTunnelSessionTtlMs: () => 1000 });
  registerManagedRemoteRoutes(app, { service, requireAuth: ui.requireAuth, resolveAuthContext: ui.resolveAuthContext });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const ingress = createPublicIngress({ origin, port, onRequest: app, onUpgrade: (_req, socket) => socket.destroy() });
  await ingress.listen(); ingress.setEnabled(true);
  cleanup.push(() => ingress.close());
  // The wire adapter stands in only for TLS termination. Requests still cross
  // a real loopback socket and the production guarded listener and auth owners.
  const requests: Array<{ url: string; headers: Headers; redirect: RequestInit['redirect'] }> = [];
  const wire: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== origin) throw new Error('Unexpected remote test destination');
    const headers = new Headers(init.headers); headers.set('Host', url.host);
    requests.push({ url: url.href, headers: new Headers(headers), redirect: init.redirect });
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path: url.pathname + url.search,
        method: init.method ?? 'GET', headers: Object.fromEntries(headers), signal: init.signal ?? undefined,
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('end', () => {
          const responseHeaders = new Headers();
          for (const [name, values] of Object.entries(response.headers)) {
            for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) responseHeaders.append(name, value);
          }
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers: responseHeaders }));
        });
      });
      request.once('error', reject);
      request.end(init.body);
    });
  };
  const request = (path: string, init: RequestInit = {}) => wire(`${origin}${path}`, nativeHostRequestInit(`${origin}${path}`, init));
  const registry = (token: string) => createManagedRemoteTargetRegistry({ coordinatorHostId, kernel: {} as never, resources: {} as never,
    readSettings: async () => ({ desktopHosts: [{ id: 'fixed-work-connection', apiUrl: origin, clientToken: token }] }), fetch: wire });
  return { clients, pairing, ingress, sourceRequest, requests, wire, request, registry };
}

it('uses the fixed guarded origin for original native pairing, identity and managed Source capability requests', async () => {
  const f = await fixture();
  expect(await (await f.request('/health')).json()).toMatchObject({ serverId: hostId, status: 'ok' });
  const pending = await f.pairing.createPairingSession({ allowedClientKinds: ['desktop'] });
  const path = '/api/client-auth/pairing/redeem';
  const redeem = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    pairingId: pending.pairing.id, secret: pending.pairing.secret, clientKind: 'desktop', deviceName: 'Other Varin',
  }) };
  // A native request lacking target Origin used to fail here. Browser requests
  // must still fail, even with a valid pairing secret or device credential.
  expect((await f.wire(`${origin}${path}`, redeem)).status).toBe(403);
  expect((await f.wire(`${origin}${path}`, { ...redeem, headers: { ...redeem.headers, Origin: 'https://foreign.example.test' } })).status).toBe(403);
  expect(await f.pairing.listPendingSessions()).toHaveLength(1);
  const paired = await f.request(path, redeem);
  expect(paired.status).toBe(200);
  const result = await paired.json() as { clientToken: string; client: { id: string; capabilities: string[] }; server: { url: string } };
  expect(result.server.url).toBe(origin);
  expect(paired.headers.get('set-cookie')).toBeNull();
  expect((await f.request(path, redeem)).status).toBe(400);
  const registry = f.registry(result.clientToken);
  const discovered = await registry.sourceTargets();
  expect(discovered.targets).toHaveLength(1);
  const owner = discovered.targets[0]!.resourceOwner;
  expect(owner).toMatchObject({ kind: 'managed_host', hostId, connectionId: 'fixed-work-connection' });
  expect(JSON.stringify(discovered)).not.toContain(result.clientToken);
  const source = await registry.source(owner);
  await source.capabilities({ coordinatorHostId, mode: 'live_root' });
  expect(f.sourceRequest).toHaveBeenCalledWith('source.capabilities', { mode: 'live_root', clientCapabilities: result.client.capabilities }, expect.any(AbortSignal));
  for (const request of f.requests.filter(request => request.url.includes('/managed-execution/'))) {
    expect(request.headers.get('Origin')).toBe(origin);
    expect(request.headers.get('Authorization')).toBe(`Bearer ${result.clientToken}`);
    expect(request.redirect).toBe('error');
  }
  await f.clients.revokeClient(result.client.id);
  expect((await registry.sourceTargets()).targets).toHaveLength(0);
  await expect(source.capabilities({ coordinatorHostId, mode: 'live_root' })).rejects.toThrow();
  f.ingress.setEnabled(false);
  expect((await f.request('/health')).status).toBe(503);
});

it('preserves restricted node permissions and never turns a trusted Origin into authorization', async () => {
  const f = await fixture();
  const readonly = await f.clients.createClient({ label: 'Read-only node', profile: 'read-only', allowedDirectories: ['/original/workspace'] });
  const registry = f.registry(readonly.token);
  const discovered = await registry.sourceTargets();
  expect(discovered.targets).toHaveLength(1);
  const source = await registry.source(discovered.targets[0]!.resourceOwner);
  await source.capabilities({ coordinatorHostId, mode: 'live_root' });
  expect(f.sourceRequest).toHaveBeenCalledWith('source.capabilities', { mode: 'live_root', clientCapabilities: readonly.client.capabilities }, expect.any(AbortSignal));
  const body = JSON.stringify({ coordinatorHostId, command: 'must-not-run', toolCallId: 'test' });
  expect((await f.request(`${base}/shell/exec`, { method: 'POST', headers: { Authorization: `Bearer ${readonly.token}`, 'Content-Type': 'application/json' }, body })).status).toBe(403);
  expect((await f.request(`${base}/identity`)).status).toBe(401);
  const write = { method: 'POST', headers: { Authorization: `Bearer ${readonly.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ coordinatorHostId, mode: 'live_root' }) };
  expect((await f.wire(`${origin}${base}/sources/capabilities`, write)).status).toBe(403);
  expect((await f.wire(`${origin}${base}/sources/capabilities`, { ...write, headers: { ...write.headers, Origin: 'https://foreign.example.test' } })).status).toBe(403);
  expect(f.sourceRequest).toHaveBeenCalledTimes(1);
});


it('keeps native password login on the same guarded address and issues the original desktop credential', async () => {
  const f = await fixture('native-test-password');
  const response = await f.request('/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'native-test-password', issueClientToken: true, clientKind: 'desktop', clientLabel: 'Other Varin' }) });
  expect(response.status).toBe(200);
  const result = await response.json() as { clientToken: string };
  expect(result.clientToken).toMatch(/^varin_client_/);
  const session = await f.request('/auth/session', { headers: { Authorization: `Bearer ${result.clientToken}` } });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ authenticated: true });
  expect((await f.clients.listClients())[0]?.clientKind).toBe('desktop');
});
