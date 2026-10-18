import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocket } from 'ws';
import { test } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { clearRuntimeUrlAuthToken } from '@varin/application-client';
import type { VarinSurfaceServiceLeaseEvent, VarinSurfaceServiceLeaseRequest } from '@varin/extension-contract';
import { registerExtensionRoutes } from '#application-host/lib/extensions/routes.js';
import { attachObservations } from '#application-host/lib/observations.js';
import { createWebExtensionsAPI } from './extensions';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const until = async (ready: () => boolean, message: string) => {
  const end = Date.now() + 10_000;
  while (!ready()) { assert(Date.now() < end, message); await new Promise(resolve => setTimeout(resolve, 5)); }
};

test('public Surface lease client binds scoped broker graphs and owns only its real response lifetime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-surface-composition-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(directory, 'data'), varinVersion: '1.2.3',
    brokerScript: fileURLToPath(new URL('../../../extension-host/broker/broker-child.mjs', import.meta.url)) });
  const entered = deferred<void>(), release = deferred<void>();
  const closedGenerations = new Set<number>();
  const watchServiceLease = runtime.watchServiceLease.bind(runtime);
  runtime.watchServiceLease = async (request, ...args) => {
    try { await watchServiceLease(request, ...args); }
    finally { closedGenerations.add((request as VarinSurfaceServiceLeaseRequest).owner.generation); }
  };
  runtime.capabilities.register('review.surface.gate', async () => { entered.resolve(); await release.promise; return null; });
  const dependency = 'review.surface.dependency', composed = 'review.surface.composed';
  const install = async (id: string, kind: 'dependency' | 'composed' | 'surface') => {
    const path = join(directory, id); await mkdir(path);
    const service = { id: kind === 'dependency' ? dependency : composed, version: 1, multiple: true };
    await writeFile(join(path, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
    await writeFile(join(path, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
      entrypoints: kind === 'surface'
        ? { surfaces: [{ id: 'panel', file: 'surface.cjs', mode: 'managed', supports: ['web'], activation: ['application-startup'] }] }
        : { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
      ...(kind !== 'surface' ? { provides: { services: [service] } } : {}),
      ...(kind === 'dependency' ? { capabilities: { host: ['review.surface.gate'] } } : {
        requires: { services: [{ id: kind === 'composed' ? dependency : composed, version: 1, binding: 'selected',
          realms: [kind === 'composed' ? 'host' : 'surface'] }] },
      }),
    }));
    await writeFile(join(path, kind === 'surface' ? 'surface.cjs' : 'host.cjs'), kind === 'surface'
      ? 'module.exports={activate(){}}'
      : `module.exports={activate(ctx){${kind === 'composed' ? `const dep=ctx.services.use('${dependency}',1);` : ''}
          ctx.services.provide(${JSON.stringify(service)}, { read(){return ${kind === 'composed' ? 'dep.call("read")' : JSON.stringify(id)};},
            async hold(){${kind === 'composed' ? 'return dep.call("hold");' : `await ctx.capabilities.call('review.surface.gate','wait',null);return '${id}';`}}});}};`);
    await runtime.installOrStage({ expectedRevision: (await runtime.catalog.snapshot()).revision,
      source: { kind: 'local', display: id, specifier: path } });
    if (kind === 'dependency') await runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await runtime.catalog.snapshot()).revision,
      decisions: [{ realm: 'host', capability: 'review.surface.gate', granted: true }] });
    const entry = (await runtime.catalog.snapshot()).extensions.find(value => value.manifest.id === id)!;
    if (!entry.desired.enabled) await runtime.setEnabled(id, true, (await runtime.catalog.snapshot()).revision);
  };
  const key = (id: string, serviceId: string) => `${id}:host:${serviceId}@1`;
  const route = async (projectId: string, target: string) => runtime.upsertServiceRoutingRule({
    expectedRevision: (await runtime.routing.read()).document.revision,
    rule: { scope: { projectId }, serviceId: dependency, version: 1, providerKeys: [key(target, dependency)], allowFallback: false },
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let principal = 'review-user', authorized = true;
  const previousDataDir = process.env.VARIN_DATA_DIR;
  process.env.VARIN_DATA_DIR = join(directory, 'authentication');
  const { createUiAuth } = await import('#application-host/lib/ui-auth/ui-auth.js');
  const auth = createUiAuth({ password: 'review-only-fixture-password', clientAuthController: {
    authenticateBearerToken: async token => ['review-user', 'another-user'].includes(token)
      ? { ok: true, clientId: token } : null,
  } });
  const controllers: AbortController[] = [], completions: Promise<void>[] = [];
  const app = express(); app.use(express.json());
  const server = createServer(app);
  const observations = attachObservations({ server,
    authenticate: async request => Boolean(await auth.resolveWebSocketAuthContext(request)),
    isRequestOriginAllowed: () => true,
    rejectWebSocketUpgrade: socket => socket.destroy(),
  });
  const originalFetch = globalThis.fetch;
  try {
    await runtime.start();
    await install('review.surface.b', 'dependency'); await install('review.surface.c', 'dependency');
    await install('review.surface.a', 'composed'); await install('review.surface.panel', 'surface');
    await route('p', 'review.surface.b'); await route('q', 'review.surface.c');
    const router = express.Router();
    router.post('/auth/url-token', auth.handleUrlAuthToken);
    router.use('/api/varin/extensions', (_request, response, next) => {
      if (!authorized) { response.status(401).json({ error: 'unauthorized' }); return; }
      next();
    });
    app.use(router);
    registerExtensionRoutes(app, { extensionCatalog: runtime.catalog, extensionPackages: runtime.packages,
      extensionRuntime: runtime, uiAuthController: auth });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    setGlobal('WebSocket', WebSocket);
    setGlobal('window', { location: { origin: 'https://surface.invalid', href: 'https://surface.invalid/' },
      __VARIN_LOCAL_ORIGIN__: origin });
    clearRuntimeUrlAuthToken();
    setGlobal('fetch', (input: URL | string, init: RequestInit = {}) => {
      const target = new URL(String(input)); assert.equal(target.origin, origin);
      assert.equal(init.credentials, 'include');
      const headers = new Headers(init.headers);
      // Controlled browser authentication only at token mint. Actual service requests must use
      // the real client's application-token header and the original middleware/path authority.
      if (target.pathname === '/auth/url-token') headers.set('authorization', `Bearer ${principal}`);
      else {
        assert(headers.has('x-varin-application-token'));
        assert.equal(headers.has('authorization'), false);
        if (!authorized) headers.delete('x-varin-application-token');
      }
      return originalFetch(target, { ...init, headers });
    });
    const api = createWebExtensionsAPI();
    const request = async (projectId: string, generation: number): Promise<VarinSurfaceServiceLeaseRequest> => {
      const catalog = await runtime.catalog.snapshot(), entry = catalog.extensions.find(value => value.manifest.id === 'review.surface.panel')!;
      return { owner: { hostId: catalog.hostId, realmId: 'surface-review', extensionId: entry.manifest.id,
        extensionVersion: entry.manifest.version, entrypointId: 'panel', generation, desiredRevision: entry.desired.revision },
      surface: 'web', slot: 'selected', artifactIntegrity: entry.integrity!, routing: { projectId },
      expectedRoutingRevision: (await runtime.routing.read()).document.revision,
      services: [{ serviceId: composed, version: 1, providerKey: key('review.surface.a', composed) }] };
    };
    const open = async (projectId: string, generation: number) => {
      const input = await request(projectId, generation), controller = new AbortController(); controllers.push(controller);
      const ready = deferred<Extract<VarinSurfaceServiceLeaseEvent, { kind: 'ready' }>>();
      const completion = api.watchServiceLease(input, event => {
        if (event.kind === 'ready') ready.resolve(event);
        else ready.reject(new Error(event.kind === 'error' ? event.message : event.code));
      }, controller.signal);
      completions.push(completion.catch(() => undefined));
      void completion.catch(ready.reject);
      const selected = await ready.promise;
      const invoke = (method: string, generationOverride = generation) => api.invokeService({ serviceId: composed, version: 1,
        providerId: selected.providers[0]!.providerId, method, args: [], lease: { id: selected.leaseId,
          owner: { realmId: input.owner.realmId, extensionId: input.owner.extensionId, entrypointId: 'panel', generation: generationOverride } } });
      return { selected, controller, invoke };
    };
    const p = await open('p', 1), q = await open('q', 2);
    assert.equal(await p.invoke('read'), 'review.surface.b'); assert.equal(await q.invoke('read'), 'review.surface.c');
    assert.notEqual(p.selected.providers[0]!.providerId, q.selected.providers[0]!.providerId);
    await assert.rejects(p.invoke('read', 9), /authenticated composition owner/);
    principal = 'another-user'; clearRuntimeUrlAuthToken();
    await assert.rejects(p.invoke('read'), /authenticated composition owner/);
    principal = 'review-user'; clearRuntimeUrlAuthToken();
    authorized = false;
    await assert.rejects(api.watchServiceLease(await request('p', 3), () => undefined, new AbortController().signal), /request failed \(401\)/);
    authorized = true;
    const held = p.invoke('hold'); void held.catch(() => undefined); await entered.promise;
    await route('p', 'review.surface.c');
    const replacement = await open('p', 4);
    assert.equal(replacement.selected.providers[0]!.providerId, q.selected.providers[0]!.providerId,
      'The new project choice shares the actual matching A/C instance');
    assert.equal(await p.invoke('read'), 'review.surface.b', 'An open lease never reselects its dependency');
    p.controller.abort(new Error('Surface detached'));
    await completions[0];
    await until(() => closedGenerations.has(1), 'The Host must observe the original lease response closing');
    await assert.rejects(p.invoke('read'), /authenticated composition owner/);
    assert(runtime.services.getSnapshot().providers.some(provider => provider.providerId === p.selected.providers[0]!.providerId),
      'The actual old callback still owns A/B after the Surface reader closes');
    assert.equal(await q.invoke('read'), 'review.surface.c');
    release.resolve(); assert.equal(await held, 'review.surface.b');
    await until(() => !runtime.services.getSnapshot().providers.some(provider => provider.providerId === p.selected.providers[0]!.providerId),
      'Old exact instance must retire after its real callback and disposer drain');
  } finally {
    authorized = true; release.resolve(); controllers.forEach(controller => controller.abort());
    await Promise.allSettled(completions);
    try { await runtime.stop(); }
    finally {
      observations.stop(); server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      auth.dispose(); clearRuntimeUrlAuthToken();
      if (previousDataDir === undefined) delete process.env.VARIN_DATA_DIR; else process.env.VARIN_DATA_DIR = previousDataDir;
      for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
      await rm(directory, { recursive: true, force: true });
    }
  }
});
