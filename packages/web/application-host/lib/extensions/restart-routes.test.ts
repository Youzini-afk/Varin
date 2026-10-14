import { afterEach, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { registerExtensionRoutes } from './routes.js';
import { routerTransport } from './direct-router.test-helper.js';

const roots: string[] = [];
const runtimes: ApplicationExtensionRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.stop())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('authenticated restart route persists first, deduplicates response retries, and records an actual restart-owner failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-restart-route-')); roots.push(root);
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), brokerScript: 'unused', varinVersion: '1.2.3' }); runtimes.push(runtime);
  const id = 'test.route.native';
  for (const version of ['1.0.0', '2.0.0']) {
    const directory = join(root, version); await mkdir(directory);
    await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version, engines: { varin: '*' },
      entrypoints: { host: { file: 'host.cjs', mode: 'native', activation: ['service-request'] } } }));
    await writeFile(join(directory, 'host.cjs'), 'module.exports={activate(){}};');
    await runtime.installOrStage({ source: { kind: 'local', display: 'Route fixture', specifier: directory }, expectedRevision: (await runtime.catalog.snapshot()).revision });
  }
  const catalog = await runtime.catalog.snapshot();
  const body = { extensionId: id, handoffId: 'route-original-attempt', candidateIntegrity: catalog.extensions[0]!.candidate!.integrity, expectedRevision: catalog.revision };
  let calls = 0, finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const router = express.Router();
  const auth: Parameters<typeof registerExtensionRoutes>[1]['uiAuthController']['requireAuth'] = (req, res, next) => req.headers['x-test-auth'] === 'yes' ? next() : res.status(401).json({ error: 'auth' });
  registerExtensionRoutes(router as unknown as Express, { extensionRuntime: runtime, extensionCatalog: runtime.catalog, extensionPackages: runtime.packages,
    uiAuthController: { requireAuth: auth, requireSessionAuth: auth }, restartApplicationHost: async () => {
      calls += 1;
      expect((await runtime.catalog.snapshot()).extensions[0]!.restartHandoffs!.at(-1)!.status).toBe('pending-restart');
      await gate; throw new Error('Launch owner rejected restart');
    } });
  const transport = routerTransport(router);
  const url = new URL('https://host.invalid/api/varin/extensions/v1/candidates/restart-handoff');
  const request = (authenticated: boolean) => transport(url, { method: 'POST', headers: authenticated ? { 'x-test-auth': 'yes' } : {}, body: JSON.stringify(body) });
  expect((await request(false)).status).toBe(401); expect(calls).toBe(0);
  const unavailable = express.Router();
  registerExtensionRoutes(unavailable as unknown as Express, { extensionRuntime: runtime, extensionCatalog: runtime.catalog,
    extensionPackages: runtime.packages, uiAuthController: { requireAuth: auth, requireSessionAuth: auth } });
  expect((await routerTransport(unavailable)(url, { method: 'POST', headers: { 'x-test-auth': 'yes' }, body: JSON.stringify(body) })).status).toBe(501);
  expect((await runtime.catalog.snapshot()).revision).toBe(catalog.revision);
  expect((await request(true)).status).toBe(200); expect(calls).toBe(1);
  expect((await request(true)).status).toBe(200); expect(calls).toBe(1);
  finish();
  await expect.poll(async () => (await runtime.catalog.snapshot()).extensions[0]!.restartHandoffs!.at(-1)!.status).toBe('failed');
  expect((await runtime.catalog.snapshot()).extensions[0]!.selectedVersion).toBe('1.0.0');
  expect((await runtime.catalog.snapshot()).extensions[0]!.restartHandoffs!.at(-1)!.failure!.code).toBe('host_restart_failed');
});


