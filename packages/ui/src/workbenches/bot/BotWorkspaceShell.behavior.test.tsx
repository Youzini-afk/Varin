import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run, ThreadSummary } from '@varin/protocol';
import type { BotEntryResult } from '@varin/application-client';
import { BotWorkspaceShell } from './BotWorkspaceShell';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import { useBotNavigation, useBotReturn, type BotSession, type BotSummary, type BotWorkItem } from '@/lib/bots';
import { threadSummary } from '@/test/threadFixtures';
import { useBotLayout } from './botLayout';
import { BOT_CONVERSATION_PANEL_SCOPE } from '@/lib/openConversationTree';
import { useOpenThreadContext } from '@/lib/openThreadContext';

const state = vi.hoisted(() => ({
  profileId: 'varin.bot', mobile: false,
  list: vi.fn(), ensure: vi.fn(), primary: vi.fn(), work: vi.fn(), sessions: vi.fn(), createSession: vi.fn(), memory: vi.fn(), schedules: vi.fn(),
  create: vi.fn(), update: vi.fn(), archive: vi.fn(), open: vi.fn(), change: vi.fn(), openWork: vi.fn(), activity: vi.fn(), presence: vi.fn(),
  fork: vi.fn(), copy: vi.fn(), arrangements: vi.fn(), eventSources: vi.fn(),
}));
vi.mock('@/lib/bots', async original => ({
  ...await original<typeof import('@/lib/bots')>(),
  listBots: state.list,
  ensureBotEntry: state.ensure,
  ensurePrimaryBot: state.primary,
  listBotWork: state.work,
  listBotSessions: state.sessions,
  createBotSession: state.createSession,
  listBotMemory: state.memory,
  listBotSchedules: state.schedules,
  readBotActivity: state.activity,
  readBotPresence: state.presence,
  createBot: state.create,
  updateBot: state.update,
  archiveBot: state.archive,
  changeBotState: state.change,
  openBotWorkInWorkbench: state.openWork,
  deleteBot: vi.fn(),
}));
vi.mock('@/hooks/useRuntimeAPIs', () => { const threads = { fork: state.fork, sources: { list: async () => ({ targets: [], unavailable: [] }) }, followups: { arrangements: state.arrangements, eventSources: state.eventSources } }; return { useRuntimeAPIs: () => ({ threads }) }; });
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: state.copy }));
vi.mock('@/lib/computers', () => ({ listComputers: async () => ({ desktops: [], machines: [], defaultDesktopId: null }) }));
vi.mock('./BotWorkDetail', async () => {
  const { useBotPanel } = await import('./botPanelModel');
  return { BotWorkDetail: ({ identity }: { identity: import('@varin/application-client').ThreadIdentity }) => {
    const model = useBotPanel(); return <div data-work-detail={identity.threadId}><button onClick={() => model.openWork(identity, { tab: 'overview', id: `${identity.threadId}\0${identity.branchId}` })}>bot.workspace.openProcess</button></div>;
  } };
});
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => undefined }));
vi.mock('@/components/layout/ContextSidebarTab', () => ({ ContextPanelContent: ({ identity, jobRunId, readOnly }: { identity?: { threadId: string; branchId: string }; jobRunId?: string; readOnly?: boolean }) => <aside data-context-thread={identity?.threadId} data-context-branch={identity?.branchId} data-context-job={jobRunId} data-context-readonly={String(readOnly)} /> }));
vi.mock('@/components/thread/ConversationTreePanel', () => ({ ConversationTreePanel: () => <aside data-mobile-tree /> }));
vi.mock('@/components/layout/ContextPanel', () => ({ ContextPanel: ({ layoutScope, surfaceModes, contextOwner }: { layoutScope?: string; surfaceModes?: readonly string[]; contextOwner?: { identity: { threadId: string; branchId: string } | null; readOnly: boolean } }) => <aside data-conversation-tree={layoutScope} data-surface-modes={surfaceModes?.join(',')}
  data-initial-context-thread={contextOwner?.identity?.threadId} data-initial-context-branch={contextOwner?.identity?.branchId} data-initial-context-readonly={String(contextOwner?.readOnly)} /> }));
