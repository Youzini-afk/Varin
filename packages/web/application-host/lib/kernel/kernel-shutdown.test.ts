import { expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { KernelClient, type KernelGrantHandle } from './kernel-client.js';
import { KERNEL_PROTOCOL_VERSION, KERNEL_REQUEST_WINDOW } from './protocol.generated.js';
import { ShutdownDeadline } from '../shutdown-runtime.js';

/** Actual client/windows/stop, with only wire responses controlled by the fixture. */
function fixture(child?: ChildProcessWithoutNullStreams) {
  const client = new KernelClient({ hostId: 'shutdown-review', storageRoot: '/unused', buildVersion: 'review' });
  const owner = client as unknown as {
    epoch: string; handshakeResult: unknown; managementGrant: KernelGrantHandle; child: ChildProcessWithoutNullStreams | null;
    grantFromResponse(value: Record<string, unknown>): KernelGrantHandle;
    transport: { send(frame: Record<string, unknown>): Promise<void>; cancelRequest(): void; close(): Promise<void> };
    pending: Map<string, unknown>; consumeFrame(value: unknown): void;
    requestRaw(method: string, params: unknown, options: unknown): Promise<unknown>;
  };
  owner.epoch = 'epoch'; owner.handshakeResult = {};
  owner.managementGrant = owner.grantFromResponse({ grant_id: 'management', kernel_epoch: 'epoch' });
  if (child) owner.child = child;
  const sent: Record<string, unknown>[] = [];
  const close = vi.fn(async () => {});
  owner.transport = { async send(frame) { sent.push(frame); }, cancelRequest() {}, close };
  const request = (method: string) => owner.requestRaw(method, {}, { allowBootstrap: true });
  const finish = (index: number) => owner.consumeFrame({ v: KERNEL_PROTOCOL_VERSION, kind: 'response', id: sent[index]!.id, ok: true, result: {} });
  return { client, owner, sent, close, request, finish };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('refuses queued new execution after draining starts without blocking control or losing original receipts', async () => {
  const f = fixture();
  const originals = Array.from({ length: KERNEL_REQUEST_WINDOW }, () => f.request('process.write'));
  await tick();
  const queued = expect(f.request('runtime.input.submit')).rejects.toMatchObject({ code: 'host-draining', settlement: 'not_dispatched' });
  f.client.beginDraining();
  await queued;
  expect(f.owner.pending.size).toBe(KERNEL_REQUEST_WINDOW);
  const cancel = f.request('runtime.operation.cancel');
  await tick();
  expect(f.sent.at(-1)?.method).toBe('runtime.operation.cancel');
  f.finish(KERNEL_REQUEST_WINDOW); await cancel;
  expect(f.owner.pending.size).toBe(KERNEL_REQUEST_WINDOW);
  f.finish(0);
  for (let index = 1; index < KERNEL_REQUEST_WINDOW; index++) f.finish(index);
  await Promise.all(originals);
  expect(f.sent.some(frame => frame.method === 'runtime.input.submit')).toBe(false);
  const observation = f.request('runtime.operation.inspect'); await tick(); f.finish(KERNEL_REQUEST_WINDOW + 1); await observation;
  await f.client.close();
});

it('retains the actual native child and transport on deadline; a late drain receipt cannot resume teardown', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const f = fixture(child);
  try {
    // Use the public native-workspace path to acquire the original lifetime.
    const opening = f.client.workspaceRequest('workspace.open', {} as never, f.owner.managementGrant);
    await tick(); f.finish(0); await opening;
    const deadline = new ShutdownDeadline(50);
    const stopping = f.client.close(deadline);
    await expect(stopping).rejects.toMatchObject({ code: 'shutdown-incomplete', owner: 'kernel.native-drain', reason: 'deadline' });
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull(); expect(child.killed).toBe(false);
    expect(f.owner.child).toBe(child);
    expect(f.close).not.toHaveBeenCalled();
    const shutdownIndex = f.sent.findIndex(frame => frame.method === 'kernel.shutdown');
    expect(shutdownIndex).toBeGreaterThanOrEqual(0);
    f.finish(shutdownIndex); await tick();
    expect(f.close).not.toHaveBeenCalled();
    expect(f.client.close(deadline)).toBe(stopping);
    await expect(f.client.close(deadline)).rejects.toMatchObject({ reason: 'deadline' });
  } finally {
    // The test is the external supervisor, not an invented successful owner stop.
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exited;
  }
});
