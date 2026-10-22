import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict } from '@/lib/i18n/messages/en';
import { useUIStore } from '@/stores/useUIStore';
import { ChatThinkingBlock } from './ChatThinkingBlock';
import { TimelineSessionContext } from './toolDisclosureContext';
import { projectChatSortedTurn } from './chatSortedTurnProjection';
import type { ChatAssistantMessage } from './types';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict) => dict[key] }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));

let root: Root;
let container: HTMLDivElement;
let sessionId: string;
let text: string;
let streaming: boolean;
let messageId: string;
let redacted: boolean;
const render = () => act(async () => root.render(<TimelineSessionContext.Provider value={sessionId}>
  <ChatThinkingBlock key={messageId} content={{ type: 'thinking', thinking: text, redacted }}
    messageId={messageId} streaming={streaming} label="Thinking" />
</TimelineSessionContext.Provider>));
const heading = () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;

beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element,
    Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  window.HTMLElement.prototype.scrollTo = vi.fn();
  useUIStore.setState({ showReasoningTraces: true, collapsibleThinkingBlocks: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  sessionId = crypto.randomUUID(); messageId = 'request-a:thinking:0'; text = 'First thought'; streaming = true; redacted = false;
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('previews new thinking while collapsed and preserves a manual choice through completion and remount', async () => {
  await render();
  expect(heading().getAttribute('aria-expanded')).toBe('false');
  text += ' Then inspect the new evidence.'; await render();
  expect(container.textContent).toContain('Then inspect the new evidence.');
  expect(heading().getAttribute('aria-expanded')).toBe('false');
  await act(async () => heading().click());
  streaming = false; await render();
  expect(heading().getAttribute('aria-expanded')).toBe('true');
  await act(async () => root.render(null));
  await render();
  expect(heading().getAttribute('aria-expanded')).toBe('true');
  messageId = 'request-b:thinking:0'; streaming = true; await render();
  expect(heading().getAttribute('aria-expanded')).toBe('false');
});

it('can collapse automatically expanded thinking without unmounting the animated body', async () => {
  useUIStore.setState({ collapsibleThinkingBlocks: false });
  await render();
  expect(heading().getAttribute('aria-expanded')).toBe('true');
  const body = container.querySelector('[role="region"]');
  await act(async () => heading().click());
  text += ' More output'; streaming = false; await render();
  expect(heading().getAttribute('aria-expanded')).toBe('false');
  const panel = document.getElementById(heading().getAttribute('aria-controls')!)!;
  expect(panel.hasAttribute('inert')).toBe(true);
  expect(panel.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('[role="region"]')).toBe(body);
});

it('pauses following when reading above, retains that position after folding and resumes on request', async () => {
  useUIStore.setState({ collapsibleThinkingBlocks: false }); await render();
  const viewport = container.querySelector<HTMLDivElement>('[role="region"]')!;
  let height = 1000, top = 0;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 300 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(height - 300, value)); } },
  });
  text += ' More'; await render(); expect(top).toBe(700);
  await act(async () => { viewport.scrollTop = 250; viewport.dispatchEvent(new window.Event('scroll')); });
  height = 1300; text += ' Newer'; await render(); expect(top).toBe(250);
  await act(async () => heading().click());
  await act(async () => heading().click());
  expect(top).toBe(250);
  const follow = [...container.querySelectorAll('button')].find(button => button.textContent === dict['chat.tools.followOutput'])!;
  await act(async () => follow.click()); expect(top).toBe(1000);
  height = 1500; text += ' Latest'; await render(); expect(top).toBe(1200);
});

it('hides unavailable or disabled thinking without exposing its body', async () => {
  redacted = true; text = 'Must remain hidden'; await render();
  expect(heading().disabled).toBe(true);
  expect(container.textContent).not.toContain(text);
  expect(container.querySelector('[role="region"]')).toBeNull();
  await act(async () => useUIStore.setState({ showReasoningTraces: false }));
  expect(container.children.length).toBe(0);
});

it('keeps sorted thinking identity when a live assistant becomes a history entry', () => {
  const message: ChatAssistantMessage = { id: 'native-assistant-a', api: '', provider: '', model: '', role: 'assistant', timestamp: 0,
    stopReason: 'pending', content: [{ type: 'thinking', thinking: 'Read the evidence' }] };
  const live = projectChatSortedTurn([], message);
  const history = projectChatSortedTurn([{ type: 'message', id: 'history-entry-a', parentId: null, timestamp: '',
    message: { ...message, stopReason: 'stop' } }]);
  expect(live.activity[0]?.id).toBe(history.activity[0]?.id);
  const next = projectChatSortedTurn([], { ...message, id: 'native-assistant-b' });
  expect(next.activity[0]?.id).not.toBe(live.activity[0]?.id);
});
