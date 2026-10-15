import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatContextMenu, ChatTextSource } from './ChatContextMenu';
import { ChatTurnNavigator } from './ChatTurnNavigator';
import { ConversationContext, type ConversationPresentation } from './ConversationContext';
import { projectChatTimeline, resolveChatTimelineItem } from './chatTimelineProjection';
import type { ChatSessionMessageEntry } from './types';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => true }));
vi.mock('./ChatMemoryDialog', () => ({ ChatMemoryDialog: () => null }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: React.PropsWithChildren) => children,
  motion: { div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) => <div {...props} ref={ref}>{children}</div>) },
}));
// Keep the context menu's DOM target and action behavior, without testing popup geometry here.
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children, onOpenChange }: React.PropsWithChildren<{ onOpenChange(open: boolean, details: { event: Event; cancel(): void }): void }>) =>
    <div onContextMenu={event => onOpenChange(true, { event: event.nativeEvent, cancel() {} })}>{children}</div>,
  ContextMenuTrigger: ({ children }: React.PropsWithChildren) => children,
  ContextMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
  ContextMenuItem: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  ContextMenuSeparator: () => <hr />,
}));

const user: ChatSessionMessageEntry = { id: 'user:original', parentId: null, timestamp: '', type: 'message', message: { role: 'user', content: 'Original request', timestamp: 0 } };
const answer: ChatSessionMessageEntry = { id: 'answer:original', parentId: user.id, timestamp: '', type: 'message', message: { id: 'answer:original', role: 'assistant', content: [{ type: 'text', text: 'Original answer' }], timestamp: 0, model: 'original-model', provider: '', api: '', stopReason: 'stop' } };
const nextUser: ChatSessionMessageEntry = { ...user, id: 'user:next', parentId: answer.id, message: { role: 'user', content: 'Next request', timestamp: 1 } };
const entries = [user, answer, nextUser];
const projection = projectChatTimeline(entries);
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  window.getSelection = () => ({ isCollapsed: true, rangeCount: 0 }) as Selection;
  vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100, left: 0, right: 100, height: 100, width: 100, x: 0, y: 0, toJSON() {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps the original history identity for right-click quote, fork and recovery', async () => {
  const quote = vi.fn(), fork = vi.fn(), recover = vi.fn();
  const presentation = { quote, identity: { runtime: 'agent', threadId: 'thread', branchId: 'branch' }, head: answer.id, toolExecutions: {} } as unknown as ConversationPresentation;
  await act(async () => root.render(<ConversationContext.Provider value={presentation}>
    <ChatContextMenu sessionId="conversation" entries={entries} projection={projection} onFork={fork} onRecover={recover} onRevealEntry={() => {}}>
      <article data-conversation-entry-id={user.id} data-conversation-user-message>
        <ChatTextSource entryId={user.id} text="Original request" offset={0}><p>Original request</p></ChatTextSource>
      </article>
    </ChatContextMenu>
  </ConversationContext.Provider>));
  await act(async () => container.querySelector('p')!.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true })));
  const choose = async (label: string) => {
    const action = [...container.querySelectorAll('button')].find(button => button.textContent === label);
    expect(action).toBeDefined();
    await act(async () => action!.click());
  };
  await choose('chat.context.quote');
  expect(quote).toHaveBeenCalledWith(expect.stringContaining('#varin-chat-source:conversation:user%3Aoriginal'));
  await choose('chat.messageBody.actions.fork');
  await choose('chat.messageBody.actions.revert');
  expect(fork).toHaveBeenCalledWith(user); expect(recover).toHaveBeenCalledWith(user);
});

it('moves between prompt and response markers with Arrow keys, Home and End', async () => {
  const select = vi.fn();
  await act(async () => root.render(<ChatTurnNavigator items={projection.items} sorted={false} initialIndex={0}
    readItem={index => resolveChatTimelineItem(projection.items[index]!, projection.liveItem)} onSelect={select} />));
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('nav button')];
  expect(buttons).toHaveLength(3);
  const focus = buttons.map(button => vi.spyOn(button, 'focus'));
  const key = async (index: number, value: string) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value });
    await act(async () => buttons[index]!.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  };
  await key(0, 'ArrowDown'); expect(focus[1]).toHaveBeenCalledOnce();
  await key(1, 'End'); expect(focus[2]).toHaveBeenCalledOnce();
  await key(2, 'Home'); expect(focus[0]).toHaveBeenCalledOnce();
  await key(1, 'ArrowUp'); expect(focus[0]).toHaveBeenCalledTimes(2);
  await act(async () => buttons[1]!.click());
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ rowId: projection.items[0]!.id, role: 'assistant' }));
});
