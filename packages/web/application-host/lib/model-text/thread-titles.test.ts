import { expect, it, vi } from 'vitest';
import { KERNEL_PROTOCOL_VERSION, type AgentRuntimeStreamEvent, type RuntimeEvent, type ThreadSummary, type ThreadTitleJob } from '../kernel/protocol.generated.js';
import { createThreadTitleService } from './thread-titles.js';
import type { ModelTextInput, ModelTextResult } from './service.js';
type Runtime = Parameters<typeof createThreadTitleService>[0]['runtime'];

function fixture() {
  const job: ThreadTitleJob = { key: 'title-check', threadId: 'thread:test', branchId: 'main', headId: 'user', checkpointId: null, activeRunId: null, rounds: 0, generation: 0, title: 'Initial request', initial: true };
  const thread = { thread_id: job.threadId, title: job.title, title_mode: 'automatic', main_branch_id: 'main', deleted_at_ms: null, parent_thread_id: null, bot_id: null,
    branches: [{ branch_id: 'main', head: 'user', active_run_id: null, latest_run: null }] } as ThreadSummary;
  let prepared = false;
  const runtime = {
    thread: vi.fn(async () => thread), threads: vi.fn(async () => [] as ThreadSummary[]),
    prepareThreadTitle: vi.fn<Runtime['prepareThreadTitle']>(async () => { if (prepared) return null; prepared = true; return job; }),
    finishThreadTitle: vi.fn(async () => true),
    historyPage: vi.fn(async () => ({ head: 'user', previous: null, items: [{ id: 'user', run_id: 'run', source: 'user', parent: null, thread_id: job.threadId, content_ref: 'content' }] })),
    historyItem: vi.fn(async () => ({ id: 'user', source: 'user', content: { text: '分析启动流程' } })),
    context: vi.fn(async () => null), run: vi.fn(async () => ({ state: 'completed' })),
    status: vi.fn(async () => ({ eventCursor: 0 })), events: vi.fn<Runtime['events']>(async () => []),
    onEvent: vi.fn<Runtime['onEvent']>(() => () => {}), onReady: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}),
  };
  const modelText = { generate: vi.fn(async (_input: ModelTextInput): Promise<ModelTextResult> => ({ text: '启动流程分析', requestId: 'request', providerId: 'auxiliary', modelId: 'configured' })),
    original: vi.fn(async () => null as { purpose: string; prompt: string } | null),
    resumeUnsent: vi.fn(async () => null as ModelTextResult | null) };
  const onError = vi.fn();
  const options = { runtime: runtime as unknown as Parameters<typeof createThreadTitleService>[0]['runtime'], modelText, readSettings: async () => ({ titleUpdateInterval: 50 }), onError };
  return { job, thread, runtime, modelText, onError, options };
}

it('coalesces concurrent checks and uses the interval only in scheduling, not prompt assembly', async () => {
  const f = fixture(), owner = createThreadTitleService(f.options);
  owner.schedule(f.thread); owner.schedule(f.thread);
  await vi.waitFor(() => expect(f.runtime.finishThreadTitle).toHaveBeenCalledOnce());
  expect(f.runtime.prepareThreadTitle).toHaveBeenCalledWith(expect.objectContaining({ interval: 50, initial: true }), expect.any(AbortSignal));
  expect(f.modelText.generate).toHaveBeenCalledOnce();
  expect(f.modelText.generate.mock.calls[0]![0].prompt).toContain('USER\n分析启动流程');
  expect(f.modelText.generate.mock.calls[0]![0].prompt).not.toContain('ignored input');
  expect(f.runtime.finishThreadTitle).toHaveBeenCalledWith({ job: f.job, title: '启动流程分析' }, expect.any(AbortSignal));
  await owner.close(); expect(f.onError).not.toHaveBeenCalled();
});

it('resumes the original auxiliary receipt at its stored cut after restart without rebuilding its input', async () => {
  const f = fixture(); f.runtime.threads.mockResolvedValue([f.thread]);
  f.modelText.original.mockResolvedValue({ purpose: 'title', prompt: 'Original frozen exchanges' });
  f.modelText.resumeUnsent.mockResolvedValue({ text: f.job.title, requestId: 'original', providerId: 'auxiliary', modelId: 'configured' });
  const owner = createThreadTitleService(f.options); await owner.recover();
  await vi.waitFor(() => expect(f.runtime.finishThreadTitle).toHaveBeenCalled());
  expect(f.modelText.generate).not.toHaveBeenCalled(); expect(f.runtime.historyPage).not.toHaveBeenCalled();
  expect(f.runtime.finishThreadTitle).toHaveBeenCalledWith({ job: f.job, title: f.job.title }, expect.any(AbortSignal));
  await owner.close();
});

