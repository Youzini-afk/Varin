import "./network-fixture.js";
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createThreadsHttpAPI } from '../src/threads-http.js';

it('releases each rejected observation response before the caller retries', async () => {
  const original = globalThis.fetch;
  let cancelled = 0;
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (_input, init) => {
    signals.push(init!.signal!);
    return new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancelled += 1; } }), { status: 401 });
  };
  try {
    const api = createThreadsHttpAPI();
    const owner = new AbortController();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await assert.rejects(api.observe(7, () => assert.fail('Rejected observation published an event'), { signal: owner.signal }), /unavailable/);
      assert.equal(cancelled, attempt);
      assert.equal(signals.at(-1)!.aborted, true);
      assert.equal(owner.signal.aborted, false);
    }
  } finally { globalThis.fetch = original; }
});

it('releases the reader and original channel after malformed event data', async () => {
  const original = globalThis.fetch;
  let cancelled = 0;
  let signal: AbortSignal | undefined;
  const body = new ReadableStream<Uint8Array>({
    start: controller => controller.enqueue(new TextEncoder().encode('data: not-json\n\n')),
    cancel: () => { cancelled += 1; },
  });
  globalThis.fetch = async (_input, init) => { signal = init!.signal!; return new Response(body); };
  try {
    await assert.rejects(createThreadsHttpAPI().observe(7, () => assert.fail('Invalid event was published'), { signal: new AbortController().signal }), SyntaxError);
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
    assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = original; }
});

it('preserves observation transport failures and releases an errored reader', async () => {
  const original = globalThis.fetch;
  const failure = new Error('Observation connection closed before response completion');
  let signal: AbortSignal | undefined;
  const body = new ReadableStream<Uint8Array>({ start: controller => controller.error(failure) });
  globalThis.fetch = async (_input, init) => { signal = init!.signal!; return new Response(body); };
  try {
    await assert.rejects(createThreadsHttpAPI().observe(7, () => {}, { signal: new AbortController().signal }), error => error === failure);
    assert.equal(body.locked, false);
    assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = original; }
});
