import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ThreadHistoryItem, ThreadSnapshot } from '@varin/application-client';
import type { ExploreToolProgress, Operation } from '@varin/protocol';
import { dict } from '@/lib/i18n/messages/zh-CN';
import { ChatExploreCard } from './ChatExploreCard';
import { ChatRetrievalTrace } from './ChatRetrievalTrace';
import { ConversationContext, useConversationPresentation, type ConversationPresentation } from './ConversationContext';
import { HistoryPresentation } from './historyPresentation';
import type { ChatToolCall, ChatToolResultMessage } from './types';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params: Record<string, unknown> = {}) =>
  dict[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name])) }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/icons/FileTypeIcon', () => ({ FileTypeIcon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }));
vi.mock('motion/react', () => ({ AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  motion: { li: ({ children }: React.PropsWithChildren) => <li>{children}</li>,
    p: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
    div: ({ children }: React.PropsWithChildren) => <div>{children}</div> } }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps the accepted Job active after the parent ends and uses its final receipt without duplicating the answer', async () => {
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const acceptance = { kind: 'job_accepted', operation_id: 'request:tool:call', phase: 'preparing', effect: 'none', lifetime: 'thread',
    content: { parts: [], data: { kind: 'retrieval', status: 'preparing', operationId: 'request:tool:call' } } };
  const base = { thread_id: 'thread', run_id: 'run', provider: null, parent: null };
  const history = [
    { ...base, id: 'call', source: 'assistant', content: { id: 'model-item:7:request:call', content: { kind: 'tool_call', call: { call_id: 'call', name: 'code_retrieval', arguments: { question: 'Find the source' } } } } },
    { ...base, id: 'receipt', source: 'tool', content: { content: { kind: 'tool_result', result: { request_id: 'request', call_id: 'call', completion: acceptance } } } },
  ] as ThreadHistoryItem[];
  const projector = new HistoryPresentation('thread');
  const operation = { id: 'request:tool:call', run_id: 'run', phase: 'running', call_completion: acceptance } as unknown as Operation;
  const render = async (loadedOperation = true) => {
    const view = projector.project(history, { operations: loadedOperation ? [operation] : [], activeRun: null });
    const entry = view.entries[0]!;
    if (entry.type !== 'message' || entry.message.role !== 'assistant') throw new Error('Missing call');
    const call = entry.message.content[0] as ChatToolCall;
    const resultEntry = view.entries[1]!;
    if (resultEntry.type !== 'message' || resultEntry.message.role !== 'toolResult') throw new Error('Missing acceptance');
    const result = resultEntry.message;
    expect(view.entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'retrieval-result')).toHaveLength(0);
    await act(async () => root.render(<ConversationContext.Provider value={{ readOnly: false, api: {} } as unknown as ConversationPresentation}>
      <ChatExploreCard call={call} cwd="/project" execution={view.toolExecutions[call.id]} result={result} rawDetails={null} />
    </ConversationContext.Provider>));
  };
  try {
    await render();
    expect(container.textContent).toContain(dict['chat.explore.investigating']);
    expect([...container.querySelectorAll('button')].some(button => button.textContent === dict['chat.explore.stop'])).toBe(true);
    operation.cancel_requested = true;
    await render();
    expect(container.textContent).toContain(dict['chat.explore.stopping']);
    expect([...container.querySelectorAll('button')].find(button => button.textContent === dict['chat.explore.stopping'])?.disabled).toBe(true);
    operation.phase = 'terminal'; operation.outcome = 'cancelled';
    operation.external_receipt = { executor: 'code_retrieval', identity: operation.id, epoch: 'collaboration-v1', outcome: 'cancelled', effect: 'none', executor_stopped: true,
      result: { parts: [], data: { kind: 'retrieval', status: 'cancelled', answer: 'Existing findings are retained.' } } };
    history.push({ ...base, id: 'delivery', source: 'agent', content: { content: { kind: 'output', output: { data: { kind: 'retrieval_result', operationId: operation.id, status: 'cancelled' },
      parts: [{ kind: 'text', text: 'Background result notice' }, { kind: 'text', text: 'Existing findings are retained.' }] } } } });
    await render();
    expect(container.textContent?.split('Existing findings are retained.')).toHaveLength(2);
    expect(container.textContent).toContain(dict['chat.explore.phase.cancelled']);
    expect(container.textContent).not.toContain(dict['chat.explore.stopping']);
    await render(false);
    expect(container.textContent?.split('Existing findings are retained.')).toHaveLength(2);
    expect(container.textContent).toContain(dict['chat.explore.phase.cancelled']);
    expect(container.textContent).not.toContain(dict['chat.explore.investigating']);
  } finally { act(() => root.unmount()); container.remove(); }
});

