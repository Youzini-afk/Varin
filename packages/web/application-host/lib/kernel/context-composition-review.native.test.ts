import { resourceScopeFixture } from './resource-scope.test-helper.js';
import { createMemoryOwner } from './memory-owner.js';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createContextComposition } from './context-composition.js';
import { createRequire } from 'node:module';
import { createThreadContext } from './thread-context.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createThreadSourcePreparer } from './thread-sources.js';
import { createDocumentAuthority } from '../documents/authority.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';
import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createThreadsHttpAPI, configureRuntimeUrlResolver, setRuntimeExtraHeaders } from '@varin/application-client';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { setRuntimeExtraHeaders(null); configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' }); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture needs a TCP listener');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${address.port}`;
}
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void, existingRoot?: string, existingEndpoint?: string) {
  await fs.access(kernelPath);
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'varin-http-review-'));
  const kernel = createKernelClient({ hostId: 'http-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); if (!existingRoot) await fs.rm(root, { recursive: true, force: true }); });
  const secret = 'fake-http-provider-key-not-a-real-secret';
  const requests: Array<{ body: Record<string, unknown>; authorization?: string }> = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (bytes: Buffer) => chunks.push(bytes));
    request.on('end', () => {
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
      reply(requests.at(-1)!.body, response);
    });
  });
  const endpoint = existingEndpoint ?? `${await listen(provider)}/responses`;
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-local-handle', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: secret } }) },
  });
  const configuration = { providerFamily: 'openai-responses', model: 'fixture-model', endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace, { recursive: true });
  const documents = createDocumentAuthority({ hostId: 'http-review', dataDir: path.join(root, 'documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'http-review', storageRoot: root, resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
  const resources = resourceScopeFixture(root, workingStates, documents);
  const prepare = createThreadSourcePreparer({ documents, workingStates, prepareResources: resources.prepareSourceCapture });
  let refresh = () => Promise.resolve();
  const refreshTasks: Promise<void>[] = [];
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'selected-project' }), onChanged: () => { const task = refresh(); void task.catch(() => undefined); refreshTasks.push(task); } });
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: buildVersion,
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await extensions.start(); cleanups.push(() => extensions.stop());
  const composition = createContextComposition(extensions);
  const prepareContext = createThreadContext({ composition, personalization, resources, projectForWorkspace: async () => 'selected-project' });
  kernel.setMemoryOwner(createMemoryOwner({ personalization, prepareContext }));
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await storage.dispose(); await documents.dispose(); await kernel.close(); };
  cleanups.push(close);

  const adapter = new ThreadAdapter(new AgentRuntimeClient(kernel), {
    resolveModel: async selection => {
      if (selection.providerId !== 'fixture-provider' || selection.modelId !== 'fixture-model') throw new Error('unselected model');
      return { configuration, credentialOwner: owner };
    },
    rebindModel: async () => owner,
  }, async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); }, (_runId, error) => { launchErrors.push(error); }, prepare, prepareContext);
  refresh = () => adapter.refreshPersonalization();
  const flushRefreshes = async () => { while (refreshTasks.length) await Promise.all(refreshTasks.splice(0)); };
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'fixture-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'fixture-client' });
  return { extensions, composition, adapter, flushRefreshes, endpoint, personalization, workspace, documents, workingStates, close, kernel, api: createThreadsHttpAPI(), runtime: adapter.runtime, hostUrl, secret, requests, launchErrors, root, closeKernel: () => kernel.close() };
}

const model = { providerId: 'fixture-provider', modelId: 'fixture-model' };
const system = (body: Record<string, unknown>) => JSON.stringify((body.input as Array<{ role?: string }>).filter(item => item.role === 'system'));
function complete(response: ServerResponse, id: string, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id, type: 'message', content: [{ type: 'output_text', text }] }] } })}\n\n`);
}
async function installExample(f: Awaited<ReturnType<typeof fixture>>) {
  const example = path.join(f.root, 'project-context'); await fs.mkdir(example);
  for (const file of ['package.json', 'varin.extension.json']) await fs.copyFile(path.join(repository, 'examples/extensions/project-context', file), path.join(example, file));
  await build({ entryPoints: [path.join(repository, 'examples/extensions/project-context/host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(example, 'host.cjs'), alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') } });
  await f.extensions.installOrStage({ expectedRevision: (await f.extensions.state()).catalog.revision, source: { kind: 'local', display: 'Real example', specifier: example } });
}
async function route(f: Awaited<ReturnType<typeof fixture>>, providerKey: string, scope: {projectId?: string; sessionId?: string}) {
  return f.extensions.upsertServiceRoutingRule({ expectedRevision: (await f.extensions.routing.read()).document.revision,
    rule: { allowFallback: false, providerKey, scope, serviceId: 'varin.context.fragments', version: 1 } });
}
it('packaged default and installable scoped example reach captured model requests and refresh without changing frozen bytes', async () => {
  let held!: ServerResponse; let count = 0;
  const f = await fixture((_body, response) => { if (++count === 1) held = response; else complete(response, `composition-${count}`, 'done'); });
  const identity = await f.api.create('composition-review');
  await fs.writeFile(path.join(f.workspace, 'AGENTS.md'), 'FROZEN WORKSPACE');
  const source = await f.api.prepareSource({ ...identity, key: 'source', path: f.workspace, mode: 'fixed_branch' });
  const first = await f.api.submit({ ...identity, key: 'first', expectedHead: null, text: 'first', model, source: source.source });
  await expect.poll(() => f.requests.length).toBe(1);
  const oldBytes = structuredClone(f.requests[0]!.body);
  expect(system(oldBytes)).toContain('Distinguish completed work, attempted work');
  const old = (await f.api.snapshot(identity)).context.checkpoint!;
  expect(old.personalization!.contextComposition!.sections[0]!.name).toBe('execution-reporting');
  await installExample(f);
  await route(f, 'example.project-context:host:varin.context.fragments@1', { projectId: 'selected-project' });
  const other = await f.composition({ sessionId: 'other-session', projectId: 'different-project' });
  expect(other!.sections[0]!.name).toBe('execution-reporting');
  await f.adapter.refreshPersonalization();
  const refreshed = (await f.api.snapshot(identity)).context.checkpoint!;
  expect(refreshed.personalization!.revision).toBe(old.personalization!.revision);
  expect(refreshed.personalization!.contextComposition!.sections[0]!.name).toBe('research-evidence');
  expect(refreshed.proposal).toMatchObject({ effective_system_prompt: old.proposal.effective_system_prompt, memory_checkpoint: old.proposal.memory_checkpoint });
  expect(f.requests[0]!.body).toEqual(oldBytes);
  complete(held, 'old-completed', 'done');
  await expect.poll(async () => (await f.api.run(first.run_id)).state).toBe('completed');
  const head = (await f.api.snapshot(identity)).historyPage.head;
  const second = await f.api.submit({ ...identity, key: 'second', expectedHead: head, text: 'second', model });
  await expect.poll(async () => (await f.api.run(second.run_id)).state).toBe('completed');
  expect(system(f.requests.at(-1)!.body)).toContain('distinguish evidence from hypotheses');
  expect(system(f.requests.at(-1)!.body)).not.toContain('Distinguish completed work, attempted work');
  const beforeRestart = (await f.api.snapshot(identity)).context.checkpoint!;
  await f.extensions.setEnabled('example.project-context', false, (await f.extensions.state()).catalog.revision);
  await expect(f.adapter.refreshPersonalization()).rejects.toThrow();
  expect((await f.api.snapshot(identity)).context.checkpoint).toEqual(beforeRestart);
  await f.extensions.setEnabled('example.project-context', true, (await f.extensions.state()).catalog.revision);
  await f.adapter.refreshPersonalization();
  const prior = (await f.api.snapshot(identity)).context.checkpoint!;
  expect(prior.personalization!.revision).toBe(beforeRestart.personalization!.revision);
  expect(prior.personalization!.contextComposition!.providerId).not.toBe(beforeRestart.personalization!.contextComposition!.providerId);
  const { contextComposition, ...basis } = prior.personalization!;
  await expect(f.runtime.refreshContext({ branchId: identity.branchId, expectedRevision: prior.revision, context: {
    ...(prior.resources ? { resources: prior.resources } : {}),
    effectiveSystemPrompt: prior.proposal.effective_system_prompt + ' UNAUTHORIZED SAME REVISION',
    instructionSources: prior.proposal.instruction_sources, memoryCheckpoint: prior.proposal.memory_checkpoint,
    personalization: { ...basis, contextComposition: { ...contextComposition!, contentVersion: 'changed', sections: [] } },
  } })).rejects.toThrow();
  await route(f, 'missing.context:host:varin.context.fragments@1', { projectId: 'selected-project' });
  await expect(f.adapter.refreshPersonalization()).rejects.toThrow();
  expect((await f.api.snapshot(identity)).context.checkpoint).toEqual(prior);
});
it('a cache hit cannot return an old selection revision if routing changes before actual binding', async () => {
  const f = await fixture((_body, response) => complete(response, 'unused', 'unused'));
  const scope = { sessionId: 'race-session', projectId: 'race-project' };
  const first = await f.composition(scope);
  const originalPrepare = f.extensions.prepareService.bind(f.extensions);
  let changed = false;
  f.extensions.prepareService = async (...args) => {
    if (!changed) { changed = true; await route(f, 'varin.builtin.context-fragments:host:varin.context.fragments@1', { projectId: 'race-project' }); }
    return originalPrepare(...args);
  };
  const result = await f.composition(scope).catch(() => undefined);
  expect(result?.selectionRevision).not.toBe(first!.selectionRevision);
});

