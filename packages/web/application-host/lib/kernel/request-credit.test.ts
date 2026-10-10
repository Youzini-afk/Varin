import { expect, it } from 'vitest';
import { KernelClient, type KernelGrantHandle } from './kernel-client.js';

/** Real client admission/cancellation with only the transport replaced by an in-memory fixture. */
function fixture() {
  const client = new KernelClient({ hostId: 'credit-review', storageRoot: '/unused', buildVersion: 'review' });
  const owner = client as unknown as {
    epoch: string; handshakeResult: unknown; grantFromResponse(value: Record<string, unknown>): KernelGrantHandle; transport: { send(frame: Record<string, unknown>, lane: string): Promise<void>; cancelRequest(): void };
    pending: Map<string, unknown>;
    requestRaw(method: string, params: unknown, options: unknown): Promise<unknown>;
    consumeFrame(frame: unknown): void;
    whenRequestsIdle(): Promise<void>;
  };
  owner.epoch = 'epoch'; owner.handshakeResult = {};
  const sent: Array<{ frame: Record<string, unknown>; lane: string }> = [];
  owner.transport = { async send(frame, lane) { sent.push({ frame, lane }); }, cancelRequest() {} };
  const request = (method: string, signal?: AbortSignal) => owner.requestRaw(method, {}, { allowBootstrap: true, signal });
  const release = (index: number) => owner.consumeFrame({ v: 1, kind: 'request-credit-released', id: sent[index]!.frame.id,
    kernelEpoch: 'epoch', method: sent[index]!.frame.method });
  const finish = (index: number) => owner.consumeFrame({ v: 1, kind: 'response', id: sent[index]!.frame.id, ok: true, result: {} });
  return { client, owner, sent, request, release, finish };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it('releases only body admission credit while original input receipts and cancellation stay owned', async () => {
  const f = fixture();
  let inputDone = false;
  const first = f.request('process.write').then(() => { inputDone = true; });
  const second = f.request('process.write');
  await tick();
  const read = f.request('process.read');
  const enqueue = f.request('runtime.input.enqueue');
  const stop = f.request('process.kill');
  const cancel = f.request('runtime.operation.cancel');
  await tick();
  expect(f.sent.map(v => v.frame.method)).toEqual(['process.write', 'process.write', 'process.kill', 'runtime.operation.cancel']);
  f.release(0); f.release(1); await tick();
  expect(f.sent.map(v => v.frame.method)).toEqual(['process.write', 'process.write', 'process.kill', 'runtime.operation.cancel', 'process.read', 'runtime.input.enqueue']);
  expect(inputDone).toBe(false);
  let idle = false; const drained = f.owner.whenRequestsIdle().then(() => { idle = true; });
  for (let i = 2; i < f.sent.length; i++) f.finish(i);
  f.release(0); // Duplicate body-credit receipt cannot enlarge the window or settle input.
  await tick(); expect(idle).toBe(false); expect(f.owner.pending.size).toBe(2);
  f.finish(0); f.finish(1);
  await Promise.all([first, second, read, enqueue, stop, cancel, drained]);
  expect(idle).toBe(true);
});

it('keeps an aborted admitted input until its original effect response after credit release', async () => {
  const f = fixture(); const controller = new AbortController();
  const input = expect(f.request('process.write', controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  await tick(); f.release(0); controller.abort(); await input;
  expect(f.sent[1]!.frame.kind).toBe('cancel'); expect(f.sent[1]!.lane).toBe('control');
  expect(f.owner.pending.size).toBe(1);
  let idle = false; const drained = f.owner.whenRequestsIdle().then(() => { idle = true; });
  const read = f.request('process.read'); await tick(); f.finish(2); await read;
  expect(idle).toBe(false);
  f.finish(0); await drained; expect(idle).toBe(true);
});


it.each(['retire', 'revoke'] as const)('%s closes the original grant caller over the control lane without consuming its unsettled effect receipt', async action => {
  const f = fixture();
  const grant = f.owner.grantFromResponse({ grant_id: 'original-source', kernel_epoch: 'epoch', thread_id: 'original-thread', run_id: 'original-run' });
  const input = expect(f.owner.requestRaw('process.write', {}, { allowBootstrap: true, grant })).rejects.toMatchObject({ code: 'cancelled' });
  const other = f.request('file.read'); await tick();
  const inactive = action === 'retire' ? f.client.retireGrant(grant.grantId) : f.client.revokeGrant(grant.grantId);
  await tick(); await input;
  expect(f.sent[2]!.frame.kind).toBe('cancel');
  expect(f.sent[3]).toMatchObject({ lane: 'control', frame: { method: `authority.grant.${action}`, params: action === 'retire' ? { target: { kind: 'grant', grantId: grant.grantId } } : { grantId: grant.grantId } } });
  expect(f.owner.pending.size).toBe(3);
  f.finish(3); await inactive;
  const denied = expect(f.owner.requestRaw('process.read', {}, { allowBootstrap: true, grant })).rejects.toMatchObject({ code: 'forbidden' });
  f.finish(1); await other; await denied;
  expect(f.sent).toHaveLength(4); expect(f.owner.pending.size).toBe(1);
  f.finish(0); await f.owner.whenRequestsIdle();
});
