import { expect, test } from 'vitest';
import { RemoteBrowserOwner, browserActor } from './remote-owner.js';
import { deferred, type BrowserDeviceWire } from './device-wire.js';

function fixture() {
  const request = deferred<Record<string, unknown>>(), messages: Record<string, unknown>[] = [];
  const wire = {
    onMessage: (_message: Record<string, unknown>) => {}, onFrame: () => {}, onClose: () => {},
    async send(message: Record<string, unknown>) { messages.push(message); if (message.kind === 'call') request.resolve(message); },
    close() { wire.onClose(); },
  };
  const owner = new RemoteBrowserOwner({ hostId: 'host', deviceId: 'device', browserId: 'browser', ownerGeneration: 'generation', grantId: 'grant', label: 'device' }, wire as unknown as BrowserDeviceWire, () => {}, () => {});
  const action = browserActor.run({ kind: 'thread', threadId: 'thread', runId: 'run', invocationId: 'call' }, () => owner.act('page', { action: 'press', key: 'A' })).catch(error => error);
  return { owner, wire, request: request.promise, messages, action };
}

test('an unknown executor without a local completion waiter keeps its original lease until a stop receipt', async () => {
  const f = fixture(), call = await f.request;
  f.wire.onMessage({ kind: 'response', requestId: call.requestId, leaseId: call.leaseId, ok: false,
    error: { message: 'Native observer lost', effect: 'unknown', executorStopped: false, pendingCompletion: false } });
  const unknown = await f.action; expect(unknown).toMatchObject({ effect: 'unknown', executorStopped: false });
  let stopped = false; void unknown.completion.then(() => { stopped = true; });
  expect(f.messages.some(message => message.kind === 'receipt-ack')).toBe(false);
  f.wire.close(); await Promise.resolve(); expect(stopped).toBe(false);
  expect(() => f.owner.recoverStop(String(call.requestId), 'wrong-lease')).toThrow('original request lease');
  expect(stopped).toBe(false);
  f.owner.recoverStop(String(call.requestId), String(call.leaseId)); await unknown.completion; expect(stopped).toBe(true);
});

test('a malformed success closes transport and reports unknown instead of stranding the caller', async () => {
  const f = fixture(), call = await f.request;
  f.wire.onMessage({ kind: 'response', requestId: call.requestId, leaseId: call.leaseId, ok: true, executorStopped: false });
  const unknown = await f.action; expect(unknown).toMatchObject({ effect: 'unknown', executorStopped: false });
  expect(f.owner.connected).toBe(false);
  let stopped = false; void unknown.completion.then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
});
