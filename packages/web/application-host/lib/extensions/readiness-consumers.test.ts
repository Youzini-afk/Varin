import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import type { ExtensionsAPI } from '@varin/application-client';
import type { VarinExtensionCandidatePublicationRequest } from '@varin/extension-contract';
import { registerExtensionRoutes } from './routes.js';
import { routerTransport } from './direct-router.test-helper.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), token: vi.fn() }));
vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  fetchWithoutRuntimeRouting: transport.fetch,
  refreshLocalRuntimeUrlAuthToken: transport.token,
}));
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => {
  vi.restoreAllMocks();
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

it('real Web publication consumer keeps exact readiness and cancellation through auth, Router and the original Catalog lock', async () => {
  // The bridge is a direct Router, never a listener. Transport is controlled; artifact,
  // catalog and file-lock work are real. Actual mount evidence lives in the stdio chain.
  const root = await mkdtemp(join(tmpdir(), 'varin-readiness-consumer-'));
  const directory = join(root, 'package'); await mkdir(directory);
  const id = 'example.readiness.consumer', serviceId = `${id}.read`;
  const manifest = {
    schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
    updateReadiness: { surfaceEntrypoints: ['panel'] },
    entrypoints: { host: { mode: 'brokered', file: 'host.cjs', activation: ['service-request'] },
      surfaces: [{ id: 'panel', mode: 'managed', file: 'surface.cjs', supports: ['web'] }] },
    provides: { services: [{ id: serviceId, version: 1 }] },
  };
  await writeFile(join(directory, 'varin.extension.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'host.cjs'), 'module.exports = { activate() {} }; // original');
  await writeFile(join(directory, 'surface.cjs'), 'exports.activate = () => {};');
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.0.0',
    brokerScript: 'not-started', transportFactory: ({ owner }) => ({ forceTerminate() {}, terminate: async () => {},
      request: async method => method === 'activate' ? { provisions: [{ id: serviceId, version: 1 }] } : owner.generation }),
  });
  const router = express.Router();
  const auth: Parameters<typeof registerExtensionRoutes>[1]['uiAuthController']['requireAuth'] = (request, response, next) =>
    request.headers['x-varin-application-token'] === 'controlled-ui-token'
      ? next() : response.status(401).json({ error: { message: 'Authentication required' } });
  registerExtensionRoutes(router as unknown as Express, { extensionRuntime: runtime, extensionCatalog: runtime.catalog,
    extensionPackages: runtime.packages, uiAuthController: { requireAuth: auth, requireSessionAuth: auth } });
  const fetchRoute = routerTransport(router);
  transport.fetch.mockImplementation(fetchRoute); transport.token.mockResolvedValue('controlled-ui-token');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __VARIN_LOCAL_ORIGIN__: 'https://application-host.invalid',
    location: { href: 'varin-ui://app/', origin: 'varin-ui://app' },
  } });
  const adapter: { createWebExtensionsAPI(): ExtensionsAPI } = await import(new URL('../../../src/api/extensions.ts', import.meta.url).href);
  const api = adapter.createWebExtensionsAPI();
  const source = { kind: 'local' as const, display: 'Controlled user package', specifier: directory };
  let locked = false;
  const lockPath = join(runtime.catalog.store.directory, '.catalog.lock');
  try {
    let installed = await api.install({ source, expectedRevision: 0 });
    if (!installed.extensions[0]!.desired.enabled) installed = await api.setEnabled(id, true, installed.revision);
    await runtime.activateExtension(id);
    const original = installed.extensions[0]!.integrity;
    expect(await runtime.services.bind(serviceId, 1).invoke('read', [])).toBe(1);
    await writeFile(join(directory, 'host.cjs'), 'module.exports = { activate() {} }; // updated');
    const staged = await api.install({ source, expectedRevision: (await runtime.catalog.snapshot()).revision });
    const candidateIntegrity = staged.extensions[0]!.candidate!.integrity;
    const requested = await api.requestCandidateApplication({ extensionId: id, candidateIntegrity, expectedRevision: staged.revision });
    const base = { extensionId: id, candidateIntegrity, expectedRevision: requested.revision };
    await expect(api.selectCandidate(base)).rejects.toThrow(/Surface|surface|readiness/);
    expect((await runtime.catalog.snapshot()).extensions[0]!.integrity).toBe(original);
    const prepared = await api.prepareCandidate(id, candidateIntegrity);
    expect(prepared.hostPreparation).toBeDefined();
    const publication: VarinExtensionCandidatePublicationRequest = { ...base, surfaceReadiness: {
      hostPreparation: prepared.hostPreparation!, realmId: 'controlled-real-client', surface: 'web',
      members: [{ entrypointId: 'panel', generation: 1 }],
    } };
    await expect(api.selectCandidate({ ...publication, surfaceReadiness: { ...publication.surfaceReadiness!,
      hostPreparation: { ...prepared.hostPreparation!, id: randomUUID() } } })).rejects.toThrow(/preparation|identity|readiness|stale/i);
    const entered = deferred(), drained = deferred();
    const originalSelect = runtime.packages.selectCandidate.bind(runtime.packages);
    vi.spyOn(runtime.packages, 'selectCandidate').mockImplementation(async (...args) => {
      entered.resolve();
      return originalSelect(...args);
    });
    const originalPublication = runtime.selectCandidate.bind(runtime);
    vi.spyOn(runtime, 'selectCandidate').mockImplementation(async (...args) => {
      try { return await originalPublication(...args); }
      finally { drained.resolve(); }
    });
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: 'controlled-lock' }), { flag: 'wx' });
    locked = true;
    const controller = new AbortController();
    const selecting = api.selectCandidate(publication, controller.signal);
    const rejected = expect(selecting).rejects.toThrow();
    await entered.promise;
    controller.abort(new Error('Required local preparation closed before Catalog commit'));
    await rejected;
    await rm(lockPath); locked = false;
    await drained.promise;
    // A rejected fetch alone is insufficient: wait for the original owner operation to
    // unwind before reading its actual catalog/provider facts.
    expect((await runtime.catalog.snapshot()).extensions[0]!.integrity).toBe(original);
    expect(await runtime.services.bind(serviceId, 1).invoke('read', [])).toBe(1);
    const selected = await api.selectCandidate(publication);
    expect(selected.extensions[0]!.integrity).toBe(candidateIntegrity);
    expect(await runtime.services.bind(serviceId, 1).invoke('read', [])).toBe(2);
    expect(transport.token).toHaveBeenCalled();
  } finally {
    if (locked) await rm(lockPath);
    await runtime.stop(); await rm(root, { recursive: true, force: true });
  }
});
