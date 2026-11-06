import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import request from 'supertest';
import { createDrainingAdmission, createHttpObservationDrain } from './draining-admission.js';
import { registerServerStatusRoutes } from './platform/core-routes.js';
import { registerExtensionRoutes } from './extensions/routes.js';

describe('draining admission', () => {
  it('withdraws health readiness before cleanup resolves, rejects new work, retains queries and cancellation', async () => {
    const app = express();
    let draining = false;
    const mutation = vi.fn((_req, res) => res.json({ accepted: true }));
    app.use(createDrainingAdmission(() => draining));
    registerServerStatusRoutes(app, {
      express, varinVersion: 'test', runtimeName: 'test',
      getHealthSnapshot: () => ({ ready: !draining, lifecycle: draining ? 'draining' : 'running' }),
      gracefulShutdown: async () => { draining = true; await new Promise(() => {}); },
    });
    app.post('/api/threads/submit', mutation);
    app.post('/api/threads/snapshot', (_req, res) => res.json({ observed: true }));
    app.post('/api/threads/run/cancel', (_req, res) => res.json({ cancellationRequested: true }));
    app.put('/api/config/settings', mutation);
    app.get(['/connect', '/auth/session', '/mobile-login', '/api/push/vapid-public-key', '/api/new-get-with-effects'], mutation);
    app.post('/api/harness/managed-execution/v1/jobs/coordinator/job/kill', (_req, res) => res.json({ stopped: true }));
    expect((await request(app).get('/health')).status).toBe(200);
    await request(app).post('/api/threads/submit').expect(200);
    await request(app).post('/api/system/shutdown').expect(200);
    await request(app).get('/live').expect(200, { status: 'alive' });
    const health = await request(app).get('/health').expect(503);
    expect(health.body).toMatchObject({ ready: false, lifecycle: 'draining', status: 'unavailable' });
    expect((await request(app).post('/api/threads/submit').expect(503)).body).toMatchObject({ code: 'host-draining', admission: 'not_started' });
    await request(app).put('/api/config/settings').expect(503);
    await request(app).post('/api/threads/unknown-future-command').expect(503);
    await request(app).post('/api/threads/snapshot').expect(200, { observed: true });
    await request(app).post('/api/threads/run/cancel').expect(200, { cancellationRequested: true });
    for (const path of ['/connect', '/auth/session', '/mobile-login', '/api/push/vapid-public-key', '/api/new-get-with-effects']) {
      await request(app).get(path).expect(503);
      await request(app).head(path).expect(503);
    }
    await request(app).post('/api/harness/managed-execution/v1/jobs/coordinator/job/kill').expect(200, { stopped: true });
    expect(mutation).toHaveBeenCalledOnce();
  });
});

it('serves liveness without consulting a stuck identity store or unavailable kernel', async () => {
  const app = express();
  const identity = vi.fn(() => new Promise<string | null>(() => {}));
  const kernel = vi.fn(() => { throw new Error('kernel unavailable'); });
  registerServerStatusRoutes(app, { express, varinVersion: 'test', runtimeName: 'test',
    getServerId: identity, getHealthSnapshot: kernel, gracefulShutdown: async () => {} });
  await request(app).get('/live').expect(200, { status: 'alive' });
  expect(identity).not.toHaveBeenCalled(); expect(kernel).not.toHaveBeenCalled();
});

it('reports withdrawn readiness without awaiting a stopping identity store', async () => {
  const app = express();
  const identity = vi.fn(() => new Promise<string | null>(() => {}));
  registerServerStatusRoutes(app, { express, varinVersion: 'test', runtimeName: 'test',
    getServerId: identity, getHealthSnapshot: () => ({ ready: false, lifecycle: 'draining' }), gracefulShutdown: async () => {} });
  expect((await request(app).get('/health').expect(503)).body).toMatchObject({ ready: false, lifecycle: 'draining' });
  expect(identity).not.toHaveBeenCalled();
});

it('retains direct SSE during draining and ends it only at the final observation teardown', async () => {
  const app = express(), observations = createHttpObservationDrain();
  let draining = false;
  app.use(observations.middleware); app.use(createDrainingAdmission(() => draining));
  app.get('/api/notifications/stream', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: ready\n\n'); });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/notifications/stream`;
  try {
    const response = await fetch(endpoint), reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    draining = true;
    let ended = false;
    const end = reader.read().then(result => { ended = result.done === true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(ended).toBe(false);
    observations.close();
    await end; expect(ended).toBe(true);
    expect((await fetch(endpoint)).status).toBe(503);
    await new Promise<void>(resolve => server.close(() => resolve()));
  } finally { observations.close(); server.closeAllConnections(); server.close(); }
});

it('retains an existing Surface lease but rejects fresh leases and authentication crossing drain before provider preparation', async () => {
  const app = express(), observations = createHttpObservationDrain();
  let draining = false, released = false;
  let authEntered!: () => void, finishAuth!: () => void;
  const authenticating = new Promise<void>(resolve => { authEntered = resolve; });
  type Dependencies = Parameters<typeof registerExtensionRoutes>[1];
  const watchServiceLease = vi.fn<NonNullable<Dependencies['extensionRuntime']>['watchServiceLease']>(async (_body, _principal, emit, signal) => {
    emit({ kind: 'ready', leaseId: 'original', routingRevision: 0, providers: [] });
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { released = true; resolve(); }, { once: true }));
  });
  app.use(observations.middleware); app.use(createDrainingAdmission(() => draining)); app.use(express.json());
  registerExtensionRoutes(app, {
    isDraining: () => draining,
    extensionCatalog: {} as Dependencies['extensionCatalog'], extensionPackages: {} as Dependencies['extensionPackages'],
    extensionRuntime: { watchServiceLease } as unknown as NonNullable<Dependencies['extensionRuntime']>,
    uiAuthController: {
      requireAuth: (_req, _res, next) => next(), requireSessionAuth: (_req, _res, next) => next(),
      resolveAuthContext: async req => {
        if (req.headers['x-wait-auth']) { authEntered(); await new Promise<void>(resolve => { finishAuth = resolve; }); }
        return { type: 'session', token: 'test-session' };
      },
    },
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/api/varin/extensions/v1/services/lease`;
  try {
    const response = await fetch(endpoint, { method: 'POST' }), reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const pending = fetch(endpoint, { method: 'POST', headers: { 'x-wait-auth': 'yes' } });
    await authenticating;
    draining = true;
    const denied = await fetch(endpoint, { method: 'POST' });
    expect(denied.status).toBe(503); expect(await denied.json()).toMatchObject({ code: 'host-draining', admission: 'not_started' });
    finishAuth(); expect((await pending).status).toBe(503);
    expect(watchServiceLease).toHaveBeenCalledOnce(); expect(released).toBe(false);
    observations.close();
    expect((await reader.read()).done).toBe(true);
    await vi.waitFor(() => expect(released).toBe(true));
  } finally { finishAuth?.(); observations.close(); server.closeAllConnections(); server.close(); }
});
