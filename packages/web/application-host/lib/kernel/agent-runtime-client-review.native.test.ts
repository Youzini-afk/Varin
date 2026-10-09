import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { TransportFixture } from './tests/transport-fixture.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { KERNEL_PROTOCOL_VERSION, KERNEL_REQUEST_WINDOW } from './protocol.generated.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
type Envelope = { kind: string; id: string; method?: string; epoch?: string; grantId?: string; ok?: boolean; error?: { code: string; message: string }; result?: unknown };

async function fixture() {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-client-review-'));
  const probe = new TransportFixture();
  const requests = probe.sent as Envelope[];
  const responses = new Map<string, Envelope>();
  const held = probe.held;
  let holdMethod: string | undefined;
  probe.onReceive = value => { if (typeof value.id === 'string') responses.set(value.id, value as Envelope); };
  probe.hold = value => !!holdMethod && requests.find(request => request.id === value.id)?.method === holdMethod;
  let child!: ChildProcessWithoutNullStreams;
  const options = { hostId: 'client-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false };
  const host = createKernelClient({ ...options, transportFactory: probe.create, spawnProcess: ((command, args, input) => {
    child = spawn(command, args ?? [], input ?? {}) as ChildProcessWithoutNullStreams;
    return child;
  }) as typeof spawn });
  const releaseHeld = () => { holdMethod = undefined; for (const value of held.splice(0)) (host as unknown as {consumeFrame(value: unknown): void}).consumeFrame(value); };
  cleanups.push(async () => { releaseHeld(); await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  await host.start();
  return { host, runtimeClient: new AgentRuntimeClient(host), root, options, requests, responses, held, hold(method: string) { holdMethod = method; }, release: () => releaseHeld(),
    async crash() { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; },
    async raw(value: Record<string, unknown>) { const id = `review-${requests.length}`; await probe.send({ v: KERNEL_PROTOCOL_VERSION, kind: 'request', id, epoch: host.kernelEpoch, ...value }); await expect.poll(() => responses.has(id)).toBe(true); return responses.get(id)!; },
  };
}

it('client submits, inspects, cancels, replays events and preserves receipt on reopen', async () => {
  const f = await fixture();
  const before = await f.runtimeClient.status();
  expect(Number.isInteger(before.epoch)).toBe(true);
  expect(await f.runtimeClient.createThread('thread', 'branch')).toEqual({ threadId: 'thread', branchId: 'branch' });
  const input = { key: 'request-key', threadId: 'thread', branchId: 'branch', expectedHead: null, input: { text: 'local IPC verification' }, configuration: {} };
  const receipt = await f.runtimeClient.submit(input);
  expect(await f.runtimeClient.submit(input)).toEqual(receipt);
  await expect(f.runtimeClient.submit({ ...input, input: { text: 'changed retry' } })).rejects.toThrow(/conflict/i);
  await expect(f.runtimeClient.submit({ ...input, key: 'second-input' })).rejects.toThrow(/conflict/i);
  expect((await f.runtimeClient.run(receipt.run_id)).thread_id).toBe('thread');
  expect((await f.runtimeClient.history('branch')).map(item => item.content)).toEqual([input.input]);
  expect((await f.runtimeClient.cancelRun(receipt.run_id)).cancel_requested).toBe(true);
  const events = await f.runtimeClient.events(0, 100);
  expect(events.some(event => event.kind === 'run.accepted' && event.subject === receipt.run_id)).toBe(true);
  expect(events.every((event, index) => index === 0 || event.cursor > events[index - 1]!.cursor)).toBe(true);
  expect(await f.runtimeClient.events(events.at(-1)!.cursor, 100)).toEqual([]);
  await f.host.close();
  const reopened = createKernelClient(f.options);
  try {
    const runtimeClient = new AgentRuntimeClient(reopened);
    expect((await runtimeClient.status()).epoch).toBeGreaterThan(before.epoch);
    expect(await runtimeClient.submit(input)).toEqual(receipt);
    expect((await runtimeClient.history('branch')).map(item => item.id)).toEqual([receipt.input_id]);
  } finally { await reopened.close(); }
}, 30_000);

it('framed IPC rejects malformed parameters and stale or grant-scoped authority', async () => {
  const f = await fixture();
  for (const request of [
    { method: 'runtime.status', epoch: 'stale', params: {} },
    { method: 'runtime.status', grantId: 'tool-grant', params: {} },
    { method: 'runtime.status', params: { unexpected: true } },
    { method: 'runtime.thread.create', params: { threadId: '', branchId: 'branch' } },
    { method: 'runtime.events.read', params: { cursor: -1, limit: 1 } },
    { method: 'runtime.events.read', params: { cursor: 0, limit: 1.5 } },
    { method: 'runtime.input.submit', params: { key: 'key', threadId: 't', branchId: 'b', input: {}, configuration: {} } },
  ]) expect((await f.raw(request)).ok).toBe(false);
  expect((await f.runtimeClient.status()).epoch).toBeGreaterThan(0);
  await expect(f.runtimeClient.run('missing')).rejects.toThrow();
  await expect(f.runtimeClient.operation('missing')).rejects.toThrow();
}, 30_000);

it('client uses unique IDs and independent credits while ordinary responses are delayed', async () => {
  const f = await fixture();
  f.hold('storage.health');
  const ordinary = Array.from({ length: KERNEL_REQUEST_WINDOW }, () => f.host.health());
  await expect.poll(() => f.held.length).toBe(KERNEL_REQUEST_WINDOW);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.runtimeClient.status()));
  expect(results.every(value => value.epoch === results[0]!.epoch)).toBe(true);
  const runtimeRequests = f.requests.filter(value => value.method?.startsWith('runtime.'));
  expect(new Set(runtimeRequests.map(value => value.id)).size).toBe(runtimeRequests.length);
  expect(runtimeRequests.every(value => value.epoch === f.host.kernelEpoch && value.grantId === undefined)).toBe(true);
  f.release();
  expect((await Promise.all(ordinary)).every(value => value.integrity === 'ok')).toBe(true);
}, 30_000);

it('abort retains wire credit until receipt and cancels queued admission without dispatch', async () => {
  const f = await fixture();
  f.hold('runtime.status');
  const controller = new AbortController();
  const first = f.runtimeClient.status(controller.signal);
  const rejected = expect(first).rejects.toThrow(/cancelled/i);
  const second = f.runtimeClient.status();
  await expect.poll(() => f.held.length).toBe(KERNEL_REQUEST_WINDOW);
  controller.abort();
  await rejected;
  expect(f.requests.some(value => value.kind === 'cancel')).toBe(true);
  const queued = new AbortController();
  const third = f.runtimeClient.status(queued.signal);
  const queuedRejected = expect(third).rejects.toThrow(/cancelled/i);
  queued.abort();
  await queuedRejected;
  expect(f.requests.filter(value => value.method === 'runtime.status')).toHaveLength(KERNEL_REQUEST_WINDOW);
  f.release();
  await second;
  expect((await f.runtimeClient.status()).epoch).toBeGreaterThan(0);
}, 30_000);


async function localProvider(reply: (body: Record<string, unknown>, response: ServerResponse, request: IncomingMessage) => void) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      reply(body, response, request);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback server has no TCP address');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { requests, configuration: { providerFamily: 'openai-responses', model: 'local-test-model', endpoint: `http://127.0.0.1:${address.port}/responses`, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 } };
}

