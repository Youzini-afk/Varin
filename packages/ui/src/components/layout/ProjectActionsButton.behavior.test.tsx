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
  translate: (key: string) => key,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: mocks.mobile }) }));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => false, canUseElectronDesktopIPC: () => false }));
vi.mock('@/lib/project-config', () => ({ getProjectActionsState: mocks.readActions }));
vi.mock('@/lib/detectDevServer', () => ({
  readPackageJsonScripts: async () => ({ dev: 'vite' }),
  detectDevServerCommand: async () => ({ command: 'bun run dev' }),
}));
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
  const render = async () => {
    await act(async () => {
      root.render(<ProjectActionsButton
        projectRef={{ id: 'project', path: '/repo' }} directory="/repo" allowMobile
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
    useTerminalStore.setState({ sessions: new Map(), buffers: new Map(), projectActionRuns: {} });
    useUIStore.setState({ contextPanelByDirectory: {} });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps project navigation visible on mobile without configured commands', async () => {
    mocks.mobile = true;
    await render();
    expect(container.textContent).toContain('Project');
    expect(mocks.readActions).not.toHaveBeenCalled();
    await openMenu();
    expect(container.textContent).toContain('Edit project');
    expect(container.textContent).toContain('projectActions.actions.addNewAction');
  });

  it('starts preview from the menu and still discovers its URL after the menu closes', async () => {
    await render();
    expect(mocks.readActions).not.toHaveBeenCalled();
    await openMenu();
    const launch = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'contextPanel.preview.startPreview');
    expect(launch).toBeDefined();
    await act(async () => { launch!.click(); });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(mocks.sendInput).toHaveBeenCalledWith(expect.any(String), 'bun run dev\r');
    const [run] = Object.values(useTerminalStore.getState().projectActionRuns);
    await act(async () => {
      mocks.subscriptions.get(run!.sessionId)!.onEvent({ type: 'data', data: 'Local: http://localhost:5173\n', sequence: 1 });
    });
    const tabs = useUIStore.getState().contextPanelByDirectory['/repo']?.tabs;
    expect(tabs?.some((tab) => tab.targetPath === 'http://localhost:5173')).toBe(true);
    expect(useTerminalStore.getState().projectActionRuns[run!.key]?.status).toBe('running');
    await act(async () => { mocks.subscriptions.get(run!.sessionId)!.onEvent({ type: 'exit', exitCode: 0 }); });
    expect(useTerminalStore.getState().projectActionRuns[run!.key]).toBeUndefined();
  });

  it('offers configured commands alongside preview and project management', async () => {
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
});