// Shell navigation is driven by the Bot API fixture; stream transport has its
// own tests and must not create a real observation connection for this DOM.
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/components/thread/ThreadConversation', () => ({ ThreadConversation: ({ identity, readOnly, preferredModel, surface }: { identity: { threadId: string; branchId: string }; readOnly: boolean; preferredModel?: { providerId: string; modelId: string } | null; surface?: 'workbench' | 'bot' }) => { const openThreadContext = useOpenThreadContext(); return <div data-agent={identity.threadId} data-branch={identity.branchId} data-readonly={String(readOnly)} data-model={JSON.stringify(preferredModel)} data-surface={surface}><button onClick={() => openThreadContext({ runtime: 'agent', ...identity }, undefined, undefined, readOnly)}>Open context</button></div>; } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: () => {} }) } }));
vi.mock('@/lib/workbench/profile-context', () => ({ useWorkbenchProfileId: () => state.profileId }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: state.mobile }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }), getCurrentIntlLocale: () => 'en-US' }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>, TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>, TooltipContent: () => null }));
// Model menu activation and close completion, including the native Item's onClick contract.
vi.mock('@/components/ui/context-menu', async () => {
  const { createContext, useContext, useState } = await import('react');
  const Menu = createContext({ open: false, toggle: (_open: boolean) => {} });
  return {
    ContextMenu: ({ children, onOpenChange, onOpenChangeComplete }: React.PropsWithChildren<{ onOpenChange?(open: boolean): void; onOpenChangeComplete?(open: boolean): void }>) => {
      const [open, setOpen] = useState(false);
      return <Menu.Provider value={{ open, toggle(next) { onOpenChange?.(next); setOpen(next); onOpenChangeComplete?.(next); } }}>{children}</Menu.Provider>;
    },
    ContextMenuTrigger: ({ children }: React.PropsWithChildren) => {
      const menu = useContext(Menu);
      return <div onContextMenu={event => { event.preventDefault(); event.stopPropagation(); menu.toggle(true); }}>{children}</div>;
    },
    ContextMenuContent: ({ children }: React.PropsWithChildren) => useContext(Menu).open ? <div role="menu">{children}</div> : null,
    ContextMenuItem: ({ children, onClick, disabled }: React.PropsWithChildren<{ onClick?(): void; disabled?: boolean }>) => {
      const menu = useContext(Menu);
      return <button role="menuitem" disabled={disabled} onClick={event => { event.stopPropagation(); onClick?.(); menu.toggle(false); }}>{children}</button>;
    },
    ContextMenuSeparator: () => null,
  };
});
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children, onOpenChangeComplete }: React.PropsWithChildren<{ onOpenChangeComplete?(open: boolean): void }>) => <div onClick={event => {
    if ((event.target as HTMLElement).closest('[data-menu-item]')) onOpenChangeComplete?.(false);
  }}>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-menu="">{children}</div>,
  DropdownMenuItem: ({ children, onSelect, onClick, disabled }: { children: React.ReactNode; onSelect?: () => void; onClick?: () => void; disabled?: boolean }) => <button type="button" data-menu-item="" disabled={disabled} onClick={() => { onClick?.(); onSelect?.(); }}>{children}</button>,
  DropdownMenuSeparator: () => null,
}));
vi.mock('@/components/sections/harness/useHarnessSettings', () => ({ useHarnessSettings: () => ({ harness: null, update: vi.fn(), error: null }) }));
vi.mock('@/components/sections/bots/BotModelSelector', () => ({ BotModelSelector: () => null }));
vi.mock('@/components/layout/WorkbenchProfileSwitcher', () => ({ WorkbenchProfileSwitcher: () => null }));
vi.mock('@/components/sections/bots/BotDetailsDialog', () => ({ BotDetailsDialog: ({ bot }: { bot: { id: string; tab: string } | null }) => bot ? <div data-details={bot.id}>{bot.tab}</div> : null }));
vi.mock('@/components/sections/bots/BotMenu', () => ({ BotMenu: ({ bot, onAction, children }: { bot: BotSummary; onAction(action: string): void; children: React.ReactNode }) => <div>{children}
  <button onClick={() => onAction('profile')}>profile-{bot.id}</button>
  <button onClick={() => onAction('sleep')}>sleep-{bot.id}</button>
</div> }));
vi.mock('@/components/sections/bots/BotNameDialog', () => ({
  BotNameDialog: ({ open, name, onNameChange, onSubmit }: {
    open: boolean;
    name: string;
    onNameChange: (value: string) => void;
    onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  }) => open ? <form onSubmit={onSubmit}>
    <input value={name} onChange={(event) => onNameChange(event.target.value)} />
    <button type="button" onClick={() => onNameChange('Named bot')}>set-name</button>
    <button type="submit">settings.bots.save</button>
  </form> : null,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
vi.mock('@/components/layout/MainLayout', () => ({
  MainLayout: ({ renderNavigator, renderConversation, renderSecondaryPanel, navigationTitle, navigationSubtitle, headerPanelControl }: {
    renderNavigator(visible: boolean): React.ReactNode;
    renderConversation(active: boolean): React.ReactNode;
    renderSecondaryPanel?(placement: 'docked' | 'drawer', visible: boolean): React.ReactNode;
    navigationTitle?: string; navigationSubtitle?: string; headerPanelControl?: React.ReactNode;
  }) => <>
    <header data-title={navigationTitle} data-subtitle={navigationSubtitle ?? ''}>{headerPanelControl}</header>
    {renderNavigator(true)}{renderConversation(true)}<div data-secondary="">{renderSecondaryPanel?.('docked', true)}</div>
  </>,
}));

const bot = (id: string): BotSummary => ({
  id, revision: 1, name: `Bot ${id}`, entry: { runtime: 'agent', threadId: `entry-${id}`, branchId: `branch-${id}` }, archived: false,
  homeDir: `/bots/${id}`, coordinatorHostId: 'host-a', instructions: null, model: null,
  createdAt: '', updatedAt: '',
});
const sessionOf = (botId: string, threadId: string, branchId: string, patch: Partial<ThreadSummary> = {}, primary = false): BotSession => ({
  identity: { runtime: 'agent', threadId, branchId }, primary,
  thread: threadSummary(threadId, { main_branch_id: branchId, bot_id: botId, title: '', branches: [{ branch_id: branchId, head: null, active_run_id: null, latest_run: null }], ...patch }),
});
const run = (threadId: string, branchId: string, patch: Partial<Run>): Run => ({ id: `run:${threadId}`, thread_id: threadId, branch_id: branchId, state: 'executing', waiting_on: null, revision: 1, epoch: 1, configuration: null, cancel_requested: false, ...patch });

describe('Bot workbench', () => {
  let container: HTMLDivElement;
  let root: Root;
  // Host reads chain (list → select → entry, sessions, work), so let them all settle.
  const settle = async () => { for (let index = 0; index < 4; index += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const render = async () => { await act(async () => { root.render(<BotWorkspaceShell />); }); await settle(); };
  const key = async (target: Element, value: string) => {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'key', { value });
    await act(async () => { target.dispatchEvent(event); });
  };
  const find = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === text || item.getAttribute('aria-label') === text);
  const click = async (text: string) => {
    const button = find(text);
    expect(button, text).toBeTruthy();
    await act(async () => { button!.click(); });
  };
  const centre = () => container.querySelector('[data-agent]');

  beforeEach(() => {
    const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
    Object.defineProperty(window, 'location', { value: new URL('http://ui.test/'), configurable: true });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useBotNavigation.setState({ botId: null, entry: null, archived: undefined });
    useBotLayout.setState({ panelOpen: true, panelWidth: 360, tab: 'overview', seen: {}, activityScope: 'all', memoryScope: 'current', ordinarySidebar: null, sidebarOpen: false });
    state.profileId = 'varin.bot'; state.mobile = false;
    state.list.mockReset().mockResolvedValue([bot('a'), bot('b')]);
    state.ensure.mockReset().mockImplementation(async (id: string) => ({ bot: bot(id), model: null, entry: { runtime: 'agent', threadId: `entry-${id}`, branchId: `branch-${id}` } }));
    state.primary.mockReset().mockResolvedValue({ ...bot('primary'), name: 'Varin' });
    state.work.mockReset().mockResolvedValue([]);
    state.sessions.mockReset().mockImplementation(async (id: string) => [sessionOf(id, `entry-${id}`, `branch-${id}`, {}, true)]);
    state.createSession.mockReset();
    state.memory.mockReset().mockResolvedValue([]);
    state.schedules.mockReset().mockResolvedValue([]);
    state.arrangements.mockReset().mockResolvedValue([]);
    state.eventSources.mockReset().mockResolvedValue([]);
    state.activity.mockReset().mockImplementation(async (botId: string) => ({ botId, events: [], participants: [], before: null, eventCursor: 0 }));
    // Without a projection the selected Bot falls back to the live catalog and work list.
    state.presence.mockReset().mockRejectedValue(new Error('presence unavailable'));
    state.create.mockReset().mockResolvedValue(bot('new'));
    state.update.mockReset().mockResolvedValue(bot('a'));
    state.archive.mockReset().mockResolvedValue(bot('a'));
    state.change.mockReset().mockResolvedValue(bot('a'));
    state.open.mockReset();
    state.openWork.mockReset().mockResolvedValue(undefined);
    state.fork.mockReset(); state.copy.mockReset().mockResolvedValue({ ok: true });
    useThreadStore.setState({ hostKey: 'host-a', selectedIdentity: { runtime: 'agent', threadId: 'ordinary', branchId: 'ordinary-main' }, threads: [], catalogError: null });
    useUIStore.setState({ isSettingsDialogOpen: false, settingsPage: 'general', contextPanelByDirectory: {},
      mainSurfaceSelectionRevision: 0, isScheduledTasksDialogOpen: false, scheduledTasksFocus: null,
      isArchivePageOpen: false, worktreesPageProjectId: null, isMultiRunLauncherOpen: false });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens ordinary settings from the sidebar and preserves the last settings page', async () => {
    useUIStore.setState({ settingsPage: 'appearance' });
    await render();
    await click('sessions.sidebar.footer.actions.settings');
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
    expect(useUIStore.getState().settingsPage).toBe('appearance');
  });
  it('opens and closes the Bot tree independently of the workbench panel, keeping its exit mounted', async () => {
    useUIStore.getState().openContextPanelTab('', { mode: 'context' });
    const ordinaryPanel = useUIStore.getState().contextPanelByDirectory[''];
    await render();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="chat.tree.title"]')!;
    expect(toggle).not.toBeNull();
    await act(async () => toggle.click());
    expect(useUIStore.getState().contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE]?.isOpen).toBe(true);
    expect(container.querySelector(`[data-conversation-tree="${BOT_CONVERSATION_PANEL_SCOPE}"]`)).not.toBeNull();
    await act(async () => toggle.click());
    expect(useUIStore.getState().contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE]?.isOpen).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory['']).toBe(ordinaryPanel);
    expect(container.querySelector('[data-conversation-tree]')).not.toBeNull();
  });

  it('opens Bot context in its visible panel without changing workbench layout or conversation selection', async () => {
    useUIStore.getState().openContextPanelTab('', { mode: 'file' });
    const ordinaryPanel = useUIStore.getState().contextPanelByDirectory[''];
    await render();
    const identity = useThreadStore.getState().selectedIdentity;
    await click('Open context');
    const panel = useUIStore.getState().contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE];
    expect(panel?.isOpen).toBe(true);
    const tab = panel?.tabs.find(tab => tab.id === panel.activeTabId);
    expect(tab).toMatchObject({ mode: 'context', thread: { runtime: 'agent', threadId: 'entry-a', branchId: 'branch-a' }, readOnly: false });
    expect(container.querySelector('[data-surface-modes]')?.getAttribute('data-surface-modes')?.split(',')).toContain('context');
    expect(useUIStore.getState().contextPanelByDirectory['']).toBe(ordinaryPanel);
    expect(useThreadStore.getState().selectedIdentity).toBe(identity);
    await click('chat.tree.title');
    const tree = useUIStore.getState().contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE];
    expect(tree?.tabs.find(tab => tab.id === tree.activeTabId)?.mode).toBe('tree');
    await click('Open context');
    expect(useUIStore.getState().contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE]?.activeTabId).toBe(tab?.id);
    await act(async () => useUIStore.getState().closeContextPanel(BOT_CONVERSATION_PANEL_SCOPE));
    expect(useUIStore.getState().contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE]?.isOpen).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory['']).toBe(ordinaryPanel);
  });

  it('opens the exact read-only Bot context in a mobile dialog without a workspace', async () => {
    state.mobile = true;
    state.sessions.mockImplementation(async (id: string) => [sessionOf(id, `entry-${id}`, `branch-${id}`, { archived: true }, true)]);
    await render();
    await click('Open context');
    await settle();
    const inspector = container.querySelector('[role="dialog"] [data-context-thread]');
    expect(inspector?.getAttribute('data-context-thread')).toBe('entry-a');
    expect(inspector?.getAttribute('data-context-branch')).toBe('branch-a');
    expect(inspector?.getAttribute('data-context-readonly')).toBe('true');
    expect(container.querySelector('[data-conversation-tree]')).toBeNull();
    await act(async () => useUIStore.getState().closeContextPanel(BOT_CONVERSATION_PANEL_SCOPE));
    expect(container.querySelector('[data-context-thread]')).toBeNull();
  });

  it('supplies the current archived Bot Thread when the desktop tree first opens the context surface', async () => {
    state.sessions.mockImplementation(async (id: string) => [sessionOf(id, `entry-${id}`, `branch-${id}`, { archived: true }, true)]);
    await render();
    await click('chat.tree.title');
    const panel = container.querySelector('[data-conversation-tree]');
    expect(panel?.getAttribute('data-initial-context-thread')).toBe('entry-a');
    expect(panel?.getAttribute('data-initial-context-branch')).toBe('branch-a');
    expect(panel?.getAttribute('data-initial-context-readonly')).toBe('true');
    expect(useThreadStore.getState().selectedIdentity?.threadId).toBe('ordinary');
  });

  it('leaves the panel without a context owner while the Bot entry is unavailable', async () => {
    state.ensure.mockRejectedValue(new Error('entry unavailable'));
    useUIStore.getState().openContextPanelTab(BOT_CONVERSATION_PANEL_SCOPE, { mode: 'tree' });
    await render();
    expect(container.querySelector('[data-conversation-tree]')?.hasAttribute('data-initial-context-thread')).toBe(false);
    expect(useThreadStore.getState().selectedIdentity?.threadId).toBe('ordinary');
  });

  it('does not open the ordinary Thread from an ownerless saved mobile context tab', async () => {
    state.mobile = true;
    useUIStore.getState().openContextPanelTab(BOT_CONVERSATION_PANEL_SCOPE, { mode: 'context' });
    await render();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('contextSidebar.empty.openSession');
    expect(container.querySelector('[data-context-thread]')).toBeNull();
  });

  it('keeps a staged candidate inert and leaves the ordinary conversation hidden', async () => {
    state.profileId = 'default';
    await render();
    expect(state.list).not.toHaveBeenCalled();
    expect(state.ensure).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
    expect(state.sessions).not.toHaveBeenCalled();
    expect(centre()).toBeNull();
    expect(useThreadStore.getState().selectedIdentity?.threadId).toBe('ordinary');
  });

  it('reopens the current Bot identity and switches to another durable entry', async () => {
    useBotNavigation.setState({ botId: 'b', entry: null });
    await render();
    expect(state.ensure).toHaveBeenCalledWith('b', expect.any(AbortSignal));
    expect(useBotNavigation.getState().entry).toEqual(bot('b').entry);
    expect(centre()).not.toBeNull();
    expect(centre()?.getAttribute('data-surface')).toBe('bot');
    await click('Bot a');
    expect(useBotNavigation.getState().entry).toEqual(bot('a').entry);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('waits for a resolved session before reading arrangements after the original entry was deleted', async () => {
    const original = bot('a');
    const replacement = { runtime: 'agent' as const, threadId: 'replacement-session', branchId: 'replacement-branch' };
    let resolve!: (value: BotEntryResult) => void;
    const ready = new Promise<BotEntryResult>(done => { resolve = done; });
    state.list.mockResolvedValue([original]);
    state.sessions.mockResolvedValue([]);
    state.ensure.mockReturnValue(ready);
    await render();
    expect(state.arrangements).not.toHaveBeenCalled();
    expect(state.eventSources).not.toHaveBeenCalled();
    await act(async () => { resolve({ bot: original, entry: replacement, model: null }); });
    await settle();
    expect(useBotNavigation.getState().entry).toEqual(replacement);
    expect(centre()?.getAttribute('data-agent')).toBe(replacement.threadId);
    expect(state.arrangements).toHaveBeenCalledWith(replacement, original.id, expect.any(AbortSignal));
    expect(state.eventSources).toHaveBeenCalledWith(replacement, expect.any(AbortSignal));
    expect(state.arrangements.mock.calls.every(([identity]) => identity.threadId === replacement.threadId)).toBe(true);
  });

  it('asks the Host for the primary Bot when none is active and creates others only on request', async () => {
    state.list.mockResolvedValue([]);
    state.ensure.mockResolvedValue({ bot: { ...bot('primary'), name: 'Varin' }, model: null, entry: bot('primary').entry });
    await render();
    expect(state.primary).toHaveBeenCalledTimes(1);
    expect(centre()?.getAttribute('data-agent')).toBe('entry-primary');
    expect(container.querySelector('header')?.getAttribute('data-title')).toBe('Varin');
    expect(state.create).not.toHaveBeenCalled();
    state.ensure.mockImplementation(async (id: string) => ({ bot: bot(id), model: null, entry: bot(id).entry }));
    await click('settings.bots.create');
    await click('set-name');
    await act(async () => { document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    expect(state.create).toHaveBeenCalledExactlyOnceWith({ name: 'Named bot' });
    expect(useBotNavigation.getState().entry).toEqual(bot('new').entry);
  });

  it('lists the Bot’s own conversations, opens them in place and starts new ones', async () => {
    const trip = sessionOf('a', 'thread:bot:a:trip', 'branch:bot:a:trip', { title: 'Trip planning', unread: true });
    state.sessions.mockResolvedValue([sessionOf('a', 'entry-a', 'branch-a', { title: 'New thread' }, true), trip]);
    await render();
    expect(container.querySelector('header')?.getAttribute('data-title')).toBe('Bot a');
    expect(container.querySelector('[data-sidebar-row="session:entry-a:branch-a"]')?.textContent).toContain('Bot a');
    expect(container.textContent).not.toContain('New thread');
    expect(container.querySelector('header')?.getAttribute('data-subtitle')).toBe('Bot a');
    expect(container.querySelector('[aria-label="bot.session.unread"]')).not.toBeNull();
    await click('Trip planning');
    expect(centre()?.getAttribute('data-agent')).toBe('thread:bot:a:trip');
    expect(container.querySelector('header')?.getAttribute('data-title')).toBe('Trip planning');
    const fresh = sessionOf('a', 'thread:bot:a:fresh', 'branch:bot:a:fresh', { title: 'New thread' });
    state.createSession.mockResolvedValue(fresh);
    state.sessions.mockResolvedValue([sessionOf('a', 'entry-a', 'branch-a', {}, true), trip, fresh]);
    await click('bot.session.new');
    await settle();
    expect(state.createSession).toHaveBeenCalledExactlyOnceWith('a');
    expect(useBotNavigation.getState().entry).toEqual(fresh.identity);
    expect(container.querySelector('header')?.getAttribute('data-title')).toBe('Bot a');
    expect(container.textContent).not.toContain('New thread');
    expect([...container.querySelectorAll('[data-sidebar-row]')].map(row => row.getAttribute('data-sidebar-row'))).toContain('session:thread:bot:a:fresh:branch:bot:a:fresh');
  });

  it('reveals the selected session or Bot from the schedule page, including repeated selection', async () => {
    const trip = sessionOf('a', 'trip', 'trip-main', { title: 'Trip planning' });
    state.sessions.mockImplementation(async (id: string) => id === 'a'
      ? [sessionOf('a', 'entry-a', 'branch-a', {}, true), trip]
      : [sessionOf(id, `entry-${id}`, `branch-${id}`, {}, true)]);
    await render();
    const ordinary = useThreadStore.getState().selectedIdentity;
    for (const target of ['Trip planning', 'Trip planning', 'Bot b', 'Bot a']) {
      await act(async () => useUIStore.getState().openArrangements(bot('a').entry, 'arrangement'));
      await click(target);
      await settle();
      expect(useUIStore.getState().isScheduledTasksDialogOpen, target).toBe(false);
      expect(useUIStore.getState().scheduledTasksFocus).toBeNull();
      expect(useThreadStore.getState().selectedIdentity).toBe(ordinary);
    }
    expect(useBotNavigation.getState().entry).toEqual(bot('a').entry);
  });

  it('retains the current conversation and schedule page when another Bot cannot open', async () => {
    await render();
    const previous = useBotNavigation.getState().entry;
    state.ensure.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('Bot unavailable');
      return { bot: bot(id), entry: bot(id).entry, model: null };
    });
    await act(async () => useUIStore.getState().setScheduledTasksDialogOpen(true));
    await click('Bot b');
    await settle();
    expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(true);
    expect(useBotNavigation.getState().entry).toBe(previous);
    expect(container.querySelector('header')?.getAttribute('data-title')).toBe('Bot a');
  });

  it('does not dismiss a newer schedule page when restoring the initial Bot entry finishes', async () => {
    let finish!: (value: BotEntryResult) => void;
    state.ensure.mockReturnValue(new Promise<BotEntryResult>(resolve => { finish = resolve; }));
    await render();
    await act(async () => useUIStore.getState().setScheduledTasksDialogOpen(true));
    await act(async () => finish({ bot: bot('a'), entry: bot('a').entry, model: null }));
    await settle();
    expect(useBotNavigation.getState().entry).toEqual(bot('a').entry);
    expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(true);
  });

  it('discards a pending Bot switch after the user reselects the current conversation', async () => {
    await render();
    let finish!: (value: BotEntryResult) => void;
    state.ensure.mockImplementation(async (id: string) => id === 'b'
      ? new Promise<BotEntryResult>(resolve => { finish = resolve; })
      : { bot: bot(id), entry: bot(id).entry, model: null });
    await act(async () => useUIStore.getState().setScheduledTasksDialogOpen(true));
    await click('Bot b');
    expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(true);
    const current = container.querySelector<HTMLButtonElement>('[data-sidebar-row="session:entry-a:branch-a"]');
    expect(current).not.toBeNull();
    await act(async () => current!.click());
    expect(useUIStore.getState().isScheduledTasksDialogOpen).toBe(false);
    await act(async () => finish({ bot: bot('b'), entry: bot('b').entry, model: null }));
    await settle();
    expect(useBotNavigation.getState().entry).toEqual(bot('a').entry);
  });

  it.each(['schedule', 'archive', 'worktrees', 'multi-run', 'same-schedule'] as const)(
    'retains a newer %s page when a previously requested Bot lookup completes', async surface => {
      await render();
      if (surface === 'same-schedule') await act(async () => useUIStore.getState().setScheduledTasksDialogOpen(true));
      let finish!: (value: BotEntryResult) => void;
      state.ensure.mockImplementation(async (id: string) => id === 'b'
        ? new Promise<BotEntryResult>(resolve => { finish = resolve; })
        : { bot: bot(id), entry: bot(id).entry, model: null });
      await click('Bot b');
      await act(async () => {
        const ui = useUIStore.getState();
        if (surface === 'archive') ui.setArchivePageOpen(true);
        else if (surface === 'worktrees') ui.setWorktreesPageProjectId('project');
        else if (surface === 'multi-run') ui.openMultiRunLauncherWithPrompt('New work');
        else ui.setScheduledTasksDialogOpen(true);
      });
      const chosen = useUIStore.getState();
      await act(async () => finish({ bot: bot('b'), entry: bot('b').entry, model: null }));
      await settle();
      expect(useBotNavigation.getState().entry).toEqual(bot('a').entry);
      expect(useUIStore.getState()).toMatchObject({
        isScheduledTasksDialogOpen: chosen.isScheduledTasksDialogOpen,
        isArchivePageOpen: chosen.isArchivePageOpen,
        worktreesPageProjectId: chosen.worktreesPageProjectId,
        isMultiRunLauncherOpen: chosen.isMultiRunLauncherOpen,
      });
    },
  );

  it('renames and pins the right-clicked session without selecting it or changing the Bot profile', async () => {
    const trip = sessionOf('a', 'trip', 'trip-main', { title: 'Trip planning', title_mode: 'manual' });
    state.sessions.mockResolvedValue([sessionOf('a', 'entry-a', 'branch-a', {}, true), trip]);
    const update = vi.spyOn(useThreadStore.getState(), 'updateThread').mockImplementation(async (id, patch) => {
      useThreadStore.setState(current => ({ threads: current.threads.map(thread => thread.thread_id === id ? { ...thread, ...patch } : thread) }));
    });
    useThreadStore.setState({ threads: [trip.thread] });
    await render();
    const menu = async (action: string) => {
      const row = container.querySelector('[data-sidebar-row="session:trip:trip-main"]')!;
      await act(async () => { row.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true })); });
      expect(centre()?.getAttribute('data-agent')).toBe('entry-a');
      const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === action)!;
      await act(async () => { item.click(); });
    };
    await menu('sessions.sidebar.session.menu.rename');
    await click('set-name');
    await act(async () => { document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    expect(update).toHaveBeenCalledWith('trip', { title: 'Named bot' });
    expect(state.update).not.toHaveBeenCalled();
    await menu('sessions.sidebar.session.menu.pin');
    expect(update).toHaveBeenLastCalledWith('trip', { pinned: true });
    expect(container.querySelector('[data-sidebar-row^="session:"]')?.getAttribute('data-sidebar-row')).toBe('session:trip:trip-main');
  });

  it('keeps branch menu actions on the clicked branch and exposes no conversation rename on it', async () => {
    const trip = sessionOf('a', 'trip', 'trip-main', { title: 'Trip', branches: [
      { branch_id: 'trip-main', head: 'main-head', active_run_id: null, latest_run: null },
      { branch_id: 'trip-alternative', head: 'alternative-head', active_run_id: null, latest_run: null },
    ] });
    state.sessions.mockResolvedValue([sessionOf('a', 'entry-a', 'branch-a', {}, true), trip]);
    state.fork.mockResolvedValue({ runtime: 'agent', threadId: 'trip', branchId: 'new-branch' });
    await render();
    const menu = async () => {
      await act(async () => { container.querySelector('[data-sidebar-row="session:trip:trip-alternative"]')!
        .dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true })); });
      return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    };
    let items = await menu();
    expect(items.some(item => item.textContent === 'sessions.sidebar.session.menu.rename')).toBe(false);
    expect(items.some(item => item.textContent === 'sessions.sidebar.dialogs.deleteSession.titleAction')).toBe(false);
    expect(items.some(item => item.textContent === 'bot.session.menu.deleteBranch')).toBe(true);
    await act(async () => items.find(item => item.textContent === 'bot.session.menu.copyBranchId')!.click());
    expect(state.copy).toHaveBeenCalledExactlyOnceWith('trip-alternative');
    expect(centre()?.getAttribute('data-agent')).toBe('entry-a');
    items = await menu();
    await act(async () => items.find(item => item.textContent === 'bot.session.menu.fork')!.click());
    expect(state.fork).toHaveBeenCalledWith({ runtime: 'agent', threadId: 'trip', branchId: 'trip-alternative', key: expect.any(String), headId: 'alternative-head' });
    expect(useBotNavigation.getState().entry?.branchId).toBe('new-branch');
  });

  it('deletes just the selected alternate route and returns to the main conversation', async () => {
    const entry = sessionOf('a', 'entry-a', 'branch-a', { branches: [
      { branch_id: 'branch-a', head: null, active_run_id: null, latest_run: null },
      { branch_id: 'alternative', head: null, active_run_id: null, latest_run: null },
      { branch_id: 'sibling', head: null, active_run_id: null, latest_run: null },
    ] }, true);
    state.sessions.mockResolvedValue([entry]);
    useThreadStore.setState({ threads: [entry.thread] });
    const remove = vi.spyOn(useThreadStore.getState(), 'deleteBranch').mockImplementation(async () => {
      useThreadStore.setState({ threads: [{ ...entry.thread, branches: entry.thread.branches.filter(branch => branch.branch_id !== 'alternative') }] });
      return entry.identity;
    });
    await render();
    const alternative = container.querySelector<HTMLButtonElement>('[data-sidebar-row="session:entry-a:alternative"]')!;
    await act(async () => alternative.click());
    await act(async () => alternative.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true })));
    const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'bot.session.menu.deleteBranch')!;
    await act(async () => item.click());
    expect(remove).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === 'bot.session.menu.deleteBranch')!;
    await act(async () => confirm.click());
    await settle();
    expect(remove).toHaveBeenCalledExactlyOnceWith({ ...entry.identity, branchId: 'alternative' });
    expect(centre()?.getAttribute('data-branch')).toBe('branch-a');
    expect(container.querySelector('[data-sidebar-row="session:entry-a:alternative"]')).toBeNull();
    expect(container.querySelector('[data-sidebar-row="session:entry-a:sibling"]')).not.toBeNull();
  });

  it('archives and restores a conversation, then deletes it only after confirmation', async () => {
    const entry = sessionOf('a', 'entry-a', 'branch-a', { title: 'Planning' }, true);
    const other = sessionOf('a', 'other', 'other-main', { title: 'Follow-up' });
    let sessions = [entry, other];
    state.sessions.mockImplementation(async () => sessions);
    state.ensure.mockImplementation(async () => ({
      bot: bot('a'), model: null, entry: sessions.find(session => !session.thread.archived)?.identity,
    }));
    const syncCatalog = () => useThreadStore.setState({ threads: sessions.map(session => session.thread) });
    const update = vi.spyOn(useThreadStore.getState(), 'updateThread').mockImplementation(async (id, patch) => {
      sessions = sessions.map(session => session.identity.threadId === id ? { ...session, thread: { ...session.thread, ...patch } } : session);
      syncCatalog();
    });
    const remove = vi.spyOn(useThreadStore.getState(), 'deleteThread').mockImplementation(async id => {
      sessions = sessions.filter(session => session.identity.threadId !== id);
      syncCatalog();
    });
    syncCatalog();
    await render();
    const row = () => container.querySelector<HTMLButtonElement>('[data-sidebar-row="session:entry-a:branch-a"]');
    const action = async (label: string) => {
      await act(async () => row()!.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true })));
      const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === label)!;
      await act(async () => item.click());
      await settle();
    };
    await action('sessions.sidebar.bulkActions.archive');
    expect(update).toHaveBeenCalledWith('entry-a', { archived: true });
    expect(centre()?.getAttribute('data-agent')).toBe('other');
    expect(find('bot.session.archivedList1')?.getAttribute('aria-expanded')).toBe('false');
    await click('bot.session.archivedList1');
    await act(async () => row()!.click());
    expect(centre()?.getAttribute('data-readonly')).toBe('true');
    await action('sessions.sidebar.session.menu.restore');
    expect(update).toHaveBeenLastCalledWith('entry-a', { archived: false });
    expect(centre()?.getAttribute('data-readonly')).toBe('false');
    await action('sessions.sidebar.dialogs.deleteSession.titleAction');
    expect(remove).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]')!;
    const confirm = [...dialog.querySelectorAll('button')].find(item => item.textContent === 'sessions.sidebar.dialogs.deleteSession.titleAction')!;
    await act(async () => confirm.click());
    await settle();
    expect(remove).toHaveBeenCalledExactlyOnceWith('entry-a');
    expect(row()).toBeNull();
    expect(centre()?.getAttribute('data-agent')).toBe('other');
  });

  it('activates the Bot profile context menu through click, like its dropdown menu', async () => {
    const { BotMenu } = await vi.importActual<typeof import('@/components/sections/bots/BotMenu')>('@/components/sections/bots/BotMenu');
    const action = vi.fn();
    await act(async () => root.render(<BotMenu bot={bot('a')} disabled={false} onAction={action}><button>Bot profile</button></BotMenu>));
    await act(async () => { find('Bot profile')!.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true })); });
    const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'settings.bots.rename')!;
    await act(async () => item.click());
    expect(action).toHaveBeenCalledExactlyOnceWith('rename');
    const dropdownItem = [...container.querySelectorAll<HTMLButtonElement>('[data-menu-item]')].find(item => item.textContent === 'settings.bots.sleep')!;
    await act(async () => dropdownItem.click());
    expect(action).toHaveBeenLastCalledWith('sleep');
  });

  it('cannot start a conversation while the Bot rests', async () => {
    const sleeping = { ...bot('a'), activity: { state: 'asleep' as const, operationId: 'sleep-a', planned: true, work: [], machines: [], error: null } };
    state.list.mockResolvedValue([sleeping]);
    await render();
    expect(find('bot.session.new')?.disabled).toBe(true);
    expect(state.createSession).not.toHaveBeenCalled();
  });

  it('opens work details beside the conversation before entering the original workbench', async () => {
    const child = { runtime: 'agent' as const, threadId: 'child-work', branchId: 'child-branch' };
    const waiting = run(child.threadId, child.branchId, { state: 'waiting', waiting_on: 'permission:write' });
    const item: BotWorkItem = { runtime: 'agent', identity: child, purpose: 'work', activeRun: waiting, sessionThreadId: 'entry-a',
      thread: threadSummary(child.threadId, { title: 'Writer', bot_id: 'a', parent_thread_id: 'entry-a', main_branch_id: child.branchId, branches: [{ branch_id: child.branchId, head: null, active_run_id: waiting.id, latest_run: waiting }] }) };
    state.list.mockResolvedValue([bot('a')]);
    state.work.mockResolvedValue([item]);
    await render();
    expect(container.querySelector('.bot-stage .bot-figure')?.getAttribute('data-state')).toBe('waiting');
    expect(container.querySelector('.bot-stage [aria-live]')?.textContent).toBe('bot.state.waitingPermission');
    await act(async () => { container.querySelector<HTMLButtonElement>('.bot-need')!.click(); });
    expect(state.openWork).not.toHaveBeenCalled();
    expect(container.querySelector('[data-work-detail="child-work"]')).not.toBeNull();
    expect(centre()?.getAttribute('data-agent')).toBe('entry-a');
    await click('bot.workspace.openProcess');
    expect(state.openWork).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ botId: 'a', session: bot('a').entry, workThreadId: 'child-work', focus: { tab: 'overview', id: expect.any(String) } }), child);
    // Coming back through the workbench's back control lights the card the user left from.
    await act(async () => useBotReturn.setState({ returned: state.openWork.mock.calls[0]![0] }));
    expect(container.querySelector('.bot-need')?.classList.contains('bot-flash')).toBe(true);
    expect(useBotReturn.getState().returned).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.bot-space-back')!.click());
    await click('bot.tab.activity');
    expect(container.querySelector('[role="tabpanel"]')?.id).toBe('bot-pane-activity');
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('Writer');
    // A notification that points the Bot at its child does not open the child here.
    useThreadStore.setState({ threads: [item.thread] });
    await act(async () => useBotNavigation.setState({ botId: 'a', entry: child }));
    expect(centre()).toBeNull();
  });

  it('applies the profile model to the Bot’s conversations after a refresh', async () => {
    const entry = { runtime: 'agent' as const, threadId: 'root-work', branchId: 'root-branch' };
    const native = { ...bot('a'), entry };
    state.list.mockResolvedValue([native]); state.ensure.mockResolvedValue({ bot: native, entry, model: null });
    state.sessions.mockResolvedValue([sessionOf('a', entry.threadId, entry.branchId, {}, true)]);
    await render();
    expect(centre()?.getAttribute('data-agent')).toBe('root-work');
    const updated = { ...native, model: { providerId: 'changed-provider', modelId: 'changed-model' } };
    state.list.mockResolvedValue([updated]); state.ensure.mockResolvedValue({ bot: updated, entry, model: updated.model });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="tasksHub.refresh"]')!.click(); });
    expect(centre()?.getAttribute('data-model')).toBe(JSON.stringify(updated.model));
  });

  it('opens the right-clicked Bot profile without switching the conversation', async () => {
    await render();
    await click('profile-b');
    expect(container.querySelector('[data-details]')?.getAttribute('data-details')).toBe('b');
    expect(useBotNavigation.getState().entry).toEqual(bot('a').entry);
    expect(useThreadStore.getState().selectedIdentity?.threadId).toBe('ordinary');
  });

  it('pushes the selected Bot’s profile over the tabs and returns to them', async () => {
    await render();
    await click('profile-a');
    expect(container.querySelector('.bot-profile-page')).not.toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
    await click('bot.profile.back');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.id).toBe('bot-tab-overview');
  });

  it('views a sleeping Bot read-only without waking it, and wakes it on request', async () => {
    const sleeping = { ...bot('a'), activity: { state: 'asleep' as const, operationId: 'sleep-a', planned: true, work: [], machines: [], error: null } };
    state.list.mockResolvedValue([sleeping]);
    state.ensure.mockResolvedValue({ bot: sleeping, entry: { runtime: 'agent', threadId: 'entry-a', branchId: 'branch-a' } });
    await render();
    expect(centre()?.getAttribute('data-readonly')).toBe('true');
    expect(container.querySelector('.bot-figure[data-state="sleeping"]')).not.toBeNull();
    expect(state.change).not.toHaveBeenCalled();
    await click('settings.bots.wakeContinue');
    expect(state.change).toHaveBeenCalledWith('a', 'wake');
  });

  it('sleeps the clicked Bot without changing the selected Bot', async () => {
    await render();
    state.change.mockResolvedValue(bot('b'));
    await click('sleep-b');
    expect(state.change).toHaveBeenCalledWith('b', 'sleep');
    expect(useBotNavigation.getState().entry).toEqual(bot('a').entry);
  });

  it('resizes and closes the panel from its handle with the keyboard', async () => {
    await render();
    const handle = () => container.querySelector<HTMLElement>('[role="separator"]');
    expect(handle()?.getAttribute('aria-valuenow')).toBe('360');
    await key(handle()!, 'ArrowLeft');
    expect(useBotLayout.getState().panelWidth).toBe(376);
    expect(handle()?.getAttribute('aria-valuenow')).toBe('376');
    for (let index = 0; index < 20; index += 1) await key(handle()!, 'ArrowLeft');
    expect(useBotLayout.getState().panelWidth).toBe(560);
    await key(handle()!, 'Enter');
    expect(useBotLayout.getState().panelOpen).toBe(false);
    expect(container.querySelector('aside.bot-panel')?.getAttribute('data-open')).toBe('false');
    await click('bot.panel.open');
    expect(useBotLayout.getState().panelOpen).toBe(true);
  });

  it('discards a pending entry after the shell unmounts', async () => {
    let finish!: (value: { bot: BotSummary; entry: BotSummary['entry'] }) => void;
    state.ensure.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    act(() => root.render(null));
    await act(async () => { finish({ bot: bot('a'), entry: { runtime: 'agent', threadId: 'entry-a', branchId: 'branch-a' } }); });
    expect(state.open).not.toHaveBeenCalled();
  });

  it('discards an old Host response and loads the new Host', async () => {
    let finish!: (value: { bot: BotSummary; entry: BotSummary['entry'] }) => void;
    state.ensure.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    state.list.mockResolvedValue([bot('c')]);
    state.ensure.mockImplementation(async (id: string) => ({ bot: bot(id), model: null, entry: bot(id).entry }));
    await act(async () => { useThreadStore.setState({ hostKey: 'host-b', selectedIdentity: null }); });
    await act(async () => { finish({ bot: bot('a'), entry: { runtime: 'agent', threadId: 'entry-a', branchId: 'branch-a' } }); });
    expect(useBotNavigation.getState().entry).toEqual(bot('c').entry);
    expect(centre()?.getAttribute('data-agent')).toBe('entry-c');
  });

  it('shows catalog failure as an error without offering implicit creation', async () => {
    state.list.mockRejectedValue(new Error('Host unavailable'));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Host unavailable');
    expect(state.primary).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('draws every Bot from the Host presence, including one that is not selected', async () => {
    state.presence.mockImplementation(async (botId: string) => botId === 'a'
      ? { botId, needs: [], replying: [], working: [{ identity: { runtime: 'agent', threadId: 'w', branchId: 'wb' }, name: 'Reviewer', avatar: null, sessionThreadId: 'entry-a' }] }
      : { botId, needs: [{ identity: { runtime: 'agent', threadId: 'entry-b', branchId: 'branch-b' }, name: 'Bot b', avatar: null, kind: 'question', session: true }], replying: [], working: [] });
    await render();
    expect(container.querySelector('.bot-stage .bot-figure')?.getAttribute('data-state')).toBe('working');
    expect(container.querySelector('[data-sidebar-row="bot:b"] .bot-figure')?.getAttribute('data-state')).toBe('waiting');
    expect(state.presence.mock.calls.map(([botId]) => botId).sort()).toEqual(['a', 'b']);
  });
  it('lists a quiet round’s inputs on request and loads earlier activity below', async () => {
    const quiet = { cursor: 9, atMs: Date.now(), sessionThreadId: 'entry-a', sessionBranchId: 'branch-a', kind: 'quiet', runId: 'r', inputs: [
      { origin: 'message', threadId: 'writer', branchId: 'wb', change: null }, { origin: 'message', threadId: 'editor', branchId: 'eb', change: null }] };
    const dispatch = { cursor: 3, atMs: Date.now() - 1000, sessionThreadId: 'entry-a', sessionBranchId: 'branch-a', kind: 'dispatch', operationId: 'op', executionId: 'e',
      threadId: 'writer', branchId: 'wb', task: 'Draft the notes', preset: null };
    const participants = [{ threadId: 'writer', name: 'Writer', agentId: 'w', avatar: null }, { threadId: 'editor', name: 'Editor', agentId: 'e', avatar: null }];
    state.list.mockResolvedValue([bot('a')]);
    state.activity.mockImplementation(async (botId: string, page?: { before?: number }) => page?.before === 9
      ? { botId, events: [dispatch], participants, before: null, eventCursor: 9 }
      : { botId, events: [quiet], participants, before: 9, eventCursor: 9 });
    await render();
    await click('bot.tab.activity');
    const pane = () => container.querySelector('[role="tabpanel"]')!;
    const round = pane().querySelector<HTMLButtonElement>('.bot-event[data-kind="quiet"]')!;
    expect(round.textContent).toContain('bot.event.quietReports');
    expect(pane().querySelector('.bot-event-inputs')).toBeNull();
    await act(async () => { round.click(); });
    expect([...pane().querySelectorAll('.bot-event-input')].map(item => item.textContent)).toEqual(['bot.event.quietReport', 'bot.event.quietReport']);
    await act(async () => { pane().querySelector<HTMLButtonElement>('.bot-event-input')!.click(); });
    expect(state.openWork).toHaveBeenCalledWith(expect.objectContaining({ workThreadId: 'writer' }), { runtime: 'agent', threadId: 'writer', branchId: 'wb' });
    await click('bot.activity.earlier');
    await settle();
    expect(state.activity).toHaveBeenLastCalledWith('a', { before: 9, limit: 30 });
    expect(pane().querySelector('.bot-event[data-kind="dispatch"]')?.textContent).toContain('Draft the notes');
    expect(find('bot.activity.earlier')).toBeUndefined();
  });
  it('keeps sleeping native history read-only and does not ensure or wake it', async () => {
    const entry = { runtime: 'agent' as const, threadId: 'sleep-work', branchId: 'sleep-branch' };
    state.list.mockResolvedValue([{ ...bot('a'), entry, activity: { state: 'asleep', operationId: 'sleep', planned: true, work: [], machines: [], error: null } }]);
    await render();
    expect(centre()?.getAttribute('data-readonly')).toBe('true');
    expect(state.ensure).not.toHaveBeenCalled(); expect(state.change).not.toHaveBeenCalled(); expect(state.open).not.toHaveBeenCalled();
  });

  it('opens a notification branch on another Bot in an already mounted shell, including archived history', async () => {
    const archived = { ...bot('b'), archived: true };
    state.list.mockResolvedValue([bot('a'), archived]);
    await render();
    expect(centre()?.getAttribute('data-agent')).toBe('entry-a');
    state.ensure.mockClear();
    useThreadStore.setState({ threads: [threadSummary('archived-work', { main_branch_id: 'main', title: 'Work', bot_id: 'b', branches: [{ branch_id: 'review-branch', head: null, active_run_id: null, latest_run: null }] })] });
    await act(async () => useBotNavigation.setState({ botId: 'b', entry: { runtime: 'agent', threadId: 'archived-work', branchId: 'review-branch' }, archived: true, model: null }));
    expect(centre()?.getAttribute('data-agent')).toBe('archived-work');
    expect(centre()?.getAttribute('data-branch')).toBe('review-branch');
    expect(centre()?.getAttribute('data-readonly')).toBe('true');
    expect(state.ensure).not.toHaveBeenCalled();
  });
});
