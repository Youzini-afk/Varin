import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import { ContextPanel } from './ContextPanel';
import { useUIStore } from '@/stores/useUIStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { BOT_CONVERSATION_PANEL_SCOPE, openConversationTree } from '@/lib/openConversationTree';
import { threadSummary } from '@/test/threadFixtures';

const runtime = vi.hoisted(() => ({ api: undefined as ThreadsAPI | undefined }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: runtime.api }) }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/ordinary-workspace' }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ themeMode: 'light', setThemeMode: vi.fn() }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./railMotion', () => ({ useMainColumnGlide: () => {} }));
// The panel, surface store and Thread projection are real. Unrelated surfaces and
// the inspector's presentation do not participate in choosing its owner.
vi.mock('@/components/context/ContextInspector', () => ({ ContextInspector: ({ identity, readOnly }: { identity: ThreadIdentity; readOnly?: boolean }) =>
  <div data-context-thread={identity.threadId} data-context-branch={identity.branchId} data-context-readonly={String(readOnly)} /> }));
vi.mock('@/components/thread/ConversationTreePanel', () => ({ ConversationTreePanel: () => <div data-tree /> }));
vi.mock('@/components/interactive-ui/InteractiveUiCard', () => ({ InteractiveUiPanel: () => null }));
vi.mock('@/components/workbench/ContextBrowserView', () => ({ ContextBrowserView: () => null }));
vi.mock('@/components/workbench/MaterialViewActions', () => ({ BrowserMaterialAction: () => null }));
vi.mock('@/components/icons/FileTypeIcon', () => ({ FileTypeIcon: () => null }));
vi.mock('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: () => null }));
vi.mock('@/components/views/TerminalView', () => ({ TerminalView: () => null }));
vi.mock('./RightSidebarTabs', () => ({ ProjectContextPanel: () => null }));
vi.mock('./WorkspaceRecoveryPanel', () => ({ WorkspaceRecoveryPanel: () => null }));
vi.mock('./SidebarFilesTree', () => ({ SidebarFilesTree: () => null }));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children, onSelect, disabled }: React.PropsWithChildren<{ onSelect(): void; disabled?: boolean }>) =>
    <button role="menuitem" disabled={disabled} onClick={onSelect}>{children}</button>,
}));

const ordinary: ThreadIdentity = { runtime: 'agent', threadId: 'ordinary', branchId: 'ordinary-main' };
const bot: ThreadIdentity = { runtime: 'agent', threadId: 'bot-entry', branchId: 'bot-branch' };
const surfaces = ['tree', 'context'] as const;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  useUIStore.setState({ contextPanelByDirectory: {} });
  useThreadStore.setState({ hostKey: 'host', selectedIdentity: ordinary, threads: [] });
  const api: Pick<ThreadsAPI, 'snapshot' | 'contextInspection' | 'observe'> = {
    snapshot: vi.fn<ThreadsAPI['snapshot']>(async identity => ({ identity, eventCursor: 0, thread: threadSummary(identity.threadId), activeRun: null,
      history: [], historyPage: { head: null, previous: null }, inputs: [], operations: [], followups: [], goals: [], launch: null,
      modelSelection: { desired: null, active: null }, policySelection: null, context: { checkpoint: null, jobs: [] } } as ThreadSnapshot)),
    contextInspection: async () => ({ head: null, counts: { total: 0, user: 0, assistant: 0, tool: 0 }, latestRequest: null, contextRequest: null }),
    observe: async (_cursor, _listener, { signal }) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
  };
  runtime.api = api as ThreadsAPI;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const menuItem = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === label)!;
const switchTo = async (label: string) => { await act(async () => menuItem(label).click()); };
const activeTab = () => {
  const panel = useUIStore.getState().contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE]!;
  return panel.tabs.find(tab => tab.id === panel.activeTabId)!;
};
const render = async (identity: ThreadIdentity | null, readOnly = false) => {
  await act(async () => root.render(<ContextPanel layoutScope={BOT_CONVERSATION_PANEL_SCOPE} surfaceModes={surfaces}
    contextOwner={{ identity, readOnly }} />));
};