it('observes native tools through the parent retrieval and stops polling after completion', async()=>{
  vi.useFakeTimers();
  const {document,window}=parseHTML('<html><body></body></html>');
  for(const[name,value]of Object.entries({document,window,HTMLElement:window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true}))vi.stubGlobal(name,value);
  const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
  const history=[{id:'native-call',parent:null,thread_id:'thread:child',run_id:'child-run',source:'assistant',provider:null,
    content:{id:'model-item:7:child-request:search',content:{kind:'tool_call',call:{call_id:'search',name:'file_search',arguments:{query:'marker'}}}}}];
  const retrievalTrace=vi.fn(async()=>({operationId:'parent-op',history:{items:history,head:'native-call',previous:null},operations:[],
    run:{id:'child-run',thread_id:'thread:child',branch_id:'child-branch',state:'runnable'}}));
  const context={identity:{runtime:'agent',threadId:'thread:parent',branchId:'parent-branch'},api:{retrievalTrace}} as unknown as ConversationPresentation;
  const Tool=({call}:{call:ChatToolCall})=>{const owner=useConversationPresentation();return <span>{owner.identity.threadId}:{call.name}</span>;};
  const render=async(running:boolean,expanded:boolean)=>act(async()=>root.render(<ConversationContext.Provider value={context}>
    <ChatRetrievalTrace operationId="parent-op" running={running} expanded={expanded} renderTool={call=><Tool call={call}/>} />
  </ConversationContext.Provider>));
  try{
    await render(true,false);expect(retrievalTrace).toHaveBeenCalledWith('parent-op',undefined,expect.any(AbortSignal));
    expect(container.textContent).toContain('marker');
    await render(true,true);expect(container.textContent).toContain('thread:child:file_search');
    await render(false,true);const calls=retrievalTrace.mock.calls.length;
    await act(async()=>vi.advanceTimersByTimeAsync(2000));expect(retrievalTrace).toHaveBeenCalledTimes(calls);
  }finally{act(()=>root.unmount());container.remove();}
});

it.each([false, true])('keeps saved retrieval progress and excerpts readable (gateway=%s)', async gateway => {
  vi.useFakeTimers();
  const { document, window } = parseHTML('<html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const openFile = vi.fn(async () => {});
  const cancelOperation = vi.fn(async () => ({ cancel_requested: true }));
  const context = { openFile, api: { cancelOperation } } as unknown as ConversationPresentation;
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
    expect(container.textContent).toContain('正在调查');
    expect(container.textContent).not.toContain('暂无执行结果');
    const progress: ExploreToolProgress = { phase: 'selecting', elapsedMs: 1200, receivedFiles: 1, receivedSnippets: 1, sources: [],
      activities: [{ kind: 'read', sequence: 1, elapsedMs: 900, viewId: 'view', path: 'src/frames.ts', startLine: 1, endLine: 3, revision: 'rev', source: 'disk' }] };
    await render(progress);
    expect(container.textContent).toContain('正在筛选证据');
    expect(container.textContent).toContain('已获得 1 个候选片段');
    expect(container.textContent).toContain('frames.ts');
    expect(container.textContent).toContain('1.2 秒');
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === dict['chat.explore.stop'])!.click());
    expect(cancelOperation).toHaveBeenCalledExactlyOnceWith('request:tool:call');
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