it('run.start reaches a local HTTP provider and continues durable assistant history', async () => {
  const f = await fixture();
  let outputNumber = 0;
  const provider = await localProvider((_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `local-message-${++outputNumber}`, type: 'message', content: [{ type: 'output_text', text: 'HTTP result' }] }], usage: { input_tokens: 4, output_tokens: 3 } } })}\n\n`);
  });
  await f.runtimeClient.createThread('model-thread', 'model-branch');
  const receipt = await f.runtimeClient.submit({ key: 'model-input', threadId: 'model-thread', branchId: 'model-branch', expectedHead: null, input: { text: 'local user input' }, configuration: provider.configuration });
  expect((await f.runtimeClient.startRun(receipt.run_id)).runId).toBe(receipt.run_id);
  await expect.poll(async () => (await f.runtimeClient.run(receipt.run_id)).state, { timeout: 8_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]).toMatchObject({ model: 'local-test-model', stream: true, input: [{ role: 'user', content: 'local user input' }] });
  const history = await f.runtimeClient.history('model-branch');
  expect(history.some(item => item.source === 'assistant' && JSON.stringify(item.content).includes('HTTP result'))).toBe(true);
  await expect(f.runtimeClient.startRun(receipt.run_id)).rejects.toThrow();
  expect(provider.requests).toHaveLength(1);
  const next = await f.runtimeClient.submit({ key: 'model-followup', threadId: 'model-thread', branchId: 'model-branch', expectedHead: history.at(-1)!.id, input: { text: 'follow up' }, configuration: provider.configuration });
  await f.runtimeClient.startRun(next.run_id);
  await expect.poll(async () => { const run = await f.runtimeClient.run(next.run_id); if (run.state === 'failed') throw new Error(JSON.stringify(await f.runtimeClient.events(0, 100))); return run.state; }, { timeout: 8_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests[1]!.input)).toContain('HTTP result');
  expect(JSON.stringify(provider.requests[1]!.input)).toContain('follow up');
}, 30_000);

it('run.cancel interrupts an active local HTTP stream and leaves control usable', async () => {
  const f = await fixture();
  const provider = await localProvider((_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    response.write(': waiting for cancellation\n\n');
  });
  await f.runtimeClient.createThread('cancel-thread', 'cancel-branch');
  const receipt = await f.runtimeClient.submit({ key: 'cancel-input', threadId: 'cancel-thread', branchId: 'cancel-branch', expectedHead: null, input: { text: 'cancel local stream' }, configuration: provider.configuration });
  await f.runtimeClient.startRun(receipt.run_id);
  await expect.poll(() => provider.requests.length, { timeout: 8_000 }).toBe(1);
  await expect(f.runtimeClient.startRun(receipt.run_id)).rejects.toThrow();
  await f.runtimeClient.cancelRun(receipt.run_id);
  await expect.poll(async () => (await f.runtimeClient.run(receipt.run_id)).state, { timeout: 8_000 }).toBe('cancelled');
  expect(provider.requests).toHaveLength(1);
  expect((await f.runtimeClient.status()).epoch).toBeGreaterThan(0);
}, 30_000);

it('tool loop reads a grant-scoped fixed file revision and returns its receipt to the provider', async () => {
  const f = await fixture();
  let turn = 0;
  const provider = await localProvider((_body, response) => {
    const output = ++turn === 1
      ? [{ id: 'file-call', type: 'function_call', call_id: 'file-read-1', name: 'file_read', arguments: JSON.stringify({ path: 'allowed.txt' }) }]
      : [{ id: 'file-answer', type: 'message', content: [{ type: 'output_text', text: 'read finished' }] }];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
  });
  await f.runtimeClient.createThread('tool-thread', 'tool-branch');
  const receipt = await f.runtimeClient.submit({ key: 'tool-input', threadId: 'tool-thread', branchId: 'tool-branch', expectedHead: null, input: { text: 'read local file' }, configuration: provider.configuration });
  const grant = await f.host.issueGrant({ grantId: 'file-owner', threadId: 'tool-thread', runId: receipt.run_id, owningWorkspace: 'workspace', executionWorkspace: 'workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
  const actor = f.host.scoped(grant);
  const bytes = Buffer.from('fixed file content');
  const blob = await actor.putBlob(bytes, 'test-file');
  await actor.createBranch({ operationId: 'source-create', branchId: 'file-source', workspaceId: 'workspace', draftBasePaths: [], captureScopes: [], entries: [{ path: 'allowed.txt', state: { kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId }] });
  const source = await actor.readBranch({ branchId: 'file-source' });
  const published = await actor.publishBranch({ operationId: 'source-publish', branchId: 'file-source', expectedRoot: source.root, expectedWriteRevision: source.writeRevision });
  const binding = { grantId: grant.grantId, runId: receipt.run_id, threadId: 'tool-thread', workspaceId: 'workspace', executionWorkspaceId: 'workspace', fileSource: { branchId: 'file-source', revision: Number(published.revision) }, enabledTools: ['file_read'] };
  await expect(f.runtimeClient.startRun(receipt.run_id, undefined, { ...binding, runId: 'wrong-run' })).rejects.toThrow();
  expect(provider.requests).toHaveLength(0);
  await f.runtimeClient.startRun(receipt.run_id, undefined, binding);
  await expect.poll(async () => (await f.runtimeClient.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests[0]!.tools)).toContain('file_read');
  const continuation = provider.requests[1]!.input as Array<Record<string, unknown>>;
  const result = continuation.find(item => item.type === 'function_call_output');
  expect(result?.call_id).toBe('file-read-1');
  expect(String(result?.output)).toContain('fixed file content');
  expect((await f.runtimeClient.history('tool-branch')).some(item => item.source === 'tool')).toBe(true);
}, 30_000);

it.each([false, true])('tool process settles OS and durable operation evidence (cancel=%s)', async (cancelProcess) => {
  const f = await fixture();
  const workspace = path.join(f.root, 'process-workspace');
  await fs.mkdir(workspace);
  let turn = 0;
  const provider = await localProvider((_body, response) => {
    const output = ++turn === 1
      ? [{ id: 'process-call', type: 'function_call', call_id: 'spawn-1', name: 'process_spawn', arguments: JSON.stringify({ cwd: '', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("test-marker.txt", "real process");' + (cancelProcess ? 'setInterval(() => {}, 1000)' : '')], mode: 'pipe' }) }]
      : [{ id: 'process-answer', type: 'message', content: [{ type: 'output_text', text: 'spawn accepted' }] }];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
  });
  await f.runtimeClient.createThread('process-thread', 'process-branch');
  const receipt = await f.runtimeClient.submit({ key: 'process-input', threadId: 'process-thread', branchId: 'process-branch', expectedHead: null, input: { text: 'spawn local fixture process' }, configuration: provider.configuration });
  const grant = await f.host.issueGrant({ grantId: 'process-owner', threadId: 'process-thread', runId: receipt.run_id, owningWorkspace: 'process-workspace', executionWorkspace: 'process-workspace', capabilities: ['storage.read', 'storage.write', 'process'], pathScopes: [''] });
  const actor = f.host.scoped(grant);
  const registered = await actor.fileRootRegister({ workspaceId: 'process-workspace', executionWorkspaceId: 'process-workspace', canonicalRoot: workspace });
  await f.runtimeClient.startRun(receipt.run_id, undefined, { grantId: grant.grantId, runId: receipt.run_id, threadId: 'process-thread', workspaceId: 'process-workspace', executionWorkspaceId: 'process-workspace', rootId: registered.rootId, sourceMode: 'live_root', liveRoot: { hostId: 'client-review', canonicalRoot: registered.canonicalRoot, rootId: registered.rootId }, enabledTools: ['process_spawn'] });
  await expect.poll(async () => (await f.runtimeClient.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(2);
  const continuation = provider.requests[1]!.input as Array<Record<string, unknown>>;
  const result = continuation.find(item => item.type === 'function_call_output');
  const accepted = JSON.parse(String(result?.output)) as { operation_id: string };
  expect(typeof accepted.operation_id).toBe('string');
  const processIdentity = { workspaceId: 'process-workspace', processId: accepted.operation_id };
  try {
    await expect.poll(async () => fs.readFile(path.join(workspace, 'test-marker.txt'), 'utf8').catch(() => ''), { timeout: 8_000 }).toBe('real process');
    await expect(actor.processList({ workspaceId: 'process-workspace', rootId: String(registered.rootId) })).rejects.toThrow(/process maintenance/i);
    if (cancelProcess) {
      expect((await actor.processInspect(processIdentity)).writerActive).toBe(true);
      await f.runtimeClient.cancelOperation(accepted.operation_id);
    }
    await expect.poll(async () => (await actor.processInspect(processIdentity)).writerActive, { timeout: 8_000 }).toBe(false);
    await expect.poll(async () => (await f.runtimeClient.operation(accepted.operation_id)).phase, { timeout: 8_000 }).toBe('terminal');
    expect((await f.runtimeClient.operation(accepted.operation_id)).outcome).toBe(cancelProcess ? 'cancelled' : 'succeeded');
  } finally {
    if ((await actor.processInspect(processIdentity)).writerActive) {
      await actor.processKill({ ...processIdentity, force: true });
      await expect.poll(async () => (await actor.processInspect(processIdentity)).writerActive, { timeout: 8_000 }).toBe(false);
    }
  }
}, 30_000);

it('and Storage negotiated windows remain independent during real concurrent uploads', async () => {
  const f = await fixture();
  const actor = f.host.scoped(await f.host.issueGrant({ grantId: 'concurrent-owner', owningWorkspace: 'concurrent-workspace', executionWorkspace: 'concurrent-workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }));
  const body = Buffer.alloc(2 * 1024 * 1024, 37);
  const uploads = [actor.putBlob(body, 'concurrent-blob-a'), actor.putBlob(Buffer.from(body).fill(38), 'concurrent-blob-b')] as const;
  const controls = Promise.all(Array.from({ length: 100 }, () => f.runtimeClient.status()));
  const [first, second, statuses] = await Promise.all([...uploads, controls] as const);
  expect(first?.byteLength).toBe(body.length);
  expect(second?.byteLength).toBe(body.length);
  expect(statuses).toHaveLength(100);
  expect((await f.host.health()).integrity).toBe('ok');
}, 30_000);

function completeLocalResponse(response: ServerResponse, id: string, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id, type: 'message', content: [{ type: 'output_text', text }] }] } })}\n\n`);
}

