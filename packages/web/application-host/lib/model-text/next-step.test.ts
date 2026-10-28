import { expect, it, vi } from 'vitest';
import type { HistoryItem, HistoryReference, Run, RuntimeEvent, ThreadSummary, AgentRuntimeStreamEvent } from '@varin/protocol';
import { createNextStepService } from './next-step.js';
import { buildNextStepContext, NEXT_STEP_SYSTEM, NEXT_STEP_SCHEMA } from './next-step-context.js';
import type { ModelTextInput, ModelTextResult } from './service.js';

const identity = { runtime: 'agent' as const, threadId: 'thread:one', branchId: 'branch:one' };
const row = (id: string, run: string, source: HistoryItem['source'], text: string): HistoryItem => ({
  id, run_id: run, source, thread_id: identity.threadId, parent: null, provider: null,
  content: source === 'user' ? { text } : { content: { kind: 'text', text } },
});
function fixture() {
  const run = { id: 'run:now', thread_id: identity.threadId, branch_id: identity.branchId, state: 'completed' } as Run;
  const branch = { branch_id: identity.branchId, head: 'answer', active_run_id: null as string | null, latest_run: run };
  const thread = { ...identity, thread_id: identity.threadId, parent_thread_id: null, bot_id: null, deleted_at_ms: null, branches: [branch] } as unknown as ThreadSummary;
  const items = [row('old-user', 'run:old', 'user', '先讨论，别急着实现'), row('old-answer', 'run:old', 'assistant', '我们先看方案'),
    row('request', run.id, 'user', '好，按这个方向做吧'), row('tool', run.id, 'tool', 'HUGE_TOOL_OUTPUT'), row('agent', run.id, 'agent', 'CHILD_REPORT'),
    row('reason', run.id, 'assistant', ''), row('correction', run.id, 'user', '暂时不要打包'), row('answer', run.id, 'assistant', '已经完成实现，尚未打包')];
  items[5]!.content = { content: { kind: 'reasoning_summary', text: 'THINKING_ONLY' } };
  const references = items.map((item, index) => ({ ...item, parent: items[index - 1]?.id ?? null, content_ref: item.id })) as HistoryReference[];
  let listener: (event: AgentRuntimeStreamEvent) => void = () => {};
  const events: RuntimeEvent[] = [];
  const runtime = {
    thread: vi.fn(async () => thread), run: vi.fn(async () => run),
    context: vi.fn(async () => null), activeOperations: vi.fn(async () => []),
    historyPage: vi.fn(async (input: { headId?: string | null; beforeId?: string | null; limit?: number }) => {
      const end = input.beforeId ? references.findIndex(ref => ref.id === input.beforeId) + 1 : references.length;
      const start = Math.max(0, end - 3); // Force actual pagination through mixed tool/message history.
      return { head: input.headId ?? branch.head, items: references.slice(start, end), previous: start ? references[start - 1]!.id : null };
    }),
    historyItem: vi.fn(async (ref: HistoryReference) => items.find(item => item.id === ref.id)!),
    status: vi.fn(async () => ({ eventCursor: 0 })), events: vi.fn(async (cursor: number) => events.filter(event => event.cursor > cursor)),
    onEvent: vi.fn((fn: typeof listener) => { listener = fn; return () => {}; }), onReady: () => () => {}, onExit: () => () => {},
  } as unknown as Parameters<typeof createNextStepService>[0]['runtime'];
  let settings: unknown = { harness: { nextStep: { enabled: true }, models: { nextStep: { providerId: 'chosen', modelId: 'fast' } } } };
  const originals = new Map<string, ModelTextResult>();
  const generate = vi.fn(async (input: ModelTextInput) => {
    const result = { text: JSON.stringify({ suggestion: '好，再看看还有没有问题' }), requestId: input.key, providerId: 'chosen', modelId: 'fast' };
    originals.set(input.key, result); return result;
  });
  const count = vi.fn(async (texts: readonly string[]) => ({ counts: texts.map(text => [...text].length), tokenizer: 'fixture tokenizer' }));
  const release = vi.fn(async () => {});
  const modelText = { original: vi.fn(async (key: string) => originals.has(key) ? { purpose: 'text', prompt: 'frozen input' } : null),
    resumeUnsent: vi.fn(async (key: string) => originals.get(key) ?? null),
    prepareBudget: vi.fn(async ({ model }: { model: { providerId: string; modelId: string } }) => ({ contextTokens: 16384, outputTokens: 2048, count, release,
      generate: (input: Omit<ModelTextInput, 'model'>) => generate({ ...input, model }) })) } as unknown as Parameters<typeof createNextStepService>[0]['modelText'];
  const onError = vi.fn();
  const service = createNextStepService({ runtime, modelText, readSettings: async () => settings, onError });
  return { service, runtime, generate, count, release, items, branch, run, onError, modelText,
    settings: (value: unknown) => { settings = value; },
    emit: (event: RuntimeEvent) => { events.push(event); listener({ stream: 'durable', cursor: event.cursor } as AgentRuntimeStreamEvent); } };
}

