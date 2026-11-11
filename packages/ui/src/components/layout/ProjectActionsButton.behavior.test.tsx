import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalHandlers } from '@varin/application-client';
import { ProjectActionsButton } from './ProjectActionsButton';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';

const mocks = vi.hoisted(() => ({
  mobile: false,
  readActions: vi.fn(),
  subscriptions: new Map<string, TerminalHandlers>(),
  createSession: vi.fn(),
  sendInput: vi.fn(),
  openExternal: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: mocks.mobile }) }));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => false, canUseElectronDesktopIPC: () => false }));
vi.mock('@/lib/project-config', () => ({ getProjectActionsState: mocks.readActions }));
vi.mock('@/lib/url', () => ({ openExternalUrl: mocks.openExternal }));
vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'dark' }, colors: { surface: { background: '#111' }, syntax: { base: { foreground: '#eee' } } } } }),
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ terminal: {
    createSession: mocks.createSession,
    sendInput: mocks.sendInput,
    connect: (id: string, handlers: TerminalHandlers) => {
      mocks.subscriptions.set(id, handlers);
      return { close: () => { mocks.subscriptions.delete(id); } };
    },
  } }),
}));

// Closing the popup removes its items while leaving the action controller mounted.
vi.mock('@/components/ui/context-menu', async () => {
  const { createContext, useContext, useState } = await import('react');
  const Menu = createContext({ open: false, toggle: (_open: boolean) => {} });
  return {
    ContextMenu: ({ children, onOpenChange }: React.PropsWithChildren<{ onOpenChange(open: boolean): void }>) => {
      const [open, setOpen] = useState(false);
      return <Menu.Provider value={{ open, toggle: (next) => { setOpen(next); onOpenChange(next); } }}>{children}</Menu.Provider>;
    },
    ContextMenuTrigger: ({ render }: { render: React.ReactElement }) => {
      const menu = useContext(Menu);
      return <div onContextMenu={() => menu.toggle(true)}>{render}</div>;
    },
    ContextMenuContent: ({ children }: React.PropsWithChildren) => useContext(Menu).open ? <div role="menu">{children}</div> : null,
    ContextMenuItem: ({ children, onClick, disabled }: React.PropsWithChildren<{ onClick(): void; disabled?: boolean }>) => {
      const menu = useContext(Menu);
      return <button type="button" disabled={disabled} onClick={() => { onClick(); menu.toggle(false); }}>{children}</button>;
    },
    ContextMenuSeparator: () => <hr />,
  };
});