it('boundary input edits and cancellation remain outside history until a legal model boundary', async () => {
  const f = await fixture();
  let firstResponse: ServerResponse | undefined;
  let turn = 0;
  const provider = await localProvider((_body, response) => {
    if (++turn === 1) firstResponse = response;
    else completeLocalResponse(response, `boundary-output-${turn}`, 'updated answer');
  });
  await f.runtimeClient.createThread('boundary-thread', 'boundary-branch');
  const run = await f.runtimeClient.submit({ key: 'boundary-initial', threadId: 'boundary-thread', branchId: 'boundary-branch', expectedHead: null, input: { text: 'first question' }, configuration: provider.configuration });
  await f.runtimeClient.startRun(run.run_id);
  await expect.poll(() => provider.requests.length).toBe(1);
  const command = { key: 'boundary-queued', threadId: 'boundary-thread', branchId: 'boundary-branch', mode: 'boundary' as const, input: { text: 'unrevised queued content' } };
  const queued = await f.runtimeClient.enqueue(command);
  expect(queued.run_id).toBe(run.run_id);
  const edited = await f.runtimeClient.editInput(queued.input_id, 1, { text: 'revised boundary content' });
  expect(edited.revision).toBe(2);
  await expect(f.runtimeClient.editInput(queued.input_id, 1, { text: 'stale write' })).rejects.toThrow(/conflict/i);
  expect(await f.runtimeClient.enqueue(command)).toEqual(queued);
  const cancelled = await f.runtimeClient.enqueue({ ...command, key: 'boundary-cancelled', input: { text: 'cancelled content' } });
  expect((await f.runtimeClient.cancelInput(cancelled.input_id, 1)).state).toBe('cancelled');
  expect(await f.runtimeClient.history('boundary-branch')).toHaveLength(1);
  expect((await f.runtimeClient.input(queued.input_id)).state).toBe('queued');
  completeLocalResponse(firstResponse!, 'boundary-output-1', 'original answer');
  await expect.poll(async () => (await f.runtimeClient.run(run.run_id)).state, { timeout: 8_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(2);
  const secondInput = JSON.stringify(provider.requests[1]!.input);
  expect(secondInput).toContain('revised boundary content');
  expect(secondInput).not.toContain('unrevised queued content');
  expect(secondInput).not.toContain('cancelled content');
  expect((await f.runtimeClient.input(queued.input_id)).state).toBe('delivered');
  expect((await f.runtimeClient.inputs('boundary-branch')).map(input => input.state)).toEqual(['delivered', 'cancelled']);
}, 30_000);

it('interrupt replaces only the active model step and continues the same Run', async () => {
  const f = await fixture();
  let turn = 0;
  const provider = await localProvider((_body, response) => {
    if (++turn === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'interrupted-message', delta: 'unfinished first answer' })}\n\n`);
    } else completeLocalResponse(response, `interrupt-output-${turn}`, 'answer after interrupt');
  });
  await f.runtimeClient.createThread('interrupt-thread', 'interrupt-branch');
  const run = await f.runtimeClient.submit({ key: 'interrupt-initial', threadId: 'interrupt-thread', branchId: 'interrupt-branch', expectedHead: null, input: { text: 'initial prompt' }, configuration: provider.configuration });
  await f.runtimeClient.startRun(run.run_id);
  await expect.poll(() => provider.requests.length).toBe(1);
  const queued = await f.runtimeClient.enqueue({ key: 'interrupt-queued', threadId: 'interrupt-thread', branchId: 'interrupt-branch', mode: 'interrupt', input: { text: 'correct the current task' } });
  expect(queued.run_id).toBe(run.run_id);
  await expect.poll(async () => (await f.runtimeClient.run(run.run_id)).state, { timeout: 8_000 }).toBe('completed');
  expect((await f.runtimeClient.run(run.run_id)).cancel_requested).toBe(false);
  expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests[1]!.input)).toContain('correct the current task');
  const history = JSON.stringify(await f.runtimeClient.history('interrupt-branch'));
  expect(history).toContain('answer after interrupt');
  expect(history).not.toContain('unfinished first answer');
  expect((await f.runtimeClient.input(queued.input_id)).state).toBe('delivered');
}, 30_000);

it('next-run inputs promote in FIFO order, skipping a cancelled queued Run', async () => {
  const f = await fixture();
  let firstResponse: ServerResponse | undefined;
  let turn = 0;
  const provider = await localProvider((_body, response) => {
    if (++turn === 1) firstResponse = response;
    else completeLocalResponse(response, `next-output-${turn}`, `answer for queued Run ${turn}`);
  });
  await f.runtimeClient.createThread('next-thread', 'next-branch');
  const run = await f.runtimeClient.submit({ key: 'next-initial', threadId: 'next-thread', branchId: 'next-branch', expectedHead: null, input: { text: 'initial turn' }, configuration: provider.configuration });
  await f.runtimeClient.startRun(run.run_id);
  await expect.poll(() => provider.requests.length).toBe(1);
  const enqueue = (key: string) => f.runtimeClient.enqueue({ key, threadId: 'next-thread', branchId: 'next-branch', mode: 'next_run', input: { text: key } });
  const cancelled = await enqueue('skip queued turn');
  const first = await enqueue('first queued turn');
  const second = await enqueue('second queued turn');
  await f.runtimeClient.cancelInput(cancelled.input_id, 1);
  expect((await f.runtimeClient.startRun(first.run_id)).runId).toBe(first.run_id);
  expect((await f.runtimeClient.startRun(second.run_id)).runId).toBe(second.run_id);
  expect(provider.requests).toHaveLength(1);
  expect(await f.runtimeClient.history('next-branch')).toHaveLength(1);
  completeLocalResponse(firstResponse!, 'next-output-1', 'initial answer');
  await expect.poll(async () => (await f.runtimeClient.run(second.run_id)).state, { timeout: 8_000 }).toBe('completed');
  expect((await f.runtimeClient.run(first.run_id)).state).toBe('completed');
  expect((await f.runtimeClient.run(cancelled.run_id)).state).toBe('cancelled');
  expect(provider.requests).toHaveLength(3);
  expect(JSON.stringify(provider.requests[1]!.input)).toContain('first queued turn');
  expect(JSON.stringify(provider.requests[1]!.input)).not.toContain('second queued turn');
  expect(JSON.stringify(provider.requests[2]!.input)).toContain('second queued turn');
  expect(JSON.stringify(await f.runtimeClient.history('next-branch'))).not.toContain('skip queued turn');
}, 30_000);

it('process push subscription rejects another actor ack and supports explicit unsubscribe', async () => {
  const f = await fixture();
  const workspace = path.join(f.root, 'subscription-workspace');
  await fs.mkdir(workspace);
  const grant = await f.host.issueGrant({ grantId: 'subscription-owner', owningWorkspace: 'subscription-workspace', executionWorkspace: 'subscription-workspace', capabilities: ['storage.read', 'storage.write', 'process'], pathScopes: [''] });
  const other = await f.host.issueGrant({ grantId: 'subscription-other', owningWorkspace: 'subscription-workspace', executionWorkspace: 'subscription-workspace', capabilities: ['storage.read', 'storage.write', 'process'], pathScopes: [''] });
  const actor = f.host.scoped(grant);
  const root = await actor.fileRootRegister({ workspaceId: 'subscription-workspace', executionWorkspaceId: 'subscription-workspace', canonicalRoot: workspace });
  const identity = { workspaceId: 'subscription-workspace', processId: 'subscription-process' };
  await actor.processSpawn({ ...identity, rootId: String(root.rootId), cwd: '', command: process.execPath, args: ['-e', 'process.stdout.write("pushed fixture output")'], env: Object.entries(process.env).flatMap(([name, value]) => value === undefined ? [] : [{name, value}]), mode: 'pipe' });
  const events: Array<{ stream: string; sequence: number; subscriptionId: string }> = [];
  const chunks: Buffer[] = [];
  const subscription = await actor.processSubscribe({ ...identity, cursor: 0 }, event => {
    events.push(event);
    if (event.stream === 'data') for (const chunk of event.result?.chunks ?? []) chunks.push(Buffer.from(chunk.bytesBase64, 'base64'));
  });
  try {
    await expect.poll(() => Buffer.concat(chunks).toString()).toBe('pushed fixture output');
    const data = events.find(event => event.stream === 'data')!;
    expect(data.sequence).toBe(1);
    const wrongActor = await f.raw({ method: 'process.subscription.ack', grantId: other.grantId, params: { subscriptionId: data.subscriptionId, stream: 'data', sequence: data.sequence } });
    expect(wrongActor.ok).toBe(false);
    await subscription.acknowledge('data', data.sequence);
    const control = events.find(event => event.stream === 'control');
    if (control) await subscription.acknowledge('control', control.sequence);
    await subscription.close();
    await expect(subscription.closed).resolves.toBeUndefined();
    const afterClose = events.length;
    const closedAck = await f.raw({ method: 'process.subscription.ack', grantId: grant.grantId, params: { subscriptionId: data.subscriptionId, stream: 'data', sequence: data.sequence } });
    expect(closedAck.ok).toBe(false);
    expect(events).toHaveLength(afterClose);
    const revoked = await actor.processSubscribe({ ...identity, cursor: 0 }, () => undefined);
    await f.host.revokeGrant(grant.grantId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settlement = await Promise.race([
        revoked.closed.then(() => 'resolved', () => 'rejected'),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('still pending'), 2_000); }),
      ]);
      expect(settlement).toBe('rejected');
    } finally { if (timer) clearTimeout(timer); }
    expect((await f.runtimeClient.status()).epoch).toBeGreaterThan(0);
  } finally { await subscription.close(); }
}, 30_000);

it('model interrupt preserves an accepted background process job until explicit operation cancellation', async () => {
  const f = await fixture();
  const workspace = path.join(f.root, 'interrupt-job-workspace');
  await fs.mkdir(workspace);
  let turn = 0;
  const provider = await localProvider((_body, response) => {
    turn++;
    if (turn === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'interrupt-job-call', type: 'function_call', call_id: 'interrupt-job-spawn', name: 'process_spawn', arguments: JSON.stringify({ cwd: '', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], mode: 'pipe' }) }] } })}\n\n`);
    } else if (turn === 2) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': awaiting model interrupt\n\n');
    } else completeLocalResponse(response, `interrupt-job-answer-${turn}`, 'foreground changed; background retained');
  });
  await f.runtimeClient.createThread('interrupt-job-thread', 'interrupt-job-branch');
  const run = await f.runtimeClient.submit({ key: 'interrupt-job-initial', threadId: 'interrupt-job-thread', branchId: 'interrupt-job-branch', expectedHead: null, input: { text: 'start background fixture' }, configuration: provider.configuration });
  const grant = await f.host.issueGrant({ grantId: 'interrupt-job-owner', threadId: 'interrupt-job-thread', runId: run.run_id, owningWorkspace: 'interrupt-job-workspace', executionWorkspace: 'interrupt-job-workspace', capabilities: ['storage.read', 'storage.write', 'process'], pathScopes: [''] });
  const actor = f.host.scoped(grant);
  const root = await actor.fileRootRegister({ workspaceId: 'interrupt-job-workspace', executionWorkspaceId: 'interrupt-job-workspace', canonicalRoot: workspace });
  await f.runtimeClient.startRun(run.run_id, undefined, { grantId: grant.grantId, runId: run.run_id, threadId: 'interrupt-job-thread', workspaceId: 'interrupt-job-workspace', executionWorkspaceId: 'interrupt-job-workspace', rootId: root.rootId, sourceMode: 'live_root', liveRoot: { hostId: 'client-review', canonicalRoot: root.canonicalRoot, rootId: root.rootId }, enabledTools: ['process_spawn'] });
  await expect.poll(() => provider.requests.length).toBe(2);
  const secondInput = provider.requests[1]!.input as Array<Record<string, unknown>>;
  const receipt = JSON.parse(String(secondInput.find(item => item.type === 'function_call_output')?.output)) as { operation_id: string };
  const identity = { workspaceId: 'interrupt-job-workspace', processId: receipt.operation_id };
  try {
    expect((await actor.processInspect(identity)).writerActive).toBe(true);
    await f.runtimeClient.enqueue({ key: 'interrupt-job-new-input', threadId: 'interrupt-job-thread', branchId: 'interrupt-job-branch', mode: 'interrupt', input: { text: 'change foreground response' } });
    await expect.poll(async () => (await f.runtimeClient.run(run.run_id)).state, { timeout: 8_000 }).toBe('completed');
    expect(provider.requests).toHaveLength(3);
    expect((await actor.processInspect(identity)).writerActive).toBe(true);
    expect((await f.runtimeClient.operation(receipt.operation_id)).cancel_requested).toBe(false);
    await f.runtimeClient.cancelOperation(receipt.operation_id);
    await expect.poll(async () => (await f.runtimeClient.operation(receipt.operation_id)).phase, { timeout: 8_000 }).toBe('terminal');
    expect((await actor.processInspect(identity)).writerActive).toBe(false);
  } finally {
    if ((await actor.processInspect(identity)).writerActive) {
      await actor.processKill({ ...identity, force: true });
      await expect.poll(async () => (await actor.processInspect(identity)).writerActive, { timeout: 8_000 }).toBe(false);
    }
  }
}, 30_000);


