import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadHistoryItem, ThreadSnapshot } from '@varin/application-client';
import type { ExploreToolProgress } from '@varin/protocol';
import { dict } from '@/lib/i18n/messages/zh-CN';
import { ChatExploreCard } from './ChatExploreCard';
import { ConversationContext, type ConversationPresentation } from './ConversationContext';
import { HistoryPresentation } from './historyPresentation';
import type { ChatToolCall, ChatToolResultMessage } from './types';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params: Record<string, unknown> = {}) =>
  dict[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name])) }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/icons/FileTypeIcon', () => ({ FileTypeIcon: () => null }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }));
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  motion: { li: ({ children }: React.PropsWithChildren) => <li>{children}</li> } }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([false, true])('renders a read-only retrieval from startup through live evidence to final excerpts (gateway=%s)', async gateway => {
  vi.useFakeTimers();
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const openFile = vi.fn(async () => {});
  const context = { openFile } as unknown as ConversationPresentation;
  const args = { question: 'Where are script frames parsed?' };
  const history: ThreadHistoryItem[] = [{ id: 'call-history', parent: null, thread_id: 'thread', run_id: 'run', source: 'assistant', provider: null,
    content: { id: 'model-item:7:request:call', content: { kind: 'tool_call', call: { call_id: 'call', name: gateway ? 'tool_invoke' : 'code_retrieval',
      arguments: gateway ? { reference: { name: 'code_retrieval', version: 'v1' }, arguments: args } : args } } } }];
  const snapshot = { activeRun: { id: 'run' }, operations: [] } as unknown as ThreadSnapshot;
  const projector = new HistoryPresentation('thread');
  const render = async (progress?: ExploreToolProgress) => {
    const view = projector.project(history, snapshot, [], progress ? [{ runId: 'run', operationId: 'request:tool:call', toolName: 'code_retrieval', details: { progress } }] : []);
    const callEntry = view.entries[0]!;
    if (callEntry.type !== 'message' || callEntry.message.role !== 'assistant') throw new Error('Missing tool call');
    const call = callEntry.message.content[0] as ChatToolCall;
    const receipt = view.entries[1];
    const result = receipt?.type === 'message' ? receipt.message as ChatToolResultMessage : undefined;
    await act(async () => root.render(<ConversationContext.Provider value={context}><ChatExploreCard call={call} cwd="/project"
      execution={view.toolExecutions[call.id]} result={result} rawDetails={<p>原始结果</p>} /></ConversationContext.Provider>));
  };
  try {
    await render();
    expect(container.textContent).toContain('正在启动检索');
    expect(container.textContent).not.toContain('暂无执行结果');
    const progress: ExploreToolProgress = { phase: 'selecting', elapsedMs: 1200, receivedFiles: 1, receivedSnippets: 1, sources: [],
      activities: [{ kind: 'read', sequence: 1, elapsedMs: 900, viewId: 'view', path: 'src/frames.ts', startLine: 1, endLine: 3, revision: 'rev', source: 'disk' }] };
    await render(progress);
    expect(container.textContent).toContain('正在筛选证据');
    expect(container.textContent).toContain('已获得 1 个候选片段');
    expect(container.textContent).toContain('frames.ts');
    expect(container.textContent).toContain('1.2 秒');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(container.textContent).toContain('2.2 秒');
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('frames.ts'))!.click());
    expect(openFile).toHaveBeenCalledWith(JSON.stringify(['run', 'request', 'call']), 'src/frames.ts', 1);
    const result = { status: 'partial', snippets: [{ path: 'src/frames.ts', revision: 'rev', startLine: 1, endLine: 3, content: 'export const frameSize = 42;' }] };
    history.push({ id: 'result-history', parent: 'call-history', thread_id: 'thread', run_id: 'run', source: 'tool', provider: null,
      content: { content: { kind: 'tool_result', result: { request_id: 'request', call_id: 'call', completion: { kind: 'result', outcome: 'succeeded', effect: 'none',
        content: { parts: [], data: gateway ? { reference: { name: 'code_retrieval', version: 'v1' }, result } : result } } } } } });
    snapshot.activeRun = null;
    await render({ ...progress, phase: 'partial', elapsedMs: 2400 });
    expect(container.textContent).toContain('已返回部分材料');
    expect(container.textContent).toContain('已返回 1 个片段');
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === '展开')!.click());
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent?.trim() === dict['chat.explore.excerpt'])!.click());
    expect(container.querySelector('pre')?.textContent).toBe('export const frameSize = 42;');
    expect(container.textContent).toContain('disk · rev');
    expect(JSON.stringify(history)).not.toContain('activities');
  } finally { act(() => root.unmount()); container.remove(); }
});
