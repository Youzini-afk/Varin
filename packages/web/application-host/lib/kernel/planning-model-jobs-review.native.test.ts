import { DatabaseSync } from 'node:sqlite';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createThreadContext } from './thread-context.js';
import { createMemoryOwner } from './memory-owner.js';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createThreadsHttpAPI, configureRuntimeUrlResolver, setRuntimeExtraHeaders } from '@varin/application-client';
import express from 'express';
import { createRequire } from 'node:module';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { createAgentPolicy } from './agent-policy.js';
import { createModelAuthority } from './model-authority.js';
import { createPolicyModelPreparer } from './policy-models.js';
import { createThreadSourcePreparer } from './thread-sources.js';
import { createDocumentAuthority } from '../documents/authority.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';
import { CredentialBridge, type PrivateCredentialResponse } from './credential-bridge.js';
import { ExistingHostCredentialOwner, type CredentialScope } from './credential-owner.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ThreadAdapter, type ThreadModelAuthority } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
import type { InitialContext, ModelSessionConfiguration } from './protocol.generated.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setRuntimeExtraHeaders(null);
  configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' });
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture needs a loopback TCP listener');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}
type Request = { body: Record<string, unknown>; authorization?: string };
type Reply = (request: Request, response: ServerResponse) => void;
function complete(response: ServerResponse, text: string, extra: Record<string, unknown> = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
    output: [{ id: 'fixture-message', type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, ...extra,
  } })}\n\n`);
}
async function provider(reply: Reply) {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const captured = { body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) };
      requests.push(captured); reply(captured, response);
    });
  });
  const endpoint = await listen(server);
  return { endpoint, requests, disconnect: () => server.closeAllConnections() };
}
type PolicyInput = {
  view: { run_id: string; history_count: number; pending_tool_calls: number; model_capabilities: Array<{ capability_id: string; status: string }> };
  event: { kind: string; action_id?: string; receipt?: { usable: boolean; outcome: string; output: unknown; failure: { code: string } | null; usage: unknown }; bytes?: number[] };
  state: unknown;
};
const mainSelection = { providerId: 'review-main', modelId: 'main-model' };
const planningSelection = { providerId: 'review-planner', modelId: 'planning-model' };
const configuredSettings = () => ({ global: { harness: { models: { agentPlanning: { ...planningSelection } } } } });
async function fixture(options: { main?: Reply; planner?: Reply; planningAuth?: () => Promise<void>; settings?: unknown; initialContext?: InitialContext; source?: boolean; memory?: boolean; failSettings?: boolean; failPlannerCatalog?: boolean; onDecision?: (input: PolicyInput) => void } = {}) {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-planning-host-review-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const main = await provider(options.main ?? ((_request, response) => complete(response, 'MAIN_ANSWER')));
  const planner = await provider(options.planner ?? ((_request, response) => complete(response, 'PLANNING_ONLY_EVIDENCE')));
  const scope = { reference: 'planning-reference', authority: 'fixture-existing-owner', account: 'planning-account', generation: 1 };
  const mainScope = { reference: 'main-reference', authority: 'fixture-existing-owner', account: 'main-account', generation: 1 };
  const fakeSecrets = { main: 'fake-main-key-not-a-real-secret', planner: 'fake-planner-key-not-a-real-secret' };
  const authReads: string[] = [];
  const catalogReads: string[] = [];
  const mutable = { settings: options.settings ?? configuredSettings(), planningBaseUrl: planner.endpoint, planningMaxTokens: 64,
    authBaseUrl: undefined as string | undefined, onDecision: options.onDecision, failPlannerCatalog: options.failPlannerCatalog ?? false };
  const models = createModelAuthority({
    selectedModel: async (providerId, modelId) => {
      catalogReads.push(providerId);
      if (providerId === planningSelection.providerId && mutable.failPlannerCatalog) throw new Error('Fixture catalog unavailable');
      const planning = providerId === planningSelection.providerId && modelId === planningSelection.modelId;
      if (!planning && (providerId !== mainSelection.providerId || modelId !== mainSelection.modelId)) throw new Error('Unknown fixture model');
      return { providerId, modelId, name: modelId, api: 'openai-responses', baseUrl: planning ? mutable.planningBaseUrl : main.endpoint,
        maxTokens: planning ? mutable.planningMaxTokens : 64 };
    },
    listModels: async () => [],
    getAuth: async providerId => {
      authReads.push(providerId);
      if (providerId === planningSelection.providerId) await options.planningAuth?.();
      return { auth: { apiKey: providerId === planningSelection.providerId ? fakeSecrets.planner : fakeSecrets.main,
        ...(providerId === planningSelection.providerId && mutable.authBaseUrl ? { baseUrl: mutable.authBaseUrl } : {}) } };
    },
    currentScope: async providerId => ({ ...(providerId === planningSelection.providerId ? scope : mainScope) }),
    currentProviderAccount: async () => undefined,
    routingEnvironment: async () => ({}),
  });
  const prepareModels = createPolicyModelPreparer({ models, settings: async () => {
    if (options.failSettings) throw new Error('Fixture settings unavailable');
    return mutable.settings;
  } });
  const kernel = createKernelClient({ hostId: 'planning-host-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(() => kernel.close());
  let closed = false;
  const workspace = path.join(root, 'workspace');
  const documents = options.source || options.memory ? createDocumentAuthority({ hostId: 'planning-host-review', dataDir: path.join(root, 'documents'),
    isAllowedRoot: async () => true, isTrusted: async () => true }) : undefined;
  const storage = documents ? new KernelStorageAdapter({ client: kernel, hostId: 'planning-host-review', storageRoot: root,
    resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root }) : undefined;
  const prepareSource = documents && storage ? createThreadSourcePreparer({ documents, workingStates: createKernelWorkspaceWorkingStateAccess(storage) }) : undefined;
  if (documents && storage) {
    await fs.mkdir(workspace);
    cleanups.push(async () => { if (!closed) { await storage.dispose(); await documents.dispose(); } });
  }
  const personalization = options.memory ? createAgentPersonalization({ client: kernel, context: async () => ({ bot: false, projectId: 'planning-review' }) }) : undefined;
  const prepareContext = personalization && storage ? createThreadContext({ personalization, workingStates: createKernelWorkspaceWorkingStateAccess(storage), projectForWorkspace: async () => 'planning-review' }) : undefined;
  const memoryControl = { synchronizeFailure: undefined as 'reject' | 'throw' | undefined };
  if (personalization && prepareContext) {
    const owner = createMemoryOwner({ personalization, prepareContext });
    kernel.setMemoryOwner(async (query, signal) => {
      if (query.action === 'synchronize' && memoryControl.synchronizeFailure === 'reject') return { status: 'rejected', message: 'REVIEW_PLANNING_CONTEXT_REJECTED' };
      if (query.action === 'synchronize' && memoryControl.synchronizeFailure === 'throw') throw new Error('REVIEW_PLANNING_CONTEXT_THROWN');
      return owner(query, signal);
    });
  }
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: buildVersion,
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await extensions.start(); cleanups.push(() => extensions.stop());
  const decisions: PolicyInput[] = [];
  let pins = 0;
  const originalPrepare = extensions.prepareService.bind(extensions);
  extensions.prepareService = async (...args) => {
    const binding = await originalPrepare(...args);
    if (!(args[0] && typeof args[0] === 'object' && 'serviceId' in args[0] && args[0].serviceId === 'varin.agent.policy')) return binding;
    return { ...binding, pin: () => {
      const pin = binding.pin(); pins++; let released = false;
      return { ...pin, invoke: (method, args, signal) => {
        if (method === 'decide') {
          const input = structuredClone(args[0]) as unknown as PolicyInput;
          decisions.push(input); mutable.onDecision?.(input);
        }
        return pin.invoke(method, args, signal);
      }, release: () => { if (!released) { released = true; pins--; } pin.release(); } };
    } };
  };
  const runtime = new AgentRuntimeClient(kernel, undefined,
    ({ threadId }, signal) => createAgentPolicy(extensions)({ sessionId: threadId, projectId: 'planning-review' }, signal), prepareModels);
  const launchErrors: unknown[] = [];
  const adapter = new ThreadAdapter(runtime, models, async source => {
    if (!documents) throw new Error('No workspace is admitted');
    await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId);
  }, (_runId, error) => { launchErrors.push(error); }, prepareSource,
    prepareContext ?? (options.initialContext ? Object.assign(async () => options.initialContext!, { main: async () => options.initialContext! }) : undefined));
  const app = express(); registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'planning-client') { response.status(401).json({ error: 'authentication required' }); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'planning-client' });
  cleanups.push(async () => {
    // An assertion failure must not leave a deliberately stalled fixture waiting on its socket.
    planner.disconnect(); main.disconnect();
    if (closed) return;
    for (const thread of await runtime.threads()) for (const branch of thread.branches) {
      if (branch.active_run_id) await runtime.cancelRun(branch.active_run_id);
    }
  });
  const closeKernel = async () => { if (closed) return; await storage?.dispose(); await documents?.dispose(); await kernel.close(); closed = true; };
  return { closeKernel, memoryControl, personalization, prepareContext, root, workspace, main, planner, models, prepareModels, mutable, scope, mainScope, fakeSecrets, authReads, catalogReads,
    kernel, extensions, runtime, adapter, decisions, pins: () => pins, launchErrors, api: createThreadsHttpAPI() };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function install(f: Fixture, decision: string, capabilities: string[] = ['agentPlanning']) {
  const id = 'review.planning-policy';
  const folder = path.join(f.root, id); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
  await fs.writeFile(path.join(folder, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
    entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
    provides: { services: [{ id: 'varin.agent.policy', version: 1, multiple: true }] } }));
  await fs.writeFile(path.join(folder, 'host.cjs'), `module.exports={activate(context){context.services.provide({id:'varin.agent.policy',version:1,multiple:true},{
    describe(){return {identity:{name:'planning-review',version:'1'},configuration:{},capabilities:${JSON.stringify(capabilities)}}},
    decide([input]){${decision}}
  })}}`);
  await f.extensions.installOrStage({ expectedRevision: (await f.extensions.state()).catalog.revision,
    source: { kind: 'local', display: id, specifier: folder } });
  await f.extensions.upsertServiceRoutingRule({ expectedRevision: (await f.extensions.routing.read()).document.revision,
    rule: { serviceId: 'varin.agent.policy', version: 1, providerKey: `${id}:host:varin.agent.policy@1`, scope: { projectId: 'planning-review' }, allowFallback: false } });
}
async function installBundledExample(f: Fixture) {
  const folder = path.join(f.root, 'bundled-planning-policy'); await fs.mkdir(folder);
  for (const file of ['package.json', 'varin.extension.json']) {
    await fs.copyFile(path.join(repository, 'examples/extensions/planning-policy', file), path.join(folder, file));
  }
  await build({ entryPoints: [path.join(repository, 'examples/extensions/planning-policy/host.ts')], bundle: true, platform: 'node', format: 'cjs',
    outfile: path.join(folder, 'host.cjs'), alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') } });
  await f.extensions.installOrStage({ expectedRevision: (await f.extensions.state()).catalog.revision,
    source: { kind: 'local', display: 'Bundled planning example', specifier: folder } });
  await f.extensions.upsertServiceRoutingRule({ expectedRevision: (await f.extensions.routing.read()).document.revision,
    rule: { serviceId: 'varin.agent.policy', version: 1, providerKey: 'example.planning-policy:host:varin.agent.policy@1',
      scope: { projectId: 'planning-review' }, allowFallback: false } });
}
async function submitBundledExample(f: Fixture, key: string) {
  const identity = await f.api.create(key);
  await fs.writeFile(path.join(f.workspace, 'planning-context.md'), 'Candidate evidence: first.txt and second.txt. Only read the file selected by the plan.');
  await fs.writeFile(path.join(f.workspace, 'first.txt'), 'IMMUTABLE_FIRST_FINDING');
  await fs.writeFile(path.join(f.workspace, 'second.txt'), 'IMMUTABLE_SECOND_FINDING');
  const source = await f.api.prepareSource({ ...identity, key: 'source', path: f.workspace, mode: 'fixed_branch' });
  await fs.writeFile(path.join(f.workspace, 'first.txt'), 'MUTATED_LIVE_FIRST');
  await fs.writeFile(path.join(f.workspace, 'second.txt'), 'MUTATED_LIVE_SECOND');
  const run = await f.api.submit({ ...identity, key: `input-${key}`, expectedHead: null, text: 'Find the selected evidence', model: mainSelection, source: source.source });
  return { identity, run };
}
const job = (capability = 'agentPlanning') => `{kind:'request_model_job',capability_id:${JSON.stringify(capability)},instructions:['Plan from the committed context; do not execute tools.'],evidence:[]}`;
const onlyPlan = `return {action:input.event.kind==='started'?${job()}:{kind:'complete'},state:null};`;
async function submit(f: Fixture, key = 'planning-review', text = 'COMMITTED_USER_CONTEXT') {
  const identity = await f.api.create(key);
  const run = await f.api.submit({ ...identity, key: `input-${key}`, expectedHead: null, text, model: mainSelection });
  return { identity, run };
}
async function terminal(f: Fixture, runId: string, state = 'completed') {
  await terminalFromEvents(f, runId, state);
  await expect.poll(() => f.pins()).toBe(0);
}
async function modelOperations(f: Fixture, runId: string) {
  const events = await f.runtime.events(0, 256);
  return Promise.all(events.filter(event => event.kind === 'policy.model_admitted'
    && (event.data as { run_id?: string }).run_id === runId).map(event => f.runtime.operation(event.subject)));
}
async function originalObject(f: Fixture, reference: unknown): Promise<unknown> {
  const read = async (hash: string) => {
    expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);
    const hex = hash.slice('sha256-'.length);
    return fs.readFile(path.join(f.root, 'agent-runtime', 'content', 'objects', hex.slice(0, 2), hex.slice(2)));
  };
  const manifest = JSON.parse((await read((reference as { content_object: string }).content_object)).toString()) as { chunks: string[]; bytes: number };
  const body = Buffer.concat(await Promise.all(manifest.chunks.map(read)));
  expect(body.length).toBe(manifest.bytes);
  return JSON.parse(body.toString());
}
async function graphPaths(f: Fixture, runId: string) {
  const events = await f.runtime.events(0, 256);
  const operations = await Promise.all(events.filter(event => event.kind === 'policy.graph_admitted'
    && (event.data as { run_id?: string }).run_id === runId).map(event => f.runtime.operation(event.subject)));
  return operations.flatMap(operation => (operation.intent as { nodes: Array<{ node: { call: { arguments: { path: string } } } }> }).nodes
    .map(node => node.node.call.arguments.path));
}

it.each(['first', 'second'] as const)('installed bundled planning example selects %s evidence from actual planner JSON before main inference', async selected => {
  const f = await fixture({ source: true, planner: (_request, response) => complete(response, JSON.stringify({ version: 1, reads: [{ path: `${selected}.txt` }] })) });
  await installBundledExample(f);
  const { identity, run } = await submitBundledExample(f, `bundled-${selected}`);
  await terminal(f, run.run_id);
  expect(f.planner.requests).toHaveLength(1); expect(f.main.requests).toHaveLength(1);
  expect(f.planner.requests[0]!.body.tools ?? []).toEqual([]);
  expect(JSON.stringify(f.planner.requests[0]!.body)).toContain('Candidate evidence: first.txt and second.txt');
  expect(JSON.stringify(f.planner.requests[0]!.body)).not.toMatch(/IMMUTABLE_FIRST_FINDING|IMMUTABLE_SECOND_FINDING/);
  expect(await graphPaths(f, run.run_id)).toEqual(['planning-context.md', `${selected}.txt`]);
  const mainInput = f.main.requests[0]!.body.input as Array<Record<string, unknown>>;
  expect(JSON.stringify(mainInput)).toContain(`IMMUTABLE_${selected.toUpperCase()}_FINDING`);
  expect(JSON.stringify(mainInput)).not.toContain(selected === 'first' ? 'IMMUTABLE_SECOND_FINDING' : 'IMMUTABLE_FIRST_FINDING');
  expect(JSON.stringify(mainInput)).not.toMatch(/MUTATED_LIVE_FIRST|MUTATED_LIVE_SECOND/);
  expect(mainInput.find(item => JSON.stringify(item).includes(`IMMUTABLE_${selected.toUpperCase()}_FINDING`))).toMatchObject({ role: 'user' });
  expect(f.decisions.filter(input => input.event.kind === 'read_graph_completed')).toHaveLength(2);
  expect(JSON.stringify((await f.api.snapshot(identity)).history)).toContain('MAIN_ANSWER');
  expect(f.launchErrors).toEqual([]);
});

it.each([
  { name: 'malformed-json', plan: 'This is not the requested JSON plan.' },
  { name: 'parent-traversal', plan: JSON.stringify({ version: 1, reads: [{ path: '../escape.txt' }] }) },
])('installed bundled planning example refuses $name before any plan-directed read or main inference', async ({ name, plan }) => {
  const f = await fixture({ source: true, planner: (_request, response) => complete(response, plan) });
  await fs.writeFile(path.join(f.root, 'escape.txt'), 'OUTSIDE_SOURCE_MUST_NOT_BE_READ');
  await installBundledExample(f);
  const { identity, run } = await submitBundledExample(f, `bundled-${name}`);
  await terminal(f, run.run_id, 'failed');
  expect(f.planner.requests).toHaveLength(1); expect(f.main.requests).toHaveLength(0);
  expect(await graphPaths(f, run.run_id)).toEqual(['planning-context.md']);
  expect(f.decisions.filter(input => input.event.kind === 'read_graph_completed')).toHaveLength(1);
  expect(f.decisions.some(input => input.event.kind === 'result_chunk')).toBe(true);
  expect(JSON.stringify((await f.api.snapshot(identity)).history)).not.toContain('OUTSIDE_SOURCE_MUST_NOT_BE_READ');
});

// These cases cross the installed broker, authenticated HTTP API, Operation owner,
// existing Host credential owner and separate loopback provider listeners. No paid calls.
it('runs a tool-free planning Operation without main inference, ModelStep, or conversation output', async () => {
  const f = await fixture(); await install(f, onlyPlan);
  const { identity, run } = await submit(f); await terminal(f, run.run_id);
  expect(f.planner.requests).toHaveLength(1); expect(f.main.requests).toHaveLength(0);
  expect(f.planner.requests[0]!.authorization).toBe(`Bearer ${f.fakeSecrets.planner}`);
  expect(f.authReads).toEqual([planningSelection.providerId]);
  expect(f.planner.requests[0]!.body.model).toBe(planningSelection.modelId);
  expect(f.planner.requests[0]!.body.tools ?? []).toEqual([]);
  expect(JSON.stringify(f.decisions)).not.toMatch(/fake-main-key|fake-planner-key|planning-reference|planning-account|main-reference|main-account/);
  expect(JSON.stringify(f.decisions)).not.toContain(f.planner.endpoint);
  const history = (await f.api.snapshot(identity)).history;
  expect(JSON.stringify(history)).toContain('COMMITTED_USER_CONTEXT');
  expect(JSON.stringify(history)).not.toContain('PLANNING_ONLY_EVIDENCE');
  expect(history.filter(item => item.source === 'assistant')).toEqual([]);
  const events = await f.runtime.events(0, 256);
  expect(events.filter(event => event.subject === run.run_id && event.kind === 'execution.committed'
    && (event.data as { kind?: string }).kind === 'request_prepared')).toEqual([]);
  const operations = await modelOperations(f, run.run_id); expect(operations).toHaveLength(1);
  expect(operations[0]).toMatchObject({ executor: 'policy-model.v1', lifetime: 'run', effect: 'none', phase: 'terminal', outcome: 'succeeded' });
  expect(f.decisions.find(input => input.event.kind === 'model_job_completed')!.event.receipt).toMatchObject({ usable: true, outcome: 'succeeded' });
  expect(f.launchErrors).toEqual([]);
});

it('only calls main after policy inspects and explicitly selects planning evidence', async () => {
  const f: Fixture = await fixture({ main: (_request, response) => {
    expect(f.decisions.some(input => input.event.kind === 'model_job_completed')).toBe(true);
    expect(f.decisions.some(input => input.event.kind === 'result_chunk')).toBe(true);
    complete(response, 'MAIN_AFTER_PLAN');
  } });
  await install(f, `
    if(input.event.kind==='started') return {action:${job()},state:null};
    if(input.event.kind==='model_job_completed') return {action:{kind:'read_result',reference:input.event.receipt.output,index:0},state:input.event.receipt.output};
    if(input.event.kind==='result_chunk') return {action:{kind:'request_model_with_evidence',evidence:[input.state]},state:null};
    return {action:{kind:'complete'},state:null};`);
  const { identity, run } = await submit(f); await terminal(f, run.run_id);
  expect(f.planner.requests).toHaveLength(1); expect(f.main.requests).toHaveLength(1);
  expect(f.main.requests[0]!.authorization).toBe(`Bearer ${f.fakeSecrets.main}`);
  expect(f.main.requests[0]!.body.model).toBe(mainSelection.modelId);
  const input = f.main.requests[0]!.body.input as Array<Record<string, unknown>>;
  const evidence = input.find(item => JSON.stringify(item).includes('PLANNING_ONLY_EVIDENCE'))!;
  expect(evidence.role).toBe('user'); expect(JSON.stringify(evidence)).toContain('untrusted');
  expect(JSON.stringify(input)).not.toContain(f.fakeSecrets.planner);
  expect(JSON.stringify((await f.api.snapshot(identity)).history)).toContain('MAIN_AFTER_PLAN');
});

it.each([
  { name: 'missing', settings: { global: {} }, status: 'unconfigured' },
  { name: 'disabled', settings: { global: { harness: { models: { agentPlanning: { ...planningSelection, enabled: false } } } } }, status: 'disabled' },
  { name: 'invalid', settings: { global: { harness: { models: { agentPlanning: { providerId: planningSelection.providerId } } } } }, status: 'invalid' },
  { name: 'settings-unavailable', failSettings: true, status: 'unavailable' },
  { name: 'catalog-unavailable', failPlannerCatalog: true, status: 'unavailable' },
])('reports $name planning duty and never falls back to main', async scenario => {
  const f = await fixture(scenario); await install(f, onlyPlan);
  const { run } = await submit(f, scenario.name); await terminal(f, run.run_id, 'failed');
  expect(f.decisions[0]!.view.model_capabilities).toEqual([expect.objectContaining({ capability_id: 'agentPlanning', status: scenario.status })]);
  expect(f.main.requests).toHaveLength(0); expect(f.planner.requests).toHaveLength(0); expect(f.authReads).toEqual([]);
});

it('rejects a policy-forged capability ID instead of resolving a provider or using main', async () => {
  const f = await fixture(); await install(f, `return {action:${job('forged-provider-or-capability')},state:null};`);
  const { run } = await submit(f); await terminal(f, run.run_id, 'failed');
  expect(f.main.requests).toHaveLength(0); expect(f.planner.requests).toHaveLength(0); expect(f.authReads).toEqual([]);
});

it('rejects provider endpoint, configuration, and credential fields supplied by the installed policy', async () => {
  const f = await fixture();
  await install(f, `return {action:{...${job()},endpoint:${JSON.stringify(`${f.main.endpoint}/forged`)},
    configuration:{model:'forged-model'},credential_scope:{reference:'forged-credential'}},state:null};`);
  const { run } = await submit(f, 'forged-provider-fields'); await terminal(f, run.run_id, 'failed');
  expect(f.main.requests).toHaveLength(0); expect(f.planner.requests).toHaveLength(0); expect(f.authReads).toEqual([]);
  expect(await modelOperations(f, run.run_id)).toEqual([]);
});

it('does not prepare a planner for a policy that never declares that capability', async () => {
  const f = await fixture({ failSettings: true });
  await install(f, `return {action:input.event.kind==='started'?{kind:'request_model'}:{kind:'complete'},state:null};`, []);
  const { run } = await submit(f); await terminal(f, run.run_id);
  expect(f.main.requests).toHaveLength(1); expect(f.planner.requests).toHaveLength(0);
  expect(f.catalogReads).not.toContain(planningSelection.providerId);
});

it('does not authorize a genuine planning output reference in a different Run', async () => {
  const f = await fixture();
  await install(f, `
    if(input.event.kind==='started') return {action:globalThis.reviewPlanningReference
      ?{kind:'request_model_with_evidence',evidence:[globalThis.reviewPlanningReference]}:${job()},state:null};
    if(input.event.kind==='model_job_completed') globalThis.reviewPlanningReference=input.event.receipt.output;
    return {action:{kind:'complete'},state:null};`);
  const first = await submit(f, 'first-evidence-owner'); await terminal(f, first.run.run_id);
  expect(f.decisions.find(input => input.event.kind === 'model_job_completed')!.event.receipt!.output).not.toBeNull();
  const second = await submit(f, 'different-evidence-owner'); await terminal(f, second.run.run_id, 'failed');
  expect(f.planner.requests).toHaveLength(1); expect(f.main.requests).toHaveLength(0);
});

it('retains a planner tool-call failure without executing it or authorizing its output as evidence', async () => {
  const f = await fixture({ planner: (_request, response) => complete(response, '', { output: [{
    type: 'function_call', id: 'forged-write-item', call_id: 'forged-write', name: 'file_write',
    arguments: JSON.stringify({ path: 'must-not-exist.txt', content: 'UNAUTHORIZED_PLANNER_WRITE' }),
  }] }) });
  await install(f, onlyPlan); const { identity, run } = await submit(f); await terminal(f, run.run_id);
  expect(f.main.requests).toHaveLength(0); expect(f.planner.requests).toHaveLength(1);
  const receipt = f.decisions.find(input => input.event.kind === 'model_job_completed')!.event.receipt;
  expect(receipt).toMatchObject({ dispatch: 'completed', usable: false, outcome: 'failed', output: null,
    failure: { code: 'planning_tool_calls_forbidden' } });
  const operations = await modelOperations(f, run.run_id); expect(operations).toHaveLength(1);
  expect(operations[0]!.result).toMatchObject({ original_ref: expect.any(Object), receipt: { usable: false, output: null } });
  const originals = await originalObject(f, (operations[0]!.result as { original_ref: unknown }).original_ref);
  expect(JSON.stringify(originals)).toContain('forged-write-item');
  expect(JSON.stringify(originals)).toContain('UNAUTHORIZED_PLANNER_WRITE');
  expect((await f.runtime.events(0, 256)).filter(event => event.subject === run.run_id && event.kind === 'execution.committed'
    && ['tools_admitted', 'tool_dispatched', 'tool_settled', 'tool_batch_committed'].includes(String((event.data as { kind?: string }).kind)))).toEqual([]);
  expect(JSON.stringify((await f.api.snapshot(identity)).history)).not.toContain('UNAUTHORIZED_PLANNER_WRITE');
  expect(await f.runtime.activeOperations(identity.threadId)).toEqual([]);
  await expect(fs.access(path.join(f.root, 'must-not-exist.txt'))).rejects.toThrow();
});

it('quotes committed main conversation as semantic data without replaying provider continuation', async () => {
  const f = await fixture({ initialContext: { effectiveSystemPrompt: 'COMMITTED_SYSTEM_CONTEXT', instructionSources: ['fixture-system-source'], memoryCheckpoint: 'fixture-memory-checkpoint' },
    main: (_request, response) => complete(response, 'COMMITTED_MAIN_SEMANTIC', {
    id: 'OPAQUE_MAIN_CONTINUATION', output: [
      { id: 'opaque-reasoning-id', type: 'reasoning', encrypted_content: 'OPAQUE_MAIN_ENCRYPTED', summary: [] },
      { id: 'main-semantic-id', type: 'message', content: [{ type: 'output_text', text: 'COMMITTED_MAIN_SEMANTIC' }] },
    ],
  }) });
  await install(f, `
    if(input.event.kind==='started') return {action:{kind:'request_model'},state:null};
    if(input.event.kind==='model_completed') return {action:${job()},state:null};
    return {action:{kind:'complete'},state:null};`);
  const { run } = await submit(f, 'semantic'); await terminal(f, run.run_id);
  expect(f.main.requests).toHaveLength(1); expect(f.planner.requests).toHaveLength(1);
  const request = f.planner.requests[0]!.body;
  expect(JSON.stringify(request)).toContain('COMMITTED_MAIN_SEMANTIC');
  expect(JSON.stringify(request)).toContain('COMMITTED_USER_CONTEXT');
  expect(JSON.stringify(request)).toContain('COMMITTED_SYSTEM_CONTEXT');
  expect(JSON.stringify(request)).toContain('untrusted source data');
  expect(JSON.stringify(request)).not.toMatch(/OPAQUE_MAIN_CONTINUATION|OPAQUE_MAIN_ENCRYPTED|opaque-reasoning-id/);
  expect(request.previous_response_id).toBeUndefined();
  expect((request.input as Array<Record<string, unknown>>).filter(item => item.role === 'assistant' || item.type === 'function_call')).toEqual([]);
});

it.each(['account', 'generation', 'endpoint'] as const)('fences planning %s changes before credential dispatch without borrowing main auth', async change => {
  const f = await fixture(); await install(f, onlyPlan);
  f.mutable.onDecision = input => {
    if (input.event.kind !== 'started') return;
    if (change === 'account') f.scope.account = 'different-planning-account';
    if (change === 'generation') f.scope.generation++;
    if (change === 'endpoint') f.mutable.authBaseUrl = f.main.endpoint;
  };
  const { run } = await submit(f, change); await terminal(f, run.run_id);
  expect(f.main.requests).toHaveLength(0); expect(f.planner.requests).toHaveLength(0);
  expect(f.authReads).not.toContain(mainSelection.providerId);
  expect(f.decisions.find(input => input.event.kind === 'model_job_completed')!.event.receipt).toMatchObject({ dispatch: 'interrupted', usable: false, outcome: 'indeterminate', output: null });
});

it.each(['run', 'operation'] as const)('keeps control and a different Run responsive while a planner stalls, then cancels its %s', async cancel => {
  let lateResponse: ServerResponse | undefined;
  let responseClosed = false;
  const f = await fixture({ planner: (_request, response) => {
    lateResponse = response;
    response.once('close', () => { responseClosed = true; });
  } });
  await install(f, onlyPlan);
  const first = await submit(f, `stalled-${cancel}`);
  await expect.poll(() => f.planner.requests.length).toBe(1);
  await expect(f.runtime.status(AbortSignal.timeout(3000))).resolves.toHaveProperty('eventCursor');
  // An independently admitted second Run uses the built-in policy through the same kernel.
  const other = await f.api.create(`other-${cancel}`);
  const otherRun = await f.runtime.submit({ key: 'independent', threadId: other.threadId, branchId: other.branchId, expectedHead: null,
    input: { text: 'INDEPENDENT_RUN' }, configuration: (await f.models.resolveModel(mainSelection)).configuration });
  const independent = new AgentRuntimeClient(f.kernel);
  await independent.startRunWithCredentialOwner(otherRun.run_id, (await f.models.resolveModel(mainSelection)).credentialOwner);
  await expect.poll(async () => (await independent.run(otherRun.run_id)).state).toBe('completed');
  expect(f.main.requests).toHaveLength(1);
  const [operation] = await modelOperations(f, first.run.run_id); expect(operation).toBeDefined();
  if (cancel === 'run') await f.runtime.cancelRun(first.run.run_id, AbortSignal.timeout(3000));
  else await f.runtime.cancelOperation(operation!.id, AbortSignal.timeout(3000));
  await terminal(f, first.run.run_id, cancel === 'run' ? 'cancelled' : 'completed');
  expect((await f.runtime.operation(operation!.id)).phase).toBe('terminal');
  const historyBeforeLateOutput = (await f.api.snapshot(first.identity)).history;
  await expect.poll(() => responseClosed).toBe(true);
  complete(lateResponse!, 'LATE_PLANNER_MUST_NOT_BECOME_AN_ANSWER');
  await f.runtime.status();
  expect((await f.api.snapshot(first.identity)).history).toEqual(historyBeforeLateOutput);
  expect(JSON.stringify(historyBeforeLateOutput)).not.toContain('LATE_PLANNER_MUST_NOT_BECOME_AN_ANSWER');
  expect(f.planner.requests).toHaveLength(1); expect(f.main.requests).toHaveLength(1);
});

it('cancels a planner waiting on its existing credential owner and ignores late auth resolution', async () => {
  let releaseAuth!: () => void;
  let authReturned = false;
  const authGate = new Promise<void>(resolve => { releaseAuth = resolve; });
  const f = await fixture({ planningAuth: async () => { await authGate; authReturned = true; } });
  cleanups.push(async () => { releaseAuth(); });
  await install(f, onlyPlan);
  const { identity, run } = await submit(f, 'auth-stall');
  await expect.poll(() => f.authReads).toEqual([planningSelection.providerId]);
  await f.runtime.cancelRun(run.run_id, AbortSignal.timeout(3000));
  await terminal(f, run.run_id, 'cancelled');
  releaseAuth(); await expect.poll(() => authReturned).toBe(true);
  await f.runtime.status();
  expect(f.planner.requests).toHaveLength(0); expect(f.main.requests).toHaveLength(0);
  expect((await f.api.snapshot(identity)).history.every(item => item.source !== 'assistant')).toBe(true);
});

async function preparedRun(f: Fixture) {
  const identity = await f.api.create('frozen-preparation');
  const model = await f.models.resolveModel(mainSelection);
  const run = await f.runtime.submit({ key: 'frozen', threadId: identity.threadId, branchId: identity.branchId,
    expectedHead: null, input: { text: 'Frozen launch' }, configuration: model.configuration,
    launch: { source: null, enabledTools: [], credentialScope: await model.credentialOwner.scope() } });
  await f.runtime.preparePolicy(run.run_id);
  return run;
}
it('rebinds an unchanged frozen planning capability but rejects changed model limits and account scope', async () => {
  const f = await fixture(); await install(f, onlyPlan);
  const run = await preparedRun(f);
  const original = (await f.runtime.launch(run.run_id))!.selection.policy_models;
  const policyIdentity = (await f.runtime.launch(run.run_id))!.selection.policy;
  for (const changed of [
    [],
    [{ ...original[0]!, binding: null, capability_id: 'different-capability' }],
    [{ ...original[0]!, binding: null, configuration_identity: 'different-configuration' }],
    [{ ...original[0]!, binding: null, configuration: { ...original[0]!.configuration!, maxOutputTokens: 65 } }],
    [{ ...original[0]!, binding: null, credential_scope: { ...original[0]!.credential_scope!, generation: 2 } }],
  ]) {
    await expect(f.kernel.agentRuntimeRequest('runtime.launch.policy.prepare', {
      runId: run.run_id, identity: policyIdentity, policyModels: changed,
    })).rejects.toThrow();
    expect((await f.runtime.launch(run.run_id))!.selection.policy_models).toEqual(original);
  }
  const release = () => { f.kernel.unregisterPolicyOwner(run.run_id); f.kernel.unregisterCredentialOwner(run.run_id); };
  release(); await f.runtime.preparePolicy(run.run_id);
  expect((await f.runtime.launch(run.run_id))!.selection.policy_models).toEqual(original);
  release(); f.mutable.planningMaxTokens++;
  await expect(f.runtime.preparePolicy(run.run_id)).rejects.toThrow('selection-changed');
  f.mutable.planningMaxTokens--; f.scope.account = 'relinked-account';
  await expect(f.runtime.preparePolicy(run.run_id)).rejects.toThrow('selection-changed');
  expect((await f.runtime.launch(run.run_id))!.selection.policy_models).toEqual(original);
  expect(f.main.requests).toHaveLength(0); expect(f.planner.requests).toHaveLength(0);
  await f.runtime.cancelRun(run.run_id); await expect.poll(() => f.pins()).toBe(0);
});

it('preserves a planning configuration identity when equivalent owner metadata key order changes', async () => {
  const scope: CredentialScope = { reference: 'ref', authority: 'authority', account: 'account', generation: 1 };
  const configuration: ModelSessionConfiguration = { providerId: 'review-planner', providerFamily: 'openai-responses', model: 'planning-model',
    endpoint: 'http://127.0.0.1:1/responses', credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  let reordered = false;
  const owner = new ExistingHostCredentialOwner({ providerId: 'review-planner', providerFamily: 'openai-responses', endpoint: configuration.endpoint,
    currentScope: async () => reordered ? { generation: 1, account: 'account', authority: 'authority', reference: 'ref' } : scope,
    runtime: { getAuth: async () => { throw new Error('No credential dispatch is expected'); } } });
  const models: ThreadModelAuthority = { resolveModel: async () => ({ configuration: reordered
    ? Object.fromEntries(Object.entries(configuration).reverse()) as unknown as ModelSessionConfiguration : configuration, credentialOwner: owner }),
    rebindModel: async () => owner };
  const prepare = createPolicyModelPreparer({ settings: async () => configuredSettings(), models });
  const input = { threadId: 'semantic-key-order', requestedModelRoles: ['agentPlanning'] as const };
  const [first] = await prepare(input); reordered = true;
  await expect(prepare({ ...input, savedCapabilities: [first!.capability] })).resolves.toEqual([expect.objectContaining({ capability: first!.capability })]);
});

it('requires the exact auxiliary binding ID and scope in the Host credential bridge', async () => {
  const responses: PrivateCredentialResponse[] = [];
  let mainReads = 0; let planningReads = 0;
  const scope = { reference: 'ref', authority: 'owner', account: 'account', generation: 1 };
  const owner = (secret: string, read: () => void) => new ExistingHostCredentialOwner({ providerId: 'fixture', providerFamily: 'openai-responses',
    endpoint: 'http://127.0.0.1:1/responses', currentScope: async () => scope,
    runtime: { getAuth: async () => { read(); return { auth: { apiKey: secret } }; } } });
  const bridge = new CredentialBridge(() => 'epoch', async response => { responses.push(response); }, () => { throw new Error('Unexpected transport failure'); });
  cleanups.push(async () => bridge.close());
  await bridge.register('run', owner('fake-main', () => { mainReads++; }));
  await bridge.register('run', owner('fake-planner', () => { planningReads++; }), undefined, 'planning-binding');
  for (const [id, bindingId, requestScope] of [
    ['forged', 'forged-binding', scope], ['wrong-account', 'planning-binding', { ...scope, account: 'other' }],
    ['correct', 'planning-binding', scope],
  ] as const) bridge.consume({ v: 1, kind: 'credential-request', id, kernelEpoch: 'epoch', runId: 'run', bindingId, scope: requestScope });
  await expect.poll(() => responses.length).toBe(3);
  expect(responses.find(response => response.id === 'forged')!.ok).toBe(false);
  expect(responses.find(response => response.id === 'wrong-account')!.ok).toBe(false);
  expect(responses.find(response => response.id === 'correct')!.result!.headers).toContainEqual({ name: 'authorization', value: 'Bearer fake-planner' });
  expect(mainReads).toBe(0); expect(planningReads).toBe(1);
  bridge.unregister('run', 'planning-binding');
  bridge.consume({ v: 1, kind: 'credential-request', id: 'after-release', kernelEpoch: 'epoch', runId: 'run', bindingId: 'planning-binding', scope });
  bridge.consume({ v: 1, kind: 'credential-request', id: 'main-still-valid', kernelEpoch: 'epoch', runId: 'run', scope });
  await expect.poll(() => responses.length).toBe(5);
  expect(responses.find(response => response.id === 'after-release')!.ok).toBe(false);
  expect(responses.find(response => response.id === 'main-still-valid')!.result!.headers).toContainEqual({ name: 'authorization', value: 'Bearer fake-main' });
});

// These cases use real broker preparation. Wait on durable Run notifications instead of
// assuming that a cold extension has completed within expect.poll's default one second.
async function terminalFromEvents(f: Fixture, runId: string, state = 'completed') {
  let unsubscribe = () => {}; let unsubscribeExit = () => {};
  try {
    const run = await new Promise<Awaited<ReturnType<typeof f.runtime.run>>>((resolve, reject) => {
      const check = async () => {
        const current = await f.runtime.run(runId);
        if (current.waiting_on?.startsWith('preparation:')) {
          throw new Error(JSON.stringify({run:current,errors:f.launchErrors.map(String),events:(await f.runtime.events(0,256)).slice(-6)}));
        }
        if (['completed', 'failed', 'cancelled'].includes(current.state)) resolve(current);
      };
      unsubscribe = f.runtime.onEvent(event => { if (event.stream === 'durable') void check().catch(reject); });
      unsubscribeExit = f.runtime.onExit(reject);
      void check().catch(reject);
    });
    expect(run.state, JSON.stringify({ run, launchErrors: f.launchErrors.map(String), events: (await f.runtime.events(0, 256)).slice(-5) })).toBe(state);
  } finally { unsubscribe(); unsubscribeExit(); }
}

it('independent planning preparation carries pending memory facts without changing the frozen memory system', async () => {
  let held: ServerResponse | undefined;
  const f = await fixture({ memory: true, main: (_request, response) => { held = response; } });
  await f.personalization!.saveNote({ scope: { kind: 'global' }, content: 'PLANNING_FROZEN_MEMORY' });
  await install(f, `
    if(input.event.kind==='started') return {action:{kind:'request_model'},state:null};
    if(input.event.kind==='model_completed') return {action:${job()},state:null};
    return {action:{kind:'complete'},state:null};`);
  const { identity, run } = await submit(f, 'planning-memory');
  await expect.poll(() => Boolean(held)).toBe(true);
  const frozenRequest = structuredClone(f.main.requests[0]!.body);
  const before = (await f.api.snapshot(identity)).context.checkpoint!;
  await f.personalization!.saveNote({ scope: { kind: 'global' }, content: 'PLANNING_NEW_MEMORY_FACT' });
  complete(held!, 'MAIN_FINISHED');
  await terminalFromEvents(f, run.run_id);
  expect(f.main.requests).toHaveLength(1);
  expect(f.main.requests[0]!.body).toEqual(frozenRequest);
  expect(f.planner.requests).toHaveLength(1);
  expect(JSON.stringify(f.planner.requests[0]!.body)).toContain('PLANNING_NEW_MEMORY_FACT');
  const after = (await f.api.snapshot(identity)).context.checkpoint!;
  expect(after.proposal.memory_checkpoint).toBe(before.proposal.memory_checkpoint);
  expect(after.proposal.effective_system_prompt).toBe(before.proposal.effective_system_prompt);
  expect(after.proposal.effective_system_prompt).not.toContain('PLANNING_NEW_MEMORY_FACT');
  expect(after.proposal.effective_system_prompt).toContain('PLANNING_FROZEN_MEMORY');
  const operations = await modelOperations(f, run.run_id);
  expect(operations).toHaveLength(1);
  const stored = await originalObject(f, (operations[0]!.result as { request_ref: unknown }).request_ref) as { view: { request_id: string; origin: { kind: string } } };
  expect(stored.view.origin.kind).toBe('policy_model_job');
  expect(JSON.stringify(stored)).toContain('PLANNING_NEW_MEMORY_FACT');
  const database = new DatabaseSync(path.join(f.root, 'agent-runtime', 'conversation.sqlite'), { readOnly: true });
  try {
    const deliveries = database.prepare('SELECT state FROM deliveries WHERE request=? AND observer LIKE ?').all(stored.view.request_id, 'memory-delivery:%');
    expect(deliveries).toEqual([{ state: '"committed"' }]);
    expect(database.prepare('SELECT count(*) AS count FROM model_steps WHERE id=?').get(stored.view.request_id)).toEqual({ count: 0 });
  } finally { database.close(); }
});

it.each(['read', 'save'] as const)('policy read graphs treat memory %s according to its actual effect', async action => {
  const f = await fixture({ memory: true });
  const graph = { kind: 'read_graph', nodes: [{ id: 'memory-node', depends_on: [], call: {
    call_id: 'memory-node', name: 'memory', schema_version: '1', arguments: action === 'read'
      ? { action: 'read' } : { action: 'save', content: 'POLICY_MUST_NOT_WRITE_MEMORY', revision: 0 },
  } }] };
  await install(f, `return {action:input.event.kind==='started'?${JSON.stringify(graph)}:{kind:'complete'},state:null};`);
  const { run } = await submit(f, `memory-read-graph-${action}`);
  await terminalFromEvents(f, run.run_id, action === 'read' ? 'completed' : 'failed');
  expect(f.main.requests).toHaveLength(0); expect(f.planner.requests).toHaveLength(0);
  expect(await f.personalization!.catalog()).toEqual({ memories: [], prompts: {}, revision: 0 });
  expect(f.decisions.some(input => input.event.kind === 'read_graph_completed')).toBe(action === 'read');
});


it.each(['reject', 'throw'] as const)('planning context owner %s durably fails before ModelJob admission and survives reopen', async failure => {
  const f = await fixture({ memory: true });
  await install(f, onlyPlan);
  f.memoryControl.synchronizeFailure = failure;
  const { identity, run } = await submit(f, `planner-context-failure-${failure}`);
  const before = await f.runtime.context(identity.branchId);
  await terminalFromEvents(f, run.run_id, 'failed');
  expect(f.main.requests).toHaveLength(0); expect(f.planner.requests).toHaveLength(0);
  expect(await modelOperations(f, run.run_id)).toEqual([]);
  const failures = (await f.runtime.events(0, 256)).filter(event => event.subject === run.run_id && event.kind === 'context.preparation_failed');
  expect(failures).toHaveLength(1);
  expect(failures[0]!.data).toMatchObject({ code: 'context_preparation_failed', message: expect.any(String) });
  expect(JSON.stringify(failures)).not.toContain('REVIEW_');
  expect(await f.runtime.context(identity.branchId)).toEqual(before);
  await f.closeKernel();
  const reopened = createKernelClient({ hostId: 'planning-host-review', storageRoot: f.root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(() => reopened.close());
  const runtime = new AgentRuntimeClient(reopened);
  expect((await runtime.run(run.run_id)).state).toBe('failed');
  expect((await runtime.events(0, 256)).filter(event => event.subject === run.run_id && event.kind === 'context.preparation_failed')).toEqual(failures);
  expect(await runtime.context(identity.branchId)).toEqual(before);
});