it('private credential rendezvous uses a fake existing owner without persisting its secret headers', async () => {
  const f = await fixture();
  const fakeKey = 'fake-private-ipc-credential-do-not-persist';
  let authorization: string | undefined;
  const provider = await localProvider((_body, response, request) => {
    authorization = request.headers.authorization;
    completeLocalResponse(response, 'credential-answer', 'authenticated local fixture');
  });
  let lookups = 0;
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint: provider.configuration.endpoint,
    currentScope: async () => ({ reference: 'fake-reference', authority: 'fake-host-owner', account: 'fake-account', generation: 1 }),
    runtime: { getAuth: async () => { lookups++; return { auth: { apiKey: fakeKey } }; } },
  });
  await f.runtimeClient.createThread('credential-thread', 'credential-branch');
  const run = await f.runtimeClient.submit({ key: 'credential-input', threadId: 'credential-thread', branchId: 'credential-branch', expectedHead: null, input: { text: 'credential fixture prompt' }, configuration: { ...provider.configuration, allowAnonymous: false } });
  await f.runtimeClient.startRunWithCredentialOwner(run.run_id, owner);
  await expect.poll(async () => (await f.runtimeClient.run(run.run_id)).state, { timeout: 8_000 }).toBe('completed');
  expect(lookups).toBe(1);
  expect(authorization).toBe(`Bearer ${fakeKey}`);
  expect(f.requests.some(request => request.kind === 'credential-response')).toBe(true);
  expect(JSON.stringify(f.requests.filter(request => request.kind === 'request'))).not.toContain(fakeKey);
  expect(JSON.stringify(await f.runtimeClient.history('credential-branch'))).not.toContain(fakeKey);
  expect(JSON.stringify(await f.runtimeClient.events(0, 100))).not.toContain(fakeKey);
  await f.host.close();
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(filename);
      else if (entry.isFile()) expect((await fs.readFile(filename)).includes(Buffer.from(fakeKey))).toBe(false);
    }
  };
  await scan(f.root);
}, 30_000);

