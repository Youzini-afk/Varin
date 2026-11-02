import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createEnvironmentObservationCoordinator, type ObservationPort } from './coordinator.js';
import { createEnvironmentObservationRuntime } from './runtime.js';
import { KernelRequestError } from '../kernel/kernel-error.js';
import type { ContextObservationSource, EnvironmentObservationCapture, EnvironmentObservationReceipt } from '../kernel/protocol.generated.js';

const owner = (id = 'a'): ContextObservationSource => ({ threadId: `thread:${id}`, branchId: `branch:${id}`, runId: `run:${id}`,
  anchorId: `input:${id}`, epoch: 1, source: { resource_owner: { kind: 'local' }, mode: 'live_root', workspace_id: `ws:${id}`,
    execution_workspace_id: `ws:${id}`, branch_id: null, revision: null,
    live_root: { hostId: 'host', rootId: `root:${id}`, canonicalRoot: `/workspace/${id}` } } });
const capture = (id = 'save:1'): EnvironmentObservationCapture => ({ captureId: id,
  event: { kind: 'edit', at: 10, source: 'user', body: { path: 'file.md', kind: 'modified' } } });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const receipt = (item: EnvironmentObservationCapture, cursor = 1): EnvironmentObservationReceipt => ({ captureId: item.captureId,
  id: `native:${item.captureId}`, cursor, rawDigest: `sha256-${createHash('sha256').update(JSON.stringify(canonical(item.event))).digest('hex')}`,
  rawRef: 'content:raw', representation: { version: 1, digest: 'projection', bytes: 100, bodyBudgetBytes: 8192, omitted: false },
  admission: { cursor: cursor + 100, state: 'queued' } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const fixture = (owners = [owner()]) => {
  const port = { sources: vi.fn(async (_runId?: string) => owners),
    capture: vi.fn(async (_owner: ContextObservationSource, captures: EnvironmentObservationCapture[]) => captures.map((item, index) => receipt(item, index + 1))),
    receipt: vi.fn(async (_owner: ContextObservationSource, _captureIds: string[]): Promise<EnvironmentObservationReceipt[]> => []),
    snapshot: vi.fn(async (_runId: string) => ({ cursor: 7 })) } satisfies ObservationPort;
  return port;
};

it('coalesces a synchronous twenty-save burst into one source read and one exact native batch', async () => {
  const port = fixture(); const runtime = createEnvironmentObservationRuntime({ port });
  for (let index = 0; index < 20; index++) runtime.observeDocumentMutation({ workspaceId: 'ws:a', resourceId: 'report.md',
    kind: 'modified', owner: { kind: 'web-route', id: 'editor' }, changeId: `save:${index}`, observedAt: index });
  await vi.waitFor(() => expect(port.capture).toHaveBeenCalledOnce());
  const captures = port.capture.mock.calls[0]![1];
  expect(port.sources).toHaveBeenCalledOnce(); expect(captures).toHaveLength(20);
  expect(new Set(captures.map(item => item.captureId)).size).toBe(20);
  expect(captures.map(item => item.event.at)).toEqual(Array.from({ length: 20 }, (_, index) => index));
  expect(runtime.inspect()[0]).toMatchObject({ availability: 'ready', pending: [] });
  await runtime.dispose();
});

it('does not wait for unrelated source B or source A pending captures at request preparation', async () => {
  const a = owner(), b = owner('b'), gate = deferred<EnvironmentObservationReceipt[]>();
  const port = fixture([a, b]);
  port.capture.mockImplementation(async (source, captures) => source.runId === b.runId ? gate.promise : captures.map(item => receipt(item)));
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources();
  coordinator.enqueue(b, capture('b')); await vi.waitFor(() => expect(port.capture).toHaveBeenCalledOnce());
  coordinator.enqueue(a, capture('a')); await vi.waitFor(() => expect(port.capture).toHaveBeenCalledTimes(2));
  const prepared = await coordinator.prepare({ id: a.runId });
  expect(prepared.acceptedCursor).toBe(7);
  expect(prepared.sources.find(source => source.owner.runId === a.runId)?.availability).toBe('ready');
  expect(prepared.sources.find(source => source.owner.runId === b.runId)?.pending).toEqual(['b']);
  gate.resolve([receipt(capture('b'))]); await coordinator.close();
});

it('cancels only a preparation wait, retaining the original capture and its successful receipt', async () => {
  const port = fixture(), held = deferred<EnvironmentObservationReceipt[]>(), snapshot = deferred<{ cursor: number }>();
  port.capture.mockImplementation(() => held.promise); port.snapshot.mockImplementation(() => snapshot.promise);
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources(); coordinator.enqueue(owner(), capture());
  await vi.waitFor(() => expect(port.capture).toHaveBeenCalledOnce());
  const controller = new AbortController(); const preparing = coordinator.prepare({ id: 'run:a' }, controller.signal);
  const rejected = expect(preparing).rejects.toThrow(); controller.abort(); await rejected;
  expect(coordinator.inspect()[0]?.pending).toEqual(['save:1']);
  held.resolve([receipt(capture())]); snapshot.resolve({ cursor: 9 }); await coordinator.close();
  expect(coordinator.inspect()[0]).toMatchObject({ availability: 'ready', pending: [] });
  expect(port.capture).toHaveBeenCalledOnce();
});

it('resolves a lost acknowledgement by original receipt without replaying or rebinding its source', async () => {
  const original = owner(), port = fixture([original]), captured = capture();
  port.capture.mockRejectedValue(new Error('connection lost after commit'));
  port.receipt.mockResolvedValue([receipt(captured)]);
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources(); coordinator.enqueue(original, captured);
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.unknown).toEqual(['save:1']));
  port.sources.mockResolvedValue([{ ...original, epoch: 2 }]); await coordinator.sources(); coordinator.wake();
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.pending).toEqual([]));
  expect(port.capture).toHaveBeenCalledOnce();
  expect(port.receipt).toHaveBeenCalledWith(original, ['save:1']); await coordinator.close();
});

