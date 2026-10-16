import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
import { FileObservationService } from './file-observation-service.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { DocumentsFileObservationOwner } from './file-observation-owner.js';
import type { AgentRuntimeStreamEvent, FileObservationBinding, FollowupFileObserveParams, FollowupFileObserveResult,
  FollowupFileReleaseParams, FollowupFileReleaseResult, Followup } from './protocol.generated.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function binding(id = 'original'): FileObservationBinding {
  return { followupId: `followup:${id}`, generation: 3, sourceIndex: 0, receiptId: `receipt:${id}`,
    failureCode: null, observationRevision: 1, definitionRevision: 4, action: 'observe', watchId: 'watch-b',
    position: { sourceId: 'watch-source-b', generation: 9, sequence: 12 },
    target: { receiptId: `receipt:${id}`, followupId: `followup:${id}`, sourceIndex: 0, sourceRunId: 'run-a', threadId: 'thread-a',
      path: 'result.txt', immutable: false, physicalRoot: null,
      source: { mode: 'materialized', resource_owner: { kind: 'managed_host', hostId: 'host-b', connectionId: 'configured-b', endpointIdentity: 'b-endpoint' },
        workspace_id: 'same-workspace', execution_workspace_id: 'same-execution', branch_id: 'source-b', revision: 7,
        environment_run_id: 'original-environment', live_root: null } } };
}

/** Real scheduling consumer with controlled original Catalog/transport replies.
 * Local Documents is a tripwire: any managed has/open/close is a test failure. */
function fixture(initial = [binding()]) {
  const bindings = new Map(initial.map(value => [value.receiptId, value]));
  const reads: Array<{ input: FollowupFileObserveParams; signal: AbortSignal }> = [];
  const releases: Array<{ input: FollowupFileReleaseParams; signal: AbortSignal }> = [];
  const errors: unknown[] = [];
  let event = (_event: AgentRuntimeStreamEvent) => {};
  let exit = (_error: Error) => {};
  let ready = () => {};
  let listFailures = 0; let listings = 0; let stopped = false;
  let read: (input: FollowupFileObserveParams, signal: AbortSignal) => Promise<FollowupFileObserveResult> = async input => {
    const current = bindings.get(input.receiptId)!; current.observationRevision++;
    return { accepted: true, followup: { revision: current.definitionRevision } as Followup };
  };
  let release: (input: FollowupFileReleaseParams, signal: AbortSignal) => Promise<FollowupFileReleaseResult> = async input => {
    bindings.delete(input.receiptId); return { released: true };
  };
  const runtime = {
    onEvent(listener: typeof event) { event = listener; return () => { event = () => {}; }; },
    onExit(listener: typeof exit) { exit = listener; return () => { exit = () => {}; }; },
    onReady(listener: typeof ready) { ready = listener; return () => { ready = () => {}; }; },
    async fileFollowups(_after?: string, signal?: AbortSignal) {
      signal?.throwIfAborted(); listings++;
      if (listFailures > 0) { listFailures--; throw new Error('Catalog transport unavailable'); }
      return { bindings: structuredClone([...bindings.values()]), nextCursor: null };
    },
    async observeFileFollowup(input: FollowupFileObserveParams, signal: AbortSignal) { reads.push({ input, signal }); return read(input, signal); },
    async releaseFileFollowup(input: FollowupFileReleaseParams, signal: AbortSignal) { releases.push({ input, signal }); return release(input, signal); },
  } as unknown as AgentRuntimeClient;
  const noLocalOwner = () => { assert.fail('A must not inspect or reopen the original B watch'); };
  const owner = { has: noLocalOwner, query: noLocalOwner, stop: () => { stopped = true; } } as unknown as DocumentsFileObservationOwner;
  const service = new FileObservationService(runtime, owner, error => errors.push(error));
  return { service, bindings, reads, releases, errors, get stopped() { return stopped; }, get listings() { return listings; },
    emit() { event({ stream: 'durable' } as AgentRuntimeStreamEvent); }, exit() { exit(new Error('original epoch exited')); }, ready() { ready(); },
    failLists(count: number) { listFailures = count; }, onRead(callback: typeof read) { read = callback; }, onRelease(callback: typeof release) { release = callback; } };
}

