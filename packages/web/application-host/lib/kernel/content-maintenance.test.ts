import { afterEach, expect, it, vi } from 'vitest';
import { createContentMaintenance } from './content-maintenance.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { AgentRuntimeStreamEvent, ContentCollectionReport } from './protocol.generated.js';
import { KERNEL_PROTOCOL_VERSION } from './protocol.generated.js';

afterEach(() => vi.useRealTimers());
const report = (extra: Partial<ContentCollectionReport> = {}): ContentCollectionReport => ({
  status: 'completed', phase: 'sweep', removedObjects: 0, removedBytes: 0, removedStagingFiles: 0, reason: null, ...extra,
});
function fixture(releaseDeletedResources?:()=>Promise<{pending:boolean}>, releaseCollectedResources?:()=>Promise<void|{pending:boolean}>, retryCollectedResources?:()=>Promise<void|{pending:boolean}>) {
  vi.useFakeTimers();
  let event: (value: AgentRuntimeStreamEvent) => void = () => {};
  const collectContent = vi.fn<AgentRuntimeClient['collectContent']>().mockResolvedValue(report());
  const removed = vi.fn();
  const runtime = { collectContent, threads: vi.fn<AgentRuntimeClient['threads']>().mockResolvedValue([]),
    onEvent: (listener: typeof event) => { event = listener; return removed; },
    onReady: () => removed, onExit: () => removed };
  const onError = vi.fn();
  const maintenance = createContentMaintenance({ runtime, onError,...(releaseDeletedResources?{releaseDeletedResources}:{}), ...(releaseCollectedResources ? { releaseCollectedResources } : {}), ...(retryCollectedResources ? { retryCollectedResources } : {}) });
  return { maintenance, collectContent, onError, removed,
    activity: () => event({ v: KERNEL_PROTOCOL_VERSION, kind: 'runtime-event', kernelEpoch: 'test', stream: 'durable', cursor: 1 }) };
}

it('coalesces deletion requests and resumes after original execution produces its completion event', async () => {
  const f = fixture();
  f.collectContent.mockResolvedValueOnce(report({ pendingDeletedThreads: 1 }));
  f.maintenance.request(); f.maintenance.request();
  await vi.runOnlyPendingTimersAsync();
  expect(f.collectContent).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.collectContent).toHaveBeenCalledTimes(1);
  f.activity(); await vi.runOnlyPendingTimersAsync();
  expect(f.collectContent).toHaveBeenCalledTimes(2);
  f.activity(); await vi.runOnlyPendingTimersAsync();
  expect(f.collectContent).toHaveBeenCalledTimes(2);
  await f.maintenance.dispose();
  expect(f.removed).toHaveBeenCalledTimes(3);
});

it('retries pending source ownership only on the actual resource idle wake after history collection completes',async()=>{
  const release=vi.fn().mockResolvedValueOnce({pending:true}).mockResolvedValue({pending:false});
  const f=fixture(release);await vi.runOnlyPendingTimersAsync();
  expect(release).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);expect(release).toHaveBeenCalledTimes(1);
  f.maintenance.resourceIdle();await vi.runOnlyPendingTimersAsync();expect(release).toHaveBeenCalledTimes(2);
  f.maintenance.resourceIdle();await vi.runOnlyPendingTimersAsync();expect(release).toHaveBeenCalledTimes(2);
  await f.maintenance.dispose();
});

it('retries busy content readers without requiring an execution event and cancels maintenance at shutdown', async () => {
  const f = fixture();
  f.collectContent.mockResolvedValueOnce(report({ status: 'deferred', phase: 'admission' }));
  f.maintenance.request(); await vi.runOnlyPendingTimersAsync();
  await vi.advanceTimersByTimeAsync(251);
  expect(f.collectContent).toHaveBeenCalledTimes(2);
  f.maintenance.request(); await f.maintenance.dispose();
  await vi.runOnlyPendingTimersAsync();
  expect(f.collectContent).toHaveBeenCalledTimes(2);
  expect(f.onError).not.toHaveBeenCalled();
});


