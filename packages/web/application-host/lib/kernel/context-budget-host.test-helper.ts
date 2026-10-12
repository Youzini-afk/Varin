/** Real Context budget/summary owners over the existing test-only stdio rendezvous. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { VARIN_CONTEXT_BUDGET_SERVICE } from '@varin/extension-contract';
import { KernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createContextBudget, type ContextBudgetOwner } from './context-budget.js';
import { ContextService } from './context-service.js';
import { readContextPolicy } from './context-settings.js';
import { createMemoryOwner } from './memory-owner.js';
import { createThreadContext } from './thread-context.js';
import { waitWithSignal } from '../cancellation.js';
import { resourceScopeFixture } from './resource-scope.test-helper.js';
import type { ChildTask, KernelHandshakeResult } from './protocol.generated.js';

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let sequence = 0, root = '', threadId = '', branchId = '', runId = '';
let kernel: KernelClient, runtime: AgentRuntimeClient, extensions: ApplicationExtensionRuntime;
let storage: KernelStorageAdapter, service: ContextService;
let configuration: unknown;
const observations: unknown[] = [];
let holdPublication = true;
function request(method: string, params: unknown, options: { grant?: { grantId: string } } = {}): Promise<unknown> {
  const id = `budget:${++sequence}`;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send({ kind: 'fixture-request', id, method, params, ...(options.grant ? { grantId: options.grant.grantId } : {}) });
  return result;
}
async function settings(reserveTokens: number) {
  await writeFile(join(root, 'agent/settings.json'), JSON.stringify({ compaction: {
    enabled: true, reserveTokens, keepRecentTokens: 32,
  }, harness: { context: { backgroundPreparation: false, preparationWaterline: 0.5 } } }));
}
async function initialize(frame: Record<string, unknown>) {
  root = String(frame.root); threadId = String(frame.threadId); branchId = String(frame.branchId);
  configuration = frame.configuration;
  await mkdir(join(root, 'agent'), { recursive: true });
  kernel = new KernelClient({ hostId: 'web-domain-host', hostGeneration: 'web-domain-generation',
    storageRoot: String(frame.storageRoot), buildVersion: '0.9.25' });
  const transport = kernel as unknown as { epoch: string; started: boolean; handshakeResult: KernelHandshakeResult };
  transport.epoch = String(frame.epoch); transport.started = true;
  transport.handshakeResult = { hostId: 'web-domain-host', storageRoot: String(frame.storageRoot), kernelEpoch: String(frame.epoch) } as KernelHandshakeResult;
  Object.defineProperty(kernel, 'requestRaw', { value: request });
  Object.defineProperty(kernel, 'write', { value: async (value: unknown) => { send(value); } });
  runtime = new AgentRuntimeClient(kernel);
  storage = new KernelStorageAdapter({ client: kernel, hostId: 'web-domain-host', storageRoot: String(frame.storageRoot),
    resolveWorkspaceRoot: async () => { throw new Error('Source-free budget must not open a file source'); } });
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false }) });
  const context = createThreadContext({ personalization,
    resources: resourceScopeFixture(root, createKernelWorkspaceWorkingStateAccess(storage)), projectForWorkspace: async () => undefined });
  kernel.setMemoryOwner(createMemoryOwner({ personalization, prepareContext: context }));
  extensions = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'extensions'), varinVersion: '0.9.25',
    brokerScript: resolve('packages/extension-host/broker/broker-child.mjs') });
  await extensions.start();
  const originalBudget = createContextBudget(extensions);
  const budget: ContextBudgetOwner = { selected: originalBudget.selected,
    async decide(scope, input, signal) {
      const value = await originalBudget.decide(scope, input, signal);
      observations.push({ scope, input, value });
      return value;
    } };
  service = new ContextService(runtime, context, async (run) => {
    const model = run.configuration as { model: string; providerId?: string };
    const policy = await readContextPolicy({ agentDir: join(root, 'agent'), projectTrusted: false, modelId: model.model,
      ...(model.providerId ? { providerId: model.providerId } : {}) });
    const scope = await runtime.contextScope(run.id);
    return { policy, scope: { sessionId: run.thread_id, ...(scope?.projectId ? { projectId: scope.projectId } : {}) } };
  }, async (id, signal) => { await runtime.startRun(id, signal); }, budget);
  kernel.setContextOwner(service);
  const resume = runtime.resumeContextJob.bind(runtime);
  runtime.resumeContextJob = async (id, signal) => {
    if (holdPublication && (await runtime.run(id, signal)).state === 'completed') {
      send({ kind: 'fixture-publication-held', job: await runtime.contextJob(id), observations });
      await waitWithSignal(new Promise<never>(() => {}), signal);
    }
    return resume(id, signal);
  };
  if (frame.reopen) {
    holdPublication = false;
    ({ runId } = JSON.parse(await readFile(join(root, 'budget-run.json'), 'utf8')));
    await service.recover();
    send({ kind: 'fixture-recovered', observations }); return;
  }
  await settings(128);
  await personalization.savePrompt({ kind: 'global' }, { sections: { original_rule: 'ORIGINAL BUDGET USER PROFILE' } }, 0);
  const initial = await context.main({ runtime: 'agent', threadId, branchId }, null);
  const installed = await extensions.installOrStage({ expectedRevision: (await extensions.catalog.snapshot()).revision,
    source: { kind: 'local', display: 'Actual budget example', specifier: resolve('examples/extensions/context-budget') } });
  const example = installed.extensions.find(entry => entry.manifest.id === 'example.context-budget'); assert(example);
  await extensions.setEnabled(example.manifest.id, true, installed.revision);
  if (frame.child) {
    const child = frame.child as ChildTask;
    await extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
      rule: { serviceId: 'varin.context.budget', version: 1, providerKeys: ['example.context-budget:host:varin.context.budget@1'],
        scope: { sessionId: child.child_thread_id }, allowFallback: false } });
    const childContext = await context({ runtime: 'agent', threadId: child.child_thread_id, branchId: child.child_branch_id }, null,
      { mode: 'agent', threadRole: 'worker', projectId: child.project_id, childProfile: child.selected_profile });
    const prepared = await runtime.prepareChild({ executionId: String(frame.executionId), source: null, context: childContext, expectedContextCheckpoint: null });
    const childRun = prepared.receipt!.run_id;
    const checkpoint = await runtime.context(child.child_branch_id); assert(checkpoint);
    const signal = new AbortController().signal;
    const selected = await service.query({ action: 'prepare', runId: childRun, requestId: 'scope-only', expectedRevision: checkpoint.revision }, signal);
    const parent = await service.query({ action: 'prepare', runId: child.parent_run_id, requestId: 'parent-scope-only', expectedRevision: 0 }, signal);
    assert.equal(selected.status, 'ready'); assert.equal(selected.status === 'ready' && selected.external, true);
    assert.equal(parent.status, 'ready'); assert.equal(parent.status === 'ready' && parent.external, false);
    assert.equal(checkpoint.personalization?.sessionId, child.child_thread_id);
    assert.equal(checkpoint.personalization?.threadRole, 'worker');
    assert.equal(observations.length, 0, 'Selection alone must not execute the Decision');
    service.close(); await extensions.stop(); await storage.dispose();
    send({ kind: 'fixture-child-verified', childRun, checkpoint, selected, parent }); return;
  }

  // No route: merely installing the only external budget must preserve native default behavior.
  const receipt = await runtime.submit({ key: 'budget-first', threadId, branchId, expectedHead: null,
    input: { text: `ORIGINAL_EVIDENCE ${'recorded source fact. '.repeat(1000)}` }, configuration,
    launch: { source: null, enabledTools: [], inheritSource: false }, initialContext: initial });
  if (frame.withGoal) await runtime.startGoal({ key: 'calibrated-objective', runId: receipt.run_id,
    threadId, branchId, objective: 'Keep the original continuing objective and its user-level authority', budget: null });
  await runtime.startRun(receipt.run_id);
  send({ kind: 'fixture-submitted', receipt });
}
async function handle(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-response') {
    const current = pending.get(String(frame.id)); assert(current); pending.delete(String(frame.id));
    if (frame.ok) current.resolve(frame.result);
    else current.reject(Object.assign(new Error(JSON.stringify(frame.error)), { code: (frame.error as { code?: string })?.code }));
    return;
  }
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (frame.kind === 'fixture-invalid') {
    assert.equal(observations.length, 0, 'Default must not execute an installed external Decision');
    assert(!extensions.services.getSnapshot().providers.some(value => value.extensionId === 'example.context-budget'));
    const packageRoot = join(root, 'invalid-background'); await mkdir(packageRoot);
    const manifest = { schemaVersion: 1, id: 'review.invalid-background', version: '1.0.0', engines: { varin: '*' },
      displayName: 'Controlled invalid background strategy', entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
      provides: { services: [VARIN_CONTEXT_BUDGET_SERVICE] } };
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: manifest.id, version: manifest.version }));
    await writeFile(join(packageRoot, 'varin.extension.json'), JSON.stringify(manifest));
    await writeFile(join(packageRoot, 'host.cjs'), `module.exports={activate(context){context.services.provide(${JSON.stringify(VARIN_CONTEXT_BUDGET_SERVICE)}, {
      describe:()=>({identity:{name:'invalid-background',version:'1'},configuration:{}}),
      decide:([input])=>({kind:'compact',throughId:input.candidates[0].throughId,mode:'background'})
    });}};`);
    const installed = await extensions.installOrStage({ expectedRevision: (await extensions.catalog.snapshot()).revision,
      source: { kind: 'local', display: 'Controlled invalid background strategy', specifier: packageRoot } });
    await extensions.setEnabled(manifest.id, true, installed.revision);
    await extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
      rule: { serviceId: 'varin.context.budget', version: 1, providerKeys: ['review.invalid-background:host:varin.context.budget@1'],
        scope: { userId: 'default' }, allowFallback: false } });
    const branch = (await runtime.thread(threadId)).branches.find(value => value.branch_id === branchId); assert(branch);
    const receipt = await runtime.submit({ key: 'budget-invalid', threadId, branchId, expectedHead: branch.head,
      input: { text: 'Preserve the user setting disabling background preparation' }, configuration,
      launch: { source: null, enabledTools: [], inheritSource: false } });
    await runtime.startRun(receipt.run_id);
    send({ kind: 'fixture-invalid-submitted', receipt }); return;
  }
  if (frame.kind === 'fixture-second') {
    assert.equal(observations.length, 1, 'Invalid provider was actually called once');
    observations.length = 0;
    // Keep this budget unchanged across recovery. It must fit the real fixed tool schemas
    // plus S1/B/N, while the original source request remains above capacity.
    await settings(9000);
    await extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
      rule: { serviceId: 'varin.context.budget', version: 1,
        providerKeys: ['example.context-budget:host:varin.context.budget@1'], scope: { userId: 'default' }, allowFallback: false } });
    const branch = (await runtime.thread(threadId)).branches.find(value => value.branch_id === branchId); assert(branch);
    const receipt = await runtime.submit({ key: 'budget-second', threadId, branchId, expectedHead: branch.head,
      input: { text: 'SECOND USER QUESTION must remain after the fixed summary' }, configuration,
      launch: { source: null, enabledTools: [], inheritSource: false } });
    runId = receipt.run_id;
    await writeFile(join(root, 'budget-run.json'), JSON.stringify({ runId }));
    await runtime.startRun(runId);
    send({ kind: 'fixture-second-submitted', receipt }); return;
  }
  if (frame.kind === 'fixture-calibrated') {
    assert.equal(observations.length, 0);
    await settings(12000);
    await extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
      rule: { serviceId: 'varin.context.budget', version: 1,
        providerKeys: ['example.context-budget:host:varin.context.budget@1'], scope: { userId: 'default' }, allowFallback: false } });
    const branch = (await runtime.thread(threadId)).branches.find(value => value.branch_id === branchId); assert(branch);
    const receipt = await runtime.submit({ key: 'budget-calibrated', threadId, branchId, expectedHead: branch.head,
      input: { text: 'NEW USER INPUT after actual successful generation' }, configuration,
      launch: { source: null, enabledTools: [], inheritSource: false } });
    await runtime.startRun(receipt.run_id);
    send({ kind: 'fixture-calibrated-submitted', receipt }); return;
  }
  if (frame.kind === 'fixture-tail') {
    // The original source is frozen; a later request must recompile this complete new tail.
    await runtime.enqueue({ key: 'budget-tail', threadId, branchId, mode: 'boundary', input: { text: 'NEW_TAIL N entered while original summary was running' } });
    send({ kind: 'fixture-tail-added' }); return;
  }
  if (frame.kind === 'fixture-finish') {
    const jobs = await runtime.contextJobs(branchId), checkpoint = await runtime.context(branchId);
    service.close(); await extensions.stop(); await storage.dispose();
    send({ kind: 'fixture-finished', jobs, checkpoint, observations }); return;
  }
  (kernel as unknown as { consumeFrame(value: unknown): void }).consumeFrame(frame);
}
createInterface({ input: process.stdin }).on('line', line => {
  void handle(JSON.parse(line)).catch(error => { console.error(error); send({ kind: 'fixture-failed', error: String(error) }); });
});
