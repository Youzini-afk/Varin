/** Original Source/Storage, package and dynamic tool owners. Only delivery and the user's
 * explicit enable action are controlled; no product socket or HTTP listener is started. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import express, { type Express, type Request, type Response as ExpressResponse } from 'express';
import { ApplicationExtensionRuntime, type HostServicePin } from '@varin/extension-host';
import { KernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelStorageAdapter } from './storage-adapter.js';
import { createDocumentAuthority } from '../documents/authority.js';
import { createLiveSourceOwner } from './live-source.js';
import { createExtensionTools } from './extension-tool-owner.js';
import { createExtensionPackageOwner, VARIN_EXTENSION_PACKAGES_CAPABILITY } from './extension-package-owner.js';
import { createRuntimeContractOwner, VARIN_RUNTIME_CONTRACTS_CAPABILITY } from './runtime-contract-owner.js';
import { createNestedToolOwner } from './nested-tool-owner.js';
import { VARIN_RUNTIME_TOOLS_CAPABILITY, parseVarinSurfaceServiceLeaseEvent, parseVarinToolJson } from '@varin/extension-contract';
import type { SurfaceExtensionHost } from '../../../../extension-loader/dist/index.js';
import { savedSourceLaunch } from './source-launch.js';
import { registerExtensionRoutes } from '../extensions/routes.js';
import { permissionService } from './permission-service.js';
import type { LaunchSource, KernelHandshakeResult, LiveExtensionToolBinding } from './protocol.generated.js';

const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; method: string }>();
let sequence = 0, root = '', workspace = '', runId = '';
let grouped = false, initialIntegrity = '';
let kernel: KernelClient, runtime: AgentRuntimeClient, extensions: ApplicationExtensionRuntime;
let documents: ReturnType<typeof createDocumentAuthority>;
let selectedSource: LaunchSource;
let router: ReturnType<typeof express.Router>;
const id = 'example.agent-authored-panel';
const forwarded: string[] = [];
const readyArtifacts = new Set<string>();
interface PanelElement { children: ArrayLike<PanelElement>; textContent: string; dataset: Record<string, string> }
interface PanelConsumer {
  container: PanelElement;
  errors: unknown[];
  styles: Array<{ committed: boolean; disposed: boolean }>;
  loader: { getSnapshot(): { active: Array<{ integrity: string }>; diagnostics: Array<{ code: string; integrity?: string }> } };
  start(): Promise<void>;
  close(): Promise<void>;
}
let panel: PanelConsumer | undefined;
let firstSection: PanelElement | undefined;
let originalService: HostServicePin | undefined;
let firstStyles: PanelConsumer['styles'] = [];
const sectionOf = (panel: PanelConsumer) => Array.from(panel.container.children)
  .find(child => Array.from(child.children).some(node => node.children[1]?.textContent.includes('Agent-authored text counter')))?.children[0];

function request(method: string, params: unknown, options: { grant?: { grantId: string } } = {}) {
  const key = `authored:${++sequence}`;
  forwarded.push(method);
  const result = new Promise((resolve, reject) => {
    pending.set(key, { resolve, reject, method });
    write({ kind: 'fixture-request', id: key, method, params, ...(options.grant ? { grantId: options.grant.grantId } : {}) });
  });
  if (method === 'runtime.tools.ready') {
    const selected = params as { extensionBindings?: LiveExtensionToolBinding[] };
    void result.then(value => {
      if ((value as { ready: boolean }).ready) {
        for (const retained of selected.extensionBindings ?? []) readyArtifacts.add(retained.binding.artifactIntegrity);
      }
    }).catch(error => write({ kind: 'fixture-failed', error: String(error) }));
  }
  if (method === 'runtime.permission.open') {
    const exact = params as { operationId: string; permissionId: string };
    void result.then(() => permissionService(kernel).decide(exact.operationId, exact.permissionId, 'allow_once'))
      .catch(error => write({ kind: 'fixture-failed', error: String(error) }));
  }
  return result;
}

/** The ordinary route and auth middleware run directly, without app.listen or supertest. */
function route(method: string, url: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200, writableEnded: false,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      json(value: Record<string, unknown>) {
        this.writableEnded = true;
        if (this.statusCode >= 400) reject(new Error(JSON.stringify(value)));
        else resolveResponse(value);
        response.emit('finish');
        return this;
      },
    });
    const abort = () => response.emit('close');
    signal?.addEventListener('abort', abort, { once: true });
    response.once('finish', () => signal?.removeEventListener('abort', abort));
    const incoming = Object.assign(new EventEmitter(), { method, url, body, headers: { authorization: 'authored-fixture-user' } });
    const direct = router as unknown as { handle(request: Request, response: ExpressResponse, next: (error?: unknown) => void): void };
    direct.handle(incoming as Request, response as unknown as ExpressResponse, (error?: unknown) => {
      reject(error ?? new Error(`Unmatched authored fixture route ${url}`));
    });
  });
}