it('leaves failed checks with the current title and advances the attempted cut', async () => {
  const f = fixture(); f.modelText.generate.mockRejectedValue(new Error('Provider unavailable'));
  const owner = createThreadTitleService(f.options); owner.schedule(f.thread);
  await vi.waitFor(() => expect(f.runtime.finishThreadTitle).toHaveBeenCalledWith({ job: f.job, title: null }, expect.any(AbortSignal)));
  expect(f.onError).toHaveBeenCalledOnce(); await owner.close();
});

it('checks the durable completed user Run and ignores auxiliary Runs', async () => {
  const f = fixture();
  let notify: (event: AgentRuntimeStreamEvent) => void = () => {};
  f.runtime.onEvent = vi.fn(listener => { notify = listener; return () => {}; });
  const event: RuntimeEvent = { thread_id: f.thread.thread_id, branch_id: 'main', cursor: 1, subject: 'main-run', revision: 1, kind: 'run.changed', data: { state: 'completed', thread_id: f.thread.thread_id, branch_id: 'main' } };
  f.runtime.events.mockImplementation(async () => [event, { ...event, thread_id: null, branch_id: null, cursor: 2, subject: 'auxiliary', data: { state: 'completed', thread_id: 'model-text:title', branch_id: null } }]);
  const owner = createThreadTitleService(f.options);
  await vi.waitFor(() => expect(f.runtime.threads).toHaveBeenCalled());
  notify({ v: KERNEL_PROTOCOL_VERSION, kind: 'runtime-event', kernelEpoch: 'fixture', stream: 'durable', cursor: 2 });
  await vi.waitFor(() => expect(f.runtime.finishThreadTitle).toHaveBeenCalledOnce());
  expect(f.modelText.generate).toHaveBeenCalledOnce();
  expect(f.runtime.prepareThreadTitle.mock.calls.every(([input]) => input.threadId === f.thread.thread_id)).toBe(true);
  await owner.close(); expect(f.onError).not.toHaveBeenCalled();
});

it('keeps manual names, delegated Agent identities and the primary Bot entry outside automatic naming', async () => {
  const f = fixture(), botSession = vi.fn(async () => false);
  const owner = createThreadTitleService({ ...f.options, botSession });
  f.thread.title_mode = 'manual'; owner.schedule(f.thread); await Promise.resolve(); await Promise.resolve();
  expect(f.runtime.prepareThreadTitle).not.toHaveBeenCalled();
  f.thread.title_mode = 'automatic'; f.thread.bot_id = 'bot'; owner.schedule(f.thread);
  await vi.waitFor(() => expect(botSession).toHaveBeenCalled());
  expect(f.runtime.prepareThreadTitle).not.toHaveBeenCalled();
  await owner.close();
});


it.each([
  { first: 0, status: 0, after: 0 },
  { first: 0, status: 5, after: 0 },
  { first: 3, status: 5, after: 2 },
])('catches up title events from $after when wake $first precedes status $status', async ({ first, status, after }) => {
  const f = fixture();
  let ready!: (status: { eventCursor: number }) => void;
  f.runtime.status.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
  let notify!: (event: AgentRuntimeStreamEvent) => void;
  f.runtime.onEvent.mockImplementation(listener => { notify = listener; return () => {}; });
  const completed: RuntimeEvent = { thread_id: f.thread.thread_id, branch_id: 'main', cursor: first || 1, subject: 'main-run', revision: 1, kind: 'run.changed',
    data: { state: 'completed', thread_id: f.thread.thread_id, branch_id: 'main' } };
  f.runtime.events.mockImplementation(async cursor => [completed,
    ...(status > completed.cursor ? [{ ...completed, cursor: status, kind: 'unrelated' }] : [])].filter(event => event.cursor > cursor));
  const owner = createThreadTitleService(f.options);
  const wake = (cursor: number) => notify({ v: KERNEL_PROTOCOL_VERSION, kind: 'runtime-event', kernelEpoch: 'fixture', stream: 'durable', cursor });
  try {
    wake(first); ready({ eventCursor: status });
    await new Promise<void>(resolve => setImmediate(resolve));
    if (status === 0) {
      expect(f.runtime.events).not.toHaveBeenCalled();
      wake(1);
    }
    await vi.waitFor(() => expect(f.runtime.events).toHaveBeenCalled());
    expect(f.runtime.events.mock.calls[0]![0]).toBe(after);
    await vi.waitFor(() => expect(f.modelText.generate).toHaveBeenCalledOnce());
    expect(f.onError).not.toHaveBeenCalled();
  } finally { await owner.close(); }
});