it('cancelling a model awaiting fake credentials preserves owner refresh and ignores its late answer', async () => {
  const f = await fixture();
  const provider = await localProvider((_body, response) => completeLocalResponse(response, 'late-credential-output', 'unexpected late dispatch'));
  let resolveRefresh!: (value: { auth: { apiKey: string } }) => void;
  const refresh = new Promise<{ auth: { apiKey: string } }>(resolve => { resolveRefresh = resolve; });
  let entered = false;
  let persisted = false;
  const owner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint: provider.configuration.endpoint,
    currentScope: async () => ({ reference: 'cancel-fake-ref', authority: 'fake-host-owner', account: 'fake-account', generation: 1 }),
    runtime: { getAuth: async () => { entered = true; const result = await refresh; persisted = true; return result; } },
  });
  await f.runtimeClient.createThread('credential-cancel-thread', 'credential-cancel-branch');
  const run = await f.runtimeClient.submit({ key: 'credential-cancel-input', threadId: 'credential-cancel-thread', branchId: 'credential-cancel-branch', expectedHead: null, input: { text: 'cancel credential wait' }, configuration: { ...provider.configuration, allowAnonymous: false } });
  await f.runtimeClient.startRunWithCredentialOwner(run.run_id, owner);
  await expect.poll(() => entered).toBe(true);
  await f.runtimeClient.cancelRun(run.run_id);
  await expect.poll(async () => (await f.runtimeClient.run(run.run_id)).state, { timeout: 8_000 }).toBe('cancelled');
  resolveRefresh({ auth: { apiKey: 'fake-late-key-must-not-dispatch' } });
  await expect.poll(() => persisted).toBe(true);
  expect(provider.requests).toHaveLength(0);
  expect(JSON.stringify(f.requests)).not.toContain('fake-late-key-must-not-dispatch');
  expect((await f.runtimeClient.status()).epoch).toBeGreaterThan(0);
}, 30_000);