/** A controlled authenticated response stream, with the real Router retaining the lease. */
const watchServiceLease: SurfaceExtensionHost['watchServiceLease'] = (body, onEvent, signal) => new Promise<void>((done, reject) => {
  signal.throwIfAborted();
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200, writableEnded: false, headersSent: false,
    status(code: number) { this.statusCode = code; return this; }, setHeader() { return this; },
    flushHeaders() { this.headersSent = true; },
    write(frame: string) { onEvent(parseVarinSurfaceServiceLeaseEvent(JSON.parse(frame.slice(6).trim()))); return true; },
    end() { this.writableEnded = true; signal.removeEventListener('abort', abort); done(); return this; },
    json(value: unknown) { signal.removeEventListener('abort', abort); reject(new Error(JSON.stringify(value))); return this; },
  });
  const abort = () => response.emit('close'); signal.addEventListener('abort', abort, { once: true });
  const incoming = Object.assign(new EventEmitter(), { method: 'POST', url: '/api/varin/extensions/v1/services/lease', body,
    headers: { authorization: 'authored-fixture-user' } });
  const direct = router as unknown as { handle(request: Request, response: ExpressResponse, next: (error?: unknown) => void): void };
  direct.handle(incoming as Request, response as unknown as ExpressResponse, error => {
    signal.removeEventListener('abort', abort); reject(error ?? new Error('Unmatched authored Surface lease route'));
  });
});