it('looks up then retries the frozen body once per wake, renewing only a confirmed dispatch epoch', async () => {
  const original = owner(), port = fixture([original]), input = capture();
  port.capture.mockRejectedValue(new Error('unknown transport outcome'));
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources(); coordinator.enqueue(original, input);
  input.event.at = 999; // The producer no longer owns the queued envelope.
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.unknown).toHaveLength(1));
  port.sources.mockResolvedValue([{ ...original, epoch: 2 }]); await coordinator.sources(); coordinator.wake();
  await vi.waitFor(() => expect(port.capture).toHaveBeenCalledTimes(2));
  expect(port.receipt).toHaveBeenCalledOnce();
  expect(port.capture.mock.calls[1]).toEqual([{ ...original, epoch: 2 }, [capture()]]);
  await new Promise(resolve => setImmediate(resolve)); expect(port.capture).toHaveBeenCalledTimes(2);
  port.capture.mockImplementation(async (_source, captures) => captures.map(item => receipt(item)));
  coordinator.wake(); await vi.waitFor(() => expect(coordinator.inspect()[0]?.pending).toEqual([]));
  expect(port.receipt).toHaveBeenCalledTimes(2); await coordinator.close();
});

it('keeps the old source unknown after a source switch, without publishing its bytes to the new source', async () => {
  const original = owner(), port = fixture([original]); port.capture.mockRejectedValue(new Error('lost'));
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources(); coordinator.enqueue(original, capture());
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.unknown).toHaveLength(1));
  const changed = owner('new'); port.sources.mockResolvedValue([changed]); await coordinator.sources(); coordinator.wake();
  await vi.waitFor(() => expect(port.receipt).toHaveBeenCalledOnce());
  expect(port.capture).toHaveBeenCalledOnce();
  expect(coordinator.inspect(original)[0]?.unknown).toEqual(['save:1']);
  await coordinator.close(); expect(port.capture).toHaveBeenCalledOnce();
});

it('preserves uncertainty if an exact retry is rejected while its original submission may still commit', async () => {
  const port = fixture(); port.capture.mockRejectedValueOnce(new Error('lost')).mockRejectedValue(
    new KernelRequestError({ code: 'source-stale', message: 'epoch advanced' }, 'runtime.context.observations.capture', 'response'));
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources(); coordinator.enqueue(owner(), capture());
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.unknown).toHaveLength(1)); coordinator.wake();
  await vi.waitFor(() => expect(port.capture).toHaveBeenCalledTimes(2));
  expect(coordinator.inspect()[0]).toMatchObject({ unknown: ['save:1'], gap: null });
  port.receipt.mockResolvedValue([receipt(capture())]); await coordinator.close();
});

it('uses bounded fair batches and never duplicates same-ID pending captures', async () => {
  const a = owner(), b = owner('b'), port = fixture([a, b]);
  const coordinator = createEnvironmentObservationCoordinator({ port, budgets: { batchCaptures: 1, concurrentSources: 1 } });
  await coordinator.sources();
  for (let index = 0; index < 3; index++) coordinator.enqueue(a, capture(`a:${index}`));
  coordinator.enqueue(b, capture('b')); coordinator.enqueue(a, capture('a:0'));
  expect(() => coordinator.enqueue(a, { ...capture('a:0'), event: { ...capture().event, at: 44 } })).toThrow('conflicts');
  await coordinator.close();
  expect(port.capture.mock.calls.map(([source]) => source.runId)).toEqual(['run:a', 'run:b', 'run:a', 'run:a']);
});

