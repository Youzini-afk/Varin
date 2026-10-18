import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import type { ThreadHistoryItem, ThreadRunUsage } from '@varin/application-client';
import { HistoryPresentation } from './historyPresentation';
import { projectChatTimeline } from './chatTimelineProjection';
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