async function initialize(frame: Record<string, unknown>) {
  grouped = frame.grouped === true;
  root = String(frame.root); runId = String(frame.runId); workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const storageRoot = String(frame.storageRoot);
  kernel = new KernelClient({ hostId: 'web-domain-host', hostGeneration: 'web-domain-generation', storageRoot, buildVersion: '0.9.25' });
  const transport = kernel as unknown as { epoch: string; started: boolean; handshakeResult: KernelHandshakeResult };
  transport.epoch = String(frame.epoch); transport.started = true;
  transport.handshakeResult = { hostId: 'web-domain-host', storageRoot, kernelEpoch: String(frame.epoch) } as KernelHandshakeResult;
  Object.defineProperty(kernel, 'requestRaw', { value: request });
  Object.defineProperty(kernel, 'write', { value: async (value: unknown) => { write(value); } });
  documents = createDocumentAuthority({ hostId: 'web-domain-host', dataDir: join(root, 'documents'),
    isTrusted: async () => true, isAllowedRoot: async candidate => candidate === workspace });
  const identity = await documents.resolveWorkspace({ path: workspace });
  const live = createLiveSourceOwner({ documents, kernel });
  extensions = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'extensions'), varinVersion: '0.9.25',
    brokerScript: resolve('packages/extension-host/broker/broker-child.mjs') });
  runtime = new AgentRuntimeClient(kernel, undefined, undefined, undefined, live.validate,
    createExtensionTools({ runtime: extensions, kernel, currentPolicy: async () => ({ mode: 'normal', rules: [] }) }),
    (workspaceId, signal) => documents.admitWorkspaceRegistration(workspaceId, signal));
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'web-domain-host', storageRoot,
    resolveWorkspaceRoot: async workspaceId => (await documents.inspectWorkspace(workspaceId)).root });
  extensions.capabilities.register(VARIN_EXTENSION_PACKAGES_CAPABILITY,
    createExtensionPackageOwner({ extensions, kernel, runtime, storage, resolveLiveSource: live.validate }));
  extensions.capabilities.register(VARIN_RUNTIME_CONTRACTS_CAPABILITY, createRuntimeContractOwner({ extensions, kernel }));
  extensions.capabilities.register(VARIN_RUNTIME_TOOLS_CAPABILITY, createNestedToolOwner(kernel));
  await extensions.start();
  const seed = await kernel.issueGrant({ grantId: 'authored-fixture-source', threadId: String(frame.threadId),
    owningWorkspace: identity.workspaceId, executionWorkspace: identity.workspaceId,
    capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
  try {
    await kernel.scoped(seed).createBranch({ operationId: 'authored-fixture-source-create', branchId: 'source:authored',
      workspaceId: identity.workspaceId, captureScopes: [], draftBasePaths: [], entries: [{ path: 'package', state: { kind: 'directory', mode: 493 } }] });
  } finally { await kernel.revokeGrant(seed.grantId); }
  selectedSource = { resource_owner: { kind: 'local' }, mode: 'materialized', workspace_id: identity.workspaceId, execution_workspace_id: identity.workspaceId,
    branch_id: 'source:authored', revision: 0, environment_run_id: null, live_root: null };
  router = express.Router();
  const auth = (incoming: Request, response: ExpressResponse, next: () => void) => {
    if (incoming.headers.authorization !== 'authored-fixture-user') return response.status(401).json({ error: 'unauthorized' });
    incoming.varinAuth = { type: 'client', clientId: 'authored-fixture-user', client: { id: 'authored-fixture-user' } }; next();
  };
  registerExtensionRoutes(router as unknown as Express, { extensionCatalog: extensions.catalog, extensionPackages: extensions.packages,
    extensionRuntime: extensions, uiAuthController: { requireAuth: auth, requireSessionAuth: auth } });
  const example = resolve('examples/extensions/agent-authored-panel');
  const files = await Promise.all((await readdir(example)).filter(name => !name.startsWith('.')).sort().map(async name => ({
    path: `package/${name}`, content: await readFile(join(example, name), 'utf8'),
  })));
  if (grouped) {
    const manifest = files.find(file => file.path === 'package/varin.extension.json'); assert(manifest);
    manifest.content = JSON.stringify({ ...JSON.parse(manifest.content), updateReadiness: { surfaceEntrypoints: ['panel'] } });
  }
  write({ kind: 'fixture-ready', source: selectedSource, files });
}

async function handle(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-response') {
    const waiting = pending.get(String(frame.id)); assert(waiting); pending.delete(String(frame.id));
    if (frame.ok) waiting.resolve(frame.result); else waiting.reject(new Error(`${waiting.method}: ${String(frame.error)}`));
    return;
  }
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (frame.kind === 'fixture-start') {
    await runtime.startFromSource(savedSourceLaunch(runId, selectedSource, ['file_read', 'file_write']));
    write({ kind: 'fixture-started' }); return;
  }
  if (frame.kind === 'fixture-user-enable') {
    const before = await extensions.catalog.snapshot(), entry = before.extensions.find(value => value.manifest.id === id);
    assert(entry); initialIntegrity = entry.integrity!; assert.equal(entry.desired.enabled, false); assert.equal(entry.capabilityGrants.length, 0);
    assert(!extensions.services.getSnapshot().providers.some(provider => provider.extensionId === id));
    await route('PATCH', `/api/varin/extensions/v1/extensions/${id}/enabled`, { enabled: true, expectedRevision: before.revision });
    const selectedService = await extensions.prepareService({ serviceId: 'example.agent-authored-panel.count', version: 1, method: 'execute', args: [] });
    try { originalService = selectedService.pin(); } finally { selectedService.release(); }
    assert(extensions.services.getSnapshot().providers.some(provider => provider.extensionId === id && provider.status === 'active'),
      'A selected initial version does not acquire a permanent Surface-presence gate');
    const consumer: { createAuthoredPanelConsumer(host: SurfaceExtensionHost): Promise<PanelConsumer> } = await import(
      pathToFileURL(resolve('packages/ui/src/lib/extensions/authored-surface-consumer.test-support.ts')).href);
    panel = await consumer.createAuthoredPanelConsumer({
      activateExtension: extensionId => extensions.activateExtension(extensionId),
      catalog: async () => ({ supported: true, status: 'ready', snapshot: await extensions.catalog.snapshot() }),
      hostState: () => extensions.state(),
      watchServiceLease,
      invokeService: async (request, signal) => parseVarinToolJson((await route('POST', '/api/varin/extensions/v1/services/invoke', request, signal)).result),
      prepareCandidate: (extensionId, integrity, signal) => extensions.prepareCandidate(extensionId, integrity, signal),
      requestCandidateApplication: request => extensions.requestCandidateApplication(request),
      selectCandidate: (request, signal) => extensions.selectCandidate(request, signal),
      discardPreparedCandidate: (extensionId, integrity) => extensions.discardPreparedCandidate(extensionId, integrity),
      readAsset: request => extensions.packages.readAsset(request),
      readManagedEntrypoint: request => extensions.packages.readManagedEntrypoint(request),
      reportActualState: (extensionId, state) => extensions.reportActualState(extensionId, state),
      waitForHostState: (request, signal) => extensions.waitForState(request, signal),
    });
    await panel.start();
    const section = sectionOf(panel);
    assert(section, `The generated package must reach its real Workbench mount: ${JSON.stringify({ loader: panel.loader.getSnapshot(), errors: panel.errors.map(String) })}`);
    assert(panel.styles.some(style => style.committed && !style.disposed));
    firstSection = section; firstStyles = panel.styles.filter(style => style.committed && !style.disposed);
    write({ kind: 'fixture-enabled', catalogRevision: (await extensions.catalog.snapshot()).revision }); return;
  }
  if (frame.kind === 'fixture-await-tool') {
    const name = String(frame.name), deadline = Date.now() + 60_000;
    for (;;) {
      const inspection = await runtime.inspectTools(runId);
      const preparing = inspection.preparations.find(item => item.declarations.some(declaration => declaration.tool?.name === name));
      assert.notEqual(preparing?.status, 'unavailable', JSON.stringify(preparing));
      if (preparing?.status === 'ready') break;
      assert(Date.now() < deadline, `Original directory did not prepare ${name}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    write({ kind: 'fixture-tool-ready', name }); return;
  }
  if (frame.kind === 'fixture-check-update') {
    assert(panel); assert(firstSection);
    const snapshot = await extensions.catalog.snapshot();
    const entry = snapshot.extensions.find(value => value.manifest.id === id);
    if (grouped && frame.label === 'broken') {
      assert.equal(entry?.integrity, initialIntegrity, 'Failed required Surface preparation cannot select a newer Host');
      assert.equal(entry?.candidate?.integrity, frame.integrity);
      assert.equal(entry?.candidate?.applyRequested, true);
    } else if (!grouped) assert.equal(entry?.integrity, frame.integrity);
    assert.equal(entry?.manifest.version, '1.0.0', 'Same-semver revisions use actual artifact identity');
    const surfaceDeadline = Date.now() + 30_000;
    for (;;) {
      const state = panel.loader.getSnapshot();
      const settled = frame.label === 'broken'
        ? state.diagnostics.some(item => item.code === (grouped ? 'candidate_module_activation_failed' : 'module_activation_failed') && item.integrity === frame.integrity)
        : state.active.some(item => item.integrity === frame.integrity);
      if (settled) break;
      assert(Date.now() < surfaceDeadline, 'Actual Surface watch did not consume the selected artifact');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (frame.label === 'broken') {
      assert.equal(sectionOf(panel), firstSection, 'A failed real mount keeps its visible original owner');
      assert.equal(firstSection.dataset.closed, undefined);
      assert(firstStyles.every(style => style.committed && !style.disposed));
      assert(panel.loader.getSnapshot().diagnostics.some(item => item.code === (grouped ? 'candidate_module_activation_failed' : 'module_activation_failed')));
    } else {
      const current = sectionOf(panel);
      assert(current); assert.notEqual(current, firstSection);
      assert(current.children[1]!.textContent.endsWith('updated'));
      assert.equal(firstSection.dataset.closed, 'true');
      assert(firstStyles.every(style => style.disposed));
    }
    assert(extensions.services.getSnapshot().providers.some(provider => provider.extensionId === id && provider.status === 'active'));
    assert(originalService); originalService.assertAvailable();
    assert.deepEqual(await originalService.invoke('execute', [{ text: 'hello 源 world' }]), { words: 3, characters: 13 });
    if (grouped && frame.label === 'broken') {
      assert.equal((await extensions.catalog.snapshot()).extensions.find(value => value.manifest.id === id)?.integrity, initialIntegrity);
      assert(!readyArtifacts.has(String(frame.integrity)), 'A failed required member cannot publish the new Run directory');
      write({ kind: 'fixture-update-checked', label: frame.label }); return;
    }
    assert.equal((await extensions.catalog.snapshot()).extensions.find(value => value.manifest.id === id)?.integrity, frame.integrity);
    const directoryDeadline = Date.now() + 30_000;
    while (!readyArtifacts.has(String(frame.integrity))) {
      assert(Date.now() < directoryDeadline, 'Updated artifact did not reach original tools.ready');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    write({ kind: 'fixture-update-checked', label: frame.label }); return;
  }
  if (frame.kind === 'fixture-finish') {
    const current = await extensions.catalog.snapshot(), entry = current.extensions.find(value => value.manifest.id === id);
    assert(entry); assert.equal(entry.source.kind, 'source_view');
    assert(forwarded.includes('file.captureBatch')); assert(forwarded.includes('storage.getBlob'));
    assert(panel); assert.equal(panel.errors.length, 0);
    const mounted = Array.from(panel.container.children);
    await panel.close();
    assert.equal(panel.container.children.length, 0);
    assert(mounted.every(child => child.children.length === 0));
    assert(panel.styles.every(style => style.disposed));
    assert(extensions.services.getSnapshot().providers.some(provider => provider.extensionId === id && provider.status === 'active'),
      'Closing the Surface must not stop its independent backend');
    assert(originalService); originalService.release();
    const deadline = Date.now() + 30_000;
    while (extensions.services.getSnapshot().providers.some(provider => provider.providerId === originalService!.providerId)) {
      assert(Date.now() < deadline, 'Original pinned service did not retire after its actual release');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await extensions.stop(); await documents.dispose();
    write({ kind: 'fixture-finished', catalogRevision: current.revision, entry, methods: [...new Set(forwarded)] }); return;
  }
  Reflect.apply((kernel as unknown as { consumeFrame(value: unknown): void }).consumeFrame, kernel, [frame]);
}
createInterface({ input: process.stdin }).on('line', line => {
  void handle(JSON.parse(line) as Record<string, unknown>).catch(error => write({ kind: 'fixture-failed', error: String(error),
    stack: error instanceof Error ? error.stack : undefined }));
});
