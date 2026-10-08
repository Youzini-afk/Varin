import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
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