it('uses anchored original exchanges, corrections and optional state without tool/agent/reasoning text; joins and reuses the original request', async () => {
  const f = fixture();
  f.settings({ harness: { nextStep: { enabled: true }, models: { nextStep: {
    providerId: 'chosen', modelId: 'fast', agent: { modelSettings: { thinkingLevel: 'high' } },
  } } } });
  try {
    const [one, two] = await Promise.all([f.service.read(identity, f.run.id, 'answer'), f.service.read(identity, f.run.id, 'answer')]);
    expect(one).toEqual(two); expect(one).toMatchObject({ status: 'ready', text: '好，再看看还有没有问题' });
    expect(f.generate).toHaveBeenCalledOnce();
    const input = f.generate.mock.calls[0]![0];
    expect(input.model).toEqual({ providerId: 'chosen', modelId: 'fast', thinkingLevel: 'high' });
    const context = JSON.parse(input.prompt);
    expect(context.currentTurn.map((message: { text: string }) => message.text)).toEqual(['好，按这个方向做吧', '暂时不要打包', '已经完成实现，尚未打包']);
    expect(context.previousConversation.map((message: { text: string }) => message.text)).toEqual(['先讨论，别急着实现', '我们先看方案']);
    expect(input.prompt).not.toMatch(/HUGE_TOOL_OUTPUT|CHILD_REPORT|THINKING_ONLY/);
    expect(vi.mocked(f.runtime.historyPage).mock.calls.every(([query]) => query.headId === 'answer')).toBe(true);
    await f.service.read(identity, f.run.id, 'answer'); expect(f.generate).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('does not dispatch disabled, unconfigured or superseded suggestions', async () => {
  const f = fixture();
  try {
    f.settings({ harness: {} }); expect(await f.service.read(identity, f.run.id, 'answer')).toEqual({ status: 'disabled' });
    f.settings({ harness: { nextStep: { enabled: true } } });
    expect(await f.service.read(identity, f.run.id, 'answer')).toEqual({ status: 'unavailable', code: 'next-step-model-unconfigured' });
    expect(f.generate).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it('rejects a late result after a new user message advances the branch', async () => {
  const f = fixture();
  let complete!: (result: ModelTextResult) => void;
  f.generate.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const work = f.service.read(identity, f.run.id, 'answer');
  await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
  f.branch.head = 'new-user'; f.branch.active_run_id = 'run:next';
  complete({ text: '{"suggestion":"过期建议"}', requestId: 'request', providerId: 'chosen', modelId: 'fast' });
  expect(await work).toEqual({ status: 'stale' });
  await f.service.close();
});

it('starts in the background from a durable completed Run without an open chat view', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.runtime.status).toHaveBeenCalled());
  f.emit({ cursor: 1, subject: f.run.id, revision: 2, kind: 'run.changed', data: f.run });
  await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
  await f.service.close();
});

it('keeps same-turn historical progress from cancelling a suggestion, but cancels it for a newly accepted Run', async () => {
  const f = fixture();
  f.generate.mockImplementationOnce(input => new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true })));
  const work = f.service.read(identity, f.run.id, 'answer');
  await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
  f.emit({ cursor: 1, subject: f.run.id, revision: 1, kind: 'run.changed', data: { ...f.run, state: 'generating' } });
  await vi.waitFor(() => expect(f.runtime.events).toHaveBeenCalled());
  expect(f.generate.mock.calls[0]![0].signal!.aborted).toBe(false);
  vi.mocked(f.runtime.run).mockResolvedValue({ ...f.run, id: 'run:next', state: 'accepted' });
  f.emit({ cursor: 2, subject: 'run:next', revision: 1, kind: 'run.accepted', data: { input_id: 'new-user' } });
  expect(await work).toEqual({ status: 'stale' });
  expect(f.generate.mock.calls[0]![0].signal!.aborted).toBe(true);
  await f.service.close();
});

