import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
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
  return (target: URL, init: RequestInit): Promise<Response> => new Promise((resolve, reject) => {
    const headers = new Headers();
    const response = {
      statusCode: 200,
      setHeader(name: string, value: string) { headers.set(name, value); },
      status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) { resolve(Response.json(payload, { status: this.statusCode, headers })); return this; },
    };
    const request = {
      method: init.method ?? 'GET',
      url: target.pathname + target.search,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    router(request as Request, response as unknown as ExpressResponse, (error?: unknown) => {
      reject(error ?? new Error('Contract route did not respond'));
    });
  });
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
let root: string;
let directory: string;
let runtime: ApplicationExtensionRuntime;
let documents: ReturnType<typeof createDocumentAuthority>;
let api: ExtensionsAPI;
let fetchRoute: ReturnType<typeof routerTransport>;

beforeEach(async () => {
  onWorkspaceResolved.mockClear();
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'varin-contract-consumers-')));
  directory = path.join(root, 'workspace');
  await mkdir(directory);
  runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '1.0.0', brokerScript: 'not-started.cjs' });
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

describe('runtime contract User API through the real HTTP handler and runtime', () => {
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
