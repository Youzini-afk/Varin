import { expect, it, vi } from 'vitest';
import type { ThreadSummary } from '../kernel/protocol.generated.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { createThreadTitleService } from './thread-titles.js';
import type { ModelTextInput, ModelTextResult } from './service.js';

it.each([false, true])('generates once in the background and preserves a manual rename (%s)', async renamed => {
  const thread = { thread_id: 'conversation', title: 'New thread', branches: [], parent_thread_id: null, bot_id: null } as unknown as ThreadSummary;
  const text = '帮我分析这个仓库的启动流程\n这里是相关背景';
  let finish!: (result: ModelTextResult) => void;
  const generate = vi.fn((_input: ModelTextInput) => new Promise<ModelTextResult>(resolve => { finish = resolve; }));
  const read = vi.fn(async () => ({ ...thread, title: renamed ? '自己起的标题' : text.split('\n')[0]!, revision: 2, deleted_at_ms: null }));
  const update = vi.fn(async () => thread);
  const onError = vi.fn();
  const owner = createThreadTitleService({ modelText: { generate, original: async () => null, resumeUnsent: async () => null },
    runtime: { thread: read, updateThread: update, threads: async () => [], onReady: () => () => {} }, onError });
  owner.schedule(thread, text);
  owner.schedule(thread, text);
  expect(generate).toHaveBeenCalledOnce();
  expect(generate.mock.calls[0]?.[0]).toMatchObject({ purpose: 'title', prompt: text });
  expect(read).not.toHaveBeenCalled();
  finish({ text: '仓库启动流程分析', requestId: 'title-request', providerId: 'auxiliary', modelId: 'configured' });
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  if (renamed) expect(update).not.toHaveBeenCalled();
  else expect(update).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'conversation', title: '仓库启动流程分析', expectedRevision: 2 }), expect.any(AbortSignal));
  expect(onError).not.toHaveBeenCalled();
  await owner.close();
});

it('reuses the generated title when pinning changes the metadata revision during publication', async () => {
  const thread = { thread_id: 'conversation', title: 'New thread', branches: [], parent_thread_id: null, bot_id: null } as unknown as ThreadSummary;
  const text = '分析仓库启动流程';
  let revision = 2;
  const read = vi.fn(async () => ({ ...thread, title: text, revision, deleted_at_ms: null }));
  const update = vi.fn<AgentRuntimeClient['updateThread']>(async () => {
    if (revision === 2) { revision = 3; throw new Error('Metadata revision changed'); }
    return thread;
  });
  const generate = vi.fn(async () => ({ text: '仓库启动流程分析', requestId: 'request', providerId: 'auxiliary', modelId: 'title' }));
  const onError = vi.fn();
  const owner = createThreadTitleService({ modelText: { generate, original: async () => null, resumeUnsent: async () => null },
    runtime: { thread: read, updateThread: update, threads: async () => [], onReady: () => () => {} }, onError });
  owner.schedule(thread, text);
  await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 3, title: '仓库启动流程分析' });
  expect(generate).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
  await owner.close();
});

it('titles additional Bot conversations but never the primary entry or Bots without a session check', async () => {
  const session = { thread_id: 'bot-session', title: 'New thread', branches: [], parent_thread_id: null, bot_id: 'bot' } as unknown as ThreadSummary;
  const entry = { ...session, thread_id: 'bot-entry' } as ThreadSummary;
  const generate = vi.fn(async () => ({ text: '旅行安排', requestId: 'request', providerId: 'auxiliary', modelId: 'title' }));
  const read = vi.fn(async (threadId: string) => ({ ...session, thread_id: threadId, title: '帮我排一下旅行', revision: 1, deleted_at_ms: null }));
  const update = vi.fn(async () => session);
  const botSession = vi.fn(async (thread: ThreadSummary) => thread.thread_id === 'bot-session');
  const runtime = { thread: read, updateThread: update, threads: async () => [], onReady: () => () => {} };
  const owner = createThreadTitleService({ modelText: { generate, original: async () => null, resumeUnsent: async () => null }, runtime, botSession, onError: vi.fn() });
  owner.schedule(entry, '帮我排一下旅行');
  owner.schedule(session, '帮我排一下旅行');
  await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'bot-session', title: '旅行安排' }), expect.any(AbortSignal));
  expect(generate).toHaveBeenCalledOnce();
  await owner.close();
  const unchecked = createThreadTitleService({ modelText: { generate, original: async () => null, resumeUnsent: async () => null }, runtime, onError: vi.fn() });
  unchecked.schedule({ ...session, thread_id: 'other-session' } as ThreadSummary, '另一件事');
  await Promise.resolve();
  expect(generate).toHaveBeenCalledOnce();
  await unchecked.close();
});