it('ignores unrelated settings changes and cancels when the next-step setting is disabled', async () => {
  const f = fixture();
  f.generate.mockImplementationOnce(input => new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true })));
  const work = f.service.read(identity, f.run.id, 'answer');
  await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
  await f.service.settingsChanged(); expect(f.generate.mock.calls[0]![0].signal!.aborted).toBe(false);
  f.settings({ harness: { nextStep: { enabled: false } } }); await f.service.settingsChanged();
  expect(await work).toEqual({ status: 'stale' }); await f.service.close();
});

it('budgets long multilingual text, retains user corrections, and marks omissions without cutting Unicode', async () => {
  const f = fixture();
  f.items[f.items.length - 1]!.content = { content: { kind: 'text', text: '很长的结果🪷'.repeat(4000) } };
  const prompt = await buildNextStepContext(f.runtime, { ...identity, runId: f.run.id, headId: 'answer', state: 'completed', inputTokens: 2400, count: f.count }, new AbortController().signal);
  const system = `${NEXT_STEP_SYSTEM}\nReturn JSON conforming to this schema:\n${JSON.stringify(NEXT_STEP_SCHEMA)}`;
  expect([...prompt].length + [...system].length + 64).toBeLessThanOrEqual(2400);
  expect(Buffer.byteLength(prompt) + Buffer.byteLength(system) + 64).toBeGreaterThan(2400);
  expect(prompt).toContain('暂时不要打包'); expect(prompt).toContain('omitted'); expect(prompt).not.toContain('\ufffd');
  await f.service.close();
});

it('reuses the published background summary without replaying its covered dialogue and allows no suggestion', async () => {
  const f = fixture();
  vi.mocked(f.runtime.context).mockResolvedValue({ proposal: { summary: '更早已经决定先完成交互，再考虑打包。', through_id: 'old-answer' } } as NonNullable<Awaited<ReturnType<typeof f.runtime.context>>>);
  f.generate.mockResolvedValueOnce({ text: '{"suggestion":null}', requestId: 'empty', providerId: 'chosen', modelId: 'fast' });
  expect(await f.service.read(identity, f.run.id, 'answer')).toEqual({ status: 'empty' });
  const context = JSON.parse(f.generate.mock.calls[0]![0].prompt);
  expect(context.earlierBackground).toContain('先完成交互'); expect(context.previousConversation).toEqual([]);
  expect(context.currentTurn.map((value: { text: string }) => value.text)).toContain('暂时不要打包');
  await f.service.close();
});

it('keeps an explicit conservative bound when the selected model only has a reference vocabulary', async () => {
  const f = fixture();
  f.items[f.items.length - 1]!.content = { content: { kind: 'text', text: '中文材料'.repeat(2000) } };
  const prompt = await buildNextStepContext(f.runtime, { ...identity, runId: f.run.id, headId: 'answer', state: 'completed', inputTokens: 2400,
    count: async texts => ({ counts: texts.map(() => 1), tokenizer: 'o200k_base (reference tokenizer)' }) }, new AbortController().signal);
  const system = `${NEXT_STEP_SYSTEM}\nReturn JSON conforming to this schema:\n${JSON.stringify(NEXT_STEP_SCHEMA)}`;
  expect(Buffer.byteLength(prompt) + Buffer.byteLength(system) + 64).toBeLessThanOrEqual(2400);
  expect(prompt).toContain('暂时不要打包'); await f.service.close();
});
