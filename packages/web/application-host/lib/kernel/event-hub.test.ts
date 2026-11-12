import { describe, expect, it, vi } from 'vitest';
import { ThreadEventHub } from './event-hub.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { KERNEL_PROTOCOL_VERSION, type AgentRuntimeStreamEvent, type RuntimeEvent } from './protocol.generated.js';
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const log: RuntimeEvent[] = [];
  let notify: (event: AgentRuntimeStreamEvent) => void = () => {};
  let exited: (error: Error) => void = () => {};
  const owners: Record<string, string | null> = { a: 'alice', b: 'bob', public: null };
  const runtime = {
    status: vi.fn(async () => ({ eventCursor: log.at(-1)?.cursor ?? 0 })),
    onEvent(listener: typeof notify) { notify = listener; return () => { notify = () => {}; }; },
    onExit(listener: typeof exited) { exited = listener; return () => { exited = () => {}; }; },
    events: vi.fn(async (cursor: number, limit: number, _signal?: AbortSignal, principal?: string | null) =>
      log.filter(event => event.cursor > cursor && (principal === undefined || event.thread_id && (owners[event.thread_id] === null || owners[event.thread_id] === principal))).slice(0, limit)),
    ownershipResolve: vi.fn(async ({ threads }: { threads: string[] }) => ({ threads: threads.map(id => ({ id, principalId: owners[id] ?? null })), runs: [], operations: [], inputs: [] })),
  };
  const hub = new ThreadEventHub(runtime as unknown as AgentRuntimeClient);
  const append = (thread: string, kind = 'history.appended') => {
    const event: RuntimeEvent = { cursor: log.length + 1, thread_id: thread, branch_id: `${thread}-main`, subject: `${thread}-main`, revision: 0, kind, data: {} };
    log.push(event); return event;
  };
  return { runtime, hub, log, append, notify: (event: AgentRuntimeStreamEvent) => notify(event), exit: () => exited(new Error('kernel replaced')) };
}
const hint = (cursor: number): AgentRuntimeStreamEvent => ({ v: KERNEL_PROTOCOL_VERSION, kind: 'runtime-event', stream: 'durable', kernelEpoch: 'epoch', cursor });
const progress = (threadId: string, sequence = 1): AgentRuntimeStreamEvent => ({ v: KERNEL_PROTOCOL_VERSION, kind: 'runtime-event', stream: 'progress', kernelEpoch: 'epoch', threadId, branchId: `${threadId}-main`, runId: 'run', requestId: 'request', streamId: 'stream', sequence, event: { delta: 'token' } });

