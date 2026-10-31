import { expect, it, vi } from 'vitest';
import { buildThreadTitleContext } from './thread-title-context.js';
import type { HistoryItem } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { ThreadTitleJob } from '../kernel/protocol.generated.js';

it('retains three continuous complete exchanges across pages, including long prose, questions and corrections', async () => {
  const items: HistoryItem[] = [];
  const append = (run: string, source: HistoryItem['source'], content: unknown) => items.push({ id: `${run}:${items.length}`, thread_id: 'thread', run_id: run, source, content,
    parent: items.at(-1)?.id ?? null } as HistoryItem);
  const assistant = (text: string) => ({ content: { kind: 'text', text } });
  const long = '完整说明，不按字符或 token 切断。'.repeat(3000);
  for (let round = 1; round <= 4; round++) {
    const run = `run${round}`;
    append(run, 'user', { text: `用户第${round}轮` });
    append(run, 'assistant', assistant(`第${round}轮中途讨论`));
    append(run, 'assistant', { content: { kind: 'reasoning_summary', text: 'PRIVATE REASONING' } });
    append(run, 'tool', { text: 'RAW TOOL OUTPUT' });
    if (round === 3) {
      append(run, 'assistant', { content: { kind: 'tool_call', call: { name: 'ask_user', arguments: { questions: [{ question: '选择哪种方式？', options: [{ label: '保留手动修改' }] }] } } } });
      append(run, 'user', { text: '保留手动修改', questionAnswer: { operationId: 'question' } });
    }
    append(run, 'assistant', assistant(round === 2 ? long : `第${round}轮完整回复`));
    if (round === 3) append('background', 'assistant', assistant('BACKGROUND-ONLY RUN'));
  }
  append('unfinished', 'user', { text: '尚未完成的新输入' });
  const historyPage = vi.fn(async ({ beforeId }: { beforeId?: string }) => {
    const end = beforeId ? items.findIndex(item => item.id === beforeId) : items.length;
    const start = Math.max(0, end - 2);
    return { head: items.at(-1)!.id, items: items.slice(start, end), previous: start > 0 ? items[start]!.id : null };
  });
  // The next Run may finish while this background request reads history. Its
  // frozen cut must still exclude that Run rather than read half an exchange.
  const runtime = { historyPage, historyItem: vi.fn(async (ref: HistoryItem) => ref), run: vi.fn(async () => ({ state: 'completed' })),
    context: vi.fn(async () => ({ proposal: { summary: '已有的较早背景' } })) };
  const job: ThreadTitleJob = { key: 'job', threadId: 'thread', branchId: 'branch', headId: items.at(-1)!.id, checkpointId: 'original-checkpoint', activeRunId: 'unfinished', rounds: 50, generation: 0, title: '旧标题', initial: false };
  const text = await buildThreadTitleContext(runtime as unknown as AgentRuntimeClient, job, new AbortController().signal);
  expect(text).toContain(long); expect(text).toContain('已有的较早背景');
  expect(text).not.toContain('用户第1轮'); expect(text).not.toContain('PRIVATE REASONING'); expect(text).not.toContain('RAW TOOL OUTPUT');
  expect(text).not.toContain('BACKGROUND-ONLY RUN'); expect(text).not.toContain('尚未完成的新输入');
  expect(text.indexOf('用户第2轮')).toBeLessThan(text.indexOf('第2轮中途讨论'));
  expect(text.indexOf('选择哪种方式？')).toBeLessThan(text.indexOf('USER\n保留手动修改'));
  expect(text).toContain('第4轮完整回复');
  expect(runtime.context).toHaveBeenCalledWith('branch', expect.any(AbortSignal), 'original-checkpoint');
  expect(runtime.historyItem.mock.calls.every(([ref]) => ref.source !== 'tool')).toBe(true);
  expect(runtime.historyItem.mock.calls.every(([ref]) => ref.run_id !== 'background')).toBe(true);
});
