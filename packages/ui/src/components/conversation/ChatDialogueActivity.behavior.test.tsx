import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ChatDialogueActivity } from './ChatDialogueActivity';
import { projectChatDialogue } from './chatDialogueProjection';
import type { ChatAssistantMessage, ChatToolExecutionState } from './types';

vi.mock('@/lib/i18n', async original => ({
  ...await original<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => key + (values ? JSON.stringify(values) : '') }),
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => false }));
let root: Root, container: HTMLElement, height: number, message: ChatAssistantMessage;
let executions: Record<string, ChatToolExecutionState>;
const scroll = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number, y?: number) { this.scrollTop = typeof options === 'number' ? y ?? 0 : options?.top ?? 0; });
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  height = 60; scroll.mockClear();
  Object.defineProperties(window.HTMLElement.prototype, { clientHeight: { configurable: true, get: () => 20 }, scrollHeight: { configurable: true, get: () => height } });
  window.HTMLElement.prototype.scrollTo = scroll;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  message = { id: 'assistant', runId: 'run', role: 'assistant', model: '', provider: '', api: '', timestamp: 0, stopReason: 'pending',
    content: [{ id: 'thought', type: 'thinking', thinking: 'Inspect the layout first.' }] };
  executions = {};
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const render = async (history = false, showThinking = true) => {
  const items = history ? projectChatDialogue([{ type: 'message', id: 'history', runId: 'run', parentId: null, timestamp: '', message }], undefined, { showThinking })
    : projectChatDialogue([], message, { showThinking });
  const item = items[0];
  await act(async () => root.render(item?.kind === 'process' ? <ChatDialogueActivity process={item} executions={executions} results={new Map()}
    active={!history} renderActivity={() => <div data-expanded-content>Details</div>} /> : null));
};
const heading = () => container.querySelector('summary')!;

test('collapsed dialogue thinking follows the latest visual line and survives streaming-to-history replacement', async () => {
  await render();
  const preview = heading().querySelector<HTMLElement>('.thinking-preview')!;
  expect(heading().textContent).toContain('Inspect the layout first.');
  expect(preview.scrollTop).toBe(40);
  expect(container.querySelector('[data-expanded-content]')).toBeNull();
  height = 80;
  message = { ...message, content: [{ id: 'thought', type: 'thinking', thinking: 'Inspect the layout first. Now check the plan editor.' }] };
  await render();
  expect(heading().querySelector('.thinking-preview')).toBe(preview);
  expect(heading().textContent).toContain('Now check the plan editor.');
  expect(scroll).toHaveBeenLastCalledWith({ top: 60, behavior: 'smooth' });
  message = { ...message, stopReason: 'stop' };
  await render(true);
  expect(heading().querySelector('.thinking-preview')).toBe(preview);
  expect(heading().textContent).toContain('chat.dialogue.thinking');
  expect(heading().textContent).not.toContain('chat.dialogue.thinkingNow');
});

test('tool activity replaces the thinking preview and a completed mixed segment retains its receipt summary', async () => {
  await render();
  message = { ...message, content: [...message.content, { type: 'toolCall', id: 'read', name: 'file_read', arguments: { path: 'ThreadPlan.tsx' } }] };
  executions.read = { toolCallId: 'read', name: 'file_read', args: { path: 'ThreadPlan.tsx' }, status: 'success' };
  await render();
  expect(heading().querySelector('.thinking-preview')).toBeNull();
  expect(heading().textContent).toContain('ThreadPlan.tsx');
  message = { ...message, stopReason: 'stop' };
  await render(true);
  expect(heading().textContent).toContain('chat.activity.reads{"count":1}');
  expect(heading().querySelector('.thinking-preview')).toBeNull();
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
