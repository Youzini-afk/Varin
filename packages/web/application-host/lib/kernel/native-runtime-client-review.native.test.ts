import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { NativeRuntimeClient } from './native-runtime-client.js';
import { KERNEL_PROTOCOL_VERSION, KERNEL_REQUEST_WINDOW } from './protocol.generated.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
type Envelope = { kind: string; id: string; method?: string; epoch?: string; grantId?: string; ok?: boolean; error?: { code: string; message: string }; result?: unknown };
function frame(value: unknown) { const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); }

async function fixture() {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-native-client-review-'));
  const requests: Envelope[] = [];
  const responses = new Map<string, Envelope>();
  const held: Buffer[] = [];
  let holdMethod: string | undefined;
  let child!: ChildProcessWithoutNullStreams;
  let releaseHeld = () => {};
  const options = { hostId: 'native-client-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false };
  const host = createKernelClient({ ...options, spawnProcess: ((command, args, input) => {
    child = spawn(command, args ?? [], input ?? {}) as ChildProcessWithoutNullStreams;
    const write = child.stdin.write;
    child.stdin.write = ((...values: unknown[]) => {
      const bytes = values[0];
      if (Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes.readUInt32BE(0) === bytes.length - 4) requests.push(JSON.parse(bytes.subarray(4).toString()) as Envelope);
      return Reflect.apply(write, child.stdin, values);
    }) as typeof child.stdin.write;
    // Delay delivery of selected real responses, without mocking kernel execution.
    const emit = child.stdout.emit;
    let buffer = Buffer.alloc(0);
    child.stdout.emit = ((event: string | symbol, ...values: unknown[]) => {
      if (event !== 'data') return Reflect.apply(emit, child.stdout, [event, ...values]);
      buffer = Buffer.concat([buffer, Buffer.from(values[0] as Uint8Array)]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
        const end = 4 + buffer.readUInt32BE(0);
        const bytes = Buffer.from(buffer.subarray(0, end));
        buffer = buffer.subarray(end);
        const response = JSON.parse(bytes.subarray(4).toString()) as Envelope;
        responses.set(response.id, response);
        if (holdMethod && requests.find(request => request.id === response.id)?.method === holdMethod) held.push(bytes);
        else Reflect.apply(emit, child.stdout, ['data', bytes]);
      }
      return true;
    }) as typeof child.stdout.emit;
    releaseHeld = () => { holdMethod = undefined; for (const bytes of held.splice(0)) Reflect.apply(emit, child.stdout, ['data', bytes]); };
    return child;
  }) as typeof spawn });
  cleanups.push(async () => { releaseHeld(); await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  await host.start();
  return { host, native: new NativeRuntimeClient(host), root, options, requests, responses, held, hold(method: string) { holdMethod = method; }, release: () => releaseHeld(),
    async raw(value: Record<string, unknown>) { const id = `review-${requests.length}`; child.stdin.write(frame({ v: KERNEL_PROTOCOL_VERSION, kind: 'request', id, epoch: host.kernelEpoch, ...value })); await expect.poll(() => responses.has(id)).toBe(true); return responses.get(id)!; },
  };
}

it('native client submits, inspects, cancels, replays events and preserves receipt on reopen', async () => {
  const f = await fixture();
  const before = await f.native.status();
  expect(Number.isInteger(before.epoch)).toBe(true);
  expect(await f.native.createThread('thread', 'branch')).toEqual({ threadId: 'thread', branchId: 'branch' });
  const input = { key: 'request-key', threadId: 'thread', branchId: 'branch', expectedHead: null, input: { text: 'local IPC verification' }, configuration: {} };
  const receipt = await f.native.submit(input);
  expect(await f.native.submit(input)).toEqual(receipt);
  await expect(f.native.submit({ ...input, input: { text: 'changed retry' } })).rejects.toThrow(/conflict/i);
  await expect(f.native.submit({ ...input, key: 'second-input' })).rejects.toThrow(/conflict/i);
  expect((await f.native.run(receipt.run_id)).thread_id).toBe('thread');
  expect((await f.native.history('branch')).map(item => item.content)).toEqual([input.input]);
  expect((await f.native.cancelRun(receipt.run_id)).cancel_requested).toBe(true);
  const events = await f.native.events(0, 100);
  expect(events.some(event => event.kind === 'run.accepted' && event.subject === receipt.run_id)).toBe(true);
  expect(events.every((event, index) => index === 0 || event.cursor > events[index - 1]!.cursor)).toBe(true);
  expect(await f.native.events(events.at(-1)!.cursor, 100)).toEqual([]);
  await f.host.close();
  const reopened = createKernelClient(f.options);
  try {
    const native = new NativeRuntimeClient(reopened);
    expect((await native.status()).epoch).toBeGreaterThan(before.epoch);
    expect(await native.submit(input)).toEqual(receipt);
    expect((await native.history('branch')).map(item => item.id)).toEqual([receipt.input_id]);
  } finally { await reopened.close(); }
}, 30_000);

it('native framed IPC rejects malformed parameters and stale or grant-scoped authority', async () => {
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
  expect((await f.native.status()).epoch).toBeGreaterThan(0);
  await expect(f.native.run('missing')).rejects.toThrow();
  await expect(f.native.operation('missing')).rejects.toThrow();
}, 30_000);

it('native client uses unique IDs and independent credits while ordinary responses are delayed', async () => {
  const f = await fixture();
  f.hold('storage.health');
  const ordinary = Array.from({ length: KERNEL_REQUEST_WINDOW }, () => f.host.health());
  await expect.poll(() => f.held.length).toBe(KERNEL_REQUEST_WINDOW);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.native.status()));
  expect(results.every(value => value.epoch === results[0]!.epoch)).toBe(true);
  const nativeRequests = f.requests.filter(value => value.method?.startsWith('runtime.'));
  expect(new Set(nativeRequests.map(value => value.id)).size).toBe(nativeRequests.length);
  expect(nativeRequests.every(value => value.epoch === f.host.kernelEpoch && value.grantId === undefined)).toBe(true);
  f.release();
  expect((await Promise.all(ordinary)).every(value => value.integrity === 'ok')).toBe(true);
}, 30_000);

it('native abort retains wire credit until receipt and cancels queued admission without dispatch', async () => {
  const f = await fixture();
  f.hold('runtime.status');
  const controller = new AbortController();
  const first = f.native.status(controller.signal);
  const rejected = expect(first).rejects.toThrow(/cancelled/i);
  const second = f.native.status();
  await expect.poll(() => f.held.length).toBe(KERNEL_REQUEST_WINDOW);
  controller.abort();
  await rejected;
  expect(f.requests.some(value => value.kind === 'cancel')).toBe(true);
  const queued = new AbortController();
  const third = f.native.status(queued.signal);
  const queuedRejected = expect(third).rejects.toThrow(/cancelled/i);
  queued.abort();
  await queuedRejected;
  expect(f.requests.filter(value => value.method === 'runtime.status')).toHaveLength(KERNEL_REQUEST_WINDOW);
  f.release();
  await second;
  expect((await f.native.status()).epoch).toBeGreaterThan(0);
}, 30_000);


async function localProvider(reply: (body: Record<string, unknown>, response: ServerResponse) => void) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      reply(body, response);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback server has no TCP address');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { requests, configuration: { providerFamily: 'openai-responses', model: 'local-test-model', endpoint: `http://127.0.0.1:${address.port}/responses`, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 } };
}

