import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@varin/protocol';
import { RegularChatView } from './RegularChatView';
import { regularPiSessions, useBotSessionIndex } from '@/stores/useBotSessionIndex';

const session = vi.hoisted(() => ({ runtimeKey: 'host-a', currentSessionId: 'bot-entry' as string | null }));
vi.mock('@/stores/usePiSessionStore', () => ({ usePiSessionStore: (selector: (state: typeof session) => unknown) => selector(session) }));
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
  session.currentSessionId = 'bot-entry';
  useBotSessionIndex.setState({ runtimeKey: 'host-a', ids: new Set(['bot-entry', 'bot-work']), loading: false, error: null });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('does not mount a Bot entry or work conversation in an ordinary shell', async () => {
  await act(async () => { root.render(<RegularChatView active />); });
  expect(container.querySelector('[data-testid="chat-view"]')).toBeNull();

  session.currentSessionId = 'bot-work';
  await act(async () => { root.render(<RegularChatView active />); });
  expect(container.querySelector('[data-testid="chat-view"]')).toBeNull();

  session.currentSessionId = 'ordinary-session';
  await act(async () => { root.render(<RegularChatView active />); });
  expect(container.querySelector('[data-testid="chat-view"]')).not.toBeNull();
});

it('keeps Bot conversations out of ordinary session navigation, including while ownership loads', () => {
  const summaries = ['bot-entry', 'ordinary-session', 'bot-work'].map((id) => ({ id })) as SessionSummary[];
  expect(regularPiSessions(summaries, useBotSessionIndex.getState(), 'host-a').map((item) => item.id))
    .toEqual(['ordinary-session']);
  expect(regularPiSessions(summaries, { runtimeKey: 'host-b', ids: null }, 'host-a')).toEqual([]);
});
