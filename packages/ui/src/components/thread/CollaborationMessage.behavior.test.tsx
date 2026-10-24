import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict } from '@/lib/i18n/messages/en';
import { CollaborationMessage, CollaborationMessageBody } from './CollaborationMessage';
import type { CollaborationFeedItem, CollaborationMember } from './collaborationFeed';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, values?: Record<string, unknown>) =>
  Object.entries(values ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dict[key]) }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null, ContextMenuItem: () => null,
}));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: () => null, DropdownMenuItem: () => null,
}));
vi.mock('./CollaborationExchange', () => ({ CollaborationExchangeCard: () => null }));

let root: Root, container: HTMLDivElement, height: number;
const observations = new Set<() => void>();
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  for (const [key, value] of Object.entries({ window, document, HTMLElement: window.HTMLElement, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(key, value);
  height = 100;
  Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => height });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ height: 288 } as DOMRect);
  vi.stubGlobal('ResizeObserver', class {
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observations.add(callback); }
    observe() {} disconnect() { observations.delete(this.callback); }
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('folds by rendered height after reflow and keeps the complete message available through expansion', async () => {
  function Body() {
    const [expanded, setExpanded] = React.useState(false);
    return <CollaborationMessageBody id="original" text="Original body and its final passage" expanded={expanded} onExpandedChange={setExpanded} />;
  }
  await act(async () => root.render(<Body />));
  expect(container.querySelector('button')).toBeNull();
  height = 1200;
  await act(async () => observations.forEach(observe => observe()));
  const button = container.querySelector<HTMLButtonElement>('button')!;
  expect(button.textContent).toBe(dict['collaboration.expandMessage']);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  await act(async () => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(button.textContent).toBe(dict['collaboration.collapseMessage']);
  expect(container.textContent).toContain('Original body and its final passage');
  await act(async () => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('false');
  height = 100;
  await act(async () => observations.forEach(observe => observe()));
  expect(container.querySelector('button')).toBeNull();
});

const members: CollaborationMember[] = [
  { threadId: 'parent', name: 'Main Agent', agentId: 'V1', avatar: null },
  { threadId: 'worker', name: 'Layout review', agentId: 'V2', avatar: null },
];
const dispatch: CollaborationFeedItem = { id: 'dispatch:original', kind: 'dispatch', acceptedCursor: 1, acceptedAtMs: 1000,
  dispatch: { operationId: 'original', executionId: 'original-execution', senderThreadId: 'parent', senderBranchId: 'original-parent-branch',
    targetThreadId: 'worker', targetBranchId: 'original-worker-branch', acceptedCursor: 1, acceptedAtMs: 1000, task: 'Original delegated task', preset: 'worker' } };
it('shows dispatch participants and the original task, with navigation bound to the original branches', async () => {
  const onMember = vi.fn();
  await act(async () => root.render(<CollaborationMessage item={dispatch} members={members} expanded={false}
    onExpandedChange={() => {}} onMember={onMember} onReply={() => {}} onCopy={() => {}} onExchange={() => {}} />));
  expect(container.textContent).toContain('Main AgentToLayout review');
  expect(container.textContent).toContain(dict['collaboration.dispatch']);
  expect(container.textContent).toContain('Original delegated task');
  const open = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === dict['collaboration.openAgent'])!;
  await act(async () => open.click());
  expect(onMember).toHaveBeenCalledWith('worker', 'original-worker-branch');
  const sender = container.querySelector<HTMLButtonElement>('[aria-label="View Main Agent’s conversation"]')!;
  await act(async () => sender.click());
  expect(onMember).toHaveBeenCalledWith('parent', 'original-parent-branch');
});

it('keeps user identity distinct from the sending Thread and shows the actual recipient', async () => {
  const item: CollaborationFeedItem = { id: 'message:user', kind: 'message', acceptedCursor: 2, acceptedAtMs: 2000,
    message: { messageId: 'user', senderThreadId: 'parent', senderBranchId: 'original-parent-branch', targetThreadId: 'worker', targetBranchId: 'worker-branch',
      actor: { kind: 'user' }, kind: 'request', replyTo: null, acceptedCursor: 2, acceptedAtMs: 2000, text: 'Please check the result',
      state: 'queued', activation: { state: 'pending', executionId: null, holdReason: null }, replyWait: null, deliveredCursor: null, deliveredRunId: null } };
  await act(async () => root.render(<CollaborationMessage item={item} members={members} expanded={false}
    onExpandedChange={() => {}} onMember={() => {}} onReply={() => {}} onCopy={() => {}} onExchange={() => {}} />));
  expect(container.querySelector('article')?.getAttribute('data-outgoing')).toBe('true');
  expect(container.textContent).toContain('YouToLayout review');
  expect(container.textContent).toContain(dict['chat.messages.queued']);
});
