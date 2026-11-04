import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({
  invoke: vi.fn(),
  identity: null as { threadId: string; branchId: string } | null,
}));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: desktop.invoke, isDesktopShell: () => true }));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: (select: (state: unknown) => unknown) => select({ selectedIdentity: desktop.identity, threads: [] }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: unknown) => unknown) => select({ currentDirectory: '/remote/project' }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: unknown) => unknown) => select({ activeProjectId: 'remote-project' }) }));
vi.mock('@/hooks/useDesktopWindowControlsLayout', () => ({ useDesktopWindowControlsLayout: () => ({ usesFramelessChrome: false }) }));
vi.mock('@/components/desktop/WindowsWindowControls', () => ({ WindowsWindowControls: () => null }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/views/ChatView', () => ({ ChatView: () => <div>Conversation draft</div> }));
vi.mock('@/components/thread/ThreadSwitcherDropdown', () => ({ ThreadSwitcherDropdown: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
import { MiniChatLayout } from './MiniChatLayout';

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  desktop.identity = null;
  desktop.invoke.mockReset().mockImplementation(async (command: string) => command === 'desktop_get_window_pinned' ? { pinned: false } : { focused: true });
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.getElementById('root')!;
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
const render = async () => { await act(async () => { root.render(<MiniChatLayout />); }); };
const open = () => container.querySelector<HTMLButtonElement>('[aria-label="Open in main window"]')!;

it('hands off the current draft project and directory before closing Mini Chat', async () => {
  await render();
  await act(async () => open().click());
  expect(desktop.invoke).toHaveBeenCalledWith('desktop_focus_main_window', { mode: 'draft', directory: '/remote/project', projectId: 'remote-project' });
  expect(desktop.invoke).toHaveBeenCalledWith('desktop_close_current_window');
  expect(desktop.invoke.mock.calls.findIndex(call => call[0] === 'desktop_close_current_window')).toBeGreaterThan(desktop.invoke.mock.calls.findIndex(call => call[0] === 'desktop_focus_main_window'));
});

it('retains Mini Chat on a failed handoff and lets the user retry without duplicate pending actions', async () => {
  let reject!: (error: Error) => void;
  desktop.invoke.mockImplementation((command: string) => command === 'desktop_focus_main_window'
    ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve({ pinned: false }));
  await render();
  act(() => { open().click(); open().click(); });
  expect(desktop.invoke.mock.calls.filter(call => call[0] === 'desktop_focus_main_window')).toHaveLength(1);
  expect(open().disabled).toBe(true);
  await act(async () => reject(new Error('Original Host window is unavailable')));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Original Host window is unavailable');
  expect(container.textContent).toContain('Conversation draft');
  expect(desktop.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  expect(open().disabled).toBe(false);
  desktop.identity = { threadId: 'thread', branchId: 'branch' };
  desktop.invoke.mockResolvedValue({ focused: true });
  await render();
  await act(async () => open().click());
  expect(desktop.invoke).toHaveBeenCalledWith('desktop_focus_main_window', { threadId: 'thread', branchId: 'branch', directory: '/remote/project' });
  expect(desktop.invoke).toHaveBeenCalledWith('desktop_close_current_window');
});

it('does not close Mini Chat when native did not confirm focus', async () => {
  desktop.invoke.mockResolvedValue({ focused: false });
  await render();
  await act(async () => open().click());
  expect(desktop.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