it('native run.start reaches a local HTTP provider and continues durable assistant history', async () => {
  const f = await fixture();
  let outputNumber = 0;
  const provider = await localProvider((_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `local-message-${++outputNumber}`, type: 'message', content: [{ type: 'output_text', text: 'native HTTP result' }] }], usage: { input_tokens: 4, output_tokens: 3 } } })}\n\n`);
  });
  await f.native.createThread('model-thread', 'model-branch');
  const receipt = await f.native.submit({ key: 'model-input', threadId: 'model-thread', branchId: 'model-branch', expectedHead: null, input: { text: 'local user input' }, configuration: provider.configuration });
  expect((await f.native.startRun(receipt.run_id)).runId).toBe(receipt.run_id);
  await expect.poll(async () => (await f.native.run(receipt.run_id)).state, { timeout: 8_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]).toMatchObject({ model: 'local-test-model', stream: true, input: [{ role: 'user', content: 'local user input' }] });
  const history = await f.native.history('model-branch');
  expect(history.some(item => item.source === 'assistant' && JSON.stringify(item.content).includes('native HTTP result'))).toBe(true);
  await expect(f.native.startRun(receipt.run_id)).rejects.toThrow();
  expect(provider.requests).toHaveLength(1);
  const next = await f.native.submit({ key: 'model-followup', threadId: 'model-thread', branchId: 'model-branch', expectedHead: history.at(-1)!.id, input: { text: 'follow up' }, configuration: provider.configuration });
  await f.native.startRun(next.run_id);
  await expect.poll(async () => { const run = await f.native.run(next.run_id); if (run.state === 'failed') throw new Error(JSON.stringify(await f.native.events(0, 100))); return run.state; }, { timeout: 8_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests[1]!.input)).toContain('native HTTP result');
  expect(JSON.stringify(provider.requests[1]!.input)).toContain('follow up');
}, 30_000);

it('native run.cancel interrupts an active local HTTP stream and leaves control usable', async () => {
  const f = await fixture();
  const provider = await localProvider((_body, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    response.write(': waiting for cancellation\n\n');
  });
  await f.native.createThread('cancel-thread', 'cancel-branch');
  const receipt = await f.native.submit({ key: 'cancel-input', threadId: 'cancel-thread', branchId: 'cancel-branch', expectedHead: null, input: { text: 'cancel local stream' }, configuration: provider.configuration });
  await f.native.startRun(receipt.run_id);
  await expect.poll(() => provider.requests.length, { timeout: 8_000 }).toBe(1);
  await expect(f.native.startRun(receipt.run_id)).rejects.toThrow();
  await f.native.cancelRun(receipt.run_id);
  await expect.poll(async () => (await f.native.run(receipt.run_id)).state, { timeout: 8_000 }).toBe('cancelled');
  expect(provider.requests).toHaveLength(1);
  expect((await f.native.status()).epoch).toBeGreaterThan(0);
}, 30_000);

it('native tool loop reads a grant-scoped fixed file revision and returns its receipt to the provider', async () => {
  const f = await fixture();
  let turn = 0;
  const provider = await localProvider((_body, response) => {
    const output = ++turn === 1
      ? [{ id: 'file-call', type: 'function_call', call_id: 'file-read-1', name: 'native_file_read', arguments: JSON.stringify({ path: 'allowed.txt' }) }]
      : [{ id: 'file-answer', type: 'message', content: [{ type: 'output_text', text: 'read finished' }] }];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
  });
  await f.native.createThread('tool-thread', 'tool-branch');
  const receipt = await f.native.submit({ key: 'tool-input', threadId: 'tool-thread', branchId: 'tool-branch', expectedHead: null, input: { text: 'read local file' }, configuration: provider.configuration });
  const grant = await f.host.issueGrant({ grantId: 'file-owner', threadId: 'tool-thread', runId: receipt.run_id, owningWorkspace: 'workspace', executionWorkspace: 'workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
  const actor = f.host.scoped(grant);
  const bytes = Buffer.from('fixed native file content');
  const blob = await actor.putBlob(bytes, 'test-file');
  await actor.createBranch({ operationId: 'source-create', branchId: 'file-source', workspaceId: 'workspace', draftBasePaths: [], captureScopes: [], entries: [{ path: 'allowed.txt', state: { kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId }] });
  const source = await actor.readBranch({ branchId: 'file-source' });
  const published = await actor.publishBranch({ operationId: 'source-publish', branchId: 'file-source', expectedRoot: source.root, expectedWriteRevision: source.writeRevision });
  const binding = { grantId: grant.grantId, runId: receipt.run_id, threadId: 'tool-thread', workspaceId: 'workspace', executionWorkspaceId: 'workspace', fileSource: { branchId: 'file-source', revision: Number(published.revision) }, enabledTools: ['file_read'] };
  await expect(f.native.startRun(receipt.run_id, undefined, { ...binding, runId: 'wrong-run' })).rejects.toThrow();
  expect(provider.requests).toHaveLength(0);
  await f.native.startRun(receipt.run_id, undefined, binding);
  await expect.poll(async () => (await f.native.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests[0]!.tools)).toContain('native_file_read');
  const continuation = provider.requests[1]!.input as Array<Record<string, unknown>>;
  const result = continuation.find(item => item.type === 'function_call_output');
  expect(result?.call_id).toBe('file-read-1');
  expect(String(result?.output)).toContain('fixed native file content');
  expect((await f.native.history('tool-branch')).some(item => item.source === 'tool')).toBe(true);
}, 30_000);

it.each([false, true])('native tool process settles OS and durable operation evidence (cancel=%s)', async (cancelProcess) => {
  const f = await fixture();
  const workspace = path.join(f.root, 'process-workspace');
  await fs.mkdir(workspace);
  let turn = 0;
  const provider = await localProvider((_body, response) => {
    const output = ++turn === 1
      ? [{ id: 'process-call', type: 'function_call', call_id: 'spawn-1', name: 'native_process_spawn', arguments: JSON.stringify({ cwd: '', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("native-test-marker.txt", "real native process");' + (cancelProcess ? 'setInterval(() => {}, 1000)' : '')], mode: 'pipe' }) }]
      : [{ id: 'process-answer', type: 'message', content: [{ type: 'output_text', text: 'spawn accepted' }] }];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
  });
  await f.native.createThread('process-thread', 'process-branch');
  const receipt = await f.native.submit({ key: 'process-input', threadId: 'process-thread', branchId: 'process-branch', expectedHead: null, input: { text: 'spawn local fixture process' }, configuration: provider.configuration });
  const grant = await f.host.issueGrant({ grantId: 'process-owner', threadId: 'process-thread', runId: receipt.run_id, owningWorkspace: 'process-workspace', executionWorkspace: 'process-workspace', capabilities: ['storage.read', 'storage.write', 'process'], pathScopes: [''] });
  const actor = f.host.scoped(grant);
  const registered = await actor.fileRootRegister({ workspaceId: 'process-workspace', executionWorkspaceId: 'process-workspace', canonicalRoot: workspace });
  await f.native.startRun(receipt.run_id, undefined, { grantId: grant.grantId, runId: receipt.run_id, threadId: 'process-thread', workspaceId: 'process-workspace', executionWorkspaceId: 'process-workspace', rootId: registered.rootId, enabledTools: ['process_spawn'] });
  await expect.poll(async () => (await f.native.run(receipt.run_id)).state, { timeout: 10_000 }).toBe('completed');
  expect(provider.requests).toHaveLength(2);
  const continuation = provider.requests[1]!.input as Array<Record<string, unknown>>;
  const result = continuation.find(item => item.type === 'function_call_output');
  const accepted = JSON.parse(String(result?.output)) as { operation_id: string };
  expect(typeof accepted.operation_id).toBe('string');
  const processIdentity = { workspaceId: 'process-workspace', processId: accepted.operation_id };
  try {
    await expect.poll(async () => fs.readFile(path.join(workspace, 'native-test-marker.txt'), 'utf8').catch(() => ''), { timeout: 8_000 }).toBe('real native process');
    await expect(actor.processList({ workspaceId: 'process-workspace', rootId: String(registered.rootId) })).rejects.toThrow(/process maintenance/i);
    if (cancelProcess) {
      expect((await actor.processInspect(processIdentity)).writerActive).toBe(true);
      await f.native.cancelOperation(accepted.operation_id);
    }
    await expect.poll(async () => (await actor.processInspect(processIdentity)).writerActive, { timeout: 8_000 }).toBe(false);
    await expect.poll(async () => (await f.native.operation(accepted.operation_id)).phase, { timeout: 8_000 }).toBe('terminal');
    expect((await f.native.operation(accepted.operation_id)).outcome).toBe(cancelProcess ? 'cancelled' : 'succeeded');
  } finally {
    if ((await actor.processInspect(processIdentity)).writerActive) {
      await actor.processKill({ ...processIdentity, force: true });
      await expect.poll(async () => (await actor.processInspect(processIdentity)).writerActive, { timeout: 8_000 }).toBe(false);
    }
  }
}, 30_000);

it('native and Storage negotiated windows remain independent during real concurrent uploads', async () => {
  const f = await fixture();
  const actor = f.host.scoped(await f.host.issueGrant({ grantId: 'concurrent-owner', owningWorkspace: 'concurrent-workspace', executionWorkspace: 'concurrent-workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }));
  const body = Buffer.alloc(2 * 1024 * 1024, 37);
  const uploads = [actor.putBlob(body, 'concurrent-blob-a'), actor.putBlob(Buffer.from(body).fill(38), 'concurrent-blob-b')] as const;
  const controls = Promise.all(Array.from({ length: 100 }, () => f.native.status()));
  const [first, second, statuses] = await Promise.all([...uploads, controls] as const);
  expect(first?.byteLength).toBe(body.length);
  expect(second?.byteLength).toBe(body.length);
  expect(statuses).toHaveLength(100);
  expect((await f.host.health()).integrity).toBe('ok');
}, 30_000);
