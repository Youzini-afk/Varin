import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TerminalAPI, ThreadIdentity, ThreadProcessesAPI, ThreadProcessTerminal } from '@varin/application-client';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';
import { TerminalView } from './TerminalView';
import { WorkspaceTerminalDialog } from '@/components/workspace/WorkspaceTerminalDialog';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { attachProcessTerminal } from '@/lib/attachProcessTerminal';

const mocks = vi.hoisted(() => ({
  terminal: {
    connect: vi.fn<TerminalAPI['connect']>(), createSession: vi.fn<TerminalAPI['createSession']>(),
    close: vi.fn<TerminalAPI['close']>(), restartSession: vi.fn<NonNullable<TerminalAPI['restartSession']>>(),
    resize: vi.fn<TerminalAPI['resize']>(), sendInput: vi.fn<TerminalAPI['sendInput']>(),
  },
  threads: { processes: { openTerminal: vi.fn<ThreadProcessesAPI['openTerminal']>() } },
  endpointGeneration: 1,
  directory: '/coordinator',
  t: (key: string) => key,
  theme: { metadata: { variant: 'dark' }, colors: { surface: { background: '#000000' }, syntax: { base: { foreground: '#ffffff' } } } },
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ terminal: mocks.terminal, threads: mocks.threads, runtime: { platform: 'web' } }) }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => mocks.endpointGeneration }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: Object.assign(
  (select: (state: { currentDirectory: string }) => unknown) => select({ currentDirectory: mocks.directory }),
  { getState: () => ({ currentDirectory: mocks.directory }) },
) }));

vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: vi.fn() } }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: mocks.theme }) }));
vi.mock('@/hooks/useFontPreferences', () => ({ useFontPreferences: () => ({ monoFont: 'monospace' }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false, isTablet: false, hasTouchOnlyPointer: false }) }));
vi.mock('@/lib/terminalTheme', () => ({ convertThemeToXterm: () => ({ background: '#000000' }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(value => typeof value === 'string').join(' ') }));
vi.mock('@/stores/useInlineCommentDraftStore', () => ({ useInlineCommentDraftStore: () => vi.fn() }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@remixicon/react', () => ({ RiCloseLine: () => null, RiFullscreenExitLine: () => null, RiFullscreenLine: () => null, RiStopCircleLine: () => null, RiTerminalLine: () => null }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, onOpenChange, children }: React.PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void }>) => open
    ? <div role="dialog"><button aria-label="Dismiss terminal dialog" onClick={() => onOpenChange(false)} />{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button> }));
vi.mock('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: ({ items, onClose }: { items: { id: string; label: string; title: string }[]; onClose: (id: string) => void }) => <div>{items.map(item => <button key={item.id} title={item.title} onClick={() => onClose(item.id)}>{item.label}</button>)}</div> }));
vi.mock('@/components/terminal/TerminalViewport', () => ({ TerminalViewport: () => <div data-terminal-viewport /> }));

let root: Root;
let container: HTMLElement;
let handlers: Parameters<TerminalAPI['connect']>[1];
let detach: ReturnType<typeof vi.fn<() => void>>;
const managedOwner = { kind: 'managed_host' as const, hostId: 'host-b', connectionId: 'connection-b', endpointIdentity: 'sha256-b' };
const originalIdentity: ThreadIdentity = { runtime: 'agent', threadId: 'original-thread', branchId: 'original-branch' };
const originalTerminal: ThreadProcessTerminal = { cwd: '/only-on-host-b', sessionId: 'original-managed-session', resourceOwner: managedOwner, operationId: 'original-operation', processId: 'original-process' };
beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  dom.document.hasFocus = () => false;
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useTerminalStore.getState().clearAll();
  useWorkspaceStore.getState().resetForTests();
  useTerminalStore.setState({ hasHydrated: true });
  useUIStore.setState({ showTerminalQuickKeysOnDesktop: false });
  detach = vi.fn<() => void>();
  mocks.terminal.connect.mockImplementation((_id, callback) => { handlers = callback; return { close: detach }; });
  mocks.terminal.close.mockResolvedValue(undefined);
  mocks.terminal.resize.mockResolvedValue(undefined);
  mocks.terminal.sendInput.mockResolvedValue(undefined);
  mocks.endpointGeneration = 1;
  mocks.directory = '/coordinator';
  mocks.threads.processes.openTerminal.mockResolvedValue(originalTerminal);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useTerminalStore.getState().clearAll();
  vi.unstubAllGlobals(); vi.resetAllMocks();
});
const attachManaged = () => useTerminalStore.getState().attachExistingSession('/coordinator', 'original-managed-session', 'Agent process', {
  cwd: '/only-on-host-b', resourceOwner: managedOwner,
  process: { identity: originalIdentity, operationId: originalTerminal.operationId, processId: originalTerminal.processId, endpointGeneration: 1 },
});
const tab = () => useTerminalStore.getState().getActiveTab('/coordinator');

