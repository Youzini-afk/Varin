import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ExternalConversation, ExternalDelegation } from '@varin/application-client';
import { ExternalDelegateList } from './ExternalDelegates';
import opencode from '@/assets/harness-logos/opencode.svg';
import { ChatAgentMessageBubble } from '@/components/conversation/ChatAgentMessageBubble';

const state = vi.hoisted(() => ({ conversations: [] as ExternalConversation[], children: [] as ExternalDelegation[] }));
vi.mock('@/stores/useExternalAgentStore', () => ({ useExternalAgents: () => {},
  useExternalAgentStore: (select: (value: typeof state) => unknown) => select(state), openConversationFromNavigation: vi.fn() }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: (select: (value: object) => unknown) => select({ threads: [{ thread_id: 'parent', title: 'Coordinator', avatar: 'native-role' }] }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/AgentAvatar', () => ({ AgentAvatar: ({ identity }: { identity: string }) => <span data-native-avatar={identity} /> }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
const render = (element: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;
beforeEach(() => {
  state.conversations = [{ id: 'work', configurationId: 'opencode', harness: 'acp', title: 'Claude Code', cwd: '/work' } as ExternalConversation];
  state.children = [{ operationId: 'dispatch', conversationId: 'work', parentThreadId: 'parent', parentBranchId: 'branch', name: 'Audit',
    harness: 'acp', configurationId: 'opencode', avatar: 'role-portrait', state: 'running', reportReady: false, acceptedAtMs: 1 }];
});
it('places one product logo in a delegated task main slot instead of the role avatar and duplicate badge', () => {
  const document = render(<ExternalDelegateList parentThreadId="parent" />);
  expect(document.querySelectorAll('img')).toHaveLength(1);
  expect(document.querySelector('img')?.getAttribute('src')).toBe(opencode);
  expect(document.querySelector('[data-native-avatar]')).toBeNull();
  expect(document.body.textContent).toContain('Audit');
});
it('uses the same product mark for manual and dispatched collaboration participants, preserving native avatars', () => {
  state.children = [];
  const outgoing = render(<ChatAgentMessageBubble id="send" senderThreadId="parent" targetThreadId="work" text="Check it"><p>Check it</p></ChatAgentMessageBubble>);
  expect(outgoing.querySelector('[data-native-avatar="parent"]')).not.toBeNull();
  expect(outgoing.querySelector('.chat-agent-message-route img')?.getAttribute('src')).toBe(opencode);
  expect(outgoing.body.textContent).toContain('Claude Code');
  const incoming = render(<ChatAgentMessageBubble id="reply" senderThreadId="work" targetThreadId="parent" text="Done"><p>Done</p></ChatAgentMessageBubble>);
  expect(incoming.querySelector('.chat-agent-message-avatar img')?.getAttribute('src')).toBe(opencode);
  expect(incoming.querySelector('[data-native-avatar="parent"]')).not.toBeNull();
});
it('keeps the admitted product identity before the conversation directory catches up', () => {
  state.conversations = [];
  const document = render(<ChatAgentMessageBubble id="report" senderThreadId="work" targetThreadId="parent" text="Done"><p>Done</p></ChatAgentMessageBubble>);
  expect(document.querySelector('.chat-agent-message-avatar img')?.getAttribute('src')).toBe(opencode);
});
