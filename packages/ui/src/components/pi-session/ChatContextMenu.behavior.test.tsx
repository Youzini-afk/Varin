import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { PiSessionEntry } from '@varin/protocol';
import { ChatContextMenu, ChatMoreButton, ChatTextSource } from './ChatContextMenu';
import { projectPiTimeline } from './piTimelineProjection';
import { usePiDraftStore, readPiDraft } from '@/stores/usePiDraftStore';

const mocks = vi.hoisted(() => ({ copy: vi.fn(), runtimeKey: 'runtime-a', capture: vi.fn(), memory: vi.fn() }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }));
vi.mock('./chatSelection', () => ({ captureChatSelection: mocks.capture }));
vi.mock('./ChatMemoryDialog', () => ({ ChatMemoryDialog: (props: unknown) => { mocks.memory(props); return <div data-memory-dialog />; } }));
vi.mock('@varin/application-client', async (original) => ({ ...(await original<object>()), getRuntimeKey: () => mocks.runtimeKey }));
// Exercise the chat controller while replacing only popup positioning/focus infrastructure.
vi.mock('@/components/ui/context-menu', async () => {
  const { createContext, useContext } = await import('react');
  const Menu = createContext({ open: false, change: (_open: boolean, _target: EventTarget | null) => {} });
  return {
    ContextMenu: ({ open, children, onOpenChange }: React.PropsWithChildren<{ open: boolean; onOpenChange(open: boolean, details: unknown): void }>) =>
      <Menu.Provider value={{ open, change: (next, target) => onOpenChange(next, { event: { target }, cancel: () => {} }) }}>{children}</Menu.Provider>,
    ContextMenuTrigger: ({ children }: React.PropsWithChildren) => {
      const menu = useContext(Menu);
      return <div onContextMenu={(event) => { event.preventDefault(); menu.change(true, event.target); }}>{children}</div>;
    },
    ContextMenuContent: ({ children }: React.PropsWithChildren) => useContext(Menu).open ? <div role="menu">{children}</div> : null,
    ContextMenuItem: ({ children, onClick, disabled }: React.PropsWithChildren<{ onClick(): void; disabled?: boolean }>) => {
      const menu = useContext(Menu);
      return <button disabled={disabled} onClick={(event) => { onClick(); menu.change(false, event.target); }}>{children}</button>;
    },
    ContextMenuSeparator: () => <hr />,
  };
});

describe('chat context actions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let selection: { isCollapsed: boolean; rangeCount: number; getRangeAt(): Range } | null;
  const user: PiSessionEntry = { id: 'user', type: 'message', parentId: null, timestamp: 'now', message: { role: 'user', timestamp: 1, content: 'My request.' } };
  const answer: PiSessionEntry = { id: 'answer', type: 'message', parentId: 'user', timestamp: 'now', message: {
    role: 'assistant', api: 'messages', provider: 'test', model: 'test', timestamp: 2, stopReason: 'stop', content: [{ type: 'text', text: 'A useful answer.' }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } };
  const entries = [user, answer];
  const projection = projectPiTimeline(entries);
  const fork = vi.fn();
  const recover = vi.fn();
  const render = async (currentProjection = projection) => act(async () => root.render(
    <ChatContextMenu sessionId="session" entries={entries} projection={currentProjection} onFork={fork} onRecover={recover} onRevealEntry={() => {}}>
      <div data-turn-id={currentProjection.items[0]!.id}>
        <article data-pi-entry-id="user"><span data-user>My request.</span></article>
        <article data-pi-entry-id="answer"><ChatTextSource entryId="answer" text="A useful answer." offset={0}>
          <p data-answer>A useful answer.</p></ChatTextSource><ChatMoreButton /></article>
        <pre><code data-code>const x = 1;</code></pre><a data-link href="https://example.org">Example</a><input />
      </div>
    </ChatContextMenu>,
  ));
  const open = async (selector: string) => act(async () => container.querySelector(selector)!.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true })));
  const click = async (key: string) => act(async () => {
    const button = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((button) => button.textContent === key)!;
    expect(button).toBeDefined(); button.click();
  });
  beforeEach(async () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('document', document); vi.stubGlobal('window', window);
    vi.stubGlobal('Element', window.Element); vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    selection = null; window.getSelection = () => selection as Selection | null;
    mocks.runtimeKey = 'runtime-a'; mocks.copy.mockReset().mockResolvedValue({ ok: true }); mocks.memory.mockClear();
    fork.mockClear(); recover.mockClear(); usePiDraftStore.setState({ drafts: {} });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await render();
  });
  afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

  it('targets a whole reply, a user entry, code or a link without capturing editable fields', async () => {
    await open('[data-answer]'); await click('chat.context.copyTurn'); expect(mocks.copy).toHaveBeenLastCalledWith('A useful answer.');
    await open('[data-user]'); await click('chat.messageBody.actions.revert'); expect(recover).toHaveBeenCalledWith(user);
    await open('[data-code]'); await click('chat.context.copyCode'); expect(mocks.copy).toHaveBeenLastCalledWith('const x = 1;');
    await open('[data-link]'); await click('chat.context.copyLink'); expect(mocks.copy).toHaveBeenLastCalledWith('https://example.org');
    await open('input'); expect(container.querySelector('[role="menu"]')).toBeNull();
  });
  it('freezes the selection before focus changes, quotes without replacing the draft, and rejects stale runtime actions', async () => {
    const range = { commonAncestorContainer: container.querySelector('[data-answer]')!, cloneRange() { return this; } } as unknown as Range;
    selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range };
    const passages = [{ entryId: 'answer', start: 2, text: 'useful' }];
    mocks.capture.mockReturnValue({ text: 'useful', passages, complete: true });
    await open('[data-answer]'); selection = null;
    await click('chat.context.extract'); expect(mocks.memory).toHaveBeenLastCalledWith(expect.objectContaining({ sources: passages, sessionId: 'session' }));
    usePiDraftStore.getState().setDraft('session', { text: 'Existing draft' });
    await open('[data-answer]'); await click('chat.context.quote');
    expect(readPiDraft('session').text).toContain('Existing draft');
    expect(readPiDraft('session').text).toContain('> A useful answer.');
    expect(readPiDraft('session').text).toContain('#varin-chat-source:session:answer');
    expect(readPiDraft('session').text.endsWith('\n\n')).toBe(true);
    await open('[data-answer]'); mocks.runtimeKey = 'runtime-b'; await click('chat.context.copyTurn');
    expect(mocks.copy).not.toHaveBeenCalled();
  });
  it('copies the current streamed reply while the virtual row identity stays unchanged', async () => {
    if (answer.type !== 'message' || answer.message.role !== 'assistant') throw new Error('expected assistant');
    const first = projectPiTimeline(entries, {
      ...answer.message, timestamp: 3, stopReason: 'pending', content: [{ type: 'text', text: 'Old delta' }],
    }, undefined, projection);
    const current = projectPiTimeline(entries, {
      ...answer.message, timestamp: 3, stopReason: 'pending', content: [{ type: 'text', text: 'Current delta' }],
    }, undefined, first);
    expect(current.items).toBe(first.items);
    await render(current);
    await open('[data-answer]');
    await click('chat.context.copyTurn');
    expect(mocks.copy).toHaveBeenLastCalledWith('A useful answer.\n\nCurrent delta');
  });

});
