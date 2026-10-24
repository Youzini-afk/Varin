import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChatDialogueActivity } from './ChatDialogueActivity';
import { ChatThinkingBlock } from './ChatThinkingBlock';
import { useUIStore } from '@/stores/useUIStore';
import { projectChatDialogue } from './chatDialogueProjection';
import type { ChatAssistantMessage, ChatToolExecutionState } from './types';

vi.mock('@/lib/i18n', async original => ({
  ...await original<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => key + (values ? JSON.stringify(values) : '') }),
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => false }));
let root: Root, container: HTMLElement, height: number, message: ChatAssistantMessage;
let executions: Record<string, ChatToolExecutionState>;
const scroll = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) { this.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? 0; });
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  height = 60; scroll.mockClear();
  vi.useFakeTimers();
  useUIStore.setState({ showReasoningTraces: true, collapsibleThinkingBlocks: true });
  Object.defineProperties(window.HTMLElement.prototype, { clientHeight: { configurable: true, get: () => 20 }, scrollHeight: { configurable: true, get: () => height } });
  window.HTMLElement.prototype.scrollTo = scroll;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  message = { id: 'assistant', runId: 'run', role: 'assistant', model: '', provider: '', api: '', timestamp: 0, stopReason: 'pending',
    content: [{ id: 'thought', type: 'thinking', thinking: 'Inspect the layout first.' }] };
  executions = {};
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });
// Labels change in place and hold at least 260ms; springs settle within a second.
const settle = () => act(async () => { vi.advanceTimersByTime(1000); });
const render = async (history = false, showThinking = true) => {
  const items = history ? projectChatDialogue([{ type: 'message', id: 'history', runId: 'run', parentId: null, timestamp: '', message }], undefined, { showThinking })
    : projectChatDialogue([], message, { showThinking });
  const item = items[0];
  await act(async () => root.render(item?.kind === 'process' ? <ChatDialogueActivity process={item} executions={executions} results={new Map()}
    active={!history} renderActivity={activity => activity.kind === 'thinking'
      ? <ChatThinkingBlock content={activity.content} messageId={activity.id} streaming={!history && activity.streaming} label="chat.reasoningTrace.thinking" />
      : <div data-expanded-content>Details</div>} /> : null));
};
const heading = () => container.querySelector('summary, button[aria-expanded]')!;

test('single thinking keeps its own preview and expansion without a surrounding disclosure', async () => {
  await render();
  expect(container.querySelector('details')).toBeNull();
  const preview = heading().querySelector<HTMLElement>('.thinking-preview')!;
  expect(heading().textContent).toContain('Inspect the layout first.');
  expect(preview.scrollTop).toBe(40);
  expect(container.querySelector('[data-expanded-content]')).toBeNull();
  height = 80;
  message = { ...message, content: [{ id: 'thought', type: 'thinking', thinking: 'Inspect the layout first. Now check the plan editor.' }] };
  await render();
  expect(heading().querySelector('.thinking-preview')).toBe(preview);
  expect(heading().textContent).toContain('Now check the plan editor.');
  // The new line glides up rather than jumping.
  await act(async () => { vi.advanceTimersByTime(48); });
  expect(preview.scrollTop).toBeGreaterThan(40);
  expect(preview.scrollTop).toBeLessThan(60);
  await settle();
  expect(preview.scrollTop).toBe(60);
  message = { ...message, stopReason: 'stop' };
  await render(true);
  expect(heading().querySelector('.thinking-preview')).toBe(preview);
  expect(heading().textContent).toContain('chat.reasoningTrace.thinking');
  await act(async () => (heading() as HTMLButtonElement).click());
  expect(heading().getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[role="region"]')?.textContent).toContain('Now check the plan editor.');
});

test('a single tool renders directly and additional activity restores group disclosure', async () => {
  message = { ...message, content: [{ type: 'toolCall', id: 'read', name: 'file_read', arguments: { path: 'ThreadPlan.tsx' } }] };
  await render();
  expect(container.querySelector('details')).toBeNull();
  expect(container.querySelector('[data-expanded-content]')).not.toBeNull();
  message = { ...message, content: [...message.content, { type: 'toolCall', id: 'search', name: 'file_search', arguments: { pattern: 'plan' } }] };
  await render();
  expect(container.querySelector('details')).not.toBeNull();
  expect(container.querySelector('[data-expanded-content]')).toBeNull();
});

test('tool activity replaces the thinking preview and a completed mixed segment retains its receipt summary', async () => {
  await render();
  message = { ...message, content: [...message.content, { type: 'toolCall', id: 'read', name: 'file_read', arguments: { path: 'ThreadPlan.tsx' } }] };
  executions.read = { toolCallId: 'read', name: 'file_read', args: { path: 'ThreadPlan.tsx' }, status: 'success' };
  await render();
  expect(heading().querySelector('.thinking-preview')).toBeNull();
  await settle();
  expect(heading().textContent).toContain('ThreadPlan.tsx');
  const label = heading().querySelector('.swap-text');
  message = { ...message, stopReason: 'stop' };
  await render(true);
  await settle();
  expect(heading().textContent).toContain('chat.activity.reads{"count":1}');
  expect(heading().querySelector('.thinking-preview')).toBeNull();
  // The receipt replaces the action in the same label instead of remounting it.
  expect(heading().querySelector('.swap-text')).toBe(label);
});

test('a quick action stays readable before the next one replaces it', async () => {
  message = { ...message, content: [
    { type: 'toolCall', id: 'read', name: 'file_read', arguments: { path: 'First.ts' } },
    { type: 'toolCall', id: 'search', name: 'file_search', arguments: { pattern: 'plan' } },
  ] };
  executions.read = { toolCallId: 'read', name: 'file_read', args: { path: 'First.ts' }, status: 'running' };
  executions.search = { toolCallId: 'search', name: 'file_search', args: { pattern: 'plan' }, status: 'success' };
  await render();
  await settle();
  const text = () => heading().querySelector('.swap-text-current')!.textContent;
  expect(text()).toContain('First.ts');
  expect(heading().querySelector('[data-live]')).not.toBeNull();
  // A new action replaces a label that has been readable long enough at once…
  executions.read = { ...executions.read, status: 'success' };
  executions.write = { toolCallId: 'write', name: 'file_write', args: { path: 'Second.ts' }, status: 'running' };
  message = { ...message, content: [...message.content, { type: 'toolCall', id: 'write', name: 'file_write', arguments: { path: 'Second.ts', content: '' } }] };
  await render();
  expect(text()).toContain('Second.ts');
  // …but one that follows within 260ms waits its turn.
  await act(async () => { vi.advanceTimersByTime(50); });
  executions.write = { ...executions.write, status: 'success' };
  executions.list = { toolCallId: 'list', name: 'file_list', args: { path: 'src' }, status: 'running' };
  message = { ...message, content: [...message.content, { type: 'toolCall', id: 'list', name: 'file_list', arguments: { path: 'src' } }] };
  await render();
  await act(async () => { vi.advanceTimersByTime(100); });
  expect(text()).toContain('Second.ts');
  await settle();
  expect(text()).toContain('chat.dialogue.list');
});

test('redacted and disabled thinking never exposes text through the collapsed header', async () => {
  message = { ...message, content: [{ id: 'thought', type: 'thinking', thinking: 'Private content', redacted: true }] };
  await render();
  expect(container.textContent).not.toContain('Private content');
  expect(heading().textContent).toContain('chat.reasoningTrace.unavailable');
  expect(heading().querySelector('.thinking-preview')).toBeNull();
  await render(false, false);
  expect(container.children.length).toBe(0);
});