it('reports budget gaps instead of retaining unbounded bodies and follows owned work through close', async () => {
  const port = fixture(), gate = deferred<EnvironmentObservationReceipt[]>(); port.capture.mockImplementation(() => gate.promise);
  const coordinator = createEnvironmentObservationCoordinator({ port, budgets: { sourceCaptures: 2 } }); await coordinator.sources();
  coordinator.enqueue(owner(), capture('one')); coordinator.enqueue(owner(), capture('two'));
  expect(coordinator.enqueue(owner(), capture('three'))).toEqual({ captureId: 'three', state: 'gap', reason: 'queue_budget' });
  let closed = false; const closing = coordinator.close().then(result => { closed = true; return result; });
  await vi.waitFor(() => expect(port.capture).toHaveBeenCalledOnce()); expect(closed).toBe(false);
  gate.resolve([receipt(capture('one')), receipt(capture('two'), 2)]);
  expect(await closing).toMatchObject([{ pending: [], availability: 'gap', gap: { count: 1, firstCaptureId: 'three' } }]);
});

it('keeps mismatching receipt bytes unknown rather than acknowledging the wrong event', async () => {
  const port = fixture(); port.capture.mockResolvedValue([{ ...receipt(capture()), rawDigest: 'wrong' }]);
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources(); coordinator.enqueue(owner(), capture());
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.unknown).toEqual(['save:1']));
  port.receipt.mockResolvedValue([receipt(capture())]); await coordinator.close();
  expect(coordinator.inspect()[0]?.pending).toEqual([]);
});

it('retries a known not-dispatched capture under a renewed same-source fence without a receipt lookup', async () => {
  const port = fixture(); port.capture.mockRejectedValueOnce(new KernelRequestError(
    { code: 'disconnected', message: 'not dispatched' }, 'runtime.context.observations.capture', 'not_dispatched'));
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources(); coordinator.enqueue(owner(), capture());
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.availability).toBe('unavailable'));
  port.sources.mockResolvedValue([{ ...owner(), epoch: 3 }]); await coordinator.sources(); coordinator.wake();
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.pending).toEqual([]));
  expect(port.receipt).not.toHaveBeenCalled(); expect(port.capture.mock.calls[1]?.[0].epoch).toBe(3);
  expect(port.capture.mock.calls[1]?.[1]).toEqual([capture()]); await coordinator.close();
});

it('retains a native storage-error response for receipt lookup and recovery instead of creating a permanent gap', async () => {
  const port = fixture(); port.capture.mockRejectedValueOnce(new KernelRequestError(
    { code: 'storage-error', message: 'original ContentStore write unavailable' }, 'runtime.context.observations.capture', 'response'));
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources(); coordinator.enqueue(owner(), capture());
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.unknown).toEqual(['save:1']));
  expect(coordinator.inspect()[0]?.gap).toBeNull(); coordinator.wake();
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.pending).toEqual([]));
  expect(port.receipt).toHaveBeenCalledOnce(); expect(port.capture.mock.calls[1]?.[1]).toEqual([capture()]); await coordinator.close();
});

it('retires inactive settled source metadata into one workspace coverage summary', async () => {
  const port = fixture(); const coordinator = createEnvironmentObservationCoordinator({ port, budgets: { sourceBytes: 1 } });
  for (let index = 0; index < 20; index++) {
    const current = { ...owner(), runId: `run:${index}`, anchorId: `input:${index}` };
    port.sources.mockResolvedValue([current]); await coordinator.sources(); coordinator.enqueue(current, capture(`dropped:${index}`));
  }
  expect(coordinator.inspect()).toHaveLength(1);
  expect(coordinator.retiredGaps()).toEqual([{ workspaceId: 'ws:a', count: 19, firstCaptureId: 'dropped:0', lastCaptureId: 'dropped:18' }]);
  expect((await coordinator.prepare({ id: 'run:19' })).retiredGaps).toHaveLength(1); await coordinator.close();
});

it('retains a typed stale dispatch fence and retries only after the same original source is refreshed', async () => {
  const port = fixture(); port.capture.mockRejectedValueOnce(new KernelRequestError(
    { code: 'context-observation-stale-epoch', message: 'original source dispatch epoch advanced', retryable: true },
    'runtime.context.observations.capture', 'response'));
  const coordinator = createEnvironmentObservationCoordinator({ port }); await coordinator.sources(); coordinator.enqueue(owner(), capture());
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.availability).toBe('unavailable'));
  expect(coordinator.inspect()[0]?.gap).toBeNull(); port.sources.mockResolvedValue([{ ...owner(), epoch: 9 }]);
  await coordinator.prepare({ id: 'run:a' });
  await vi.waitFor(() => expect(coordinator.inspect()[0]?.pending).toEqual([]));
  expect(port.capture.mock.calls[1]).toEqual([{ ...owner(), epoch: 9 }, [capture()]]);
  expect(port.receipt).not.toHaveBeenCalled(); await coordinator.close();
});
