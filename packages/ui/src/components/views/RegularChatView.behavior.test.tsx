import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RegularChatView } from './RegularChatView';
import { useThreadStore } from '@/stores/useThreadStore';
import type { ThreadSummary } from '@varin/protocol';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./ChatView', () => ({ ChatView: () => <div data-testid="chat-view" /> }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useThreadStore.setState({ selectedIdentity: { runtime: 'agent', threadId: 'bot-entry', branchId: 'main' }, threads: ['bot-entry', 'bot-work', 'ordinary-thread'].map(thread_id => ({ thread_id, bot_id: thread_id.startsWith('bot-') ? 'bot' : null })) as ThreadSummary[] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('does not mount a Bot entry or work conversation in an ordinary shell', async () => {
  await act(async () => { root.render(<RegularChatView active />); });
  expect(container.querySelector('[data-testid="chat-view"]')).toBeNull();

  useThreadStore.setState({ selectedIdentity: { runtime: 'agent', threadId: 'bot-work', branchId: 'main' } });
  await act(async () => { root.render(<RegularChatView active />); });
  expect(container.querySelector('[data-testid="chat-view"]')).toBeNull();

  useThreadStore.setState({ selectedIdentity: { runtime: 'agent', threadId: 'ordinary-thread', branchId: 'main' } });
  await act(async () => { root.render(<RegularChatView active />); });
  expect(container.querySelector('[data-testid="chat-view"]')).not.toBeNull();
});
