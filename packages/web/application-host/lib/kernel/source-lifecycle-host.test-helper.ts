import { AgentSettingsService } from '../models/settings.js';
/** Public Thread source lifecycle with original owners; only HTTP/IPC delivery and model bytes are controlled. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Express, Request, RequestHandler, Response as ExpressResponse } from 'express';
import { createThreadsHttpAPI, ThreadRequestError, type ThreadIdentity, type ThreadSource, type ThreadPrepareSource, type ThreadPreparedSource } from '@varin/application-client';
import { createDocumentAuthority } from '../documents/authority.js';
import { spawn } from 'node:child_process';
import { createSourceGitInventory } from './source-git-inventory.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { KernelClient, KernelClientError, type KernelGrantHandle } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';
import { createThreadSourceAdmission, createThreadSourcePreparer } from './thread-sources.js';
import { createThreadResourceScope } from './thread-resource-scope.js';
import { createThreadContext } from './thread-context.js';
import { createLiveSourceOwner } from './live-source.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { ContextService } from './context-service.js';
import { createMemoryOwner } from './memory-owner.js';
import { readContextPolicy } from './context-settings.js';
import { originalMaterializationLocation } from './source-launch.js';
import { createResearchSourceAuthority } from './research-source.js';
import type { ExperimentCaller } from '../harness/research-identity.js';
import type { HostJobPending, KernelHandshakeResult } from './protocol.generated.js';
const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let sequence = 0, root = '', storageRoot = '', trusted = true, authentication = true;
let kernel: KernelClient, runtime: AgentRuntimeClient, storage: KernelStorageAdapter;
let documents: ReturnType<typeof createDocumentAuthority>, adapter: ThreadAdapter;
let api: ReturnType<typeof createThreadsHttpAPI>;
let identity: ThreadIdentity, source: ThreadSource, firstRun = '', pendingRun = '';
let sourceRequest: ThreadPrepareSource, preparedSource: ThreadPreparedSource;
const grants: string[] = [], failures: string[] = [];
const methods: string[] = [];
const model = { providerId: 'controlled', modelId: 'source-lifecycle' };
function request(method: string, params: unknown, options: { grant?: KernelGrantHandle } = {}) {
  methods.push(method);
  if (options.grant) kernel.assertGrantForScope(options.grant);
  const id = `source-lifecycle:${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ kind: 'fixture-request', id, method, params, ...(options.grant ? { grantId: options.grant.grantId } : {}) });
  });
}
function installHttp() {
  const routes = new Map<string, RequestHandler[]>();
  const app = { post(route: string, ...handlers: RequestHandler[]) { routes.set(route, handlers); }, get() {} } as unknown as Express;
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers.authorization !== 'source-lifecycle-user') { response.status(401).json({ code: 'authentication-required' }); return; }
    next();
  });
  globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const handlers = routes.get(new URL(String(input), 'https://application.invalid').pathname); assert(handlers);
    let status = 200, output: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false,
      status(value: number) { status = value; return this; },
      json(value: unknown) { output = value; this.writableEnded = true; return this; },
      end() { this.writableEnded = true; return this; }, setHeader() { return this; } });
    const request = Object.assign(new EventEmitter(), { body: JSON.parse(String(init?.body)), headers: { authorization: authentication ? 'source-lifecycle-user' : 'denied-user' } });
    await new Promise<void>((resolve, reject) => {
      let index = 0; const next = (error?: unknown) => {
        if (error) { reject(error); return; }
        const handler = handlers[index++]; if (!handler) { resolve(); return; }
        Promise.resolve(handler(request as Request, response as unknown as ExpressResponse, next)).then(() => { if (response.writableEnded) resolve(); }, reject);
      }; next();
    });
    return Response.json(output ?? {}, { status });
  }) as typeof fetch;
  api = createThreadsHttpAPI();
}
async function initialize(frame: Record<string, unknown>) {
  root = String(frame.root); storageRoot = String(frame.storageRoot);
  const agentDir = join(root, 'agent'), workspace = join(root, 'workspace');
  await mkdir(agentDir, { recursive: true }); await mkdir(join(root, 'home'), { recursive: true });
  kernel = new KernelClient({ hostId: 'web-domain-host', hostGeneration: 'web-domain-generation', storageRoot, buildVersion: '0.9.25' });
  const transport = kernel as unknown as { epoch: string; started: boolean; handshakeResult: KernelHandshakeResult; consumeFrame(frame: unknown): void };
  transport.epoch = String(frame.epoch); transport.started = true;
  transport.handshakeResult = { hostId: 'web-domain-host', storageRoot, kernelEpoch: String(frame.epoch) } as KernelHandshakeResult;
  Object.defineProperty(kernel, 'requestRaw', { value: request });
  Object.defineProperty(kernel, 'write', { value: async (frame: unknown) => { write(frame); } });
  const issue = kernel.issueGrant.bind(kernel);
  kernel.issueGrant = async (params, signal) => { const grant = await issue(params, signal); grants.push(grant.grantId); return grant; };
  runtime = new AgentRuntimeClient(kernel, undefined, undefined, undefined, undefined, undefined,
    (workspaceId, signal) => documents.admitWorkspaceRegistration(workspaceId, signal));
  documents = createDocumentAuthority({ hostId: 'web-domain-host', dataDir: join(root, 'documents'), isTrusted: async () => trusted,
    isAllowedRoot: async candidate => candidate === workspace });
  storage = new KernelStorageAdapter({ client: kernel, hostId: 'web-domain-host', storageRoot,
    resolveWorkspaceRoot: async workspaceId => (await documents.admitWorkspaceRegistration(workspaceId)).canonicalPath });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage), liveSources = createLiveSourceOwner({ documents, kernel });
  const inspectInventory = createSourceGitInventory({ spawn, gitBinary: 'git', env: process.env });
  const withSourceRead = storage.withResourceRead.bind(storage);
  const resources = createThreadResourceScope({ dataDirectory: agentDir, homeDir: join(root, 'home'), documents, workingStates,
    validateLiveSource: liveSources.validate, projectTrusted: async () => trusted, configuration: async () => ({ packages: [] }), withSourceRead });
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'source-project' }) });
  const prepareContext = createThreadContext({ resources, personalization, projectForWorkspace: async id => {
    await documents.admitWorkspaceRegistration(id); return 'source-project';
  } });
  kernel.setMemoryOwner(createMemoryOwner({ personalization, prepareContext }));
  const configuration = { providerFamily: 'openai-responses', model: model.modelId, endpoint: 'https://controlled.invalid/responses',
    credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const credentialOwner = new ExistingHostCredentialOwner({ providerId: model.providerId, providerFamily: configuration.providerFamily,
    endpoint: configuration.endpoint, currentScope: async () => ({ reference: 'controlled-source', authority: 'fixture-owner', account: 'controlled', generation: 1 }),
    runtime: { getAuth: async () => { throw new Error('Controlled model must not request external credentials'); } } });
  const prepareSource = createThreadSourcePreparer({ inspectInventory,
    sourceTools: mode => kernel.agentRuntimeRequest('runtime.source.tools', { mode }), documents, workingStates, liveSources,
    prepareResources: resources.prepareSourceCapture });
  adapter = new ThreadAdapter(runtime, { resolveModel: async selected => { assert.deepEqual(selected, model); return { configuration, credentialOwner }; },
    rebindModel: async () => credentialOwner }, createThreadSourceAdmission({ documents, liveSources, runtime, withSourceRead }),
    (_run, error) => {
      failures.push(String(error));
      console.error('Source lifecycle launch result:', error instanceof Error ? error.name : typeof error,
        error && typeof error === 'object' && 'code' in error ? error.code : 'unclassified');
    },
    async (input, signal) => {
      try { return await prepareSource(input, signal); }
      catch (error) { console.error('Source lifecycle preparation:', error); throw error; }
    }, prepareContext);
  kernel.setContextOwner(new ContextService(runtime, prepareContext, async (run, launch, signal) => {
    const selected = launch?.selection.source;
    const registration = selected ? await documents.admitWorkspaceRegistration(selected.workspace_id) : undefined;
    const policy=await readContextPolicy({ settings: await new AgentSettingsService(agentDir, () => trusted).snapshot(registration?.canonicalPath), ...(registration ? { projectRoot: registration.canonicalPath } : {}), modelId: model.modelId, providerId: model.providerId });
    const admitted=await runtime.contextScope(run.id,signal);
    return {policy,scope:{threadId:run.thread_id,...(admitted?.projectId?{projectId:admitted.projectId}:{}),
      ...(registration?{workspaceId:registration.canonicalPath}:{})}};
  }, async runId => adapter.continueLaunch(runId), null));
  installHttp();
  if (frame.reopen) {
    const saved = JSON.parse(await readFile(join(root, 'lifecycle.json'), 'utf8')) as { identity: ThreadIdentity; source: ThreadSource; firstRun: string; pendingRun: string; sourceRequest: ThreadPrepareSource; preparedSource: ThreadPreparedSource };
    ({ identity, source, firstRun, pendingRun, sourceRequest, preparedSource } = saved);
    await documents.admitWorkspaceRegistration(source.workspaceId);
    assert.deepEqual(await api.prepareSource(sourceRequest), preparedSource);
    console.error('Source lifecycle: original registration reopened', source.mode);
    write({ kind: 'fixture-ready', reopened: true }); return;
  }
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'WRONG_SAVED_INSTRUCTIONS\n');
  await writeFile(join(workspace, 'source.txt'), 'WRONG_SAVED_SOURCE_BYTES\n');
  authentication = false;
  await assert.rejects(api.create('unauthenticated'), error => error instanceof ThreadRequestError && error.status === 401);
  authentication = true;
  identity = await api.create('source-lifecycle');
  const workspaceId = (await documents.resolveWorkspace({ path: workspace })).workspaceId;
  const consumer = { kind: 'thread' as const, threadId: identity.threadId, branchId: identity.branchId };
  const ownerId = 'source-lifecycle-editor', generation = 1;
  const draftResources = [
    { resource: { workspaceId, resourceId: 'AGENTS.md' }, baseRevision: null, localEditRevision: 1,
      content: 'ORIGINAL_SOURCE_INSTRUCTIONS: Always identify the preserved source.\n', encoding: 'utf-8', bom: false, lineEnding: 'lf' as const },
    { resource: { workspaceId, resourceId: 'source.txt' }, baseRevision: null, localEditRevision: 1,
      content: 'ORIGINAL_SOURCE_BYTES\r\n', encoding: 'utf-8', bom: true, lineEnding: 'crlf' as const },
  ].map(resource => ({ ...resource, documentInstanceId: `document:${resource.resource.resourceId}`,
    bufferHash: `sha256-${createHash('sha256').update(resource.content.replace(/\r\n/g, '\n')).digest('hex')}` }));
  let editorResources = draftResources;
  const publishDrafts = () => documents.publishDirtyBuffers({ ownerId, generation, workspaceId,
    resources: editorResources.map(({ content: _content, ...resource }) => resource) });
  const surface = documents.registerDirtySurface({ ownerId, generation, workspaceId }, event => {
    if (!event || typeof event !== 'object' || !('kind' in event) || event.kind !== 'dirty-state-barrier'
      || !('action' in event) || event.action !== 'acquire' || !('barrierId' in event) || typeof event.barrierId !== 'string') return;
    const barrierId = event.barrierId;
    void publishDrafts().then(() => documents.acknowledgeDirtyStateBarrier({ ownerId, generation, workspaceId, barrierId }))
      .catch(error => { failures.push(String(error)); });
  });
  await publishDrafts();
  const context = await documents.captureAgentInputSnapshot({ ownerId, generation, consumer, resources: draftResources });
  assert.equal(context.source, 'surface');
  // A later editor change must neither replace this fixed input nor be overwritten by capture.
  editorResources = draftResources.map(resource => ({ ...resource, localEditRevision: 2, content: 'LATER_UNSAVED_DRAFT\n',
    bufferHash: `sha256-${createHash('sha256').update('LATER_UNSAVED_DRAFT\n').digest('hex')}` }));
  await publishDrafts();
  const fixedRequest = { ...identity, resourceOwner: { kind: 'local' as const }, key: 'baseline', workspaceId, mode: frame.sourceMode as 'fixed_branch' | 'materialized',
    content: { mode: 'surface-drafts' as const, context }, captureScopes: [] };
  const prepared = await api.prepareSource(fixedRequest);
  sourceRequest = fixedRequest; preparedSource = prepared;
  assert(prepared.provenance && prepared.provenance.consistency !== 'fixed-root');
  assert.equal(prepared.provenance.contentMode, 'fixed-draft-baseline');
  assert.equal(prepared.provenance.drafts?.snapshotRef, context.source === 'surface' && context.snapshot.status === 'ready' ? context.snapshot.ref : null);
  assert.equal(documents.releaseAgentInputSnapshot(consumer, context).released, true);
  assert.equal(documents.cloneInputSnapshot(consumer, context).status, 'unavailable');
  assert.equal(await readFile(join(workspace, 'source.txt'), 'utf8'), 'WRONG_SAVED_SOURCE_BYTES\n');
  assert(editorResources.every(resource => resource.content === 'LATER_UNSAVED_DRAFT\n' && resource.localEditRevision === 2));
  surface.close();
  source = { ...prepared.source, tools: ['file_read'] };
  assert(source.mode !== 'live_root');
  await workingStates.withBranchStore(workspaceId, 'verify-source-draft-root', async store => {
    await store.collectUnreachableObjects();
    const entry = await store.readPath(source.branchId!, 'source.txt', { revision: 0 }); assert(entry);
    assert.deepEqual(await store.readContent(entry), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ORIGINAL_SOURCE_BYTES\r\n')]));
  }, 'shared', { threadId: identity.threadId });
  // Move the actual branch head using its original writer before hiding the live directory.
  await workingStates.withBranchStore(source.workspaceId, 'diverge-source-head', async store => {
    const branch = await store.getBranchRoot(source.branchId!); assert(branch);
    const bytes = Buffer.from('WRONG_NEW_HEAD\n'), body = await store.putObject(bytes);
    const changed = await store.commitVirtualWrites(source.branchId!, branch.writeRevision, { 'source.txt': { kind: 'regular-file', objectHash: body.hash, byteLength: bytes.byteLength, mode: 420 } });
    assert.equal(changed.status, 'committed'); assert.notEqual(changed.root, branch.root);
  }, 'shared', { threadId: identity.threadId });
  await writeFile(join(workspace, 'AGENTS.md'), 'WRONG_LIVE_INSTRUCTIONS\n');
  await writeFile(join(workspace, 'source.txt'), 'WRONG_LIVE_BYTES\n');
  await rename(workspace, join(root, 'moved-workspace'));
  assert.deepEqual(await api.prepareSource(fixedRequest), prepared);
  console.error('Source lifecycle: actual baseline captured, branch head diverged, live root moved', source.mode);
  write({ kind: 'fixture-ready', source, identity });
}
async function submit(key: string, explicitSource = true) {
  const branch = (await runtime.thread(identity.threadId)).branches.find(branch => branch.branch_id === identity.branchId)!;
  const receipt = await api.submit({ ...identity, key, expectedHead: branch.head, text: `Read preserved source ${key}`, model,
    ...(explicitSource ? { source } : {}) });
  // This is the same owner used by the public submit and reconnect/rebind paths.
  await adapter.continueLaunch(receipt.run_id);
  await waitRun(receipt.run_id);
  return receipt.run_id;
}
async function waitRun(runId: string) {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const run = await runtime.run(runId);
    if (run.state === 'completed') break;
    assert(!['failed', 'cancelled'].includes(run.state), JSON.stringify(run));
    assert(Date.now() < deadline, 'Original Run did not finish');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const checkpoint = await runtime.context(identity.branchId); assert(checkpoint);
  assert(checkpoint.proposal.effective_system_prompt.includes('ORIGINAL_SOURCE_INSTRUCTIONS'));
  assert(!checkpoint.proposal.effective_system_prompt.includes('WRONG_LIVE_INSTRUCTIONS'));
  assert.equal(failures.length, 0, failures.join('\n'));
}
async function rejectedSources() {
  assert(source.mode !== 'live_root');
  const fixedSource = source;
  for (const [name, code] of [['trust', 'source_authority_denied'], ['registration', 'source_registration_missing'], ['revision', 'source_unavailable']] as const) {
    const target = await api.create(`rejected-${name}`);
    const candidate = name === 'registration' ? { ...source, workspaceId: 'missing-registration', executionWorkspaceId: 'missing-registration' }
      : name === 'revision' ? { ...fixedSource, revision: 999_999 } : source;
    trusted = name !== 'trust';
    if (name === 'trust') await assert.rejects(api.prepareSource(sourceRequest),
      error => error instanceof ThreadRequestError && error.code === 'source_authority_denied');
    await assert.rejects(api.submit({ ...target, key: name, expectedHead: null, text: 'Must not be admitted', model, source: candidate }),
      error => error instanceof ThreadRequestError && error.code === code, name);
    trusted = true;
    const thread = await runtime.thread(target.threadId);
    assert.equal(thread.branches[0]!.head, null); assert.equal(thread.branches[0]!.latest_run, null);
  }
}
async function researchCleanup() {
  const selected = (await runtime.launch(firstRun))!.selection.source!;
  assert.equal(selected.mode, 'fixed_branch');
  const authority = createResearchSourceAuthority({ kernel, runtime: () => runtime,
    resolveLiveSource: async () => { throw new Error('Fixed research cleanup acquired a physical source'); } });
  const pinBranch = kernel.pinBranch.bind(kernel);
  let loseAcknowledgement = false;
  kernel.pinBranch = async (...args) => {
    const result = await pinBranch(...args);
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Original pin ACK lost'); }
    return result;
  };
  for (const entry of ['release', 'reconcile'] as const) {
    const job = await kernel.agentRuntimeRequest<HostJobPending, 'runtime.host_job.user'>('runtime.host_job.user', {
      subjectId: `research-cleanup:${entry}`, threadId: identity.threadId, branchId: identity.branchId,
      sourceRunId: firstRun, key: `research-cleanup:${entry}`, domain: 'research.experiment', domainVersion: 1, request: {} });
    const caller: ExperimentCaller = { workspaceId: selected.workspace_id, executionWorkspaceId: selected.execution_workspace_id,
      workspaceScope: [''], access: { kind: 'maintenance' },
      owner: { runtime: 'agent', actor: { kind: 'user', key: entry }, rootThreadId: identity.threadId,
        threadId: identity.threadId, branchId: identity.branchId, runId: firstRun, operationId: job.binding.operationId,
        executionOwner: job.binding.executionOwner, source: selected } };
    loseAcknowledgement = entry === 'reconcile';
    const admitted = entry === 'release' ? await authority.admit(caller, '') : undefined;
    if (entry === 'reconcile') await assert.rejects(authority.admit(caller, ''), /Original pin ACK lost/);
    const audit = await kernel.issueGrant({ grantId: `research-cleanup-audit:${entry}`, owningWorkspace: selected.workspace_id,
      executionWorkspace: selected.execution_workspace_id, capabilities: ['storage.read'], pathScopes: [''] });
    const reader = kernel.scoped(audit), pinId = `research-input:${job.binding.operationId}`;
    assert.equal((await reader.readPin({ pinId, includeEntries: false })).pinId, pinId);
    trusted = false;
    await assert.rejects(authority.admit(caller, ''), error => !!error && typeof error === 'object' && 'code' in error && error.code === 'untrusted');
    const before = methods.length;
    if (admitted) await authority.release(caller, admitted);
    else assert.equal(await authority.reconcileUnaccepted(caller), true);
    const cleanup = methods.slice(before);
    assert(cleanup.includes('branch.unpin'));
    assert(!cleanup.some(method => ['branch.read', 'branch.pin', 'pin.read', 'storage.getBlob'].includes(method) || method.startsWith('file.')));
    if (!admitted) assert(cleanup.includes('authority.grant.retire'));
    await assert.rejects(reader.readPin({ pinId, includeEntries: false }));
    await kernel.revokeGrant(audit.grantId);
    trusted = true;
  }
  kernel.pinBranch = pinBranch;
  console.error('Source lifecycle: real research revision pin and revoked-trust cleanup verified');
}
async function handle(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (frame.kind === 'fixture-response' || frame.kind === 'response') {
    const waiting = pending.get(String(frame.id)); assert(waiting, `Unexpected response ${String(frame.id)}`); pending.delete(String(frame.id));
    if (frame.ok) waiting.resolve(frame.result);
    else {
      const value = typeof frame.error === 'object' && frame.error ? frame.error as { code: string; message: string; retryable: boolean } : { code: 'fixture-error', message: String(frame.error), retryable: false };
      waiting.reject(new KernelClientError(value));
    }
    return;
  }
  if (frame.kind === 'fixture-first') {
    await rejectedSources(); firstRun = await submit('first-after-move');
    if (source.mode === 'fixed_branch') await researchCleanup();
    await writeFile(join(root, 'lifecycle.json'), JSON.stringify({ identity, source, firstRun, sourceRequest, preparedSource }));
    if (source.mode === 'materialized') {
      const location = await originalMaterializationLocation(storageRoot, source.workspaceId, firstRun);
      await writeFile(join(location.targetPath, 'source.txt'), 'PRESERVED_MANAGED_COPY\n');
    }
    console.error('Source lifecycle: public rejections and first assembled Run verified', source.mode);
    write({ kind: 'fixture-first-done', firstRun, identity, grants }); return;
  }
  if (frame.kind === 'fixture-pending') {
    const branch = (await runtime.thread(identity.threadId)).branches.find(branch => branch.branch_id === identity.branchId)!;
    const receipt = await api.submit({ ...identity, key: String(frame.key ?? 'pending-before-reopen'), expectedHead: branch.head,
      text: 'Resume the original accepted source input', model, ...(source.mode === 'fixed_branch' ? { source } : {}) });
    pendingRun = receipt.run_id;
    await writeFile(join(root, 'lifecycle.json'), JSON.stringify({ identity, source, firstRun, pendingRun, sourceRequest, preparedSource }));
    write({ kind: 'fixture-pending-admitted', pendingRun, grants }); return;
  }
  if (frame.kind === 'fixture-second') {
    await api.retryPreparation(pendingRun); await waitRun(pendingRun);
    const secondRun = await submit('second-after-reopen', source.mode === 'fixed_branch');
    console.error('Source lifecycle: pending Run rebound and new input finished after native reopen', source.mode);
    write({ kind: 'fixture-second-done', firstRun, pendingRun, secondRun, identity, grants }); return;
  }
  if (frame.kind === 'fixture-hide-copy') {
    const location = await originalMaterializationLocation(storageRoot, source.workspaceId, firstRun);
    await rename(location.targetPath, `${location.targetPath}.unavailable`);
    write({ kind: 'fixture-copy-hidden' }); return;
  }
  if (frame.kind === 'fixture-retry-missing') {
    await assert.rejects(api.retryPreparation(pendingRun), error => error instanceof ThreadRequestError && error.code === 'source_environment_unavailable');
    const location = await originalMaterializationLocation(storageRoot, source.workspaceId, firstRun);
    await assert.rejects(readFile(join(location.targetPath, 'source.txt')), { code: 'ENOENT' });
    write({ kind: 'fixture-missing-done', pendingRun }); return;
  }
  (kernel as unknown as { consumeFrame(value: unknown): void }).consumeFrame(frame);
}
createInterface({ input: process.stdin }).on('line', line => { void handle(JSON.parse(line)).catch(error => {
  console.error(error); write({ kind: 'fixture-failed', error: String(error), stack: error instanceof Error ? error.stack : undefined });
}); });
