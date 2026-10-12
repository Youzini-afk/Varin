/** Real original source/Experiment/reader owners; only IPC delivery and the provider are controlled.
 * Existing collected artifact records are seeded here, not claimed as new compute-job evidence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { WEB_CAPABILITY, VARIN_BUILTIN_WEB_EXTENSION_ID } from '@varin/extension-builtins';
import { createThreadsHttpAPI, type ThreadResearchSelection } from '@varin/application-client';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { KernelStorageAdapter } from './storage-adapter.js';
import { createMaterialStorageAccess } from './material-storage.js';
import { createWebRuntime } from './web-runtime.js';
import { createDocumentSources } from './document-sources.js';
import { createLiveSourceOwner } from './live-source.js';
import { originalMaterializationLocation } from './source-launch.js';
import { createExtensionTools, type ExtensionToolScope } from './extension-tool-owner.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import type { LaunchSource } from './protocol.generated.js';
import { createWebFetch } from '../harness/web-fetch.js';
import { createWebMaterialStore } from '../harness/web-materials.js';
import { createDocumentReader } from '../harness/document-reading.js';
import { createExperimentService } from '../harness/experiments.js';
import { createResourceService } from '../harness/resources.js';
import { createMaterialReviewFixture, writeMaterialFixtureFrame as write } from './material-review-fixture.test-helper.js';
import { makePdf } from '../harness/pdf-test-fixture.js';
import { createDocumentAuthority, type DocumentAuthority } from '../documents/authority.js';
let documents: DocumentAuthority;
const fixture = createMaterialReviewFixture(params => {
  assert.equal(params.sessionId, undefined);
  if (String(params.grantId).startsWith('material:')) {
    assert.deepEqual(params.capabilities, (params.capabilities as string[]).filter(value => value === 'storage.read' || value === 'storage.write' || value === 'storage.maintenance'));
    assert.equal(params.runId, undefined);
    assert.deepEqual(params.pathScopes, []);
  }
  if (String(params.grantId).startsWith('source:')) {
    assert.deepEqual(params.capabilities, ['storage.read', 'storage.write']);
    assert.equal(params.operationId, undefined);
    assert.equal(params.runId, selection.sourceRunId);
  }
}, (id, signal) => documents.admitWorkspaceRegistration(id, signal));
const { kernel, runtime, bridge } = fixture;
let extensions: ApplicationExtensionRuntime, selected: ExtensionToolScope | undefined;
let web: ReturnType<typeof createWebRuntime>, storage: KernelStorageAdapter;
let experiments: ReturnType<typeof createExperimentService>, resources: ReturnType<typeof createResourceService>;
let selection: ThreadResearchSelection, source: LaunchSource, physical = '';
const unreachable = async (): Promise<never> => { throw new Error('PDF source read unexpectedly started network, compute, or model work'); };
const pdf = (label: string) => Buffer.concat([Buffer.from(makePdf().toString('latin1').replace('LEFT', label), 'latin1'), Buffer.from('\n%' + 'x'.repeat(label === 'FIXD' ? 13 * 1024 * 1024 : 300_000))]);
async function initialize(frame: Record<string, unknown>) {
  fixture.initialize(frame);
  const root = String(frame.root), storageRoot = String(frame.storageRoot), mode = String(frame.mode);
  selection = { runtime: 'agent', threadId: String(frame.threadId), branchId: String(frame.branchId), sourceRunId: String(frame.runId) };
  physical = join(root, 'live'); await mkdir(physical, { recursive: true });
  const registeredRoot = physical;
  documents = createDocumentAuthority({ hostId: 'web-domain-host', dataDir: join(root, 'documents'),
    isTrusted: async candidate => candidate === registeredRoot, isAllowedRoot: async candidate => candidate === registeredRoot });
  const { workspaceId } = await documents.resolveWorkspace({ path: registeredRoot });
  const live = createLiveSourceOwner({ kernel, documents });
  if (!frame.readerOnly) {
    const seed = await kernel.issueGrant({ grantId: 'pdf-fixture-seed', threadId: selection.threadId, runId: selection.sourceRunId, owningWorkspace: workspaceId, executionWorkspace: workspaceId,
      capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
    const actor = kernel.scoped(seed);
    const fixedBytes = pdf('FIXD');
    const blob = await actor.putBlob(fixedBytes, 'fixture-fixed-pdf');
    await actor.createBranch({ operationId: 'fixture-source', workspaceId, branchId: 'source:pdf',
      captureScopes: [], draftBasePaths: [], entries: [{ path: 'paper.pdf', ownerId: blob.ownerId,
        state: { kind: 'regular-file', objectHash: blob.hash, byteLength: fixedBytes.byteLength, mode: 420 } }] });
    await actor.releaseBlob(blob.ownerId);
    source = mode === 'live_root'
      ? { mode, workspace_id: workspaceId, execution_workspace_id: workspaceId, branch_id: null, revision: null,
        live_root: await live.prepare(workspaceId, workspaceId, selection.threadId) }
      : { mode: mode as 'materialized' | 'fixed_branch', workspace_id: workspaceId, execution_workspace_id: workspaceId,
        branch_id: 'source:pdf', revision: 0, live_root: null };
    await writeFile(join(physical, 'paper.pdf'), pdf('LIVE'));
    if (mode === 'materialized') {
      const location = await originalMaterializationLocation(storageRoot, source.workspace_id, selection.sourceRunId);
      const container = await actor.fileRootRegister({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, canonicalRoot: storageRoot });
      const branch = await actor.readBranch({ branchId: 'source:pdf', revision: 0, includeEntries: false });
      await actor.fileMaterialize({ operationId: 'fixture-materialize', workspaceId: source.workspace_id, rootId: String(container.rootId),
        path: location.relativeTarget, sourceRoot: branch.root });
      physical = location.targetPath;
      await writeFile(join(physical, 'paper.pdf'), pdf('COPY'));
    }
    const artifact = await actor.putBlob(pdf('BLOB'), 'fixture-artifact-pdf');
    const owner = { runtime: 'agent', actor: { kind: 'user', key: 'collected-fixture' }, rootThreadId: selection.threadId,
      threadId: selection.threadId, branchId: selection.branchId, runId: selection.sourceRunId, operationId: 'existing:collection',
      executionOwner: { kind: 'external', epoch: 'collected-fixture', identity: 'existing:collection' }, source };
    const base = { workspaceId: source.workspace_id, threadId: selection.threadId, runId: selection.sourceRunId,
      ownerIds: [], references: [] };
    await actor.putRecord({ ...base, operationId: 'fixture-attempt', recordId: 'experiment.attempt:attempt:pdf', recordType: 'experiment.attempt', state: 'completed',
      payloadJson: JSON.stringify({ id: 'attempt:pdf', specId: 'spec:pdf', backend: 'local', cancelRequested: false,
        collection: 'done', spawnDispatched: true, collectionCompletion: { recordRevision: 1, outcome: 'done' }, researchOwner: owner, executionWorkspaceId: source.execution_workspace_id, workspaceScope: [''] }) });
    const jobId = `job-${createHash('sha256').update('attempt:pdf').digest('hex').slice(0, 40)}`;
    await actor.putRecord({ ...base, operationId: 'fixture-job', recordId: `experiment.job:${jobId}`, recordType: 'experiment.job', state: 'released',
      payloadJson: JSON.stringify({ id: jobId, attemptId: 'attempt:pdf', backend: 'local', executorStopped: true, outputDrained: true, researchOwner: owner, executionWorkspaceId: source.execution_workspace_id }) });
    await actor.putRecord({ ...base, operationId: 'fixture-artifact', recordId: 'experiment.artifact:artifact:pdf', recordType: 'experiment.artifact', state: 'available',
      payloadJson: JSON.stringify({ id: 'artifact:pdf', attemptId: 'attempt:pdf', name: 'collected.pdf', kind: 'file', byteLength: artifact.byteLength,
        researchOwner: owner, executionWorkspaceId: source.execution_workspace_id }),
      ownerIds: [artifact.ownerId], references: [{ slot: 'content', objectHash: artifact.hash }] });
    await actor.releaseBlob(artifact.ownerId); await kernel.revokeGrant(seed.grantId);
  }
  storage = new KernelStorageAdapter({ client: kernel, hostId: 'web-domain-host', storageRoot, resolveWorkspaceRoot: unreachable });
  const access = createMaterialStorageAccess({ kernel, storage, legacy: { withBranchStore: unreachable } });
  const materials = createWebMaterialStore(access), documentReader = createDocumentReader({ materials });
  resources = createResourceService({ client: kernel });
  experiments = createExperimentService({ client: kernel, resources, resolveWorkspaceRoot: unreachable, resolveBackend: unreachable,
    onError: error => write({ kind: 'fixture-failed', error: error.stack }) });
  const documentSources = createDocumentSources({ kernel, runtime, resolveLiveSource: live.validate, experiments });
  const webFetch = createWebFetch({ ssrf: { check: unreachable, isSameHost: () => false }, materials, documentReader });
  web = createWebRuntime({ runtime, webFetch, documentReader, documentSources, materials, fetch: unreachable, readAuth: unreachable,
    settings: async () => ({ global: {}, globalRevision: 'default', project: {}, projectRevision: 'none', projectTrusted: false }) });
  if (frame.readerOnly) { write({ kind: 'fixture-reader-ready' }); return; }
  extensions = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'extensions'), varinVersion: '0.9.25',
    brokerScript: join(resolve('.'), 'packages/extension-host/broker/broker-child.mjs') });
  extensions.capabilities.register(WEB_CAPABILITY, web.capability);
  await extensions.start(); await extensions.activateExtension(VARIN_BUILTIN_WEB_EXTENSION_ID);
  const prepare = createExtensionTools({ runtime: extensions, kernel, currentPolicy: async () => ({ mode: 'normal', rules: [] }),
    prepareConfiguration: (run, required) => web.prepareConfiguration(run, required) });
  selected = await prepare({ threadId: selection.threadId, runId: selection.sourceRunId, source }, [], new AbortController().signal);
  const document = selected.initial.find(entry => entry.binding.tool.name === 'document_read'); assert(document);
  const registered = bridge.register(selection.sourceRunId, document.lease);
  write({ kind: 'fixture-prepared', source, bindings: [{ ownerId: registered.ownerId, generation: document.generation, binding: document.binding }] });
}
async function publicRead(frame: Record<string, unknown>) {
  const adapter = new ThreadAdapter(runtime, { resolveModel: unreachable, rebindModel: unreachable }, unreachable, unreachable);
  const routes = new Map<string, RequestHandler[]>();
  const app = { post(path: string, ...handlers: RequestHandler[]) { routes.set(path, handlers); }, get() {} } as unknown as Express;
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers.authorization !== 'fixture-pdf-user') { response.status(401).end(); return; } next();
  }, undefined, undefined, web.user);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit): Promise<Response> => {
    const handlers = routes.get(new URL(String(input), 'https://application.invalid').pathname); assert(handlers);
    let status = 200, output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; }, json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; }, setHeader() { return this; } });
    const request = Object.assign(new EventEmitter(), { body: JSON.parse(String(init?.body)), headers: { authorization: 'fixture-pdf-user' } });
    await new Promise<void>((resolve, reject) => {
      let index = 0; const next = (error?: unknown) => {
        if (error) { reject(error); return; } const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(request as Request, response as unknown as ExpressResponse, next)).then(() => { if (response.writableEnded) resolve(); }, reject);
      }; next();
    });
    return Response.json(output ?? {}, { status });
  }) as typeof globalThis.fetch;
  try {
    const api = createThreadsHttpAPI();
    const identity = { runtime: selection.runtime, threadId: selection.threadId, branchId: selection.branchId };
    await writeFile(join(physical, 'paper.pdf'), pdf('EDIT'));
    const local = await api.materials.read(identity, { snapshotId: String(frame.local), view: 'text', pages: 'all' });
    assert.equal(local.status, 'ok'); if (local.status !== 'ok') throw new Error('retained local PDF unavailable');
    assert(local.markdown?.includes(String(frame.expected))); assert(!local.markdown?.includes('EDIT'));
    const request = { artifact: { attemptId: 'attempt:pdf', artifactId: 'artifact:pdf' }, view: 'text' as const, pages: 'all' as const };
    const result = await api.materials.readArtifact(selection, request); assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('original artifact read failed'); assert(result.markdown?.includes('BLOB'));
    const image = await api.materials.read(identity, { snapshotId: result.snapshot!.snapshotId, view: 'page-image', page: 1 });
    assert.equal(image.status, 'ok'); if (image.status !== 'ok') throw new Error('retained artifact image unavailable');
    const bytes = image.pageImage ?? image.pageImages?.[0]; assert(bytes); assert.equal(Buffer.from(bytes.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await assert.rejects(api.materials.readArtifact({ ...selection, sourceRunId: 'missing:run' }, request));
    await assert.rejects(api.materials.readArtifact({ ...selection, threadId: 'thread:foreign', branchId: 'branch:foreign' }, request));
    const wrong = await api.materials.read({ runtime: 'agent', threadId: 'thread:foreign', branchId: 'branch:foreign' }, { snapshotId: result.snapshot!.snapshotId });
    assert.equal(wrong.status, 'snapshot-missing');
    write({ kind: 'fixture-public-result', ok: true });
  } finally { globalThis.fetch = originalFetch; }
}
async function receive(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (fixture.receive(frame)) return;
  if (frame.kind === 'fixture-public') return publicRead(frame);
  if (frame.kind === 'fixture-finish') {
    selected?.close(); await bridge.close(); if (extensions) await extensions.stop(); await experiments.dispose(); await resources.dispose(); await storage.dispose(); await documents.dispose();
    write({ kind: 'fixture-finished' }); return;
  }
  throw new Error(`Unexpected PDF source frame ${JSON.stringify(frame)}`);
}
createInterface({ input: process.stdin }).on('line', line => {
  void receive(JSON.parse(line) as Record<string, unknown>).catch(error => write({ kind: 'fixture-failed', error: error instanceof Error ? error.stack : String(error) }));
});
