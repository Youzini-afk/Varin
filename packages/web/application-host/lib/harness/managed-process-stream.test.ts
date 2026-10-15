import { expect, it, vi } from 'vitest';
import { consumeManagedProcessStream } from './managed-process-stream.js';
import { createManagedSourceProcesses } from './managed-source-processes.js';
import { KERNEL_PROTOCOL_VERSION, type KernelProcessStreamEvent } from '../kernel/protocol.generated.js';
import type { KernelProcessObserver } from '../kernel/kernel-client.js';

const address = { coordinatorHostId: 'A', authorityId: 'B-view', resourceEpoch: 'B-epoch', processId: 'original-job' };
const input = { ...address, subscriptionId: 'view', cursor: 0 };
const principal = { principalId: 'paired-A', capabilities: ['filesystem:read', 'terminal:use', 'process:control'] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function stream() {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { out = controller; } });
  return { response: new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    send(frame: unknown) { out.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`)); }, end() { out.close(); } };
}
function event(stream: 'control' | 'data', sequence = 1): KernelProcessStreamEvent {
  return { v: KERNEL_PROTOCOL_VERSION, kind: 'process-event', processId: address.processId, kernelEpoch: address.resourceEpoch,
    grantId: address.authorityId, subscriptionId: input.subscriptionId, replayCursor: 20, stream, sequence, error: null,
    result: null };
}

it('carries independent native data/control credit and closes only the original view', async () => {
  let nativeObserver!: KernelProcessObserver, resolveClosed!: () => void;
  const nativeClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const acknowledge = vi.fn(async () => {}), detach = vi.fn(async () => { resolveClosed(); }), release = vi.fn(async () => {});
  const processWrite = vi.fn(async (value: unknown) => value);
  const scoped = { processSubscribe: vi.fn(async (_input, observer) => { nativeObserver = observer;
    return { closed: nativeClosed, close: detach, acknowledge }; }), processWrite };
  const access = vi.fn(async () => ({ source: { workspace_id: 'B-workspace' }, physicalRoot: { rootId: 'B-root' } }) as never);
  const owner = createManagedSourceProcesses({ kernel: { sourceAuthorityGrant: () => 'grant', scoped: () => scoped } as never, access, release });
  const transport = stream();
  const target = await owner.processSubscribe(principal, input, next => transport.send({ kind: 'event', event: next }));
  const received: Array<{ value: KernelProcessStreamEvent; ack(): Promise<void> }> = [];
  const opening = consumeManagedProcessStream(transport.response, input, (value, ack) => received.push({ value, ack }),
    command => owner.processControl(principal, command));
  transport.send({ kind: 'ready', subscriptionId: input.subscriptionId, resourceEpoch: input.resourceEpoch });
  const client = await opening;
  nativeObserver({ ...event('data'), grantId: 'private-native-grant', subscriptionId: 'private-native-stream' }, async () => {});
  nativeObserver({ ...event('control'), grantId: 'private-native-grant', subscriptionId: 'private-native-stream' }, async () => {});
  await tick();
  expect(received).toHaveLength(2); expect(acknowledge).not.toHaveBeenCalled();
  expect(received[0]!.value.grantId).toBe(address.authorityId);
  await received[1]!.ack();
  expect(acknowledge.mock.calls).toEqual([['control', 1]]);
  await owner.processWrite(principal, { ...address, operationId: 'exact-input', bytesBase64: Buffer.from('echo x\n').toString('base64') });
  expect(processWrite).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'B-workspace', rootId: 'B-root', operationId: 'exact-input' }));
  await client.close(); await target.closed;
  expect(detach).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
  expect(processWrite).toHaveBeenCalledTimes(1);
});

it('rejects a changed stream identity without replaying an interaction', async () => {
  const transport = stream(), control = vi.fn(async (_request: Parameters<Parameters<typeof consumeManagedProcessStream>[3]>[0]) => ({})), observer = vi.fn();
  const opening = consumeManagedProcessStream(transport.response, input, observer, control);
  transport.send({ kind: 'ready', subscriptionId: input.subscriptionId, resourceEpoch: input.resourceEpoch });
  const client = await opening;
  const failed = expect(client.closed).rejects.toThrow('identity changed');
  transport.send({ kind: 'event', event: { ...event('control'), kernelEpoch: 'other-B-epoch' } });
  await failed; await tick();
  expect(observer).not.toHaveBeenCalled();
  expect(control).toHaveBeenCalledOnce(); expect(control.mock.calls[0]![0]).toMatchObject({ ...address, kind: 'close' });
});

it('keeps input failures as failures and rejects another principal or process on a view', async () => {
  const processWrite = vi.fn(async () => { throw new Error('original partial input receipt'); });
  let resolve!: () => void;
  const closed = new Promise<void>(done => { resolve = done; });
  const owner = createManagedSourceProcesses({ kernel: { sourceAuthorityGrant: () => 'grant', scoped: () => ({ processWrite,
    processSubscribe: async () => ({ closed, close: async () => resolve(), acknowledge: async () => {} }) }) } as never,
    access: async () => ({ source: { workspace_id: 'B' }, physicalRoot: { rootId: 'root' } }) as never, release: async () => {} });
  const view = await owner.processSubscribe(principal, input, () => {});
  await expect(owner.processWrite(principal, { ...address, operationId: 'one-input', bytesBase64: 'YQ==' })).rejects.toThrow('original partial');
  expect(processWrite).toHaveBeenCalledTimes(1);
  await expect(owner.processControl({ ...principal, principalId: 'other' }, { ...input, kind: 'ack', stream: 'data', sequence: 1 })).rejects.toThrow('unavailable');
  await expect(owner.processControl(principal, { ...input, processId: 'other-job', kind: 'close' })).rejects.toThrow('identity changed');
  await view.close();
});
