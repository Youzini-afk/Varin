import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadSummary } from '@varin/protocol';
import { ConversationSidebar } from './ConversationSidebar';
import { useThreadStore } from '@/stores/useThreadStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';
import { captureDialogOrigin, dialogOrigin } from '@/lib/motion/dialogOrigin';
import { getRuntimeKey } from '@varin/application-client';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  returnFocus: [] as Array<() => void>,
  translate: (key: string) => key,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: ({ name }: { name: string }) => <span data-icon={name} /> }));
vi.mock('@/components/ui/AgentAvatar', () => ({ AgentAvatar: () => null }));
// This fixture checks the sidebar's delegation mark; appearance loading has its own Host/asset tests.
vi.mock('@/workbenches/bot/BotFigure', () => ({ BotFigure: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ files: {} }) }));
vi.mock('@/lib/desktop', () => ({ canUseElectronDesktopIPC: () => false, isDesktopLocalOriginActive: () => false }));
vi.mock('@/components/layout/ProjectActionsButton', () => ({ ProjectActionsButton: () => null }));
vi.mock('@/components/layout/WorkbenchProfileSwitcher', () => ({ WorkbenchProfileSwitcher: () => null }));
vi.mock('@/lib/extensions/workbench-registry', () => ({ useWorkbenchMatchRenderers: () => [], renderFirstWorkbenchMatch: () => null }));
vi.mock('@/components/ui/tooltip', () => {
  const Children = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return { TooltipProvider: Children, Tooltip: Children, TooltipTrigger: Children, TooltipContent: () => null };
});
vi.mock('@/components/ui/dialog', () => ({
  Dialog: () => null, DialogContent: () => null, DialogDescription: () => null,
  DialogFooter: () => null, DialogHeader: () => null, DialogTitle: () => null,
}));
// Linkedom supplies DOM input events without the browser's React change-event normalization.
vi.mock('@/components/ui/input', () => ({
  Input: ({ onChange, ...props }: React.ComponentProps<'input'>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} />,
}));

// Preserve the menu contract relevant to editing: close completion starts the editor, then the
// closing popup resolves finalFocus. Positioning and CSS transitions are outside this regression.
vi.mock('@/components/ui/context-menu', async () => {
  const { createContext, useContext, useRef, useState } = await import('react');
  type MenuProps = React.PropsWithChildren<{ onOpenChange?(open: boolean): void; onOpenChangeComplete?(open: boolean): void }>;
  const Menu = createContext<{
    open: boolean; toggle(open: boolean): void;
    trigger: React.RefObject<HTMLDivElement | null>;
    finalFocus: React.RefObject<(() => boolean) | undefined>;
  }>(null!);
  const ContextMenu = ({ children, onOpenChange, onOpenChangeComplete }: MenuProps) => {
    const [open, setOpen] = useState(false);
    const trigger = useRef<HTMLDivElement>(null);
    const finalFocus = useRef<(() => boolean) | undefined>(undefined);
    const toggle = (next: boolean) => {
      onOpenChange?.(next);
      setOpen(next);
      onOpenChangeComplete?.(next);
      if (!next) mocks.returnFocus.push(() => {
        if (finalFocus.current?.() !== false) trigger.current?.focus();
      });
    };
    return <Menu.Provider value={{ open, toggle, trigger, finalFocus }}>{children}</Menu.Provider>;
  };
  const Trigger = ({ children, dropdown = false }: React.PropsWithChildren<{ dropdown?: boolean }>) => {
    const menu = useContext(Menu);
    const open = (event: React.SyntheticEvent) => { event.stopPropagation(); menu.toggle(true); };
    return <div ref={menu.trigger} onContextMenu={dropdown ? undefined : open} onClick={dropdown ? open : undefined}>{children}</div>;
  };
  const ContextMenuContent = ({ children, finalFocus }: React.PropsWithChildren<{ finalFocus?: () => boolean }>) => {
    const menu = useContext(Menu);
    menu.finalFocus.current = finalFocus;
    return menu.open ? <div role="menu">{children}</div> : null;
  };
  const ContextMenuItem = ({ children, onClick, disabled }: React.PropsWithChildren<{ onClick?(): void; disabled?: boolean }>) => {
    const menu = useContext(Menu);
    return <button role="menuitem" disabled={disabled} onClick={(event) => {
      event.stopPropagation(); onClick?.(); menu.toggle(false);
    }}>{children}</button>;
  };
  return {
    ContextMenu, ContextMenuTrigger: Trigger, ContextMenuContent, ContextMenuItem,
    ContextMenuSeparator: () => null,
    DropdownTrigger: ({ children }: React.PropsWithChildren) => <Trigger dropdown>{children}</Trigger>,
  };
});
vi.mock('@/components/ui/dropdown-menu', async () => {
  const menu = await vi.importMock<Record<string, React.ComponentType>>('@/components/ui/context-menu');
  const Children = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return {
    DropdownMenu: menu.ContextMenu, DropdownMenuTrigger: menu.DropdownTrigger,
    DropdownMenuContent: menu.ContextMenuContent, DropdownMenuItem: menu.ContextMenuItem,
    DropdownMenuSeparator: () => null, DropdownMenuLabel: Children,
    DropdownMenuRadioGroup: Children, DropdownMenuRadioItem: Children,
  };
});