async function publishSource(host: ReturnType<typeof createKernelClient>, branchId: string, text: string) {
  const actor = host.scoped(await host.issueGrant({ grantId: `source-owner-${branchId}`, owningWorkspace: 'source-workspace', executionWorkspace: 'source-workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }));
  const bytes = Buffer.from(text);
  const blob = await actor.putBlob(bytes, `blob-${branchId}`);
  await actor.createBranch({ operationId: `create-${branchId}`, branchId, workspaceId: 'source-workspace', draftBasePaths: [], captureScopes: [], entries: [{ path: 'source.txt', state: { kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId }] });
  const branch = await actor.readBranch({ branchId });
  const published = await actor.publishBranch({ operationId: `publish-${branchId}`, branchId, expectedRoot: branch.root, expectedWriteRevision: branch.writeRevision });
  return Number(published.revision);
}
function toolResponse(response: ServerResponse, name: string, args: Record<string, unknown>, serial: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `item-${serial}`, type: 'function_call', call_id: `${name}-${serial}`, name, arguments: JSON.stringify(args) }] } })}\n\n`);
}

it('source launch reads shell changes from materialized disk while fixed-branch reads retain the selected revision', async () => {
  const f = await fixture();
  const revision = await publishSource(f.host, 'selected-source', 'immutable original source');
  let serial = 0;
  let processId = '';
  let materializedRead = '';
  let fixedRead = '';
  const provider = await localProvider((body, response) => {
    const fixed = body.model === 'fixed-source-model';
    const output = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
    const result = output ? JSON.parse(String(output.output)) as { operation_id?: string; content?: { writerActive?: boolean } } : undefined;
    if (!output) {
      if (fixed) toolResponse(response, 'file_read', { path: 'source.txt' }, ++serial);
      else toolResponse(response, 'process_spawn', { cwd: '', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("source.txt", "changed by actual shell")'], mode: 'pipe' }, ++serial);
    } else if (String(output.call_id).startsWith('process_spawn-')) {
      processId = result!.operation_id!;
      toolResponse(response, 'process_inspect', { processId }, ++serial);
    } else if (String(output.call_id).startsWith('process_inspect-')) {
      if (result!.content!.writerActive) toolResponse(response, 'process_inspect', { processId }, ++serial);
      else toolResponse(response, 'file_read', { path: 'source.txt' }, ++serial);
    } else {
      if (fixed) fixedRead = String(output.output); else materializedRead = String(output.output);
      completeLocalResponse(response, `source-answer-${++serial}`, 'source read finished');
    }
  });
  for (const mode of ['materialized', 'fixed_branch'] as const) {
    const threadId = `source-${mode}-thread`;
    const branchId = `source-${mode}-conversation`;
    await f.runtimeClient.createThread(threadId, branchId);
    const run = await f.runtimeClient.submit({ key: `source-${mode}-input`, threadId, branchId, expectedHead: null, input: { text: 'read selected source' }, configuration: { ...provider.configuration, model: mode === 'fixed_branch' ? 'fixed-source-model' : 'materialized-source-model' } });
    await f.runtimeClient.startFromSource({ runId: run.run_id, workspaceId: 'source-workspace', executionWorkspaceId: 'source-workspace', branchId: 'selected-source', revision, mode, tools: mode === 'materialized' ? ['file_read', 'process_spawn', 'process_inspect'] : ['file_read'] });
    await expect.poll(async () => (await f.runtimeClient.run(run.run_id)).state, { timeout: 10_000 }).toBe('completed');
    expect((await f.runtimeClient.launch(run.run_id))?.selection.source).toMatchObject({ branch_id: 'selected-source', revision, mode, live_root: null });
  }
  expect(materializedRead).toContain('changed by actual shell');
  expect(fixedRead).toContain('immutable original source');
  expect(fixedRead).not.toContain('changed by actual shell');
}, 30_000);

it('queued source launch survives kernel loss and rebinds fresh authority to the saved revision', async () => {
  const f = await fixture();
  const revision = await publishSource(f.host, 'rebind-source', 'source survives restart');
  let serial = 0;
  const provider = await localProvider((body, response) => {
    if (!JSON.stringify(body.input).includes('queued source request')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': active predecessor\n\n');
      return;
    }
    const output = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
    if (!output) toolResponse(response, 'file_read', { path: 'source.txt' }, ++serial);
    else completeLocalResponse(response, `rebound-answer-${++serial}`, 'rebound source read finished');
  });
  await f.runtimeClient.createThread('rebind-thread', 'rebind-conversation');
  const predecessor = await f.runtimeClient.submit({ key: 'rebind-predecessor', threadId: 'rebind-thread', branchId: 'rebind-conversation', expectedHead: null, input: { text: 'held predecessor' }, configuration: provider.configuration });
  await f.runtimeClient.startFromSource({runId: predecessor.run_id, workspaceId: 'source-workspace', executionWorkspaceId: 'source-workspace', branchId: 'rebind-source', revision, mode: 'fixed_branch', tools: ['file_read']});
  await expect.poll(() => provider.requests.length).toBe(1);
  const next = await f.runtimeClient.enqueue({ key: 'rebind-next', threadId: 'rebind-thread', branchId: 'rebind-conversation', mode: 'next_run', input: { text: 'queued source request' } });
  const selection = { runId: next.run_id, workspaceId: 'source-workspace', executionWorkspaceId: 'source-workspace', branchId: 'rebind-source', revision, mode: 'fixed_branch' as const, tools: ['file_read'] as const };
  await f.runtimeClient.startFromSource(selection);
  const oldEpoch = f.host.kernelEpoch;
  await f.crash();
  await f.host.close();
  const restarted = createKernelClient(f.options);
  try {
    const runtimeClient = new AgentRuntimeClient(restarted);
    const launch = await runtimeClient.launch(next.run_id);
    expect(restarted.kernelEpoch).not.toBe(oldEpoch);
    expect(launch?.requires_rebind).toBe(true);
    expect((await runtimeClient.pendingLaunches()).some(item => item.run_id === next.run_id)).toBe(true);
    await expect(runtimeClient.startFromSource({ ...selection, revision: revision + 1 })).rejects.toThrow(/source selection/i);
    await runtimeClient.rebindLaunch(next.run_id);
    await runtimeClient.cancelRun(predecessor.run_id);
    await expect.poll(async () => (await runtimeClient.run(next.run_id)).state, { timeout: 10_000 }).toBe('completed');
    expect(JSON.stringify(await runtimeClient.history('rebind-conversation'))).toContain('source survives restart');
    expect((await runtimeClient.launch(next.run_id))?.requires_rebind).toBe(false);
  } finally { await restarted.close(); }
}, 30_000);

it('file write and edit return real applied receipts while a stale read version cannot overwrite later text', async () => {
  const f = await fixture();
  const revision = await publishSource(f.host, 'mutation-source', 'original text\n');
  const receipts: Array<{ outcome?: string; effect?: string; content?: { readVersion?: string; status?: string; content?: { text?: string } } }> = [];
  let firstVersion = '';
  let turn = 0;
  let successorReadRequested = false;
  let successorRead = '';
  const provider = await localProvider((body, response) => {
    if (JSON.stringify(body.input).includes('inspect prior edits in successor')) {
      if (!successorReadRequested) { successorReadRequested = true; toolResponse(response, 'file_read', { path: 'source.txt' }, 100); }
      else {
        const output = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
        successorRead = String(output?.output);
        completeLocalResponse(response, 'mutation-successor-answer', 'successor read finished');
      }
      return;
    }
    const output = (body.input as Array<Record<string, unknown>>).findLast(item => item.type === 'function_call_output');
    if (output) receipts.push(JSON.parse(String(output.output)) as (typeof receipts)[number]);
    const last = receipts.at(-1);
    turn++;
    if (turn === 1) toolResponse(response, 'file_read', { path: 'source.txt' }, turn);
    else if (turn === 2) {
      firstVersion = last?.content?.readVersion ?? '';
      toolResponse(response, 'file_write', { path: 'source.txt', readVersion: firstVersion, content: 'alpha\nbeta\n' }, turn);
    } else if (turn === 3) toolResponse(response, 'file_edit', { path: 'source.txt', readVersion: last?.content?.readVersion, edits: [{ oldText: 'beta', newText: 'gamma' }] }, turn);
    else if (turn === 4 || turn === 6) toolResponse(response, 'file_read', { path: 'source.txt' }, turn);
    else if (turn === 5) toolResponse(response, 'file_write', { path: 'source.txt', readVersion: firstVersion, content: 'must not overwrite newer text' }, turn);
    else completeLocalResponse(response, 'mutation-answer', 'mutation fixture finished');
  });
  await f.runtimeClient.createThread('mutation-thread', 'mutation-conversation');
  const run = await f.runtimeClient.submit({ key: 'mutation-input', threadId: 'mutation-thread', branchId: 'mutation-conversation', expectedHead: null, input: { text: 'update selected source' }, configuration: provider.configuration });
  await f.runtimeClient.startFromSource({ runId: run.run_id, workspaceId: 'source-workspace', executionWorkspaceId: 'source-workspace', branchId: 'mutation-source', revision, mode: 'materialized', tools: ['file_read', 'file_write', 'file_edit'] });
  await expect.poll(async () => (await f.runtimeClient.run(run.run_id)).state, { timeout: 10_000 }).toMatch(/completed|failed/);
  expect((await f.runtimeClient.run(run.run_id)).state, JSON.stringify({ receipts, events: (await f.runtimeClient.events(0, 100)).slice(-10) })).toBe('completed');
  expect(receipts).toHaveLength(6);
  expect(receipts[1]).toMatchObject({ outcome: 'succeeded', effect: 'confirmed', content: { status: 'applied' } });
  expect(receipts[2]).toMatchObject({ outcome: 'succeeded', effect: 'confirmed', content: { status: 'applied' } });
  expect(receipts[3]?.content?.content?.text).toBe('alpha\ngamma\n');
  expect(receipts[4]).toMatchObject({ kind: 'not_dispatched' });
  expect(JSON.stringify(receipts[4])).toContain('conflict');
  const conflict = (await f.runtimeClient.events(0, 256)).find(event => event.kind === 'operation.settled' && JSON.stringify(event.data).includes('File version conflict'));
  expect(conflict).toBeDefined();
  expect(await f.runtimeClient.operation(conflict!.subject)).toMatchObject({ phase: 'terminal', outcome: 'failed', effect: 'none' });
  expect(receipts[5]?.content?.content?.text).toBe('alpha\ngamma\n');
  const history = await f.runtimeClient.history('mutation-conversation');
  const next = await f.runtimeClient.submit({ key: 'mutation-successor', threadId: 'mutation-thread', branchId: 'mutation-conversation', expectedHead: history.at(-1)!.id, input: { text: 'inspect prior edits in successor' }, configuration: provider.configuration });
  await f.runtimeClient.continueFromLaunch(run.run_id, next.run_id);
  await expect.poll(async () => (await f.runtimeClient.run(next.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(successorRead).toContain('alpha\\ngamma\\n');
}, 30_000);
