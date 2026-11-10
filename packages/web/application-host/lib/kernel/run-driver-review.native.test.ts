import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createDocumentAuthority } from '../documents/authority.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { createAgentDriver } from './agent-driver.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { createKernelClient } from './kernel-client.js';
import { bindDocumentTextCodec } from '../documents/inspect.js';
import { guardProviderReply } from './provider-response.test-helper.js';
import { resourceScopeFixture } from './resource-scope.test-helper.js';
import { createRunDriverOwner, VARIN_AGENT_DRIVER_CAPABILITY } from './run-driver-owner.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';
import { ThreadAdapter } from './thread-adapter.js';
import { createThreadSourcePreparer } from './thread-sources.js';
import { TransportFixture } from './tests/transport-fixture.js';
import { KERNEL_REQUEST_WINDOW, type RuntimeEvent, type AgentRuntimeStreamEvent } from './protocol.generated.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const model = { providerId: 'driver-review-provider', modelId: 'driver-review-model' };
function complete(response: ServerResponse, output: unknown[]) {
  if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output,
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } })}\n\n`);
}
const message = (id: string, text: string) => ({ id, type: 'message', content: [{ type: 'output_text', text }] });
async function fixture(reply: (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>, probe?: TransportFixture, sourceCode?: string) {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-driver-native-review-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', guardProviderReply(response, () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body); return reply(body, response);
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture requires a loopback listener');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const endpoint = `http://127.0.0.1:${address.port}/responses`;
  const kernel = createKernelClient({ hostId: 'driver-native-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false, ...(probe ? { transportFactory: probe.create } : {}) });
  const releaseCodec = bindDocumentTextCodec(kernel);
  cleanups.push(async () => { releaseCodec(); await kernel.close(); });
  const progress: AgentRuntimeStreamEvent[] = [];
  const stopProgress = kernel.onAgentRuntimeEvent(event => { if (event.stream === 'progress') progress.push(event); });
  cleanups.push(async () => { stopProgress(); });
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: buildVersion,
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await extensions.start(); cleanups.push(() => extensions.stop());
  cleanups.push(async () => { releaseCodec(); await kernel.close(); });
  extensions.capabilities.register(VARIN_AGENT_DRIVER_CAPABILITY, createRunDriverOwner(kernel));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const documents = createDocumentAuthority({ hostId: 'driver-native-review', dataDir: path.join(root, 'documents'), isAllowedRoot: async () => true, isTrusted: async () => true });
  const storage = new KernelStorageAdapter({ client: kernel, hostId: 'driver-native-review', storageRoot: root,
    resolveWorkspaceRoot: async id => (await documents.inspectWorkspace(id)).root });
  cleanups.push(async () => { await storage.dispose(); await documents.dispose(); });
  const workingStates = createKernelWorkspaceWorkingStateAccess(storage);
  const resources = resourceScopeFixture(root, workingStates, documents, undefined, (input, consume) => storage.withResourceRead(input, consume));
  const prepareSource = createThreadSourcePreparer({ inspectInventory: async () => ({ kind: 'directory' }),
    sourceTools: mode => kernel.agentRuntimeRequest('runtime.source.tools', { mode }), documents, workingStates, prepareResources: resources.prepareSourceCapture });
  const owner = new ExistingHostCredentialOwner({ providerId: model.providerId, providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'driver-fixture-reference', authority: 'fixture-existing-owner', account: 'fixture-account', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: 'fake-driver-fixture-key-not-a-real-secret' } }) } });
  const configuration = { providerFamily: 'openai-responses', model: model.modelId, endpoint, credentialEnvironment: null,
    allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 256 };
  const runtime = new AgentRuntimeClient(kernel, undefined, undefined, undefined, undefined, undefined,
    (id, signal) => documents.admitWorkspaceRegistration(id, signal), createAgentDriver(extensions));
  const launchErrors: unknown[] = [];
  const adapter = new ThreadAdapter(runtime, {
    resolveModel: async selection => {
      if (selection.providerId !== model.providerId || selection.modelId !== model.modelId) throw new Error('Unknown fixture model');
      return { configuration, credentialOwner: owner };
    }, rebindModel: async () => owner,
  }, async source => { await documents.inspectWorkspace(source.workspaceId); await documents.inspectWorkspace(source.executionWorkspaceId); },
  (_runId, error) => { launchErrors.push(error); }, prepareSource);
  const folder = path.join(root, 'parallel-driver'); await fs.mkdir(folder);
  for (const file of ['package.json', 'varin.extension.json']) await fs.copyFile(path.join(repository, 'examples/extensions/parallel-driver', file), path.join(folder, file));
  const entrypoint = sourceCode ? path.join(folder, 'host.ts') : path.join(repository, 'examples/extensions/parallel-driver/host.ts');
  if (sourceCode) await fs.writeFile(entrypoint, sourceCode);
  await build({ entryPoints: [entrypoint], bundle: true, platform: 'node', format: 'cjs',
    outfile: path.join(folder, 'host.cjs'), alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') } });
  await extensions.installOrStage({ expectedRevision: (await extensions.state()).catalog.revision, source: { kind: 'local', display: 'Real parallel driver example', specifier: folder } });
  await extensions.reviewCapabilities({ extensionId: 'example.parallel-driver', expectedRevision: (await extensions.state()).catalog.revision,
    decisions: [{ realm: 'host', capability: VARIN_AGENT_DRIVER_CAPABILITY, granted: true }] });
  await extensions.setEnabled('example.parallel-driver', true, (await extensions.state()).catalog.revision);
  await extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision,
    rule: { serviceId: 'varin.agent.driver', version: 1, scope: { userId: 'default' }, providerKeys: ['example.parallel-driver:host:varin.agent.driver@1'], allowFallback: false } });
  return { root, kernel, runtime, adapter, documents, workspace, requests, launchErrors, owner, configuration, progress };
}