describe('Host event fan-out', () => {
  it('reads a durable batch once for many subscribers and preserves principal and progress interests', async () => {
    const f = fixture();
    const alice = vi.fn((_event: unknown) => true), bob = vi.fn((_event: unknown) => true), observer = vi.fn((_event: unknown) => true), failure = vi.fn();
    const closes = [f.hub.subscribe(0, 'alice', alice, failure, ['a']), f.hub.subscribe(0, 'bob', bob, failure, ['b']),
      f.hub.subscribe(0, undefined, observer, failure, [])];
    await settle(); await settle(); f.runtime.events.mockClear();
    const a = f.append('a'), b = f.append('b'), pub = f.append('public');
    f.notify(hint(pub.cursor));
    await settle(); await settle();
    expect(f.runtime.events).toHaveBeenCalledTimes(1);
    expect(alice.mock.calls.map(call => call[0])).toEqual([a, pub]);
    expect(bob.mock.calls.map(call => call[0])).toEqual([b, pub]);
    expect(observer).toHaveBeenCalledTimes(3);
    f.notify(progress('a')); f.notify(progress('b'));
    await settle();
    expect(alice).toHaveBeenCalledTimes(3); expect(bob).toHaveBeenCalledTimes(3); expect(observer).toHaveBeenCalledTimes(3);
    expect(failure).not.toHaveBeenCalled(); closes.forEach(close => close());
  });
  it('does not reset on a stale durable hint when its read already saw newer commits', async () => {
    const f = fixture(), emit = vi.fn((_event: unknown) => true);
    const close = f.hub.subscribe(0, undefined, emit, vi.fn()); await settle();
    f.append('a'); f.append('a'); f.notify(hint(1)); await settle();
    f.notify(hint(1)); await settle();
    expect(emit).toHaveBeenCalledTimes(2); close();
  });
  it('backfills a late subscriber without forcing current observers to replay', async () => {
    const f = fixture();
    for (let n = 0; n < 4200; n++) f.append(n % 2 ? 'a' : 'b');
    const first = vi.fn((_event: unknown) => true), late = vi.fn((_event: unknown) => true);
    const close = f.hub.subscribe(0, undefined, first, vi.fn());
    await settle(); await settle();
    expect(first).toHaveBeenCalledTimes(4200);
    const stop = f.hub.subscribe(0, 'alice', late, vi.fn());
    await settle(); await settle();
    expect(late).toHaveBeenCalledTimes(2100); expect(first).toHaveBeenCalledTimes(4200);
    expect(late.mock.calls.map(call => (call[0] as RuntimeEvent).cursor)).toEqual(f.log.filter(event => event.thread_id === 'a').map(event => event.cursor));
    close(); stop();
  });
  it('signals reset for a restored Catalog and isolates slow or failed subscribers', async () => {
    const f = fixture(), ready = vi.fn((_event: unknown) => true), slow = vi.fn((_event: unknown) => false), fail = vi.fn();
    const close = f.hub.subscribe(100, undefined, ready, fail);
    await settle();
    expect(ready).toHaveBeenCalledWith({ stream: 'resync', cursor: 0, reason: 'cursor-reset' });
    f.hub.subscribe(0, undefined, slow, fail);
    f.append('a'); f.notify(hint(1)); await settle();
    f.append('a'); f.notify(hint(2)); await settle();
    expect(slow).toHaveBeenCalledTimes(1); expect(ready).toHaveBeenCalledTimes(3);
    f.exit(); expect(fail).toHaveBeenCalledTimes(1); close();
  });
  it('changes interests on the live connection without losing ordering or expanding principal access', async () => {
    const f = fixture(), alice = vi.fn((_event: unknown) => true), bob = vi.fn((_event: unknown) => true);
    const close = f.hub.subscribe(0, 'alice', alice, vi.fn(), ['a'], 'live');
    const stop = f.hub.subscribe(0, 'bob', bob, vi.fn(), ['b'], 'live');
    await settle();
    f.notify(progress('a', 1));
    f.hub.updateInterests('live', 'alice', ['a', 'b']);
    f.notify(progress('a', 2)); f.notify(progress('b', 3));
    await settle();
    expect(alice.mock.calls.map(([event]) => (event as { sequence: number }).sequence)).toEqual([1, 2]);
    expect(bob.mock.calls.map(([event]) => (event as { sequence: number }).sequence)).toEqual([3]);
    expect(() => f.hub.updateInterests('live', 'mallory', null)).toThrow('no longer active');
    f.hub.updateInterests('live', 'alice', []); f.notify(progress('a', 4)); await settle();
    expect(alice).toHaveBeenCalledTimes(2);
    f.hub.updateInterests('live', 'alice', null); f.notify(progress('a', 5)); await settle();
    expect(alice).toHaveBeenCalledTimes(3);
    close(); stop();
    expect(() => f.hub.updateInterests('live', 'alice', null)).toThrow('no longer active');
  });
  it('resets a late restored cursor even while another observer already owns the live reader', async () => {
    const f = fixture(), live = vi.fn((_event: unknown) => true), late = vi.fn((_event: unknown) => true);
    const close = f.hub.subscribe(0, undefined, live, vi.fn()); await settle();
    f.append('a'); f.notify(hint(1)); await settle();
    const stop = f.hub.subscribe(100, undefined, late, vi.fn()); await settle();
    expect(late).toHaveBeenCalledWith({ stream: 'resync', cursor: 1, reason: 'cursor-reset' });
    const next = f.append('a'); f.notify(hint(2)); await settle();
    expect(late).toHaveBeenLastCalledWith(next); expect(live).toHaveBeenCalledTimes(2);
    close(); stop();
  });

  it('shares an unresolved ownership read so a later token cannot overtake the original token', async () => {
    const f = fixture(), emit = vi.fn((_event: unknown) => true);
    let release!: (value: Awaited<ReturnType<typeof f.runtime.ownershipResolve>>) => void;
    f.runtime.ownershipResolve.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const close = f.hub.subscribe(0, 'alice', emit, vi.fn(), ['a']); await settle();
    f.notify(progress('a', 1)); await settle(); // First ownership read is already in flight.
    f.notify(progress('a', 2)); f.notify(progress('a', 3)); await settle();
    expect(f.runtime.ownershipResolve).toHaveBeenCalledTimes(1); expect(emit).not.toHaveBeenCalled();
    release({ threads: [{ id: 'a', principalId: 'alice' }], runs: [], operations: [], inputs: [] }); await settle();
    expect(emit.mock.calls.map(([event]) => (event as { sequence: number }).sequence)).toEqual([1, 2, 3]);
    close();
  });

});