test('managed polling keeps original keys, pauses without losing cursor, resumes immediately, and recovers on ready', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const original = binding(); const f = fixture([original]);
  try {
    await f.service.recover(); await turn(); assert.equal(f.reads.length, 1); assert.equal(f.reads[0]?.input.reopen, false);
    vi.advanceTimersByTime(999); await turn(); assert.equal(f.reads.length, 1);
    vi.advanceTimersByTime(1); await turn(); assert.equal(f.reads.length, 2);
    assert.deepEqual(f.reads.map(({ input }) => input), [1, 2].map(observationRevision => ({ followupId: original.followupId,
      generation: original.generation, sourceIndex: 0, receiptId: original.receiptId, observationRevision, reopen: false })));
    const cursor = structuredClone(original.position); original.action = 'paused'; original.definitionRevision++; f.emit(); await turn();
    f.service.changed(original.receiptId); vi.advanceTimersByTime(5_000); await turn();
    assert.equal(f.reads.length, 2); assert.deepEqual(original.position, cursor); assert.equal(f.releases.length, 0);
    original.action = 'observe'; original.definitionRevision++; f.emit(); await turn();
    assert.equal(f.reads.length, 3); assert.equal(f.reads[2]?.input.observationRevision, 3);
    f.exit(); vi.advanceTimersByTime(5_000); await turn(); assert.equal(f.reads.length, 3);
    f.ready(); await turn(); assert.equal(f.reads.length, 4); assert.equal(f.reads[3]?.input.observationRevision, 4);
    assert.equal(f.reads.every(({ input }) => input.reopen === false), true); assert.deepEqual(f.errors, []);
  } finally { await f.service.stop(); }
  vi.advanceTimersByTime(5_000); await turn(); assert.equal(f.reads.length, 4); assert.equal(f.stopped, true);
});

test('an unreachable observation never blocks other cancellation; lost and negative release replies retry the same receipt', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const unavailable = binding('unavailable'); const other = binding('other'); other.action = 'release'; const f = fixture([unavailable, other]);
  f.onRead(async (_input, signal) => new Promise<FollowupFileObserveResult>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  }));
  try {
    await f.service.recover(); await turn();
    assert.equal(f.reads.length, 1); assert.equal(f.releases.length, 1); assert.equal(f.bindings.has(other.receiptId), false);
    vi.advanceTimersByTime(5_000); await turn(); assert.equal(f.reads.length, 1);
    unavailable.action = 'release'; unavailable.definitionRevision++; let attempts = 0;
    f.onRelease(async input => {
      assert.equal(input.receiptId, unavailable.receiptId); attempts++;
      if (attempts === 1) throw new Error('B release reply lost');
      if (attempts === 2) return { released: false };
      f.bindings.delete(input.receiptId); return { released: true };
    });
    f.emit(); await turn(); assert.equal(f.reads[0]?.signal.aborted, true); assert.equal(attempts, 1);
    assert.equal(f.bindings.has(unavailable.receiptId), true);
    vi.advanceTimersByTime(1_000); await turn(); assert.equal(attempts, 2); assert.equal(f.bindings.has(unavailable.receiptId), true);
    vi.advanceTimersByTime(1_000); await turn(); assert.equal(attempts, 3); assert.equal(f.bindings.has(unavailable.receiptId), false);
    vi.advanceTimersByTime(5_000); await turn(); assert.equal(attempts, 3);
    const attemptsForReceipt = f.releases.filter(({ input }) => input.receiptId === unavailable.receiptId);
    assert.equal(attemptsForReceipt.length, 3);
    assert.deepEqual(attemptsForReceipt.map(({ input }) => input), Array(3).fill(attemptsForReceipt[0]!.input));
    assert.equal(f.errors.length, 1); assert.match(String(f.errors[0]), /reply lost/);
  } finally { await f.service.stop(); }
});