it('attaches the owned remote session while preserving its host and source', async () => {
  attachManaged();
  await act(async () => root.render(<TerminalView visible />));
  expect(mocks.terminal.connect).toHaveBeenCalledWith('original-managed-session', expect.any(Object));
  await act(async () => handlers.onEvent({ type: 'snapshot', status: 'running', sequence: 0, data: 'Server ready: http://localhost:3456/\n' }));
  await act(async () => handlers.onEvent({ type: 'data', sequence: 1, data: 'Local: http://127.0.0.1:7890/\n' }));
  expect(mocks.terminal.createSession).not.toHaveBeenCalled();
  expect(container.querySelector('[title="Agent process · host-b · /only-on-host-b"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[title="Agent process · host-b · /only-on-host-b"]')!.click());
  expect(detach).toHaveBeenCalled();
  expect(mocks.terminal.close).not.toHaveBeenCalled();
  expect(mocks.terminal.restartSession).not.toHaveBeenCalled();
});

it.each([
  ['PROCESS_UNAVAILABLE', false], ['SESSION_NOT_FOUND', true],
] as const)('retains the accepted owner after %s (fatal: %s) and retries the same attachment', async (code, fatal) => {
  const id = attachManaged();
  await act(async () => root.render(<TerminalView visible />));
  await act(async () => handlers.onError?.(Object.assign(new Error('Host B is unavailable'), { code }), fatal));
  expect(tab()).toMatchObject({ id, lifecycle: 'running', terminalSessionId: 'original-managed-session' });
  expect(container.textContent).toContain('terminalView.error.connectionFailed');
  let rebind!: (value: ThreadProcessTerminal) => void;
  mocks.threads.processes.openTerminal.mockImplementationOnce(() => new Promise(resolve => { rebind = resolve; }));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.retry"]')!.click());
  expect(mocks.threads.processes.openTerminal).toHaveBeenCalledExactlyOnceWith({ ...originalIdentity, operationId: originalTerminal.operationId });
  expect(mocks.terminal.connect).toHaveBeenCalledTimes(1);
  await act(async () => rebind(originalTerminal));
  expect(mocks.terminal.connect).toHaveBeenCalledTimes(2);
  expect(mocks.terminal.connect.mock.calls.map(([session]) => session)).toEqual(['original-managed-session', 'original-managed-session']);
  expect(mocks.terminal.createSession).not.toHaveBeenCalled();
  expect(mocks.terminal.restartSession).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain('terminalView.error.connectionFailed');
  await act(async () => handlers.onEvent({ type: 'exit', sequence: 4, exitCode: 7 }));
  expect(tab()?.lifecycle).toBe('exited');
});

it('keeps the original session retryable when process-view rebinding is rejected', async () => {
  attachManaged();
  await act(async () => root.render(<TerminalView visible />));
  await act(async () => handlers.onError?.(Object.assign(new Error('Host B is unavailable'), { code: 'PROCESS_UNAVAILABLE' }), false));
  mocks.threads.processes.openTerminal.mockRejectedValueOnce(new Error('Original authority unavailable'));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.retry"]')!.click());
  expect(mocks.terminal.connect).toHaveBeenCalledTimes(1);
  expect(tab()).toMatchObject({ lifecycle: 'running', terminalSessionId: originalTerminal.sessionId });
  expect(container.textContent).toContain('terminalView.error.connectionFailed');
  expect(container.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.retry"]')!.disabled).toBe(false);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.retry"]')!.click());
  expect(mocks.threads.processes.openTerminal).toHaveBeenCalledTimes(2);
  expect(mocks.terminal.connect).toHaveBeenCalledTimes(2);
  expect(mocks.terminal.createSession).not.toHaveBeenCalled();
  expect(mocks.terminal.restartSession).not.toHaveBeenCalled();
});

