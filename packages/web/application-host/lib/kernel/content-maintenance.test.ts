import { afterEach, expect, it, vi } from 'vitest';
import { createContentMaintenance } from './content-maintenance.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { AgentRuntimeStreamEvent, ContentCollectionReport } from './protocol.generated.js';

afterEach(() => vi.useRealTimers());
const report = (extra: Partial<ContentCollectionReport> = {}): ContentCollectionReport => ({
  status: 'completed', phase: 'sweep', removedObjects: 0, removedBytes: 0, removedStagingFiles: 0, reason: null, ...extra,
});
function fixture() {
  vi.useFakeTimers();
  let event: (value: AgentRuntimeStreamEvent) => void = () => {};
  const collectContent = vi.fn<AgentRuntimeClient['collectContent']>().mockResolvedValue(report());
  const removed = vi.fn();
  const runtime = { collectContent, threads: vi.fn<AgentRuntimeClient['threads']>().mockResolvedValue([]),
    onEvent: (listener: typeof event) => { event = listener; return removed; },
    onReady: () => removed, onExit: () => removed };
  const onError = vi.fn();
  const maintenance = createContentMaintenance({ runtime, onError });
  return { maintenance, collectContent, onError, removed,
    activity: () => event({ v: 54, kind: 'runtime-event', kernelEpoch: 'test', stream: 'durable', cursor: 1 }) };
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