let root: Root;
let container: HTMLDivElement;
const summary = (id: string, title: string, parentId: string | null): ThreadSummary => ({
  thread_id: id, main_branch_id: `${id}-main`, title, revision: 1, created_at_ms: 1, updated_at_ms: 1,
  pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false,
  bot_id: null, parent_thread_id: parentId, observer_project_ids: [null],
  branches: [{ branch_id: `${id}-main`, head: null, active_run_id: null, latest_run: null }],
});
const titleButton = (title: string) => Array.from(container.querySelectorAll('button')).find(button => button.firstElementChild?.textContent === title)!;
const pressKey = async (input: HTMLInputElement, key: string) => {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value: key });
  await act(async () => { input.dispatchEvent(event); });
};
const openMenu = async (title: string, menu: 'context' | 'dropdown') => {
  await act(async () => {
    const row = titleButton(title).parentElement!;
    if (menu === 'context') row.dispatchEvent(new window.Event('contextmenu', { bubbles: true }));
    else row.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.menu.label"]')!.click();
  });
};
const restoreMenuFocus = async () => { await act(async () => { mocks.returnFocus.splice(0).forEach(restore => restore()); }); };
const openRename = async (title: string, menu: 'context' | 'dropdown') => {
  await openMenu(title, menu);
  await act(async () => {
    const rename = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find(button => button.textContent === 'sessions.sidebar.session.menu.rename');
    expect(rename).toBeDefined();
    rename!.click();
  });
  await restoreMenuFocus();
  const input = container.querySelector('input');
  expect(input).not.toBeNull();
  expect(document.activeElement).toBe(input);
  return input!;
};

beforeEach(async () => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  let active: HTMLElement | null = null;
  Object.defineProperty(document, 'activeElement', { get: () => active ?? document.body });
  const focusElement = (element: HTMLElement) => {
    if (active === element) return;
    const previous = active; active = element;
    previous?.dispatchEvent(new window.Event('focusout', { bubbles: true }));
    element.dispatchEvent(new window.Event('focusin', { bubbles: true }));
  };
  window.HTMLElement.prototype.focus = function () { focusElement(this); };
  window.HTMLElement.prototype.blur = function () {
    if (active !== this) return;
    active = null; this.dispatchEvent(new window.Event('focusout', { bubbles: true }));
  };
  mocks.returnFocus.length = 0;
  mocks.update.mockReset().mockImplementation(async (id: string, patch: Partial<ThreadSummary>) => {
    useThreadStore.setState(state => ({ threads: state.threads.map(thread => thread.thread_id === id ? { ...thread, ...patch } : thread) }));
  });
  useThreadStore.setState({ threads: [summary('parent', 'Parent conversation', null), summary('child', 'Child task', 'parent')],
    selectedIdentity: null, catalogLoaded: true, catalogLoading: false, catalogError: null,
    updateThread: mocks.update, loadCatalog: async () => {},
  });
  useProjectsStore.setState({ projects: [] });
  useSessionDisplayStore.setState({ sessionGroupingMode: 'by-worktree', showRecentSection: true, projectsSectionCollapsed: false,
    conversationTreeByHost: { [getRuntimeKey()]: { groups: {}, sessions: { parent: true } } },
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<ConversationSidebar />); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('starts child task trees collapsed, remembers both choices after remount, and keeps newly added trees closed', async () => {
  await act(async () => useSessionDisplayStore.setState({ conversationTreeByHost: {} }));
  expect(titleButton('Parent conversation')).toBeDefined();
  expect(titleButton('Child task')).toBeUndefined();
  const toggleParent = () => container.querySelector<HTMLButtonElement>('[data-sidebar-row="parent"] [aria-expanded]')!.click();
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<ConversationSidebar />));
  };
  await act(async () => toggleParent());
  expect(titleButton('Child task')).toBeDefined();
  await remount();
  expect(titleButton('Child task')).toBeDefined();
  await act(async () => toggleParent());
  await remount();
  expect(titleButton('Child task')).toBeUndefined();
  await act(async () => useThreadStore.setState(state => ({ threads: [...state.threads,
    summary('another', 'Another conversation', null), summary('another-child', 'New child task', 'another'),
  ] })));
  expect(titleButton('Another conversation')).toBeDefined();
  expect(titleButton('New child task')).toBeUndefined();
});