it.each(['host changed', 'tab closed', 'view hidden', 'identity changed'] as const)('discards a pending rebind after %s', async change => {
  const id = attachManaged();
  await act(async () => root.render(<TerminalView visible />));
  await act(async () => handlers.onError?.(Object.assign(new Error('Host B is unavailable'), { code: 'PROCESS_UNAVAILABLE' }), false));
  let rebind!: (value: ThreadProcessTerminal) => void;
  mocks.threads.processes.openTerminal.mockImplementationOnce(() => new Promise(resolve => { rebind = resolve; }));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.retry"]')!.click());
  if (change === 'host changed') mocks.endpointGeneration += 1;
  if (change === 'tab closed') await act(async () => useTerminalStore.getState().removeDirectory('/coordinator'));
  if (change === 'view hidden') await act(async () => root.render(<TerminalView visible={false} />));
  const opened = change === 'identity changed' ? { ...originalTerminal, sessionId: 'substituted-session' } : originalTerminal;
  await act(async () => rebind(opened));
  expect(mocks.terminal.connect).toHaveBeenCalledTimes(1);
  expect(mocks.terminal.restartSession).not.toHaveBeenCalled();
  if (change !== 'tab closed') expect(tab()).toMatchObject({ id, terminalSessionId: originalTerminal.sessionId });
  if (change === 'identity changed') expect(container.textContent).toContain('terminalView.error.connectionFailed');
});

it('displays an unavailable snapshot without inventing an exit or replacing the accepted process', async () => {
  attachManaged();
  await act(async () => root.render(<TerminalView visible />));
  await act(async () => handlers.onEvent({ type: 'snapshot', status: 'error', sequence: 3, data: 'Last confirmed output\n' }));
  expect(container.textContent).toContain('terminalView.error.connectionFailed');
  expect(tab()).toMatchObject({ lifecycle: 'running', terminalSessionId: 'original-managed-session' });
  expect(mocks.terminal.createSession).not.toHaveBeenCalled();
});

it('opens, retries, dismisses and reopens a remote-only process without a local workspace or shell', async () => {
  mocks.directory = '';
  const process = { identity: originalIdentity, operationId: originalTerminal.operationId, processId: originalTerminal.processId, endpointGeneration: 1 };
  const open = () => attachProcessTerminal(originalTerminal.cwd, originalTerminal.sessionId, 'Agent process', managedOwner, process);
  const id = open();
  const dialog = useWorkspaceStore.getState().terminalDialog;
  expect(id).not.toBeNull();
  expect(dialog).toMatchObject({ open: true, workspacePath: null, title: 'host-b · /only-on-host-b' });
  expect(useWorkspaceStore.getState().root).toBeNull();
  await act(async () => root.render(<WorkspaceTerminalDialog />));
  expect(mocks.terminal.connect).toHaveBeenCalledWith(originalTerminal.sessionId, expect.any(Object));
  expect(container.querySelector('[title="terminalView.tabs.newTabTitle"]')).toBeNull();
  await act(async () => handlers.onError?.(Object.assign(new Error('Host B is unavailable'), { code: 'PROCESS_UNAVAILABLE' }), false));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="terminalView.actions.retry"]')!.click());
  expect(mocks.threads.processes.openTerminal).toHaveBeenCalledExactlyOnceWith({ ...originalIdentity, operationId: originalTerminal.operationId });
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss terminal dialog"]')!.click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(useTerminalStore.getState().getActiveTab(dialog.directoryKey)?.terminalSessionId).toBe(originalTerminal.sessionId);
  await act(async () => { expect(open()).toBe(id); });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[title="Agent process · host-b · /only-on-host-b"]')!.click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(detach).toHaveBeenCalled();
  expect(mocks.directory).toBe('');
  expect(mocks.terminal.createSession).not.toHaveBeenCalled();
  expect(mocks.terminal.restartSession).not.toHaveBeenCalled();
  expect(mocks.terminal.close).not.toHaveBeenCalled();
});