it('optional unavailable default is empty, but explicit missing and failing providers cannot silently erase context', async () => {
  const f = await fixture((_body, response) => complete(response, 'unused', 'unused'));
  const scope = { sessionId: 'optional-session' };
  expect((await f.composition(scope))!.sections[0]!.name).toBe('execution-reporting');
  await f.extensions.setEnabled('varin.builtin.context-fragments', false, (await f.extensions.state()).catalog.revision);
  expect(await f.composition(scope)).toBeUndefined();
  await route(f, 'varin.builtin.context-fragments:host:varin.context.fragments@1', scope);
  await expect(f.composition(scope)).rejects.toThrow();
  await f.extensions.setEnabled('varin.builtin.context-fragments', true, (await f.extensions.state()).catalog.revision);
  const bad = path.join(f.root, 'bad-context'); await fs.mkdir(bad);
  await fs.writeFile(path.join(bad, 'package.json'), JSON.stringify({ name: 'bad-context', version: '1.0.0' }));
  await fs.writeFile(path.join(bad, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id: 'review.bad-context', version: '1.0.0', engines: { varin: '*' }, entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } }, provides: { services: [{ id: 'varin.context.fragments', version: 1, multiple: true }] } }));
  await fs.writeFile(path.join(bad, 'host.cjs'), "module.exports={activate(context){context.services.provide({id:'varin.context.fragments',version:1,multiple:true},{describe(){throw new Error('deliberate describe failure')}})}}");
  await f.extensions.installOrStage({ expectedRevision: (await f.extensions.state()).catalog.revision, source: { kind: 'local', display: 'Bad context', specifier: bad } });
  await f.composition(scope);
  expect((await f.extensions.state()).services.providers.some(provider => provider.extensionId === 'review.bad-context')).toBe(false);
  await route(f, 'review.bad-context:host:varin.context.fragments@1', scope);
  await expect(f.composition(scope)).rejects.toThrow(/deliberate describe failure/);
});
it('unchanged context preparation invokes describe once and reuses the real worker generation', async () => {
  const f = await fixture((_body, response) => complete(response, 'unused', 'unused'));
  let describes = 0;
  const originalPrepare = f.extensions.prepareService.bind(f.extensions);
  f.extensions.prepareService = async (...args) => {
    const binding = await originalPrepare(...args);
    return { ...binding, invoke: (...callArgs) => { if (callArgs[0] === 'describe') describes++; return binding.invoke(...callArgs); } };
  };
  const generations = new Set<string>();
  for (let index = 0; index < 5; index++) {
    const result = await f.composition({ sessionId: 'reuse-session' });
    generations.add(result!.providerId);
    expect(result!.sections[0]!.name).toBe('execution-reporting');
  }
  const beforeRouting = await f.composition({ sessionId: 'reuse-session' });
  await route(f, 'unrelated.missing:host:varin.context.fragments@1', { projectId: 'unrelated-project' });
  const afterRouting = await f.composition({ sessionId: 'reuse-session' });
  expect(afterRouting).toEqual(beforeRouting);
  expect(describes).toBe(1);
  expect(generations.size).toBe(1);
  expect((await f.extensions.state()).services.providers.filter(provider => provider.extensionId === 'varin.builtin.context-fragments')).toHaveLength(1);
});
it('selected describe failure preserves the checkpoint and data fragments stay outside model system instructions', async () => {
  const f = await fixture((_body, response) => complete(response, `data-${Date.now()}`, 'done'));
  const identity = await f.api.create('data-review');
  const first = await f.api.submit({ ...identity, key: 'first', expectedHead: null, text: 'first', model });
  await expect.poll(async () => (await f.api.run(first.run_id)).state).toBe('completed');
  const before = (await f.api.snapshot(identity)).context.checkpoint!;
  for (const [id, implementation] of [
    ['review.fail-fragments', "throw new Error('failed fragment preparation')"],
    ['review.data-fragments', "return {sections:[{name:'quoted-evidence',kind:'data',content:'EXTERNAL QUOTED EVIDENCE'}]}"],
  ]) {
    const folder = path.join(f.root, id!); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
    await fs.writeFile(path.join(folder, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' }, entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } }, provides: { services: [{ id: 'varin.context.fragments', version: 1, multiple: true }] } }));
    await fs.writeFile(path.join(folder, 'host.cjs'), `module.exports={activate(context){context.services.provide({id:'varin.context.fragments',version:1,multiple:true},{describe(){${implementation}}})}}`);
    await f.extensions.installOrStage({ expectedRevision: (await f.extensions.state()).catalog.revision, source: { kind: 'local', display: id!, specifier: folder } });
  }
  await route(f, 'review.fail-fragments:host:varin.context.fragments@1', { sessionId: identity.threadId });
  await expect(f.adapter.refreshPersonalization()).rejects.toThrow();
  expect((await f.api.snapshot(identity)).context.checkpoint).toEqual(before);
  await route(f, 'review.data-fragments:host:varin.context.fragments@1', { sessionId: identity.threadId });
  const second = await f.api.submit({ ...identity, key: 'second', expectedHead: (await f.api.snapshot(identity)).historyPage.head, text: 'second', model });
  await expect.poll(async () => (await f.api.run(second.run_id)).state).toBe('completed');
  const wire = f.requests.at(-1)!.body;
  expect(JSON.stringify(wire)).toContain('EXTERNAL QUOTED EVIDENCE');
  expect(system(wire)).not.toContain('EXTERNAL QUOTED EVIDENCE');
});
