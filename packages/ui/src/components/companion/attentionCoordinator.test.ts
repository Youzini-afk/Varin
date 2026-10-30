import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadAttentionSnapshot, ThreadsAPI } from '@varin/application-client';
import { CompanionAttentionCoordinator, ATTENTION_READ_INTERVAL_MS } from './attentionCoordinator';
const snapshot = (eventCursor = 1, epoch = 1): ThreadAttentionSnapshot => ({ epoch, eventCursor, coverage: { native: 'complete', external: 'unsupported', scope: 'host' }, branches: [], items: [], teamExecutions: [], delegations: [], follows: [], counts: { actionRequired: 0, affectedBranches: 0, unknownEffects: 0 } });
function harness(read: ThreadsAPI['attention'] = async () => snapshot()) {
  let event: Parameters<ThreadsAPI['observe']>[1] = () => {};
  let disconnect: (error: unknown) => void = () => {};
  const attention = vi.fn(read), observe = vi.fn<ThreadsAPI['observe']>((_cursor, callback, { signal }) => {
    event = callback;
    return new Promise<void>((resolve, reject) => { disconnect = reject; signal.addEventListener('abort', () => resolve(), { once: true }); });
  });
  const api = { attention, observe, events: vi.fn(async () => []) } as unknown as ThreadsAPI;
  const coordinator = new CompanionAttentionCoordinator(api);
  return { coordinator, attention, observe, send: (value: unknown) => event(value as Parameters<typeof event>[0]), disconnect: () => disconnect(new Error('offline')) };
}
afterEach(() => vi.useRealTimers());
describe('single companion observation and compact attention reader', () => {
  it('shares one stream, ignores progress bursts and bounds durable reads', async () => {
    vi.useFakeTimers(); const h = harness(); h.coordinator.start();
    const focus = new AbortController(), listener = vi.fn();
    const observing = h.coordinator.projectionAPI.observe(null, listener, { signal: focus.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.attention).toHaveBeenCalledTimes(1); expect(h.observe).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) h.send({ stream: 'progress', sequence: i });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.attention).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledTimes(50);
    for (let i = 1; i <= 50; i++) h.send({ stream: 'durable', cursor: i });
    await vi.advanceTimersByTimeAsync(ATTENTION_READ_INTERVAL_MS);
    expect(h.attention).toHaveBeenCalledTimes(2);
    focus.abort(); await observing; h.coordinator.close();
  });
  it('coalesces dirty while in flight and ignores a response after close', async () => {
    vi.useFakeTimers(); let resolve!: (value: ThreadAttentionSnapshot) => void;
    const h = harness(() => new Promise(done => { resolve = done; })); h.coordinator.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i < 10; i++) h.send({ cursor: i });
    await vi.advanceTimersByTimeAsync(1000); expect(h.attention).toHaveBeenCalledTimes(1);
    resolve(snapshot(10)); await vi.advanceTimersByTimeAsync(0);
    expect(h.attention).toHaveBeenCalledTimes(2);
    const last = h.coordinator.getSnapshot(); h.coordinator.close(); resolve(snapshot(100)); await Promise.resolve();
    expect(h.coordinator.getSnapshot()).toBe(last);
  });
  it('rejects a read from before an observed epoch change', async () => {
    vi.useFakeTimers(); let resolve!: (value: ThreadAttentionSnapshot) => void;
    const h = harness(() => new Promise(done => { resolve = done; })); h.coordinator.start();
    h.send({ stream: 'durable', kernelEpoch: 'old', cursor: 1 });
    await vi.advanceTimersByTimeAsync(0);
    h.send({ stream: 'durable', kernelEpoch: 'new', cursor: 1 });
    resolve(snapshot(5, 1)); await vi.advanceTimersByTimeAsync(0);
    expect(h.coordinator.getSnapshot().snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(ATTENTION_READ_INTERVAL_MS);
    resolve(snapshot(2, 2)); await vi.advanceTimersByTimeAsync(0);
    expect(h.coordinator.getSnapshot().snapshot?.epoch).toBe(2); h.coordinator.close();
  });
  it('keeps last-known facts on disconnect and rejects focus observation before reconnect', async () => {
    vi.useFakeTimers(); const h = harness(); h.coordinator.start(); await vi.advanceTimersByTimeAsync(0);
    const focus = new AbortController(); const failed = h.coordinator.projectionAPI.observe(null, () => {}, { signal: focus.signal }).catch(() => 'failed');
    h.disconnect(); await Promise.resolve();
    expect(await failed).toBe('failed'); expect(h.coordinator.getSnapshot().health).toBe('unknown');
    expect(h.coordinator.getSnapshot().snapshot).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000); expect(h.observe).toHaveBeenCalledTimes(2);
    h.coordinator.close();
  });
});

it('rejects a lower Catalog epoch within one endpoint generation without presenting zero requests', async () => {
  vi.useFakeTimers(); let value = snapshot(50, 3);
  const h = harness(async () => value); h.coordinator.start(); await vi.advanceTimersByTimeAsync(0);
  value = snapshot(1, 2); h.coordinator.refresh(); await vi.advanceTimersByTimeAsync(ATTENTION_READ_INTERVAL_MS);
  expect(h.coordinator.getSnapshot().health).toBe('unknown');
  expect(h.coordinator.getSnapshot().snapshot?.epoch).toBe(3);
  h.coordinator.close();
});

it('does not let a late successful compact read hide a known disconnected stream', async () => {
  vi.useFakeTimers(); let resolve!: (value: ThreadAttentionSnapshot) => void;
  const h = harness(() => new Promise(done => { resolve = done; })); h.coordinator.start();
  await vi.advanceTimersByTimeAsync(0); h.disconnect(); await Promise.resolve();
  resolve(snapshot()); await Promise.resolve(); await Promise.resolve();
  expect(h.coordinator.getSnapshot().health).toBe('unknown');
  expect(h.coordinator.getSnapshot().snapshot).not.toBeNull();
  h.coordinator.close();
});