it('installed public driver overlaps real model requests with native file work and consumes steering before synthesis', async () => {
  const proposalEntered = deferred<void>(), challengeEntered = deferred<void>(), releaseChallenge = deferred<void>();
  let challengeFinished = false;
  const toolSettled = deferred<string>();
  void toolSettled.promise.catch(() => {});
  const f = await fixture(async (body, response) => {
    const instructions = JSON.stringify(body);
    if (instructions.includes('Independently propose')) {
      const declared = Array.isArray(body.tools) && body.tools.some(tool => (tool as { name?: string }).name === 'file_read');
      if (!declared) {
        const error = new Error('The actual driver model request did not declare native file_read');
        toolSettled.reject(error); releaseChallenge.resolve(); throw error;
      }
      proposalEntered.resolve(); await challengeEntered.promise;
      complete(response, [{ id: 'proposal-call-item', type: 'function_call', call_id: 'read-evidence', name: 'file_read', arguments: JSON.stringify({ path: 'fact.txt' }) }]);
    } else if (instructions.includes('Independently challenge')) {
      challengeEntered.resolve(); await proposalEntered.promise; await releaseChallenge.promise;
      challengeFinished = true;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'challenge-answer', delta: 'INDEPENDENT_CHALLENGE_EVIDENCE' })}\n\n`);
      complete(response, [message('challenge-answer', 'INDEPENDENT_CHALLENGE_EVIDENCE')]);
    } else {
      expect(instructions).toContain('Synthesize an answer');
      expect(JSON.stringify(body.input)).toContain('REAL_FILE_EVIDENCE');
      expect(JSON.stringify(body.input)).toContain('INDEPENDENT_CHALLENGE_EVIDENCE');
      expect(JSON.stringify(body.input)).toContain('NEW_USER_STEERING');
      complete(response, [message('synthesis-answer', 'PARALLEL_DRIVER_FINAL_ANSWER')]);
    }
  });
  // Always release provider barriers even if an assertion fails; teardown never fabricates a receipt.
  cleanups.push(async () => { releaseChallenge.resolve(); proposalEntered.resolve(); challengeEntered.resolve(); });
  await fs.writeFile(path.join(f.workspace, 'fact.txt'), 'REAL_FILE_EVIDENCE');
  const identity = await f.adapter.create('parallel-driver-native');
  const source = await f.adapter.prepareSource({ ...identity, key: 'source', resourceOwner: { kind: 'local' },
    workspaceId: (await f.documents.resolveWorkspace({ path: f.workspace })).workspaceId, content: { mode: 'saved-files' }, captureScopes: [], mode: 'fixed_branch' });
  const events: RuntimeEvent[] = [];
  let cursor = 0, reading = Promise.resolve();
  const driverTools = new Set<string>();
  const readEvents = async () => {
    const page = await f.runtime.events(cursor, 256);
    for (const event of page) {
      cursor = event.cursor; events.push(event);
      if (event.kind === 'driver.tool_selected') driverTools.add(event.subject);
      if (event.kind === 'operation.settled' && driverTools.has(event.subject)) toolSettled.resolve(event.subject);
    }
    if (f.launchErrors.length) throw new Error(f.launchErrors.map(String).join('; '));
  };
  const unsubscribe = f.runtime.onEvent(event => {
    if (event.stream === 'durable') reading = reading.then(readEvents).catch(toolSettled.reject);
  });
  const unsubscribeExit = f.runtime.onExit(toolSettled.reject);
  cleanups.push(async () => { unsubscribe(); unsubscribeExit(); await reading; });
  const submitted = await f.adapter.submit({ ...identity, key: 'request', expectedHead: null, text: 'Check fact.txt with independent reasoning', model, source: source.source });
  const operationId = await toolSettled.promise;
  const operation = await f.runtime.operation(operationId);
  expect(operation.run_id).toBe(submitted.run_id);
  expect(operation.outcome).toBe('succeeded');
  expect(JSON.stringify(operation.result)).toContain('REAL_FILE_EVIDENCE');
  expect(challengeFinished, 'a real file Operation settles before the other model finishes').toBe(false);
  const steering = await f.adapter.enqueue({ ...identity, key: 'steering', mode: 'boundary', text: 'NEW_USER_STEERING: include the disagreement explicitly' });
  expect(steering.run_id).toBe(submitted.run_id);
  releaseChallenge.resolve();
  await expect.poll(async () => { expect(f.launchErrors).toEqual([]); return (await f.runtime.run(submitted.run_id)).state; }).toBe('completed');
  expect(f.requests).toHaveLength(3);
  const history = JSON.stringify((await f.adapter.snapshot(identity)).history);
  expect(history).toContain('PARALLEL_DRIVER_FINAL_ANSWER');
  expect(history).not.toContain('INDEPENDENT_CHALLENGE_EVIDENCE');
  expect(f.progress.filter(event => event.stream === 'progress' && event.runId === submitted.run_id)).toEqual([]);
  expect((await f.runtime.launch(submitted.run_id))?.selection.driver).toMatchObject({ kind: 'extension', artifact: {
    extensionId: 'example.parallel-driver', recovery: 'none', serviceId: 'varin.agent.driver', serviceVersion: 1 } });
  const db = new DatabaseSync(path.join(f.root, 'agent-runtime', 'conversation.sqlite'), { readOnly: true });
  try {
    const steps = db.prepare('SELECT body FROM model_steps WHERE run_id=?').all(submitted.run_id).map(row => JSON.parse(String(row.body)));
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      const request = await readContent(f.root, step.request.content_object) as { view: { origin: { kind: string } } };
      expect(request.view.origin.kind).toBe('driver');
    }
    // Policy actions are original Operations, not a separate Catalog table. The only
    // Operation here is the actual file read; no default-loop action may be hidden behind it.
    expect(db.prepare('SELECT id FROM operations WHERE run_id=?').all(submitted.run_id)).toEqual([{ id: operationId }]);
  } finally { db.close(); }
  expect(events.some(event => event.kind === 'driver.tool_selected')).toBe(true);
});

it('caller abort after native start admission retains the original driver and credentials until its held ACK arrives', async () => {
  const probe = new TransportFixture(); let startId: string | undefined;
  const admitted = deferred<void>(), releaseModels = deferred<void>(), ackHeld = deferred<void>();
  probe.onSend = frame => { if (frame.kind === 'request' && frame.method === 'runtime.run.start') startId = String(frame.id); };
  probe.hold = frame => { if (startId && frame.id === startId) { ackHeld.resolve(); return true; } return false; };
  const f = await fixture(async (body, response) => {
    const instructions = JSON.stringify(body);
    if (instructions.includes('Synthesize an answer')) complete(response, [message('final', 'ACK_ABORT_DID_NOT_RETIRE_ACCEPTED_RUN')]);
    else { admitted.resolve(); await releaseModels.promise; complete(response, [message('branch', 'original branch evidence')]); }
  }, probe);
  cleanups.push(async () => { releaseModels.resolve(); probe.release(); });
  const identity = await f.adapter.create('start-ack-abort');
  const submitted = await f.runtime.submit({ key: 'request', threadId: identity.threadId, branchId: identity.branchId,
    expectedHead: null, input: { text: 'Continue the accepted parallel algorithm' }, configuration: f.configuration });
  await f.runtime.selectLaunch({ runId: submitted.run_id, source: null, enabledTools: [], credentialScope: await f.owner.scope() });
  const abort = new AbortController();
  const starting = f.runtime.startRunWithCredentialOwner(submitted.run_id, f.owner, abort.signal);
  // The actual default Host observation can be cancelled, but the native Run already owns work.
  const rejected = expect(starting).rejects.toThrow();
  await Promise.all([admitted.promise, ackHeld.promise]); abort.abort(); await rejected;
  expect(f.kernel.driverBinding(submitted.run_id)).toBeDefined();
  releaseModels.resolve();
  await expect.poll(async () => (await f.runtime.run(submitted.run_id)).state).toBe('completed');
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify((await f.adapter.snapshot(identity)).history)).toContain('ACK_ABORT_DID_NOT_RETIRE_ACCEPTED_RUN');
  probe.release(); await f.kernel.drainRunPreparations(submitted.run_id);
});

it('late synthesis input stays in the original callback and committed finish does not retire a held original ACK', async () => {
  const probe = new TransportFixture(), finishIds = new Set<string>();
  const synthesisEntered = deferred<void>(), releaseSynthesis = deferred<void>(), finishHeld = deferred<void>();
  probe.onSend = frame => { if (frame.kind === 'request' && frame.method === 'runtime.driver.finish') finishIds.add(String(frame.id)); };
  probe.hold = frame => {
    const result = frame.result as { kind?: string } | undefined;
    if (finishIds.has(String(frame.id)) && frame.ok === true && result?.kind === 'committed') { finishHeld.resolve(); return true; }
    return false;
  };
  let syntheses = 0;
  const f = await fixture(async (body, response) => {
    const request = JSON.stringify(body);
    if (!request.includes('Synthesize an answer')) { complete(response, [message('evidence', 'ORIGINAL_BRANCH_EVIDENCE')]); return; }
    syntheses++;
    if (syntheses === 1) {
      synthesisEntered.resolve(); await releaseSynthesis.promise;
      complete(response, [message('first', 'ANSWER_BEFORE_LATE_STEERING')]);
    } else {
      expect(request).toContain('LATE_STEERING_DURING_SYNTHESIS');
      complete(response, [message('revised', 'SAME_CALLBACK_REVISED_ANSWER')]);
    }
  }, probe);
  cleanups.push(async () => { releaseSynthesis.resolve(); probe.release(); });
  const identity = await f.adapter.create('late-driver-input');
  const submitted = await f.adapter.submit({ ...identity, key: 'initial', expectedHead: null, text: 'Discuss the evidence', model });
  await synthesisEntered.promise;
  const late = await f.adapter.enqueue({ ...identity, key: 'late', mode: 'boundary', text: 'LATE_STEERING_DURING_SYNTHESIS' });
  expect(late.run_id).toBe(submitted.run_id); releaseSynthesis.resolve();
  await finishHeld.promise;
  expect((await f.runtime.run(submitted.run_id)).state).toBe('completed');
  expect(f.kernel.isRunDriverInvoking(submitted.run_id)).toBe(true);
  expect(f.kernel.driverBinding(submitted.run_id)).toBeDefined();
  expect(f.requests).toHaveLength(4); expect(syntheses).toBe(2);
  const history = JSON.stringify((await f.adapter.snapshot(identity)).history);
  expect(history).toContain('LATE_STEERING_DURING_SYNTHESIS');
  expect(history).toContain('SAME_CALLBACK_REVISED_ANSWER');
  expect(f.launchErrors).toEqual([]);
  probe.release();
  await expect.poll(() => f.kernel.isRunDriverInvoking(submitted.run_id)).toBe(false);
  await expect.poll(() => f.kernel.driverBinding(submitted.run_id)).toBeUndefined();
});

it('installed driver waits on the original Inbox and finishes with a protocol-window of abandoned observers', async () => {
  const f = await fixture((_body, response) => { complete(response, [message('unexpected', 'unexpected')]); }, undefined, `
    import { defineHostExtension, provideAgentDriver } from '@varin/extension-sdk';
    export default defineHostExtension(host => provideAgentDriver(host, {
      identity: { name: 'event-driven-inbox', version: '1' }, configuration: null,
      modelRoles: [], recovery: 'none', checkpointSchema: null,
      async run(input, { driver }) {
        let observed = await driver.wait({ after: null, work: [] });
        await driver.deliver({ id: 'ready', text: 'DRIVER_IS_WAITING_FOR_ORIGINAL_INBOX' });
        while (!observed.inputPending) observed = await driver.wait({ after: observed.cursor, work: [] });
        const fresh = await driver.context();
        if (!JSON.stringify(fresh.history).includes('ORIGINAL_INBOX_INPUT')) throw new Error('Missing original input');
        await driver.deliver({ id: 'answer', text: 'ORIGINAL_INBOX_CONSUMED' });
        const baseline = await driver.wait({ after: null, work: [] });
        for (let i = 0; i < ${KERNEL_REQUEST_WINDOW}; i++) {
          void driver.wait({ after: baseline.cursor, work: [] }).catch(() => {});
        }
        await driver.receipt({ kind: 'delivery', id: 'answer' });
        const finished = await driver.finish({ outcome: { kind: 'complete' } });
        if (finished.kind !== 'committed') throw new Error('Original completion was not admitted');
        return { kind: 'complete' };
      }
    }));
  `);
  const identity = await f.adapter.create('driver-event-wait');
  const submitted = await f.adapter.submit({ ...identity, key: 'first', expectedHead: null, text: 'Wait for my next input', model });
  await expect.poll(async () => { expect(f.launchErrors).toEqual([]); return JSON.stringify((await f.adapter.snapshot(identity)).history); }).toContain('DRIVER_IS_WAITING_FOR_ORIGINAL_INBOX');
  expect((await f.runtime.run(submitted.run_id)).state).not.toBe('completed');
  const input = await f.adapter.enqueue({ ...identity, key: 'next', mode: 'boundary', text: 'ORIGINAL_INBOX_INPUT' });
  expect(input.run_id).toBe(submitted.run_id);
  await expect.poll(async () => (await f.runtime.run(submitted.run_id)).state).toBe('completed');
  expect(JSON.stringify((await f.adapter.snapshot(identity)).history)).toContain('ORIGINAL_INBOX_CONSUMED');
  expect(f.requests).toHaveLength(0);
});

async function readContent(root: string, reference: string): Promise<unknown> {
  const read = (hash: string) => {
    expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);
    const hex = hash.slice('sha256-'.length);
    return fs.readFile(path.join(root, 'agent-runtime', 'content', 'objects', hex.slice(0, 2), hex.slice(2)));
  };
  const manifest = JSON.parse((await read(reference)).toString()) as { chunks: string[]; bytes: number };
  const bytes = Buffer.concat(await Promise.all(manifest.chunks.map(read)));
  expect(bytes.length).toBe(manifest.bytes);
  return JSON.parse(bytes.toString());
}
