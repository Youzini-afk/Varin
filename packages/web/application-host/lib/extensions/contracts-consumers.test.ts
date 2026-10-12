import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express, type Request, type Response as ExpressResponse } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { VARIN_BUILTIN_EXTENSION_DEFINITIONS, VARIN_BUILTIN_EXTENSION_PREFIX } from '@varin/extension-builtins';
import {
  VARIN_WORKBENCH_SLOT_CONTRACTS,
  VARIN_WORKBENCH_DEFAULT_PROFILE_ID,
  VARIN_WORKBENCH_REPLACEMENT_TARGETS,
  VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
  parseVarinWorkbenchShellContributionData,
  type VarinExtensionInstallationRecord,
  type VarinExtensionServiceProvision,
  type VarinRuntimeSourceArtifact,
  type VarinRuntimeSourceRequest,
} from '@varin/extension-contract';
import type { ExtensionsAPI } from '@varin/application-client';
import { createDocumentAuthority } from '../documents/authority.js';
import { registerExtensionRoutes } from './routes.js';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), token: vi.fn() }));
vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  fetchWithoutRuntimeRouting: transport.fetch,
  refreshLocalRuntimeUrlAuthToken: transport.token,
}));

/** Exercise Express's actual route/middleware stack without opening a listener. */
function routerTransport(router: ReturnType<typeof express.Router>) {
  const exchanges: Array<{ request: EventEmitter; response: EventEmitter; replied: boolean }> = [];
  const fetch = (target: URL, init: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
    if (init.signal?.aborted) { reject(init.signal.reason); return; }
    const headers = new Headers();
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      writableEnded: false,
      destroyed: false,
      setHeader(name: string, value: string) { headers.set(name, value); },
      status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) {
        exchange.replied = true;
        this.writableEnded = true;
        init.signal?.removeEventListener('abort', abort);
        resolve(Response.json(payload, { status: this.statusCode, headers }));
        response.emit('finish');
        return this;
      },
    });
    const request = Object.assign(new EventEmitter(), {
      method: init.method ?? 'GET',
      url: target.pathname + target.search,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      aborted: false,
    });
    const exchange = { request, response, replied: false };
    exchanges.push(exchange);
    response.once('close', () => {
      response.destroyed = true;
      reject(init.signal?.aborted ? init.signal.reason : new Error('Application host connection closed'));
    });
    const abort = () => {
      request.aborted = true;
      response.destroyed = true;
      request.emit('aborted');
      response.emit('close');
      reject(init.signal?.reason);
    };
    init.signal?.addEventListener('abort', abort, { once: true });
    router(request as Request, response as unknown as ExpressResponse, (error?: unknown) => {
      init.signal?.removeEventListener('abort', abort);
      reject(error ?? new Error('Contract route did not respond'));
    });
  });
  return Object.assign(fetch, { exchanges });
}

const serviceId = 'dev.contract.discovery';
const declaredService: VarinExtensionServiceProvision = {
  id: serviceId,
  multiple: true,
  version: 1,
  contract: {
    methods: {
      read: { inputSchema: { type: 'object', properties: { key: { type: 'string' } } }, outputSchema: { type: 'string' } },
      other: { inputSchema: { type: 'null' }, outputSchema: { type: 'boolean' } },
    },
    events: { changed: { schema: { type: 'object', properties: { revision: { type: 'integer' } } } } },
  },
};

const installation = (id: string, service: VarinExtensionServiceProvision): VarinExtensionInstallationRecord => {
  const now = new Date().toISOString();
  return {
    manifest: {
      schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
      entrypoints: { host: { activation: ['service-request'], file: 'host.cjs', mode: 'brokered' } },
      provides: { services: [service] },
    },
    source: { kind: 'npm', specifier: id, display: id },
    resolvedVersion: '1.0.0', selectedVersion: '1.0.0',
    desired: { enabled: true, revision: 1, updatedAt: now }, capabilityGrants: [], installedAt: now, updatedAt: now,
  };
};

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const onWorkspaceResolved = vi.fn();
const startBroker = vi.fn(() => { throw new Error('Contract discovery must never start an extension process'); });
let root: string;
let directory: string;
let runtime: ApplicationExtensionRuntime;
let documents: ReturnType<typeof createDocumentAuthority>;
let api: ExtensionsAPI;
let fetchRoute: ReturnType<typeof routerTransport>;