it('opens the first context from the Bot tree surface menu with the Bot owner and read-only scope', async () => {
  useUIStore.getState().openContextPanelTab('/ordinary-workspace', { mode: 'file' });
  const ordinaryPanel = useUIStore.getState().contextPanelByDirectory['/ordinary-workspace'];
  openConversationTree('bot');
  await render(bot, true);
  await switchTo('contextPanel.mode.context');
  expect(activeTab()).toMatchObject({ mode: 'context', thread: bot, readOnly: true });
  expect(container.querySelector('[data-context-thread]')?.getAttribute('data-context-thread')).toBe(bot.threadId);
  expect(container.querySelector('[data-context-thread]')?.getAttribute('data-context-readonly')).toBe('true');
  expect(vi.mocked(runtime.api!.snapshot).mock.calls.map(([identity]) => identity)).toEqual([bot]);
  expect(useThreadStore.getState().selectedIdentity).toBe(ordinary);
  expect(useUIStore.getState().contextPanelByDirectory['/ordinary-workspace']).toBe(ordinaryPanel);
});

it('preserves an existing exact context when the Bot selection changes and when reopening the surface', async () => {
  const previous = { ...bot, threadId: 'previous-bot', branchId: 'previous-branch' };
  useUIStore.getState().openContextPanelTab(BOT_CONVERSATION_PANEL_SCOPE, { mode: 'context', thread: previous, readOnly: true, targetPath: 'old-compaction' });
  openConversationTree('bot');
  await render(bot);
  await switchTo('contextPanel.mode.context');
  expect(activeTab()).toMatchObject({ thread: previous, readOnly: true, targetPath: 'old-compaction' });
  await switchTo('contextPanel.mode.context');
  expect(useUIStore.getState().contextPanelByDirectory[BOT_CONVERSATION_PANEL_SCOPE]?.isOpen).toBe(false);
  await render(null);
  await switchTo('contextPanel.mode.context');
  expect(activeTab()).toMatchObject({ thread: previous, readOnly: true, targetPath: 'old-compaction' });
  expect(container.querySelector('[data-context-thread]')?.getAttribute('data-context-thread')).toBe(previous.threadId);
});

it('does not create context without a Bot Thread and uses the latest read-only scope on first creation', async () => {
  openConversationTree('bot');
  await render(null);
  expect(menuItem('contextPanel.mode.context').disabled).toBe(true);
  await switchTo('contextPanel.mode.context');
  expect(activeTab().mode).toBe('tree');
  expect(runtime.api!.snapshot).not.toHaveBeenCalled();
  await render(bot, false);
  await render(bot, true);
  await switchTo('contextPanel.mode.context');
  expect(activeTab()).toMatchObject({ thread: bot, readOnly: true });
});

it('does not resolve a previously ownerless Bot context against the ordinary selection', async () => {
  useUIStore.getState().openContextPanelTab(BOT_CONVERSATION_PANEL_SCOPE, { mode: 'context' });
  await render(null);
  expect(runtime.api!.snapshot).not.toHaveBeenCalled();
  expect(container.textContent).toContain('contextSidebar.empty.openSession');
  expect(menuItem('contextPanel.mode.context').disabled).toBe(true);
  await render(bot, true);
  await switchTo('contextPanel.mode.context');
  expect(activeTab()).toMatchObject({ thread: bot, readOnly: true });
  expect(container.querySelector('[data-context-thread]')?.getAttribute('data-context-thread')).toBe(bot.threadId);
});

it('keeps ordinary workbench context tied to its selected Thread when no shell owner is supplied', async () => {
  useUIStore.getState().openContextPanelTab('/ordinary-workspace', { mode: 'tree' });
  await act(async () => root.render(<ContextPanel surfaceModes={surfaces} />));
  await switchTo('contextPanel.mode.context');
  expect(container.querySelector('[data-context-thread]')?.getAttribute('data-context-thread')).toBe(ordinary.threadId);
  expect(vi.mocked(runtime.api!.snapshot).mock.calls.map(([identity]) => identity)).toEqual([ordinary]);
});
