import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { createSettingsFileStore } from '@varin/settings-store';
import { expect, it } from 'vitest';
import { createPublicIngress, getExternalIngress } from '../platform/public-ingress.js';
import { EXTERNAL_ACCESS_SETTINGS_KEY, parseExternalAccessConfiguration, readExternalAccessRecord } from './external-access-config.js';
import { registerExternalAccessRoutes } from './external-access-routes.js';
import { createSelfHostedAccess } from './self-hosted-access.js';
import { FrpTunnelError } from './providers/frp.js';

const origin = 'https://varin.example.test';
const responseStatus = (port: number) => new Promise<number | undefined>((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, agent: false, headers: { host: 'varin.example.test' } }, response => {
    response.resume();
    resolve(response.statusCode);
  });
  req.once('error', reject);
  req.end();
});

it('uses the real guarded listener and settings store across enable, restart, and persistent disable', async () => {
  const blocker = createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  const { port } = blocker.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()));
  const directory = await mkdtemp(join(tmpdir(), 'varin-external-access-'));
  const filePath = join(directory, 'settings.json');
  const project = (settings: Record<string, unknown>) => {
    const record = readExternalAccessRecord(settings[EXTERNAL_ACCESS_SETTINGS_KEY]);
    return record ? { revision: record.revision, config: record.configuration, enabled: record.enabled } : { revision: 0, config: null, enabled: false };
  };
  let holder = false;
  const construct = () => {
    const store = createSettingsFileStore({ filePath });
    return createSelfHostedAccess({
      resolveFrpc: async () => { throw new Error('external forwarding must not resolve an frpc component'); },
      createIngress: cfg => createPublicIngress({
        ...cfg,
        onRequest(request, response) {
          expect(getExternalIngress(request)?.origin).toBe(origin);
          response.writeHead(204).end();
        },
        onUpgrade(_req, socket) { socket.destroy(); },
      }),
      read: async () => project(await store.read()),
      compareAndSwap: (expected, next) => store.transact(current => {
        if (project(current).revision !== expected) return { result: false, write: false };
        const { config: configuration, ...intent } = next;
        return { result: true, document: { ...current, [EXTERNAL_ACCESS_SETTINGS_KEY]: { ...intent, configuration } } };
      }),
      reserve: () => {
        expect(holder).toBe(false);
        holder = true;
        return () => { holder = false; };
      },
    });
  };
  const initial = construct();
  const config = parseExternalAccessConfiguration({ name: 'Example', provider: 'external-forwarding', publicOrigin: origin, backend: { host: '127.0.0.1', port } }, 'stable-id');
  try {
    await initial.start();
    await initial.save(config, 0);
    expect(await initial.snapshot()).toMatchObject({ phase: 'disabled', listener: null, entry: { enabled: false, revision: 1 } });
    await expect(initial.enable(0)).rejects.toMatchObject({ code: 'revision_conflict' });
    await initial.enable(1);
    expect(await initial.snapshot()).toMatchObject({ phase: 'enabled', listener: { origin, host: '127.0.0.1', port }, entry: { enabled: true, revision: 2 } });
    expect(await responseStatus(port)).toBe(204);
    await initial.shutdown();
    expect(holder).toBe(false);

    const reopened = construct();
    try {
      await reopened.start();
      expect(await responseStatus(port)).toBe(204);
      await reopened.disable(2);
      expect(await reopened.snapshot()).toMatchObject({ entry: { enabled: false, revision: 3 }, phase: 'disabled', listener: null });
      await expect(responseStatus(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally { await reopened.shutdown(); }

    const disabled = construct();
    try {
      await disabled.start();
      expect(await disabled.snapshot()).toMatchObject({ entry: { enabled: false, revision: 3 }, phase: 'disabled', listener: null });
      expect(holder).toBe(false);
      await disabled.enable(3);
      expect(await responseStatus(port)).toBe(204);
      await disabled.remove(4);
      expect(await disabled.snapshot()).toMatchObject({ settingsRevision: 5, entry: null, phase: 'disabled', listener: null });
      await expect(responseStatus(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      await expect(disabled.enable(4)).rejects.toMatchObject({ code: 'revision_conflict' });
    } finally { await disabled.shutdown(); }
    const afterRemoval = construct();
    try {
      await afterRemoval.start();
      expect(await afterRemoval.snapshot()).toMatchObject({ settingsRevision: 5, entry: null, phase: 'disabled' });
      const app = express();
      registerExternalAccessRoutes(app, {
        json: express.json(), authorize: () => true, snapshot: afterRemoval.snapshot,
        save: afterRemoval.save, remove: afterRemoval.remove,
        actions: { enable: afterRemoval.enable, disable: afterRemoval.disable, retry: afterRemoval.retry },
      });
      const api = supertest(app);
      const created = await api.put('/api/varin/external-access').send({ expectedRevision: null, configuration: config }).expect(200);
      expect(created.body.entry).toMatchObject({ revision: 6, configuration: { provider: 'external-forwarding' } });
      await api.delete('/api/varin/external-access').send({ expectedRevision: 4 }).expect(409);
      await api.delete('/api/varin/external-access').send({ expectedRevision: 6 }).expect(200);
      expect(await afterRemoval.snapshot()).toMatchObject({ settingsRevision: 7, entry: null });
    } finally { await afterRemoval.shutdown(); }
  } finally {
    await initial.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects invalid FRP transport and does not expose credential references in the public projection', async () => {
  const input = {
    name: 'Example', provider: 'frp', publicOrigin: origin, backend: { host: '127.0.0.1', port: 3001 },
    frp: { tokenEnv: 'VARIN_FRP_TOKEN_HOME', proxy: { name: 'varin', remotePort: 7080 },
      server: { address: 'relay.example.test', port: 7000, tls: { caFile: join(tmpdir(), 'ca.pem'), serverName: 'relay.example.test' } } },
  };
  const candidate = parseExternalAccessConfiguration(input, 'existing');
  expect(candidate).toMatchObject({ provider: 'frp' });
  expect(() => parseExternalAccessConfiguration({ ...input, backend: { host: '0.0.0.0', port: 3001 } }, 'existing')).toThrow('loopback');
  expect(() => parseExternalAccessConfiguration({ ...input, frp: { ...input.frp, tokenEnv: 'UNRELATED_SECRET' } }, 'existing')).toThrow('VARIN_FRP_TOKEN');
  const access = createSelfHostedAccess({
    createIngress() { throw new Error('must not start'); },
    read: async () => ({ revision: 1, enabled: false, config: candidate }),
    compareAndSwap: async () => false, reserve() { throw new Error('must not start'); },
  });
  const json = JSON.stringify(await access.snapshot());
  expect(json).toContain('"provider":"frp"');
  expect(json).not.toContain('VARIN_FRP_TOKEN');
  expect(json).not.toContain('ca.pem');
  const local = await access.snapshot(true);
  expect(local.entry?.configuration).toMatchObject({ frp: { tokenEnv: 'VARIN_FRP_TOKEN_HOME', server: { tls: { caFile: expect.stringContaining('ca.pem') } } } });
});

it('guards state changes and treats environment configuration as read only', async () => {
  const app = express();
  let writes = 0;
  const f = async () => { writes++; };
  let checks = 0, installs = 0;
  const component = { state: 'missing', source: null, version: null, managedVersion: '0.65.0', installSupported: true } as const;
  registerExternalAccessRoutes(app, {
    json: express.json(),
    authorize: (req, action) => action === 'read' || req.headers['x-test-owner'] === 'yes',
    includeOperatorDetails: request => request.headers['x-test-owner'] === 'yes',
    snapshot: async (detail) => ({
      source: 'environment', entry: null, phase: 'enabled', listener: null,
      ...(detail ? { error: 'operator diagnostic' } : {}),
    }),
    save: f, actions: { enable: f, disable: f, retry: f },
    checkAccess: async () => { checks++; },
    component: { status: async () => component, install: async () => { installs++; return component; } },
  });
  const api = supertest(app);
  await api.post('/api/varin/external-access/enable').send({ expectedRevision: 1 }).expect(403);
  await api.post('/api/varin/external-access/enable').set('x-test-owner', 'yes').send({ expectedRevision: 1 }).expect(409);
  const ordinary = await api.get('/api/varin/external-access').expect('Cache-Control', 'no-store').expect(200);
  expect(ordinary.body.error).toBeUndefined();
  const operator = await api.get('/api/varin/external-access').set('x-test-owner', 'yes').expect(200);
  expect(operator.body.error).toBe('operator diagnostic');
  await api.post('/api/varin/external-access/check').expect(403);
  await api.post('/api/varin/external-access/check').set('x-test-owner', 'yes').expect(200);
  expect(checks).toBe(1);
  await api.get('/api/varin/external-access/component').expect(403);
  await api.get('/api/varin/external-access/component').set('x-test-owner', 'yes').expect(200, component);
  await api.post('/api/varin/external-access/component/install').expect(403);
  await api.post('/api/varin/external-access/component/install').set('x-test-owner', 'yes').expect(200, component);
  expect(installs).toBe(1);
  expect(writes).toBe(0);
});

it('keeps the FRP backend fenced until provider publish and fences on provider disconnect', async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const config = parseExternalAccessConfiguration({
    name: 'FRP fixture', provider: 'frp', publicOrigin: origin, backend: { host: '127.0.0.1', port },
    frp: { tokenEnv: 'VARIN_FRP_TOKEN', proxy: { name: 'varin', remotePort: 7080 },
      server: { address: 'relay.example.test', port: 7000, tls: { caFile: join(tmpdir(), 'unused-ca.pem'), serverName: 'relay.example.test' } } },
  }, 'fixture');
  let saved = { revision: 1, enabled: false, config };
  let publish: (() => void) | undefined;
  let disconnect: ((failure: FrpTunnelError) => void) | undefined;
  let stops = 0;
  const access = createSelfHostedAccess({
    env: { VARIN_FRPC_PATH: join(tmpdir(), 'unused-frpc') },
    createIngress: cfg => createPublicIngress({
      ...cfg, onRequest(_req, res) { res.writeHead(204).end(); }, onUpgrade(_req, socket) { socket.destroy(); },
    }),
    read: async () => saved,
    compareAndSwap: async (expected, next) => {
      if (saved.revision !== expected || !next.config) return false;
      saved = { ...next, config: next.config };
      return true;
    },
    reserve: () => () => undefined,
    startFrp: async (_configuration, dependencies) => {
      await new Promise<void>((resolve, reject) => {
        publish = resolve;
        const signal = dependencies?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return {
        publicOrigin: origin,
        endpointVerification: 'unverified',
        getState: () => 'published',
        stop: async () => { stops++; },
        onDisconnect: subscriber => { disconnect = subscriber; return () => { disconnect = undefined; }; },
      };
    },
  });
  try {
    await access.start();
    const attempt = access.enable(1);
    await expect.poll(() => typeof publish).toBe('function');
    expect(await responseStatus(port)).toBe(503);
    publish?.();
    await attempt;
    expect(await responseStatus(port)).toBe(204);
    expect(await access.snapshot()).toMatchObject({ source: 'settings', phase: 'connected', listener: { port } });
    disconnect?.(new FrpTunnelError('authentication_failed', 'private upstream details'));
    await expect.poll(async () => (await access.snapshot()).phase).toBe('failed');
    expect(await access.snapshot()).toMatchObject({ listener: null, entry: { enabled: true } });
    expect(await access.snapshot()).not.toMatchObject({ error: expect.stringContaining('private upstream') });
    await expect(responseStatus(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(stops).toBe(1);
  } finally { await access.shutdown(); }
});
