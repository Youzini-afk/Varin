/** Real source/language/process owners over the existing test-only stdio rendezvous.
 * Rust owns captures, managed copies, process pipes and receipts; TypeScript answers every query. */
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';
import { VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID } from '@varin/extension-builtins';
import { VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS } from '@varin/extension-builtins/host';
import { createDocumentAuthority } from '../documents/authority.js';
import { revisionFromBytes } from '../documents/inspect.js';
import { createLanguageSupervisor } from '../lsp/supervisor.js';
import { KernelClient, KernelClientError, type KernelGrantHandle } from './kernel-client.js';
import { createKernelProcessService } from './process-service.js';
import { createLiveSourceOwner } from './live-source.js';
import { createSourceQueryOwner } from './source-query.js';
import { createLanguageOwner, type LanguageToolOwner } from './language-owner.js';
import { createChildProfilePreparer } from './child-profiles.js';
import { createModelAuthority } from './model-authority.js';
import { originalMaterializationLocation } from './source-launch.js';
import { KernelStorageAdapter, KernelWorkingStateRootStore } from './storage-adapter.js';
import type { ChildCapabilityDescriptor, KernelHandshakeResult, LaunchSource, LiveRoot } from './protocol.generated.js';
const HOST = 'web-domain-host', GENERATION = 'web-domain-generation';
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let sequence = 0, root = '', storageRoot = '', source: LaunchSource, physicalRoot: LiveRoot | null;
let kernel: KernelClient, documents: ReturnType<typeof createDocumentAuthority>;
let supervisor: ReturnType<typeof createLanguageSupervisor>, processes: ReturnType<typeof createKernelProcessService>;
let owner: LanguageToolOwner;
const grants: KernelGrantHandle[] = [];
let processSpawns = 0, sourceQueries = 0, invalidations = 0;
let expectClean = false;
const runViews = new Map<string, string>();
const diagnostics: Array<{ kind: string; view?: string; resourceId: string; items: Array<Record<string, unknown>> }> = [];
const files = ['tsconfig.json', 'config/base.json', 'main.ts', 'util.ts', 'src/shared.ts'];
const main = (marker: string) => `import { greet } from './util';\nimport { shared } from '@model/shared';\nexport const marker = "${marker}";\nexport const message: number = greet(shared);\n`;
async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now() + 20_000;
  while (!check()) { assert(Date.now() < deadline, message); await pause(25); }
}
function request(method: string, params: unknown, options: { grant?: KernelGrantHandle } = {}) {
  if (options.grant) kernel.assertGrantForScope(options.grant);
  if (method === 'process.spawn') processSpawns++;
  const id = `language-source:${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ kind: 'fixture-request', id, method, params, ...(options.grant ? { grantId: options.grant.grantId } : {}) });
  });
}
async function edit(grant: KernelGrantHandle, path: string, text: string) {
  const actor = kernel.scoped(grant), address = { workspaceId: source.workspace_id, rootId: physicalRoot!.rootId, path };
  const suffix = `${sequence}:${path}`;
  const captured = await actor.fileCapture({ ...address, operationId: `language-capture:${suffix}`, store: false });
  const bytes = Buffer.from(text), blob = await actor.putBlob(bytes, `language-edit:${suffix}`);
  try {
    const changed = await actor.fileApply({ ...address, operationId: `language-apply:${suffix}`, expectedJson: String(captured.stateJson),
      targetJson: JSON.stringify({ kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.byteLength, mode: 420 }), ownerId: blob.ownerId });
    assert.equal(changed.status, 'applied');
  } finally { await actor.releaseBlob(blob.ownerId); }
}
async function initialize(frame: Record<string, unknown>) {
  root = String(frame.root); storageRoot = String(frame.storageRoot);
  const workspace = join(root, 'workspace');
  if (!frame.resume) {
    await mkdir(join(workspace, 'config'), { recursive: true }); await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'tsconfig.json'), JSON.stringify({ extends: './config/base.json', include: ['*.ts', 'src/*.ts'] }));
    await writeFile(join(workspace, 'config/base.json'), JSON.stringify({ compilerOptions: {
      strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true,
      baseUrl: '..', paths: { '@model/*': ['src/*'] },
    } }));
    await writeFile(join(workspace, 'main.ts'), main('CAPTURED_B'));
    await writeFile(join(workspace, 'util.ts'), '// B relative import\nexport function greet(name: string): string { return "B " + name; }\n');
    await writeFile(join(workspace, 'src/shared.ts'), '// B path alias\nexport const shared = "Varin";\n');
  }
  kernel = new KernelClient({ hostId: HOST, hostGeneration: GENERATION, storageRoot, buildVersion: '0.9.25' });
  const transport = kernel as unknown as { epoch: string; started: boolean; handshakeResult: KernelHandshakeResult };
  transport.epoch = String(frame.epoch); transport.started = true;
  transport.handshakeResult = { hostId: HOST, storageRoot, kernelEpoch: String(frame.epoch) } as KernelHandshakeResult;
  Object.defineProperty(kernel, 'requestRaw', { value: request });
  Object.defineProperty(kernel, 'write', { value: async (value: unknown) => { write(value); } });
  documents = createDocumentAuthority({ hostId: HOST, dataDir: join(root, 'documents'), isTrusted: async () => true,
    isAllowedRoot: async candidate => candidate === workspace });
  const live = createLiveSourceOwner({ documents, kernel });
  const saved = frame.resume ? JSON.parse(await readFile(join(root, 'language-source.json'), 'utf8')) as LaunchSource : null;
  const identity = saved ? await documents.admitWorkspaceRegistration(saved.workspace_id)
    : await documents.resolveWorkspace({ path: workspace });
  if (saved) {
    source = saved;
  } else {
    const liveRoot = await live.prepare(identity.workspaceId, identity.workspaceId, 'thread:language');
    const seed = await kernel.issueGrant({ grantId: 'language-source:capture', threadId: 'thread:language',
      owningWorkspace: identity.workspaceId, executionWorkspace: identity.workspaceId,
      capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
    const actor = kernel.scoped(seed), entries: Array<{ path: string; state: never; ownerId?: string }> = [];
    for (const path of ['config', 'src', ...files]) {
      const captured = await actor.fileCapture({ operationId: `language-original:${path}`, workspaceId: identity.workspaceId,
        rootId: liveRoot.rootId, path, store: true });
      entries.push({ path, state: JSON.parse(String(captured.stateJson)) as never,
        ...(typeof captured.ownerId === 'string' ? { ownerId: captured.ownerId } : {}) });
    }
    await actor.createBranch({ operationId: 'language-source:create', workspaceId: identity.workspaceId, branchId: 'source:language',
      captureScopes: [], draftBasePaths: [], entries });
    await actor.pinBranch({ operationId: 'language-source:pin', branchId: 'source:language', revision: 0, pinId: 'language-source:original' });
    for (const entry of entries) if (entry.ownerId) await actor.releaseBlob(entry.ownerId);
    await kernel.revokeGrant(seed.grantId);
    source = { mode: frame.mode === 'fixed_branch' ? 'fixed_branch' : 'materialized', workspace_id: identity.workspaceId, execution_workspace_id: identity.workspaceId,
      branch_id: 'source:language', revision: 0, live_root: null };
    // Conflicting unopened dependencies and project configuration remain in the old Documents root.
    await writeFile(join(workspace, 'main.ts'), main('WRONG_LIVE_A'));
    await writeFile(join(workspace, 'util.ts'), 'export function greet(name: string): number { return 99; }\n');
    await writeFile(join(workspace, 'config/base.json'), JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@model/*': ['wrong/*'] } } }));
    await mkdir(join(workspace, 'wrong')); await writeFile(join(workspace, 'wrong/shared.ts'), 'export const shared = 123;\n');
    await writeFile(join(root, 'language-source.json'), JSON.stringify(source));
  }
  physicalRoot = null;
  processes = createKernelProcessService({ client: kernel, resolveIdentity: async () => { throw new Error('Source language must use its private admitted process route'); },
    onError: error => console.error('Language source managed process:', error.message) });
  supervisor = createLanguageSupervisor({ documents, spawn: processes.spawn, spawnAdmitted: processes.spawnAdmitted, releaseAdmittedContext: processes.releaseContext });
  supervisor.subscribe(identity.workspaceId, value => {
    const event = value as typeof diagnostics[number];
    if (event.kind === 'diagnostics' && event.resourceId === 'main.ts') diagnostics.push(event);
    if (event.kind === 'diagnostics-invalidated') invalidations++;
  });
  const packageRoot = VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS.get(VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID);
  assert(packageRoot, 'Bundled TypeScript extension must be installed');
  const server = join(packageRoot, 'runtime/typescript-language-server.mjs'), tsserver = join(packageRoot, 'runtime/typescript/lib/tsserver.js');
  await Promise.all([access(server), access(tsserver)]);
  supervisor.registerProvider({ providerId: 'varin.typescript-language', command: process.execPath, args: [server, '--stdio'],
    initializationOptions: { tsserver: { fallbackPath: tsserver } }, languageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'], source: 'builtin' });
  owner = createLanguageOwner({ documents, supervisor, sources: createSourceQueryOwner({ kernel, documents, validateLiveSource: live.validate }) });
  const measured: LanguageToolOwner = async (query, signal) => {
    sourceQueries++;
    if (query.method === 'diagnostics') await eventually(() => {
      const view = runViews.get(query.runId);
      const latest = diagnostics.findLast(event => event.view === view);
      return !!view && !!latest && (expectClean ? latest.items.length === 0 : latest.items.some(item => item.code === 2322));
    }, 'Bundled TypeScript must publish its actual main.ts diagnostics');
    const result = await owner(query, signal);
    if (result.source) runViews.set(query.runId, result.source.view);
    return result;
  };
  measured.releaseSource = match => owner.releaseSource!(match);
  kernel.setLanguageOwner(measured);
  const capabilities = await kernel.agentRuntimeRequest<ChildCapabilityDescriptor[], 'runtime.child.capabilities'>('runtime.child.capabilities', {});
  const scope = { reference: 'language-source-model', authority: 'controlled', account: 'local-fixture', generation: 1 };
  const descriptor = { providerId: 'controlled', modelId: 'language-source', name: 'Controlled source decisions', api: 'openai-responses',
    baseUrl: 'https://controlled.invalid', maxTokens: 1024, reasoning: false };
  const models = createModelAuthority({ selectedModel: async () => descriptor, listModels: async () => [descriptor],
    currentScope: async () => scope, currentProviderAccount: async () => undefined, routingEnvironment: async () => ({}),
    getAuth: async () => { throw new Error('This fixture has no external model calls'); } });
  const resolved = await models.resolveModel({ providerId: 'controlled', modelId: 'language-source' });
  const parent = { configuration: resolved.configuration, credential_scope: await resolved.credentialOwner.scope() };
  const prepareProfiles = createChildProfilePreparer({ models, capabilities: async () => capabilities,
    settings: async () => ({ harness: { models: { retrievalAgent: { providerId: 'controlled', modelId: 'language-source' } }, agents: { language_reader: { name: 'Physical language reader', description: 'Explicit source-aware reader', instructions: 'Inspect the selected source.', enabled: true, tools: ['language_definition', 'language_references', 'language_diagnostics'], worktree: 'isolated', workFocus: [] } } } }) });
  const childCatalog = await prepareProfiles({ parent });
  for (const id of ['worker', 'retrieval', 'custom:language_reader']) {
    const profile = childCatalog.presets.find(profile => profile.id === id); assert(profile);
    assert.equal(profile.unavailable, null);
    for (const tool of ['language_definition', 'language_references', 'language_diagnostics']) assert.equal(profile.tools.includes(tool), true);
  }
  write({ kind: 'fixture-prepared', source, childCatalog, parent });
}
async function select(frame: Record<string, unknown>) {
  source = frame.source as LaunchSource;
  if (typeof frame.expectClean === 'boolean') expectClean = frame.expectClean;
  const runId = String(frame.runId), threadId = String(frame.threadId ?? 'thread:language');
  const grant = await kernel.issueGrant({ grantId: `language-source:${runId}`, runId, threadId,
    owningWorkspace: source.workspace_id, executionWorkspace: source.execution_workspace_id,
    capabilities: source.mode === 'fixed_branch' ? ['storage.read'] : ['storage.read', 'storage.write'], pathScopes: [''] });
  grants.push(grant);
  const actor = kernel.scoped(grant);
  if (source.mode === 'fixed_branch') {
    physicalRoot = null;
    const adapter = new KernelStorageAdapter({ client: kernel, hostId: HOST, storageRoot,
      resolveWorkspaceRoot: async () => { throw new Error('Fixed language selection must not resolve a live root'); } });
    const store = new KernelWorkingStateRootStore(await adapter.contextFromBranchGrant({ grant,
      owningWorkspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id }));
    const pin = await store.pinBranch(source.branch_id!, { revision: source.revision! });
    try {
      const revisions = Object.fromEntries(await Promise.all(['main.ts', 'util.ts', 'src/shared.ts'].map(async path => {
        const entry = await store.readPath(source.branch_id!, path, { pin }); assert(entry);
        const bytes = await store.readContent(entry); assert(bytes);
        return [path, revisionFromBytes(bytes)];
      })));
      write({ kind: 'fixture-selected', grantId: grant.grantId, physicalRoot, revisions });
    } finally { await pin.release(); }
    return;
  }
  const location = await originalMaterializationLocation(storageRoot, source.workspace_id, source.environment_run_id ?? runId);
  if (!source.environment_run_id) {
    const container = await actor.fileRootRegister({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, canonicalRoot: storageRoot });
    const branch = await actor.readBranch({ branchId: source.branch_id!, revision: source.revision!, includeEntries: false });
    await actor.fileMaterialize({ operationId: `language-materialize:${runId}`, workspaceId: source.workspace_id,
      rootId: String(container.rootId), path: location.relativeTarget, sourceRoot: branch.root });
  }
  const registered = await actor.fileRootRegister({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, canonicalRoot: location.targetPath });
  physicalRoot = { hostId: HOST, rootId: String(registered.rootId), canonicalRoot: String(registered.canonicalRoot) };
  if (!source.environment_run_id) await edit(grant, 'main.ts', main('MATERIALIZED_WORKING_B'));
  const contents = await Promise.all(['main.ts', 'util.ts', 'src/shared.ts'].map(async path => [path, revisionFromBytes(await readFile(join(location.targetPath, path)))]));
  write({ kind: 'fixture-selected', grantId: grant.grantId, physicalRoot, revisions: Object.fromEntries(contents) });
}
export async function handleLanguageFrame(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (frame.kind === 'fixture-response' || frame.kind === 'response') {
    const waiting = pending.get(String(frame.id)); assert(waiting, `Unexpected response ${String(frame.id)}`); pending.delete(String(frame.id));
    if (frame.ok) waiting.resolve(frame.result);
    else waiting.reject(typeof frame.error === 'object' ? new KernelClientError(frame.error as never) : new Error(String(frame.error)));
    return;
  }
  if (frame.kind === 'fixture-select') return select(frame);
  if (frame.kind === 'fixture-next-revision') {
    const grant = await kernel.issueGrant({ grantId: `language-revision:${++sequence}`, threadId: String(frame.threadId ?? 'thread:language'),
      owningWorkspace: source.workspace_id, executionWorkspace: source.execution_workspace_id,
      capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
    try {
      const adapter = new KernelStorageAdapter({ client: kernel, hostId: HOST, storageRoot,
        resolveWorkspaceRoot: async () => { throw new Error('Publishing a fixed revision must not resolve the live root'); } });
      const store = new KernelWorkingStateRootStore(await adapter.contextFromBranchGrant({ grant,
        owningWorkspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id }));
      const branch = await store.getBranchRoot(source.branch_id!); assert(branch);
      const bytes = Buffer.from('// changed fixed import\n\n\nexport function greet(name: string): number { return name.length; }\n');
      const object = await store.putObject(bytes);
      const changed = await store.commitVirtualWrites(source.branch_id!, branch.writeRevision,
        { 'util.ts': { kind: 'regular-file', objectHash: object.hash, byteLength: bytes.length, mode: 420 } });
      assert.equal(changed.status, 'committed');
      const published = await kernel.scoped(grant).publishBranch({ operationId: `language-publish:${sequence}`, branchId: source.branch_id!,
        expectedRoot: changed.root!, expectedWriteRevision: changed.writeRevision });
      assert.notEqual(published.status, 'conflict');
      write({ kind: 'fixture-next-revision', source: { ...source, revision: published.revision }, revision: revisionFromBytes(bytes) });
    } finally { await kernel.revokeGrant(grant.grantId); }
    return;
  }
  if (frame.kind === 'fixture-live-change') {
    await writeFile(join(root, 'workspace', 'util.ts'), '// unrelated live root\nexport function greet(name: string): boolean { return false; }\n');
    await writeFile(join(root, 'workspace', 'wrong/shared.ts'), 'export const shared = false;\n');
    write({ kind: 'fixture-live-changed', processSpawns, invalidations }); return;
  }
  if (frame.kind === 'fixture-change-import') {
    expectClean = true; const before = invalidations, events = diagnostics.length;
    await edit(grants.at(-1)!, 'util.ts', '// changed materialized import\n\n\nexport function greet(name: string): number { return name.length; }\n');
    await eventually(() => invalidations > before, 'Actual materialized watcher must invalidate the language view');
    await eventually(() => diagnostics.length > events && diagnostics.at(-1)!.items.length === 0, 'Actual TypeScript diagnostics must reflect the changed import');
    write({ kind: 'fixture-changed', processSpawns, invalidations,
      revision: revisionFromBytes(await readFile(join(physicalRoot!.canonicalRoot, 'util.ts'))) }); return;
  }
  if (frame.kind === 'fixture-release') {
    await kernel.revokeGrant(String(frame.grantId));
    write({ kind: 'fixture-released', processSpawns, sourceQueries, views: supervisor.inspectViews() }); return;
  }
  if (frame.kind === 'fixture-drain') {
    await kernel.releaseLanguageSource(String(frame.runId));
    write({ kind: 'fixture-drained', processSpawns, views: supervisor.inspectViews() }); return;
  }
  if (frame.kind === 'fixture-gc') {
    const grant = await kernel.issueGrant({ grantId: `language-gc:${++sequence}`, owningWorkspace: source.workspace_id,
      executionWorkspace: source.execution_workspace_id, capabilities: ['storage.gc'], pathScopes: [''] });
    try {
      const result = await kernel.scoped(grant).gc(`language-gc:${sequence}`);
      write({ kind: 'fixture-gc-finished', result });
    } finally { await kernel.revokeGrant(grant.grantId); }
    return;
  }
  if (frame.kind === 'fixture-finish') {
    await supervisor.dispose(); await processes.dispose(); await documents.dispose();
    write({ kind: 'fixture-finished', processSpawns, sourceQueries, invalidations, diagnostics }); return;
  }
  (kernel as unknown as { consumeFrame(value: unknown): void }).consumeFrame(frame);
  if (frame.kind === 'host-tool-owner-release') write({ kind: 'fixture-run-released', runId: frame.runId });
}

/** One rendezvous listener; child consumers add fixture commands before delegating here. */
export function startLanguageFixture(handle = handleLanguageFrame) {
  createInterface({ input: process.stdin }).on('line', line => { void handle(JSON.parse(line)).catch(error => {
    console.error(error); write({ kind: 'fixture-failed', error: String(error), stack: error instanceof Error ? error.stack : undefined });
  }); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startLanguageFixture();