it.each(['before-commit', 'after-commit'] as const)(
  'an HTTP observer disconnecting %s cannot discard accepted restart dispatch or duplicate it on replay',
  async (disconnectAt) => {
    const root = await mkdtemp(join(tmpdir(), 'varin-restart-response-loss-')); roots.push(root);
    const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), brokerScript: 'unused', varinVersion: '1.2.3' }); runtimes.push(runtime);
    const id = 'test.route.disconnect';
    for (const version of ['1.0.0', '2.0.0']) {
      const directory = join(root, version); await mkdir(directory);
      await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version, engines: { varin: '*' },
        entrypoints: { host: { file: 'host.cjs', mode: 'native', activation: ['service-request'] } } }));
      await writeFile(join(directory, 'host.cjs'), 'module.exports={activate(){}};');
      await runtime.installOrStage({ source: { kind: 'local', display: 'HTTP response loss fixture', specifier: directory },
        expectedRevision: (await runtime.catalog.snapshot()).revision });
    }
    const catalog = await runtime.catalog.snapshot();
    const body = { extensionId: id, handoffId: `original-${disconnectAt}`, candidateIntegrity: catalog.extensions[0]!.candidate!.integrity,
      expectedRevision: catalog.revision };
    let enterGate!: () => void, releaseGate!: () => void, markFirstClose!: () => void;
    const entered = new Promise<void>(resolve => { enterGate = resolve; });
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const firstClosed = new Promise<void>(resolve => { markFirstClose = resolve; });
    const commit = runtime.catalog.store.requestRestartHandoff.bind(runtime.catalog.store);
    // Hold the original real Catalog operation across socket close, on either side
    // of its durable write. Neither response events nor a fabricated DTO establish commit.
    const mutation = vi.spyOn(runtime.catalog.store, 'requestRestartHandoff').mockImplementationOnce(async (...args) => {
      if (disconnectAt === 'after-commit') {
        const result = await commit(...args);
        enterGate(); await gate;
        return result;
      }
      enterGate(); await gate;
      return commit(...args);
    });
    let dispatches = 0, responses = 0, closes = 0;
    const app = express(); app.use(express.json());
    app.use((_req, res, next) => {
      res.once('close', () => { closes += 1; markFirstClose(); });
      next();
    });
    const auth: Parameters<typeof registerExtensionRoutes>[1]['uiAuthController']['requireAuth'] = (req, res, next) =>
      req.headers['x-test-auth'] === 'yes' ? next() : res.status(401).json({ error: 'auth' });
    registerExtensionRoutes(app, { extensionRuntime: runtime, extensionCatalog: runtime.catalog, extensionPackages: runtime.packages,
      uiAuthController: { requireAuth: auth, requireSessionAuth: auth }, restartApplicationHost: async () => { dispatches += 1; } });
    const server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP listener did not expose a port');
    const options = { host: '127.0.0.1', port: address.port, path: '/api/varin/extensions/v1/candidates/restart-handoff', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-auth': 'yes' } };
    const observer = httpRequest(options, response => { responses += 1; response.resume(); });
    // Socket destruction is expected observation loss, not an unhandled client error.
    observer.on('error', () => undefined);
    try {
      observer.end(JSON.stringify(body));
      await entered;
      const beforeClose = await runtime.catalog.snapshot();
      expect(beforeClose.extensions[0]!.restartHandoffs?.at(-1)?.status)
        .toBe(disconnectAt === 'after-commit' ? 'pending-restart' : undefined);
      expect(dispatches).toBe(0);
      observer.destroy();
      await firstClosed;
      expect(responses).toBe(0);
      releaseGate();
      // The restart must happen without receiving a response or sending another request.
      await expect.poll(() => dispatches).toBe(1);
      const accepted = await runtime.catalog.snapshot();
      expect(accepted.extensions[0]!.restartHandoffs!.at(-1)!).toMatchObject({ id: body.handoffId, status: 'pending-restart' });
      expect(accepted.extensions[0]!.selectedVersion).toBe('1.0.0');
      const replayStatus = await new Promise<number | undefined>((resolve, reject) => {
        const replay = httpRequest(options, response => {
          response.resume(); response.once('end', () => resolve(response.statusCode)); response.once('error', reject);
        });
        replay.once('error', reject); replay.end(JSON.stringify(body));
      });
      expect(replayStatus).toBe(200);
      await expect.poll(() => closes).toBe(2);
      expect(dispatches).toBe(1);
      expect((await runtime.catalog.snapshot()).extensions[0]!.restartHandoffs).toHaveLength(1);
    } finally {
      releaseGate(); observer.destroy(); mutation.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
);
