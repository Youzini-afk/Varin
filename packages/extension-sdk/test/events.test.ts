import assert from 'node:assert/strict';
import test from 'node:test';
import { eventReceiver } from '../src/events.js';
test('receiver submits the original batch and waits for the actual durable receipt', async () => {
  let commit!: () => void;
  let submitted: unknown;
  const receiver = eventReceiver({ call: async (capability, method, input) => {
    assert.equal(capability, 'varin.events'); assert.equal(method, 'submit'); submitted = input;
    await new Promise<void>(resolve => { commit = resolve; }); return { cursor: 'next', accepted: 1, duplicates: 0 };
  } });
  const batch = { expectedCursor: 'saved', nextCursor: 'next', events: [{ eventId: 'message', occurredAtMs: 1,
    attributes: {}, content: { data: null, parts: [{ kind: 'text' as const, text: 'Original message' }] } }] };
  let done = false; const pending = receiver.submit(batch).then(receipt => { done = true; return receipt; });
  await Promise.resolve(); assert.equal(done, false); assert.deepEqual(submitted, batch);
  commit(); assert.deepEqual(await pending, { cursor: 'next', accepted: 1, duplicates: 0 });
});
