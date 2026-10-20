import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import type { ThreadHistoryItem, ThreadRunUsage } from '@varin/application-client';
import { HistoryPresentation } from './historyPresentation';
import { projectChatTimeline } from './chatTimelineProjection';
import { projectChatTimelineBlocks } from './chatTimelineBlocks';
import { ChatTimelineEntryList } from './ChatTimelineEntries';
import { useUIStore } from '@/stores/useUIStore';

vi.mock('@/lib/i18n', () => ({ getCurrentIntlLocale: () => 'en-US', useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/lib/extensions/workbench-registry', () => ({ useWorkbenchMatchRenderers: () => [], renderFirstWorkbenchMatch: () => undefined }));

it('shows one summed footer after an ended Run even when every paginated message is a separate row', async () => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const request = (requestId: string, inputTokens: number, outputTokens: number) => ({ requestId,
    usage: { measurement: 'actual' as const, inputTokens, outputTokens, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, pricingVersion: null } });
  const first = request('first', 100, 10), second = request('second', 200, 20);
  const history: ThreadHistoryItem[] = [first, first, second].map((metadata, index) => ({ id: `item:${index}`, parent: index ? `item:${index - 1}` : 'earlier-page',
    thread_id: 'thread', run_id: 'run', source: 'assistant', provider: null,
    content: { content: { kind: 'text', text: `Answer part ${index}` } }, modelRequest: { ...metadata, modelId: 'model', providerFamily: 'openai-completions' } }));
  const projector = new HistoryPresentation('thread');
  const render = async (usage: ThreadRunUsage[]) => {
    const view = projector.project(history, undefined, usage);
    const projection = projectChatTimeline(view.entries);
    await act(async () => root.render(<>{projection.items.map(item => item.kind === 'entry'
      ? <ChatTimelineEntryList key={item.id} cwd="/workspace" entries={[item.entry]} sessionId="thread" toolExecutions={{}} /> : null)}</>));
  };
  try {
    useUIStore.setState({ chatRenderMode: 'live' });
    await render([]);
    expect(container.querySelectorAll('[data-conversation-turn-usage]')).toHaveLength(0);
    await render([{ runId: 'run', throughId: 'item:2', requests: [first, first, second] }]);
    const footers = container.querySelectorAll('[data-conversation-turn-usage]');
    expect(footers).toHaveLength(1);
    expect(footers[0].textContent).toContain('contextSidebar.tokens.input 300');
    expect(footers[0].textContent).toContain('contextSidebar.tokens.output 30');
    expect(container.textContent!.indexOf('Answer part 2')).toBeLessThan(container.textContent!.indexOf('contextSidebar.tokens.input 300'));
    useUIStore.setState({ chatRenderMode: 'sorted' });
    await render([{ runId: 'run', throughId: 'item:2', requests: [first, second] }]);
    expect(container.querySelectorAll('[data-conversation-turn-usage]')).toHaveLength(1);
  } finally {
    act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});

it('keeps turn actions and changed files hidden while running and retains earlier completed footers', async () => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const usage = { measurement: 'missing' as const, inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, pricingVersion: null };
  const runHistory = (runId: string, parent: string | null): ThreadHistoryItem[] => {
    const requestId = `${runId}:request`;
    const modelRequest = { requestId, usage, modelId: 'model', providerFamily: 'openai-completions' };
    return [
      { id: `${runId}:user`, parent, thread_id: 'thread', run_id: runId, source: 'user', provider: null, content: 'Edit the file' },
      { id: `${runId}:call`, parent: `${runId}:user`, thread_id: 'thread', run_id: runId, source: 'assistant', provider: null, modelRequest,
        content: { content: { kind: 'tool_call', call: { call_id: 'write', name: 'file_write', arguments: { path: `${runId}.ts`, content: 'changed' } } } } },
      { id: `${runId}:result`, parent: `${runId}:call`, thread_id: 'thread', run_id: runId, source: 'tool', provider: null,
        content: { content: { kind: 'tool_result', result: { request_id: requestId, call_id: 'write', completion: {
          kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { data: { applied: true }, parts: [] },
        } } } } },
      { id: `${runId}:answer`, parent: `${runId}:result`, thread_id: 'thread', run_id: runId, source: 'assistant', provider: null, modelRequest,
        content: { content: { kind: 'text', text: 'The edit is done.' } } },
    ];
  };
  const ended = (runId: string): ThreadRunUsage => ({ runId, throughId: `${runId}:answer`, requests: [{ requestId: `${runId}:request`, usage }] });
  const projector = new HistoryPresentation('thread');
  const render = async (history: ThreadHistoryItem[], usage: ThreadRunUsage[], activeRunId?: string) => {
    const view = projector.project(history, undefined, usage);
    const projection = projectChatTimeline(view.entries);
    const blocks = projectChatTimelineBlocks(projection, { sorted: useUIStore.getState().chatRenderMode === 'sorted', expanded: () => false });
    await act(async () => root.render(<>{blocks.items.flatMap(block => block.kind === 'footer' ? [
      <section key={block.id} data-run={block.group.runId}><ChatTimelineEntryList cwd="/workspace" sessionId="thread" entries={block.group.entries}
        part="footer" turnActive={activeRunId === block.group.runId} projectedResultByCallId={projection.resultByCallId} toolExecutions={view.toolExecutions} /></section>,
    ] : [])}</>));
  };
  const summaries = () => [...container.querySelectorAll('details')].filter(node => node.querySelector('summary')?.textContent?.includes('chat.changedFiles.title'));
  try {
    useUIStore.setState({ chatRenderMode: 'live', showTurnChangedFiles: true });
    const first = runHistory('first', null), second = runHistory('second', 'first:answer');
    await render(first.slice(0, 3), [], 'first'); // Applied edit, between model steps: no live message.
    expect(summaries()).toHaveLength(0);
    await render(first, [], 'first'); // Persisted assistant text alone does not end the Run.
    expect(summaries()).toHaveLength(0);
    expect(container.querySelector('[aria-label="chat.messageBody.actions.copyAnswer"]')).toBeNull();
    await render(first, [ended('first')]);
    expect(summaries()).toHaveLength(1);
    expect(container.querySelector('[data-run="first"] [aria-label="chat.messageBody.actions.copyAnswer"]')).not.toBeNull();
    expect(summaries()[0].textContent).toContain('first.ts');
    await act(async () => useUIStore.setState({ chatRenderMode: 'sorted' }));
    await render([...first, ...second], [ended('first')], 'second');
    expect(summaries()).toHaveLength(1);
    expect(container.querySelector('[data-run="first"] [aria-label="chat.messageBody.actions.copyAnswer"]')).not.toBeNull();
    expect(container.querySelector('[data-run="second"] [aria-label="chat.messageBody.actions.copyAnswer"]')).toBeNull();
    expect(summaries()[0].closest('[data-run]')?.getAttribute('data-run')).toBe('first');
    await render([...first, ...second], [ended('first'), ended('second')]);
    expect(summaries()).toHaveLength(2);
    expect(summaries()[1].closest('[data-run]')?.getAttribute('data-run')).toBe('second');
    expect(summaries()[1].textContent).toContain('second.ts');
    expect(summaries()[1].textContent).not.toContain('first.ts');
  } finally {
    act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});