it('releases UI assets only after successful native metadata retirement in the same maintenance pass', async () => {
  const events: string[] = [];
  const before = vi.fn(async () => { events.push('source cleanup'); return { pending: false }; });
  const after = vi.fn(async () => { events.push('ui cleanup'); });
  const f = fixture(before, after);
  f.collectContent.mockImplementation(async () => { events.push('native retirement'); return report(); });
  await vi.runOnlyPendingTimersAsync();
  expect(events).toEqual(['source cleanup', 'native retirement', 'ui cleanup']);
  f.collectContent.mockResolvedValueOnce(report({ status: 'failed' }));
  f.maintenance.request(); await vi.runOnlyPendingTimersAsync();
  expect(after).toHaveBeenCalledTimes(1);
  expect(f.onError).toHaveBeenCalledTimes(1);
  await f.maintenance.dispose();
});


it('retries durable UI physical cleanup without restarting or requiring a new conversation event', async () => {
  const cleanup = vi.fn().mockResolvedValueOnce({ pending: true }).mockResolvedValueOnce({ pending: true }).mockResolvedValue({ pending: false });
  const f = fixture(undefined, cleanup, cleanup);
  await vi.runOnlyPendingTimersAsync(); expect(cleanup).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999); expect(cleanup).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2); expect(cleanup).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999); expect(cleanup).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2); expect(cleanup).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60_000); expect(cleanup).toHaveBeenCalledTimes(3);
  expect(f.collectContent).toHaveBeenCalledTimes(1);
  await f.maintenance.dispose();
});


it('keeps the original cleanup retry obligation across a transient RPC failure', async () => {
  const cleanup = vi.fn().mockResolvedValueOnce({ pending: true }).mockRejectedValueOnce(new Error('temporary transport failure')).mockResolvedValue({ pending: false });
  const f = fixture(undefined, cleanup, cleanup);
  await vi.runOnlyPendingTimersAsync();
  await vi.advanceTimersByTimeAsync(1001); expect(cleanup).toHaveBeenCalledTimes(2);
  expect(f.onError).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2001); expect(cleanup).toHaveBeenCalledTimes(3);
  expect(f.collectContent).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000); expect(cleanup).toHaveBeenCalledTimes(3);
  await f.maintenance.dispose();
});

it('repeats an uncertain full UI sweep before narrowing later retries to physical cleanup receipts', async () => {
  const full = vi.fn().mockRejectedValueOnce(new Error('response lost during record sweep')).mockResolvedValue({ pending: true });
  const retry = vi.fn().mockResolvedValue({ pending: false });
  const f = fixture(undefined, full, retry);
  await vi.runOnlyPendingTimersAsync(); expect(f.onError).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1001); expect(full).toHaveBeenCalledTimes(2);
  expect(retry).not.toHaveBeenCalled(); expect(f.collectContent).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2001); expect(retry).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000); expect(full).toHaveBeenCalledTimes(2); expect(retry).toHaveBeenCalledTimes(1);
  await f.maintenance.dispose();
});


it('never reuses a failed native collection when a prior UI cleanup is still pending', async () => {
  const full = vi.fn().mockResolvedValueOnce({ pending: true }).mockResolvedValue({ pending: false });
  const retry = vi.fn().mockResolvedValue({ pending: false });
  const f = fixture(undefined, full, retry);
  await vi.runOnlyPendingTimersAsync(); expect(full).toHaveBeenCalledTimes(1);
  f.collectContent.mockResolvedValueOnce(report({ status: 'failed' }));
  f.maintenance.request(); await vi.advanceTimersByTimeAsync(1);
  expect(f.collectContent).toHaveBeenCalledTimes(2); expect(full).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1001);
  expect(f.collectContent).toHaveBeenCalledTimes(3); expect(full).toHaveBeenCalledTimes(2);
  expect(retry).not.toHaveBeenCalled();
  await f.maintenance.dispose();
});