beforeEach(async () => {
  onWorkspaceResolved.mockClear();
  startBroker.mockClear();
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'varin-contract-consumers-')));
  directory = path.join(root, 'workspace');
  await mkdir(directory);
  runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '1.0.0',
    brokerScript: 'not-started.cjs', transportFactory: startBroker });
  documents = createDocumentAuthority({
    hostId: runtime.services.hostId, dataDir: path.join(root, 'documents'),
    isAllowedRoot: async (candidate) => candidate === directory,
    isTrusted: async (candidate) => candidate === directory,
    onWorkspaceResolved,
  });
  await runtime.catalog.upsert(installation('dev.contract.one', declaredService), 0);
  await runtime.catalog.upsert(installation('dev.contract.two', { id: serviceId, multiple: true, version: 1 }), 1);
  const router = express.Router();
  registerExtensionRoutes(router as unknown as Express, {
    extensionCatalog: runtime.catalog, extensionPackages: runtime.packages, extensionRuntime: runtime, documents,
    readProjects: async () => [{ id: 'saved-project', path: directory }],
    uiAuthController: {
      requireAuth: (request, response, next) => request.headers['x-varin-application-token'] === 'host-token'
        ? next() : response.status(401).json({ error: { message: 'Authentication required' } }),
      requireSessionAuth: (_request, _response, next) => next(),
    },
  });
  fetchRoute = routerTransport(router);
  transport.fetch.mockImplementation(fetchRoute);
  transport.token.mockResolvedValue('host-token');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __VARIN_API_BASE_URL__: 'https://selected-runtime.invalid',
      __VARIN_LOCAL_ORIGIN__: 'https://application-host.invalid',
      location: { href: 'varin-ui://app/', origin: 'varin-ui://app' },
    },
  });
  // Load the real browser producer at runtime. Its own Web project type-checks
  // browser sources; this Host integration checks the public ExtensionsAPI boundary.
  const adapter: { createWebExtensionsAPI(): ExtensionsAPI } = await import(
    new URL('../../../src/api/extensions.ts', import.meta.url).href
  );
  api = adapter.createWebExtensionsAPI();
});