describe('project menu actions', () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async (resourceOwner?:import('@varin/protocol').SourceResourceOwner, versionedWorkspace?:import('@varin/application-client').VersionedProjectWorkspace) => {
    await act(async () => {
      root.render(<ProjectActionsButton
        projectRef={{ id: 'project', path: '/repo',versionedWorkspace,...(resourceOwner?{resourceOwner}:{}) }} directory="/repo" allowMobile
        contextMenu={{ trigger: <div data-project="repo">Project</div>, children: <span>Edit project</span> }}
      />);
    });
  };
  const openMenu = async () => {
    await act(async () => {
      container.querySelector('[data-project]')!.dispatchEvent(new window.Event('contextmenu', { bubbles: true }));
    });
  };

  beforeEach(() => {
    const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.mobile = false;
    mocks.subscriptions.clear();
    mocks.readActions.mockReset().mockResolvedValue({ actions: [] });
    mocks.createSession.mockReset().mockImplementation(async ({ sessionId }: { sessionId: string }) => ({ sessionId }));
    mocks.sendInput.mockReset().mockResolvedValue(undefined);
    mocks.openExternal.mockReset().mockResolvedValue(undefined);
    useTerminalStore.setState({ sessions: new Map(), buffers: new Map(), projectActionRuns: {} });
    useUIStore.setState({ contextPanelByDirectory: {} });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each([true, false])('keeps project navigation visible without configured commands (mobile: %s)', async (mobile) => {
    mocks.mobile = mobile;
    await render();
    expect(container.textContent).toContain('Project');
    expect(mocks.readActions).not.toHaveBeenCalled();
    await openMenu();
    expect(container.textContent).toContain('Edit project');
    expect(container.textContent).toContain('projectActions.actions.addNewAction');
  });

  it('passes the exact managed Host to terminal creation and isolates identical local action names',async()=>{
    const resourceOwner={kind:'managed_host' as const,hostId:'target',connectionId:'paired',endpointIdentity:'endpoint'};
    mocks.readActions.mockResolvedValue({actions:[{id:'dev',name:'Target dev',command:'target-command'}]});
    await render(resourceOwner);await openMenu();
    const launch=Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='Target dev')!;
    await act(async()=>launch.click());
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({cwd:'/repo',resourceOwner}));
    const [key]=Object.keys(useTerminalStore.getState().projectActionRuns);
    expect(key).toContain('target');expect(key).toContain('endpoint');
  });

  it('isolates same-path owner tabs and freezes adopted selection in the tab source', async () => {
    const first = { kind: 'managed_host' as const, hostId: 'device-b', connectionId: 'pair-b', endpointIdentity: 'endpoint-b' };
    const second = { ...first, hostId: 'device-c', connectionId: 'pair-c' };
    const versionedWorkspace = { state: 'ready' as const, workspaceId: 'workspace', executionWorkspaceId: 'execution', branchId: 'branch', adoptionOperationId: 'adoption' };
    mocks.readActions.mockResolvedValue({ actions: [{ id: 'dev', name: 'Scoped action', command: 'echo source' }] });
    for (const owner of [first, second]) {
      await render(owner, versionedWorkspace); await openMenu();
      await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Scoped action')!.click());
    }
    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    const entries = [...useTerminalStore.getState().sessions.entries()].filter(([key]) => key.startsWith('project-action:'));
    expect(entries).toHaveLength(2);
    expect(entries.map(([, value]) => value.tabs[0].source?.resourceOwner)).toEqual([first, second]);
    for (const [, value] of entries) {
      expect(value.tabs).toHaveLength(1);
      expect(value.tabs[0].source).toMatchObject({ cwd: '/repo', selection: { mode: 'native_workspace', workspaceId: 'workspace', executionWorkspaceId: 'execution', branchId: 'branch', adoptionOperationId: 'adoption' } });
    }
    expect(mocks.createSession.mock.calls[0][0]).toMatchObject({ cwd: '/repo', selection: { mode: 'native_workspace' } });
  });

  it('opens the configured action output URL once after the menu closes', async () => {
    mocks.readActions.mockResolvedValue({ actions: [{ id: 'dev', name: 'Dev server', command: 'bun run dev', autoOpenUrl: true }] });
    await render();
    expect(mocks.readActions).not.toHaveBeenCalled();
    await openMenu();
    const launch = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Dev server');
    expect(launch).toBeDefined();
    await act(async () => { launch!.click(); });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(mocks.sendInput).toHaveBeenCalledWith(expect.any(String), 'bun run dev\r');
    const [run] = Object.values(useTerminalStore.getState().projectActionRuns);
    await act(async () => {
      mocks.subscriptions.get(run!.sessionId)!.onEvent({ type: 'data', data: 'Local: http://localhost:5173\n', sequence: 1 });
    });
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith('http://localhost:5173');
    await act(async () => {
      mocks.subscriptions.get(run!.sessionId)!.onEvent({ type: 'data', data: 'Local: http://localhost:5173\n', sequence: 2 });
    });
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().projectActionRuns[run!.key]?.status).toBe('running');
    await act(async () => { mocks.subscriptions.get(run!.sessionId)!.onEvent({ type: 'exit', exitCode: 0 }); });
    expect(useTerminalStore.getState().projectActionRuns[run!.key]).toBeUndefined();
  });

  it('runs configured commands alongside project management', async () => {
    mocks.readActions.mockResolvedValue({ actions: [{ id: 'check', name: 'Check types', command: 'bun run type-check', icon: 'play' }] });
    await render();
    await openMenu();
    const command = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Check types');
    expect(command).toBeDefined();
    await act(async () => { command!.click(); });
    expect(mocks.sendInput).toHaveBeenCalledWith(expect.any(String), 'bun run type-check\r');
    const [run] = Object.values(useTerminalStore.getState().projectActionRuns);
    await act(async () => { mocks.subscriptions.get(run!.sessionId)!.onEvent({ type: 'exit', exitCode: 0 }); });
  });

  it('opens a configured URL in the existing browser surface', async () => {
    mocks.readActions.mockResolvedValue({ actions: [{ id: 'dev', name: 'Dev server', command: 'bun run dev', autoOpenUrl: true, openUrl: 'http://localhost:4321' }] });
    await render();
    await openMenu();
    const launch = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Dev server')!;
    await act(async () => launch.click());
    expect(useUIStore.getState().contextPanelByDirectory['/repo']?.tabs).toEqual([
      expect.objectContaining({ mode: 'browser', targetPath: 'http://localhost:4321/' }),
    ]);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    const [run] = Object.values(useTerminalStore.getState().projectActionRuns);
    await act(async () => mocks.subscriptions.get(run!.sessionId)!.onEvent({ type: 'exit', exitCode: 0 }));
  });
});
