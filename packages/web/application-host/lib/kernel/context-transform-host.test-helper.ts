/** Actual declarative providers and ThreadContext over the existing test-only stdio rendezvous.
 * The model response is controlled in Rust. This helper never starts a product listener. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { VARIN_CONTEXT_FRAGMENTS_SERVICE } from '@varin/extension-contract';
import { KernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createContextComposition } from './context-composition.js';
import { createThreadContext, type ContextPreparer } from './thread-context.js';
import { resourceScopeFixture } from './resource-scope.test-helper.js';
import type { ContextCheckpoint } from '@varin/application-client';
import type { ChildTask, KernelHandshakeResult } from './protocol.generated.js';

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
let sequence = 0;
let root = '', threadId = '', branchId = '';
let kernel: KernelClient, runtime: AgentRuntimeClient, extensions: ApplicationExtensionRuntime;
let storage: KernelStorageAdapter, context: ContextPreparer;
let collectionPreparations = 0;
const id = (name: string) => `example.context-${name}`;
const key = (name: string) => `${id(name)}:host:varin.context.fragments@1`;

function request(method: string, params: unknown, options: { grant?: { grantId: string } } = {}): Promise<unknown> {
  const requestId = `context:${++sequence}`;
  const result = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
  send({ kind: 'fixture-request', id: requestId, method, params, ...(options.grant ? { grantId: options.grant.grantId } : {}) });
  return result;
}

async function install(name: string, content: string, kind: 'instruction' | 'data') {
  const directory = join(root, 'packages', name); await mkdir(directory, { recursive: true });
  const manifest = { schemaVersion: 1, id: id(name), version: '1.0.0', engines: { varin: '*' },
    entrypoints: { host: { mode: 'brokered', file: 'host.cjs', activation: ['service-request'] } },
    provides: { services: [VARIN_CONTEXT_FRAGMENTS_SERVICE] } };
  await writeFile(join(directory, 'varin.extension.json'), JSON.stringify(manifest));
  // Same section name deliberately belongs to independent provider/content identities.
  await writeFile(join(directory, 'host.cjs'), `module.exports = { activate(context) {
    context.services.provide(${JSON.stringify(VARIN_CONTEXT_FRAGMENTS_SERVICE)}, {
      describe() { require('node:fs').appendFileSync(${JSON.stringify(join(root, 'describe-observations.jsonl'))}, ${JSON.stringify(JSON.stringify({ name, content }) + '\n')});
        return ${JSON.stringify({ sections: [{ name: 'shared-name', kind, content }] })}; }
    });
  } };`);
  const snapshot = await extensions.installOrStage({ expectedRevision: (await extensions.catalog.snapshot()).revision,
    source: { kind: 'local', display: `Context ${name}`, specifier: directory } });
  const entry = snapshot.extensions.find(value => value.manifest.id === id(name))!;
  if (!entry.desired.enabled) return extensions.setEnabled(id(name), true, snapshot.revision);
  if (entry.candidate) {
    const requested = await extensions.requestCandidateApplication({ extensionId: id(name), candidateIntegrity: entry.candidate.integrity,
      expectedRevision: snapshot.revision });
    return extensions.selectCandidate({ extensionId: id(name), candidateIntegrity: entry.candidate.integrity, expectedRevision: requested.revision });
  }
  return snapshot;
}

async function select(names: string[]) {
  return extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
    rule: { allowFallback: false, providerKeys: names.map(key), scope: { userId: 'default' }, serviceId: 'varin.context.fragments', version: 1 } });
}

async function initialize(frame: Record<string, unknown>) {
  root = String(frame.root); threadId = String(frame.threadId); branchId = String(frame.branchId);
  kernel = new KernelClient({ hostId: 'web-domain-host', hostGeneration: 'web-domain-generation',
    storageRoot: String(frame.storageRoot), buildVersion: '0.9.25' });
  const transport = kernel as unknown as { epoch: string; started: boolean; handshakeResult: KernelHandshakeResult };
  transport.epoch = String(frame.epoch); transport.started = true;
  transport.handshakeResult = { hostId: 'web-domain-host', storageRoot: String(frame.storageRoot), kernelEpoch: String(frame.epoch) } as KernelHandshakeResult;
  Object.defineProperty(kernel, 'requestRaw', { value: request });
  Object.defineProperty(kernel, 'write', { value: async (value: unknown) => { send(value); } });
  runtime = new AgentRuntimeClient(kernel);
  storage = new KernelStorageAdapter({ client: kernel, hostId: 'web-domain-host', storageRoot: String(frame.storageRoot),
    resolveWorkspaceRoot: async () => { throw new Error('Source-free context must not open a file source'); } });
  const personalization = createAgentPersonalization({ client: kernel, context: async () => ({ bot: false }) });
  await personalization.savePrompt({ kind: 'global' }, { sections: { original_rule: 'ORIGINAL USER PROFILE' } }, 0);
  extensions = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'extensions'), varinVersion: '0.9.25',
    brokerScript: resolve('packages/extension-host/broker/broker-child.mjs') });
  await extensions.start();
  const prepareCollection = extensions.prepareServiceCollection.bind(extensions);
  extensions.prepareServiceCollection = (...args) => { collectionPreparations++; return prepareCollection(...args); };
  // Reverse installation order is intentional: explicit selection alone orders transforms.
  await install('c', 'UNSELECTED C', 'instruction');
  await install('b', 'B DATA VERSION ONE', 'data');
  await install('a', 'A INSTRUCTION', 'instruction');
  await select(['a', 'b']);
  context = createThreadContext({ composition: createContextComposition(extensions), personalization,
    resources: resourceScopeFixture(root, createKernelWorkspaceWorkingStateAccess(storage)),
    projectForWorkspace: async () => undefined });
  const initial = await context.main({ runtime: 'agent', threadId, branchId }, null);
  assert.equal(collectionPreparations, 1);
  assert(!extensions.services.getSnapshot().providers.some(value => value.extensionId === id('c')),
    'An unselected provider must not cold-activate');
  const receipt = await runtime.submit({ key: 'context-first', threadId, branchId, expectedHead: null,
    input: { text: 'FIRST USER MESSAGE' }, configuration: frame.configuration,
    launch: { source: null, enabledTools: [], inheritSource: false }, initialContext: initial });
  send({ kind: 'fixture-submitted', receipt, initial });
}

async function handle(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-response') {
    const current = pending.get(String(frame.id)); assert(current); pending.delete(String(frame.id));
    if (frame.ok) current.resolve(frame.result); else current.reject(new Error(String(frame.error)));
    return;
  }
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (frame.kind === 'fixture-update') {
    const checkpoint = frame.checkpoint as unknown as ContextCheckpoint;
    const unchanged = await context.refresh!(checkpoint);
    assert.deepEqual(unchanged.personalization?.contextComposition, checkpoint.personalization?.contextComposition);
    assert.equal(collectionPreparations, 1, 'Unchanged preparation must not repeat whole-catalog selection');
    const observed = async () => (await readFile(join(root, 'describe-observations.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { name: string; content: string });
    assert.deepEqual((await observed()).map(call => call.name).sort(), ['a', 'b']);
    await install('b', 'B DATA VERSION TWO', 'data');
    const candidate = await context.refresh!(checkpoint);
    const next = await runtime.refreshContext({ branchId, expectedRevision: checkpoint.revision, context: candidate });
    const a = checkpoint.personalization!.contextComposition!.transforms[0]!;
    assert.deepEqual(next.personalization!.contextComposition!.transforms[0], a, 'Updating B must retain A exact content and provider identity');
    const calls = await observed();
    assert.equal(calls.filter(call => call.name === 'a').length, 1);
    assert.deepEqual(calls.filter(call => call.name === 'b').map(call => call.content), ['B DATA VERSION ONE', 'B DATA VERSION TWO']);
    send({ kind: 'fixture-updated', checkpoint: next }); return;
  }
  if (frame.kind === 'fixture-disabled') {
    const checkpoint = frame.checkpoint as unknown as ContextCheckpoint;
    await extensions.setEnabled(id('b'), false, (await extensions.catalog.snapshot()).revision);
    await assert.rejects(context.refresh!(checkpoint));
    assert.deepEqual(await runtime.context(branchId), checkpoint, 'New preparation failure cannot erase the old accepted checkpoint');
    send({ kind: 'fixture-disable-checked' }); return;
  }
  if (frame.kind === 'fixture-child') {
    const child = frame.child as unknown as ChildTask;
    await extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
      rule: { allowFallback: false, providerKeys: [key('b'), key('a')], scope: { sessionId: child.child_thread_id },
        serviceId: 'varin.context.fragments', version: 1 } });
    const initial = await context({ runtime: 'agent', threadId: child.child_thread_id, branchId: child.child_branch_id }, null,
      { mode: 'agent', threadRole: 'worker', projectId: child.project_id, childProfile: child.selected_profile });
    assert.equal(initial.personalization?.sessionId, child.child_thread_id);
    assert.equal(initial.resources?.snapshot.scope.threadRole, 'worker');
    const receipt = await runtime.prepareChild({ executionId: String(frame.executionId), source: null, context: initial, expectedContextCheckpoint: null });
    const checkpoint = await runtime.context(child.child_branch_id);
    assert(checkpoint);
    const refresh = await context.refreshResources!(checkpoint);
    assert.equal(refresh.personalization?.sessionId, child.child_thread_id);
    assert.deepEqual(refresh.personalization?.contextComposition, initial.personalization?.contextComposition);
    const parentCheckpoint = await runtime.context(branchId);
    assert(parentCheckpoint);
    // Warm the parent after the genuine child routing edit, then alternate unchanged scopes.
    await context.refresh!(parentCheckpoint);
    const afterConfiguration = collectionPreparations;
    await context.refresh!(checkpoint);
    await context.refresh!(parentCheckpoint);
    assert.equal(collectionPreparations, afterConfiguration,
      'Unchanged scopes must not invalidate each other and rescan the whole Catalog');
    send({ kind: 'fixture-child-prepared', receipt, checkpoint }); return;
  }
  if (frame.kind === 'fixture-empty') {
    const checkpoint = frame.checkpoint as unknown as ContextCheckpoint;
    await select([]);
    const candidate = await context.refresh!(checkpoint);
    const next = await runtime.refreshContext({ branchId, expectedRevision: checkpoint.revision, context: candidate });
    assert.deepEqual(next.personalization!.contextComposition!.transforms, []);
    send({ kind: 'fixture-empty-checked', checkpoint: next }); return;
  }
  if (frame.kind === 'fixture-finish') {
    await extensions.stop(); await storage.dispose();
    send({ kind: 'fixture-finished' }); return;
  }
  Reflect.apply((kernel as unknown as { consumeFrame(value: unknown): void }).consumeFrame, kernel, [frame]);
}
createInterface({ input: process.stdin }).on('line', line => {
  void handle(JSON.parse(line) as Record<string, unknown>).catch(error => send({ kind: 'fixture-failed', error: String(error),
    stack: error instanceof Error ? error.stack : undefined }));
});
