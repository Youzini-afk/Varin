import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const desktop = vi.hoisted(() => ({
  invoke: vi.fn(),
  identity: null as { threadId: string; branchId: string } | null,
}));
vi.mock('@/lib/desktop', () => ({ invokeDesktop: desktop.invoke, isDesktopShell: () => true }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: unknown) => unknown) => select({ currentDirectory: '/remote/project' }) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: unknown) => unknown) => select({ activeProjectId: 'remote-project' }) }));
vi.mock('@/hooks/useDesktopWindowControlsLayout', () => ({ useDesktopWindowControlsLayout: () => ({ usesFramelessChrome: false }) }));
vi.mock('@/components/desktop/WindowsWindowControls', () => ({ WindowsWindowControls: () => null }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/views/ChatView', () => ({ ChatView: () => <div>Conversation draft</div> }));
vi.mock('@/components/thread/ThreadSwitcherDropdown', () => ({ ThreadSwitcherDropdown: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
import { MiniChatLayout } from './MiniChatLayout';
import { useThreadDraftStore, type ThreadDraft } from '@/stores/useThreadDraftStore';
import { useThreadStore } from '@/stores/useThreadStore';

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  desktop.identity = null;
  useThreadDraftStore.setState({ drafts: {} });
  useThreadStore.setState({ hostKey: 'test-host', selectedIdentity: null, selectedDraftKey: null, threads: [] });
  desktop.invoke.mockReset().mockImplementation(async (command: string) => command === 'desktop_get_window_pinned' ? { pinned: false } : { focused: true });
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.__VARIN_DESKTOP_RUNTIME__ = { runtime: 'electron', arch: 'x64', macVibrancy: false, macVibrancySupported: false, trayEnabled: false };
  container = document.getElementById('root')!;
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
const render = async () => { await act(async () => { useThreadStore.setState({ selectedIdentity: desktop.identity ? { runtime: 'agent', ...desktop.identity } : null }); root.render(<MiniChatLayout />); }); };
const open = () => container.querySelector<HTMLButtonElement>('[aria-label="Open in main window"]')!;

it('hands off the current draft project and directory before closing Mini Chat', async () => {
  await render();
  await act(async () => open().click());
  expect(desktop.invoke).toHaveBeenCalledWith('desktop_focus_main_window', { mode: 'draft', directory: '/remote/project', projectId: 'remote-project' });
  expect(desktop.invoke).not.toHaveBeenCalledWith('desktop_transfer_draft', expect.anything());
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


it('keeps actual unsent text and binary attachments in the source store after native focus succeeds', async () => {
  const bytes = new Blob(['original file'], { type: 'text/plain' });
  useThreadDraftStore.getState().patch('mini-draft', {
    text: 'Do not lose this draft',
    images: [{ mimeType: 'image/png', data: 'data:image/png;base64,aGVsbG8=' }],
    files: [{ id: 'file', filename: 'notes.txt', mimeType: 'text/plain', data: bytes, status: 'selected' }],
  });
  const original = useThreadDraftStore.getState().drafts['mini-draft'];
  await render();
  await act(async () => open().click());
  expect(desktop.invoke).toHaveBeenCalledWith('desktop_focus_main_window', expect.anything());
  expect(desktop.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  expect(useThreadDraftStore.getState().drafts['mini-draft']).toBe(original);
  expect(await original.files![0]!.data.text()).toBe('original file');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('kept open');
});

it('also protects input typed while the main window is opening', async () => {
  let complete!: (value: unknown) => void;
  desktop.invoke.mockImplementation((command: string) => command === 'desktop_focus_main_window'
    ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ pinned: false }));
  await render();
  act(() => open().click());
  useThreadDraftStore.getState().patch('new-draft', { text: 'Typed during the handoff' });
  await act(async () => complete({ focused: true }));
  expect(desktop.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  expect(useThreadDraftStore.getState().drafts['new-draft'].text).toBe('Typed during the handoff');
});


it('Tauri waits for draft acceptance rather than native focus before closing and releasing the source', async () => {
  window.__VARIN_DESKTOP_RUNTIME__ = { runtime: 'tauri', arch: 'x64', macVibrancy: false, macVibrancySupported: false, trayEnabled: false };
  const key = JSON.stringify(['test-host', 'draft', 'source']);
  useThreadStore.setState({ selectedDraftKey: key });
  useThreadDraftStore.getState().patch(key, { text: 'Await receiver', files: [{ id: 'upload-key', filename: 'keep.txt', mimeType: 'text/plain', data: new Blob(['copy bytes']), status: 'selected' }] });
  const original = useThreadDraftStore.getState().drafts[key];
  let accept!: (result: { accepted: true }) => void;
  desktop.invoke.mockImplementation((command: string) => command === 'desktop_transfer_draft'
    ? new Promise(resolve => { accept = resolve; }) : Promise.resolve({ pinned: false }));
  await render();
  await act(async () => open().click());
  await vi.waitFor(() => expect(desktop.invoke).toHaveBeenCalledWith('desktop_transfer_draft', expect.objectContaining({ transfer: expect.objectContaining({ sourceDraftKey: key, draft: expect.objectContaining({ text: 'Await receiver' }) }) })));
  expect(desktop.invoke).not.toHaveBeenCalledWith('desktop_focus_main_window', expect.anything());
  expect(desktop.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  expect(useThreadDraftStore.getState().drafts[key]).toBe(original);
  await act(async () => accept({ accepted: true }));
  expect(desktop.invoke).toHaveBeenCalledWith('desktop_close_current_window');
  expect(useThreadDraftStore.getState().drafts[key]).toBeUndefined();
});

it.each(['Receiver rejected this draft', 'Draft acknowledgment timed out; acceptance is unknown'])('Tauri keeps the actual source draft and window on %s', async error => {
  window.__VARIN_DESKTOP_RUNTIME__ = { runtime: 'tauri', arch: 'x64', macVibrancy: false, macVibrancySupported: false, trayEnabled: false };
  const key = JSON.stringify(['test-host', 'draft', 'source']);
  useThreadStore.setState({ selectedDraftKey: key });
  useThreadDraftStore.getState().patch(key, { text: 'Keep on failure' });
  desktop.invoke.mockImplementation((command: string) => command === 'desktop_transfer_draft' ? Promise.reject(new Error(error)) : Promise.resolve({ pinned: false }));
  await render();
  await act(async () => open().click());
  expect(desktop.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  expect(useThreadDraftStore.getState().drafts[key].text).toBe('Keep on failure');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(error);
});

it.each(['workflow', 'collaboration'] as const)('does not discard another empty draft with unfinished %s work after the selected draft transfers', async kind => {
  window.__VARIN_DESKTOP_RUNTIME__ = { runtime: 'tauri', arch: 'x64', macVibrancy: false, macVibrancySupported: false, trayEnabled: false };
  const key = JSON.stringify(['test-host', 'draft', 'source']);
  useThreadStore.setState({ selectedDraftKey: key });
  useThreadDraftStore.getState().patch(key, { text: 'Transfer this draft' });
  useThreadDraftStore.getState().patch('other-draft', kind === 'workflow'
    ? { composerWorkflow: { remember: { pending: { key: 'unconfirmed' } as NonNullable<NonNullable<ThreadDraft['composerWorkflow']>['remember']>['pending'] } } }
    : { collaboration: { targets: [], sending: true } });
  const original = useThreadDraftStore.getState().drafts['other-draft'];
  desktop.invoke.mockImplementation(async (command: string) => command === 'desktop_transfer_draft' ? { accepted: true } : { pinned: false });
  await render();
  await act(async () => open().click());
  expect(useThreadDraftStore.getState().drafts[key]).toBeUndefined();
  expect(useThreadDraftStore.getState().drafts['other-draft']).toBe(original);
  expect(desktop.invoke).not.toHaveBeenCalledWith('desktop_close_current_window');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('unfinished composer work');
});