afterEach(async () => {
  await runtime?.stop();
  await documents?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  transport.fetch.mockReset();
  transport.token.mockReset();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const sourceExtensionId = 'dev.contract.source';
const sourceServiceId = 'dev.contract.source.reader';
const sourceText = '// α🙂中 e\u0301\nthrow new Error("Source inspection must never execute this module");\n';

async function sourceMetadata() {
  const result = await api.queryContracts({ action: 'describe', kind: 'service', serviceId: sourceServiceId,
    version: 1, extensionId: sourceExtensionId, member: { kind: 'method', name: 'read' } }, { directory });
  if (result.action !== 'describe' || result.kind !== 'service' || result.status !== 'found'
    || result.member?.kind !== 'method' || !result.member.contract.source || !result.service?.implementations[0]) {
    throw new Error('Expected the installed source member and its implementation');
  }
  return { source: result.member.contract.source, implementation: result.service.implementations[0] };
}

async function installSource() {
  const sourceDirectory = path.join(root, 'source-package');
  await mkdir(sourceDirectory);
  await writeFile(path.join(sourceDirectory, 'host.cjs'), sourceText);
  await writeFile(path.join(sourceDirectory, 'empty.txt'), '');
  await writeFile(path.join(sourceDirectory, 'varin.extension.json'), JSON.stringify({
    schemaVersion: 1, id: sourceExtensionId, version: '1.0.0', engines: { varin: '*' },
    entrypoints: { host: { activation: ['service-request'], file: 'host.cjs', mode: 'brokered' } },
    provides: { services: [{ id: sourceServiceId, version: 1, contract: { methods: {
      read: { inputSchema: { type: 'null' }, outputSchema: { type: 'string' }, source: { path: 'host.cjs' } },
    } } }] },
  }));
  const snapshot = await api.install({ expectedRevision: (await runtime.catalog.snapshot()).revision,
    source: { kind: 'local', display: 'Source inspection fixture', specifier: sourceDirectory } });
  const metadata = await sourceMetadata();
  if (!metadata.implementation.artifacts.selected) throw new Error('Expected the installed artifact identity');
  const request: VarinRuntimeSourceRequest = { action: 'read', kind: 'source',
    ...metadata.implementation.artifacts.selected, path: metadata.source.path };
  return { sourceDirectory, snapshot, request, metadata };
}

async function readSourcePages(artifact: VarinRuntimeSourceArtifact, sourcePath: string, expectedText: string) {
  const totalBytes = Buffer.byteLength(expectedText);
  const fileIntegrity = `sha256-${createHash('sha256').update(expectedText).digest('hex')}`;
  let text = '', offset = 0, pages = 0;
  for (;;) {
    const result = await api.queryContracts({ action: 'read', kind: 'source', ...artifact,
      path: sourcePath, offset, maxBytes: 7 }, { directory });
    expect(result).toMatchObject({ action: 'read', kind: 'source', ...artifact, path: sourcePath,
      status: 'found', origin: 'immutable_artifact', permission: 'checked_on_invocation', fileIntegrity,
      page: { encoding: 'utf-8', offset, totalBytes } });
    if (result.kind !== 'source' || result.status !== 'found') throw new Error('Expected an immutable source page');
    expect(result.page.byteLength).toBe(Buffer.byteLength(result.page.text));
    expect(result.page.byteLength).toBeLessThanOrEqual(10);
    text += result.page.text;
    pages++;
    if (result.page.nextOffset === null) break;
    expect(result.page.nextOffset).toBe(offset + result.page.byteLength);
    expect(result.page.nextOffset).toBeGreaterThan(offset);
    offset = result.page.nextOffset;
  }
  expect(text).toBe(expectedText);
  return pages;
}

describe('runtime contract User API through the real HTTP handler and runtime', () => {
  it('retains source admission and consumes response-close cancellation after the real artifact read', async () => {
    const { request } = await installSource();
    const originalRead = runtime.packages.artifacts.readSource.bind(runtime.packages.artifacts);
    const read = vi.spyOn(runtime.packages.artifacts, 'readSource');
    const target = new URL('https://application-host.invalid/api/varin/extensions/v1/contracts/query');
    expect((await fetchRoute(target, { method: 'POST', body: JSON.stringify({ request }) })).status).toBe(401);
    const outsider = path.join(root, 'outside');
    await mkdir(outsider);
    await expect(api.queryContracts(request, { directory: outsider })).rejects.toThrow('deployment boundary');
    const cancelled = new AbortController();
    cancelled.abort(new Error('Source read cancelled before transport'));
    await expect(api.queryContracts(request, { directory }, cancelled.signal)).rejects.toThrow('cancelled before transport');
    expect(read).not.toHaveBeenCalled();

    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const verified = read.mockImplementationOnce(async (...args) => {
      const result = await originalRead(...args);
      expect(result.status).toBe('found');
      enter();
      await gate;
      return result;
    });
    const ownerRead = vi.spyOn(runtime.packages, 'readSource');
    const pending = api.queryContracts(request, { directory });
    const rejected = expect(pending).rejects.toThrow('Application host connection closed');
    try {
      await entered;
      const exchange = fetchRoute.exchanges.at(-1)!;
      expect(verified.mock.calls[0]?.[3]?.aborted).toBe(false);
      exchange.response.emit('close');
      expect(verified.mock.calls[0]?.[3]?.aborted).toBe(true);
      await rejected;
    } finally { release(); }
    await expect(ownerRead.mock.results[0]?.value).rejects.toThrow('Extension request disconnected');
    await new Promise<void>(resolve => setImmediate(resolve));
    const exchange = fetchRoute.exchanges.at(-1)!;
    expect(exchange.replied).toBe(false);
    expect(exchange.request.listenerCount('aborted')).toBe(0);
    expect(exchange.response.listenerCount('close')).toBe(0);
    expect(startBroker).not.toHaveBeenCalled();
  });

  it('does not start source I/O when the client disconnects during real directory admission', async () => {
    const { request } = await installSource();
    const originalLookup = documents.lookupWorkspacePath.bind(documents);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(documents, 'lookupWorkspacePath').mockImplementationOnce(async (...args) => {
      const result = await originalLookup(...args);
      enter();
      await gate;
      return result;
    });
    const read = vi.spyOn(runtime.packages.artifacts, 'readSource');
    const controller = new AbortController();
    const pending = api.queryContracts(request, { directory }, controller.signal);
    const rejected = expect(pending).rejects.toThrow('Cancelled during directory admission');
    try {
      await entered;
      controller.abort(new Error('Cancelled during directory admission'));
      await rejected;
    } finally { release(); }
    // Directory I/O completed before the gate. Let its immediate route continuation run.
    await new Promise<void>(resolve => setImmediate(resolve));
    await Promise.allSettled(read.mock.results.map(result => result.value));
    expect(read).not.toHaveBeenCalled();
    expect(fetchRoute.exchanges.at(-1)?.replied).toBe(false);
    expect(startBroker).not.toHaveBeenCalled();
  });

  it('reads exact installed UTF-8 source through metadata, candidate replacement and same-version publication', async () => {
    const prepare = vi.spyOn(runtime, 'prepareService');
    const prepareCandidate = vi.spyOn(runtime, 'prepareCandidate');
    const materialize = vi.spyOn(runtime.packages.artifacts, 'prepare');
    const invoke = vi.spyOn(runtime, 'invokeService');
    const activate = vi.spyOn(runtime, 'activateExtension');
    const { sourceDirectory, snapshot, request, metadata } = await installSource();
    const initial = metadata.implementation.artifacts.selected!;
    expect(metadata.implementation).toMatchObject({ extensionVersion: '1.0.0', registration: 'declared',
      artifacts: { selected: { extensionId: sourceExtensionId, slot: 'selected' }, candidate: null } });
    expect(JSON.stringify(metadata)).not.toContain(sourceDirectory);
    expect(await readSourcePages(initial, request.path, sourceText)).toBeGreaterThan(1);
    expect(await api.queryContracts({ ...request, path: 'empty.txt' })).toMatchObject({ status: 'found',
      page: { text: '', offset: 0, byteLength: 0, totalBytes: 0, nextOffset: null } });
    expect(await api.queryContracts({ ...request, path: 'missing.txt' }))
      .toMatchObject({ status: 'missing', code: 'source_missing' });

    const candidateText = sourceText.replace('Source inspection', 'Candidate inspection');
    await writeFile(path.join(sourceDirectory, request.path), candidateText);
    await readSourcePages(initial, request.path, sourceText);
    const staged = await api.reloadLocalSource({ extensionId: sourceExtensionId, expectedRevision: snapshot.revision });
    expect(staged.outcome).toBe('staged');
    const candidate = (await sourceMetadata()).implementation.artifacts.candidate!;
    expect(candidate).toMatchObject({ extensionId: sourceExtensionId, slot: 'candidate' });
    expect(candidate.artifactIntegrity).not.toBe(initial.artifactIntegrity);
    await readSourcePages(initial, request.path, sourceText);
    await readSourcePages(candidate, request.path, candidateText);

    const replacementText = candidateText.replace('Candidate inspection', 'Replacement inspection');
    await writeFile(path.join(sourceDirectory, request.path), replacementText);
    const replaced = await api.reloadLocalSource({ extensionId: sourceExtensionId, expectedRevision: staged.snapshot.revision });
    expect(await api.queryContracts({ ...request, ...candidate }))
      .toMatchObject({ status: 'stale', code: 'artifact_changed', artifactIntegrity: candidate.artifactIntegrity });
    const replacement = (await sourceMetadata()).implementation.artifacts.candidate!;
    await readSourcePages(replacement, request.path, replacementText);
    const requested = await api.requestCandidateApplication({ extensionId: sourceExtensionId,
      candidateIntegrity: replacement.artifactIntegrity, expectedRevision: replaced.snapshot.revision });
    // Publish through the original package owner. Public selection intentionally prepares
    // a broker; this read-only consumer fixture does not execute extension processes.
    await runtime.packages.selectCandidate({ extensionId: sourceExtensionId, candidateIntegrity: replacement.artifactIntegrity,
      expectedRevision: requested.revision });
    const published = await sourceMetadata();
    expect(published.implementation).toMatchObject({ extensionVersion: '1.0.0', artifacts: {
      selected: { ...replacement, slot: 'selected' }, candidate: null,
    } });
    expect(await api.queryContracts(request)).toMatchObject({ status: 'stale', code: 'artifact_changed',
      artifactIntegrity: initial.artifactIntegrity });
    await readSourcePages(published.implementation.artifacts.selected!, request.path, replacementText);
    expect(prepare).not.toHaveBeenCalled();
    expect(prepareCandidate).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledTimes(3); // The install and two explicit reloads only.
    expect(invoke).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(startBroker).not.toHaveBeenCalled();
    expect(runtime.services.getSnapshot().providers).toEqual([]);
    expect(await documents.listWorkspaceRegistrations()).toEqual([]);
    expect(onWorkspaceResolved).not.toHaveBeenCalled();
  });

  it('uses the Application Host transport, catalog revisions and exact declarative member without activation', async () => {
    const prepare = vi.spyOn(runtime, 'prepareService');
    const invoke = vi.spyOn(runtime, 'invokeService');
    const activate = vi.spyOn(runtime, 'activateExtension');
    const signal = new AbortController().signal;
    const result = await api.queryContracts({ action: 'describe', kind: 'service', serviceId, version: 1,
      extensionId: 'dev.contract.one', member: { kind: 'method', name: 'read' } }, undefined, signal);
    expect(result).toMatchObject({ action: 'describe', kind: 'service', status: 'found',
      origin: 'current_catalog', permission: 'checked_on_invocation', hostId: runtime.services.hostId,
      revisions: { catalog: 2, services: runtime.services.getSnapshot().revision },
      member: { kind: 'method', name: 'read', contract: declaredService.contract!.methods.read },
    });
    expect(JSON.stringify(result)).not.toContain('"outputSchema":{"type":"boolean"}');
    expect(prepare).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(runtime.services.getSnapshot().providers).toEqual([]);
    const [target, init] = transport.fetch.mock.calls[0] as [URL, RequestInit];
    expect(target.origin).toBe('https://application-host.invalid');
    expect(target.pathname).toBe('/api/varin/extensions/v1/contracts/query');
    expect(init.signal).toBe(signal);
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('X-Varin-Application-Token')).toBe('host-token');
    expect(transport.token).toHaveBeenCalledWith(target.origin);
  });

  it('derives directory and saved project scope through the original identity owner', async () => {
    const providerKey = 'dev.contract.one:host:dev.contract.discovery@1';
    await runtime.routing.upsertRule({ expectedRevision: 0, rule: {
      serviceId, version: 1, providerKey, allowFallback: false,
      scope: { userId: 'default', workspaceId: directory, projectId: 'saved-project' },
    } });
    const unscoped = await api.queryContracts({ action: 'list', kind: 'service' });
    expect(unscoped).toMatchObject({ entries: [{ selection: { status: 'ambiguous' } }] });
    const scoped = await api.queryContracts({ action: 'list', kind: 'service' }, { directory });
    expect(scoped).toMatchObject({ entries: [{ selection: { status: 'resolved', providerKey } }] });
    const outsider = path.join(root, 'outside');
    await mkdir(outsider);
    await expect(api.queryContracts({ action: 'list', kind: 'service' }, { directory: outsider })).rejects.toThrow('deployment boundary');
  });

  it('queries a legal unregistered directory without creating a workspace or notifying registration observers', async () => {
    expect(await documents.listWorkspaceRegistrations()).toEqual([]);
    await runtime.routing.upsertRule({ expectedRevision: 0, rule: {
      serviceId, version: 1, providerKey: 'dev.contract.one:host:dev.contract.discovery@1', allowFallback: false,
      scope: { projectId: 'saved-project' },
    } });
    const result = await api.queryContracts({ action: 'list', kind: 'service' }, { directory });
    expect(result).toMatchObject({ entries: [{ selection: { status: 'resolved', providerKey: 'dev.contract.one:host:dev.contract.discovery@1' } }] });
    await api.queryContracts({ action: 'list', kind: 'ui_slot' }, { directory });
    expect(await documents.listWorkspaceRegistrations()).toEqual([]);
    expect(onWorkspaceResolved).not.toHaveBeenCalled();
  });

  it('resolves selected shell declarations through the Documents workspace ID without claiming a live mount', async () => {
    await runtime.catalog.reconcileBuiltins(VARIN_BUILTIN_EXTENSION_DEFINITIONS, VARIN_BUILTIN_EXTENSION_PREFIX);
    const identity = await documents.resolveWorkspace({ path: directory });
    await runtime.workbench.updateLayout({ expectedRevision: 0, layer: {
      profileId: VARIN_WORKBENCH_DEFAULT_PROFILE_ID, scope: 'workspace', scopeId: identity.workspaceId, surface: 'web',
      references: [], replacementSelections: { [VARIN_WORKBENCH_REPLACEMENT_TARGETS.shell]: VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID },
    } });
    onWorkspaceResolved.mockClear();
    const registrations = await documents.listWorkspaceRegistrations();
    const scoped = await api.queryContracts({ action: 'list', kind: 'ui_slot' }, { directory, surface: 'web' });
    expect(scoped.action).toBe('list');
    if (scoped.action !== 'list' || scoped.kind !== 'ui_slot') throw new Error('Expected slot directory');
    const shell = VARIN_BUILTIN_EXTENSION_DEFINITIONS.flatMap((definition) => definition.manifest.contributions ?? [])
      .find((contribution) => contribution.id === VARIN_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID)!;
    const declared = parseVarinWorkbenchShellContributionData(shell.data, shell.supports).seams.web!.slots;
    for (const slot of scoped.entries) {
      expect(slot.selectedShell?.contributionId).toBe(shell.id);
      expect(slot.hosting).toBe(declared.includes(slot.id) ? 'declared' : 'dormant');
      expect(slot.live).toBe('unobserved');
    }
    const unscoped = await api.queryContracts({ action: 'list', kind: 'ui_slot' });
    if (unscoped.action !== 'list' || unscoped.kind !== 'ui_slot') throw new Error('Expected slot directory');
    expect(unscoped.entries[0]?.selectedShell?.contributionId).not.toBe(shell.id);
    expect(runtime.services.getSnapshot().providers).toEqual([]);
    expect(await documents.listWorkspaceRegistrations()).toEqual(registrations);
    expect(onWorkspaceResolved).not.toHaveBeenCalled();
  });

  it('keeps authentication, rejects request/context identity injection and malformed requests', async () => {
    const target = new URL('https://application-host.invalid/api/varin/extensions/v1/contracts/query');
    const send = (body: unknown, authenticated = true) => fetchRoute(target, {
      method: 'POST', body: JSON.stringify(body),
      headers: authenticated ? { 'X-Varin-Application-Token': 'host-token' } : {},
    });
    expect((await send({ request: { action: 'list', kind: 'service' } }, false)).status).toBe(401);
    for (const body of [
      { request: { action: 'list', kind: 'service', runId: 'foreign-run' } },
      { request: { action: 'list', kind: 'service' }, context: { workspaceId: 'foreign-workspace' } },
      { request: { action: 'list', kind: 'service' }, context: { userId: 'foreign-user' } },
      { request: { action: 'list', kind: 'service' }, scope: { routing: { sessionId: 'foreign-thread' } } },
      { request: { action: 'describe', kind: 'service', serviceId, version: 0 } },
    ]) expect((await send(body)).status).toBe(400);
  });

  it('distinguishes missing and undeclared members and supplies slot schemas from the public mount contracts', async () => {
    expect(await api.queryContracts({ action: 'describe', kind: 'service', serviceId, version: 1,
      extensionId: 'dev.contract.two', member: { kind: 'method', name: 'read' } })).toMatchObject({ status: 'undeclared', member: null });
    expect(await api.queryContracts({ action: 'describe', kind: 'service', serviceId, version: 1,
      extensionId: 'dev.contract.one', member: { kind: 'method', name: 'missing' } })).toMatchObject({ status: 'missing', member: null });
    expect(await api.queryContracts({ action: 'describe', kind: 'service', serviceId, version: 1,
      extensionId: 'dev.contract.one', member: { kind: 'event', name: 'changed' } })).toMatchObject({
      status: 'found', member: { kind: 'event', name: 'changed', contract: declaredService.contract!.events!.changed },
    });
    for (const slot of Object.values(VARIN_WORKBENCH_SLOT_CONTRACTS)) {
      expect(await api.queryContracts({ action: 'describe', kind: 'ui_slot', id: slot.id }, { directory, surface: 'web' }))
        .toMatchObject({ status: 'found', slot: { id: slot.id, version: slot.version, live: 'unobserved', propsSchema: slot.propsSchema } });
    }
    expect(await api.queryContracts({ action: 'describe', kind: 'ui_slot', id: 'workbench.unknown' }))
      .toMatchObject({ status: 'missing', slot: null });
  });
});