it('restores a collapsed project group after remount and search reveals matches without changing its saved state', async () => {
  const group = () => container.querySelector<HTMLButtonElement>('[data-flip-key="group:recent"] button[aria-expanded]')!;
  await act(async () => group().click());
  expect(titleButton('Parent conversation')).toBeUndefined();
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(<ConversationSidebar />));
  expect(group().getAttribute('aria-expanded')).toBe('false');
  const searchButton = container.querySelector<HTMLButtonElement>('button[aria-label="sessions.sidebar.header.actions.searchSessions"]');
  expect(searchButton).not.toBeNull();
  await act(async () => searchButton!.click());
  const input = container.querySelector('input')!;
  await act(async () => { input.value = 'Child task'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  expect(titleButton('Child task')).toBeDefined();
  await act(async () => { input.value = ''; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  expect(group().getAttribute('aria-expanded')).toBe('false');
  expect(titleButton('Child task')).toBeUndefined();
});

it.each([
  ['settings', 'settings'], ['shortcuts', 'help'], ['aboutVarin', 'settings'],
] as const)('opens the %s footer surface from its own button', async (action, key) => {
  useUIStore.setState({ isSettingsDialogOpen: false, isHelpDialogOpen: false, settingsPage: 'home' });
  captureDialogOrigin('settings'); captureDialogOrigin('help');
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="sessions.sidebar.footer.actions.${action}"]`)!;
  expect(button).not.toBeNull();
  Object.assign(button, { getBoundingClientRect: () => ({ left: 24, top: 720, width: 36, height: 36 }) });
  await act(async () => button.click());
  // Help still animates from its trigger; Settings now owns its full-page transition.
  if (key === 'help') expect(dialogOrigin(key)?.element.deref()).toBe(button);
  expect(useUIStore.getState().isSettingsDialogOpen).toBe(key === 'settings');
  expect(useUIStore.getState().isHelpDialogOpen).toBe(key === 'help');
  if (action === 'aboutVarin') expect(useUIStore.getState().settingsPage).toBe('about');
  await act(async () => { useUIStore.getState().setSettingsDialogOpen(false); useUIStore.getState().setHelpDialogOpen(false); });
});

it.each(['completed', 'failed'] as const)('keeps unread %s child tasks quiet while retaining the parent reminder', async state => {
  await act(async () => {
    useThreadStore.setState(store => ({ threads: store.threads.map(thread => ({ ...thread, unread: true,
      branches: thread.branches.map(branch => ({ ...branch, latest_run: { state } as NonNullable<typeof branch.latest_run> })),
    })) }));
  });
  const parent = titleButton('Parent conversation').parentElement!;
  const child = titleButton('Child task').parentElement!;
  expect(parent.querySelector(`[data-icon="${state === 'failed' ? 'error-warning' : 'notification-3'}"]`)).not.toBeNull();
  expect(child.querySelector('[data-icon="notification-3"], [data-icon="error-warning"]')).toBeNull();
  expect(useThreadStore.getState().threads.find(thread => thread.thread_id === 'child')?.unread).toBe(true);
});

it.each(['context', 'dropdown'] as const)('keeps the %s rename editor focused, saves the child, and can rename again', async menu => {
  let input = await openRename('Child task', menu);
  expect(input.value).toBe('Child task');
  await act(async () => { input.value = 'Renamed child'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await pressKey(input, 'Enter');
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith('child', { title: 'Renamed child' });
  expect(titleButton('Renamed child')).toBeDefined();
  input = await openRename('Renamed child', menu);
  await act(async () => { input.value = 'Discard this'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await pressKey(input, 'Escape');
  expect(container.querySelector('input')).toBeNull();
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(titleButton('Renamed child')).toBeDefined();
  await openMenu('Renamed child', menu);
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find(button => button.textContent === 'sessions.sidebar.session.menu.pin')!.click();
  });
  await restoreMenuFocus();
  expect(mocks.update).toHaveBeenLastCalledWith('child', { pinned: true });
  expect(container.querySelector('input')).toBeNull();
  expect(document.activeElement).not.toBe(document.body);
});

it('restores automatic titles from a manually named root conversation', async () => {
  await act(async () => { useThreadStore.setState(state => ({ threads: state.threads.map(thread => ({ ...thread, title_mode: 'manual' as const })) })); });
  await openMenu('Parent conversation', 'context');
  const resume = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(button => button.textContent === 'sessions.sidebar.session.menu.resumeTitles');
  expect(resume).toBeDefined(); await act(async () => resume!.click());
  expect(mocks.update).toHaveBeenLastCalledWith('parent', { titleMode: 'automatic' });
});

it('saves a parent title on blur without changing its child', async () => {
  const input = await openRename('Parent conversation', 'context');
  await act(async () => { input.value = 'Renamed parent'; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  await act(async () => { titleButton('Child task').focus(); });
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith('parent', { title: 'Renamed parent' });
  expect(titleButton('Child task')).toBeDefined();
});

it('omits direct Bot conversations while keeping delegated work visible', async () => {
  await act(async () => {
    useThreadStore.setState(store => ({ threads: [...store.threads,
      { ...summary('bot-session', 'Bot conversation', null), bot_id: 'varin' },
      { ...summary('bot-work', 'Delegated draft', 'bot-session'), bot_id: 'varin' },
    ] }));
  });
  expect(titleButton('Bot conversation')).toBeUndefined();
  const delegated = titleButton('Delegated draft');
  expect(delegated).toBeDefined();
  expect(delegated.querySelector('[aria-label="bot.sidebar.delegated"]')).not.toBeNull();
  expect(titleButton('Child task').querySelector('[aria-label="bot.sidebar.delegated"]')).toBeNull();
});