test('read and Catalog transport failures keep a recoverable wake, and disappearance cancels the old poll', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const f = fixture(); let attempts = 0;
  f.onRead(async () => {
    attempts++; if (attempts === 1) throw new Error('B temporarily disconnected');
    return { accepted: true, followup: { revision: 4 } as Followup };
  });
  try {
    await f.service.recover(); await turn(); assert.equal(attempts, 1);
    f.failLists(1); vi.advanceTimersByTime(1_000); await turn(); assert.equal(attempts, 1);
    vi.advanceTimersByTime(1_000); await turn(); assert.equal(attempts, 2);
    assert.deepEqual(f.reads[0]?.input, f.reads[1]?.input); assert.equal(f.errors.length, 2);
    f.bindings.clear(); f.emit(); await turn(); const listings = f.listings;
    vi.advanceTimersByTime(5_000); await turn(); assert.equal(attempts, 2); assert.equal(f.listings, listings);
  } finally { await f.service.stop(); }
});

test('pause, superseding generation and epoch exit abort old flights while preserving the original cursor', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const original = binding(); const f = fixture([original]);
  f.onRead(async (_input, signal) => new Promise<FollowupFileObserveResult>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  }));
  try {
    await f.service.recover(); await turn(); const position = structuredClone(original.position);
    original.action = 'paused'; original.definitionRevision++; f.emit(); await turn();
    assert.equal(f.reads[0]?.signal.aborted, true); assert.deepEqual(original.position, position);
    vi.advanceTimersByTime(5_000); await turn(); assert.equal(f.reads.length, 1);
    original.action = 'observe'; original.definitionRevision++; f.emit(); await turn(); assert.equal(f.reads.length, 2);
    original.generation++; original.definitionRevision++; f.emit(); await turn();
    assert.equal(f.reads[1]?.signal.aborted, true); assert.equal(f.reads.length, 3); assert.equal(f.reads[2]?.input.generation, original.generation);
    f.exit(); await turn(); assert.equal(f.reads[2]?.signal.aborted, true);
    vi.advanceTimersByTime(5_000); await turn(); assert.equal(f.reads.length, 3);
    f.ready(); await turn(); assert.equal(f.reads.length, 4);
    assert.deepEqual(original.position, position); assert.equal(f.releases.length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.service.stop(); }
});

test('a stable fixed source stops polling, while original diagnostics and failed releases still recover', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const original = binding(); original.target!.immutable = true; original.target!.source.mode = 'fixed_branch';
  original.watchId = null; original.position = null; const f = fixture([original]);
  try {
    await f.service.recover(); await turn(); assert.equal(f.reads.length, 1);
    const listings = f.listings; vi.advanceTimersByTime(5_000); await turn();
    assert.equal(f.reads.length, 1); assert.equal(f.listings, listings);
    original.failureCode = 'source_unavailable'; original.definitionRevision++;
    let unavailable = true;
    f.onRead(async () => {
      if (!unavailable) original.failureCode = null;
      original.observationRevision++;
      return { accepted: true, followup: { revision: original.definitionRevision } as Followup };
    });
    f.emit(); await turn(); assert.equal(f.reads.length, 2);
    unavailable = false; vi.advanceTimersByTime(1_000); await turn(); assert.equal(f.reads.length, 3);
    vi.advanceTimersByTime(5_000); await turn(); assert.equal(f.reads.length, 3);
    f.onRead(async () => { throw new Error('fixed source transport unavailable'); });
    f.service.changed(original.receiptId); await turn(); assert.equal(f.reads.length, 4);
    f.onRead(async () => ({ accepted: true, followup: { revision: original.definitionRevision } as Followup }));
    vi.advanceTimersByTime(1_000); await turn(); assert.equal(f.reads.length, 5);
    vi.advanceTimersByTime(5_000); await turn(); assert.equal(f.reads.length, 5);
    original.action = 'release'; original.definitionRevision++; let releases = 0;
    f.onRelease(async () => {
      if (++releases === 1) return { released: false };
      f.bindings.delete(original.receiptId); return { released: true };
    });
    f.emit(); await turn(); assert.equal(releases, 1);
    vi.advanceTimersByTime(1_000); await turn(); assert.equal(releases, 2);
    vi.advanceTimersByTime(5_000); await turn(); assert.equal(releases, 2);
    assert.equal(f.errors.length, 1); assert.match(String(f.errors[0]), /fixed source transport unavailable/);
  } finally { await f.service.stop(); }
});
