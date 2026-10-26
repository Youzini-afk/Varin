import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict } from '@/lib/i18n/messages/zh-CN';
import { ChatFileMenu } from './ChatFileMenu';
import type { ChatFileTarget } from './chatFileTargets';

const mocks = vi.hoisted(() => ({
  runtime: 'local', local: true,
  read: vi.fn(), resolveWorkspace: vi.fn(), download: vi.fn(), copy: vi.fn(), error: vi.fn(),
  openApp: vi.fn(), openDefault: vi.fn(), reveal: vi.fn(), initialize: vi.fn(),
}));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(), getRuntimeKey: () => mocks.runtime,
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({
  documents: { read: mocks.read, resolveWorkspace: mocks.resolveWorkspace }, files: { downloadFile: mocks.download },
}) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params: Record<string, string> = {}) =>
  dict[key].replace(/\{(\w+)\}/g, (_, name) => params[name]) }) }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }));
vi.mock('@/lib/desktop', () => ({
  isDesktopShell: () => true, isDesktopLocalOriginActive: () => mocks.local,
  openDesktopFileInApp: mocks.openApp, openDesktopPath: mocks.openDefault, revealDesktopPath: mocks.reveal,
}));
vi.mock('@/stores/useOpenInAppsStore', () => ({ useOpenInAppsStore: (select: (state: unknown) => unknown) => select({
  selectedAppId: 'cursor', initialize: mocks.initialize,
  availableApps: [{ id: 'finder', label: '文件资源管理器' }, { id: 'terminal', label: '终端' },
    { id: 'vscode', label: 'VS Code', appName: 'Visual Studio Code' }, { id: 'cursor', label: 'Cursor', appName: 'Cursor' }],
}) }));
vi.mock('@/components/desktop/OpenInAppButton', () => ({ AppIcon: () => null }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: mocks.error } }));
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenuItem: ({ children, onClick }: React.PropsWithChildren<{ onClick(): void }>) => <button onClick={onClick}>{children}</button>,
  ContextMenuSeparator: () => <hr />,
  ContextMenuSub: ({ children }: React.PropsWithChildren) => children,
  ContextMenuSubTrigger: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  ContextMenuSubContent: ({ children }: React.PropsWithChildren) => <section>{children}</section>,
}));

beforeEach(() => {
  vi.clearAllMocks(); mocks.runtime = 'local'; mocks.local = true;
  mocks.copy.mockResolvedValue({ ok: true }); mocks.openApp.mockResolvedValue(true);
  mocks.openDefault.mockResolvedValue(true); mocks.reveal.mockResolvedValue(true);
  const { document, window } = parseHTML('<html><body></body></html>');
  Object.assign(window, { __VARIN_PLATFORM__: 'win32' });
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
});
afterEach(() => vi.unstubAllGlobals());

async function mount(target: ChatFileTarget) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ChatFileMenu target={target} />));
  return {
    container,
    click: async (label: string) => act(async () => {
      const button = [...container.querySelectorAll('button')].find(button => button.textContent === label);
      if (!button) throw new Error(`Missing action: ${label}`);
      button.click();
    }),
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

it('uses the captured task source for editor opening, original-file download and text copying', async () => {
  const resource = { workspaceId: 'child-copy', resourceId: 'src/report.md' };
  const resolve = vi.fn(async () => ({ path: 'D:/copies/child/src/report.md', directory: 'D:/copies/child', resource }));
  const open = vi.fn();
  mocks.read.mockResolvedValue({ status: 'ready', content: '# 完整报告\n不是工具摘要\n' });
  const menu = await mount({ path: 'src/report.md', runtimeKey: 'local', open, resolve });
  try {
    expect(resolve).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
    await menu.click('打开文件'); expect(open).toHaveBeenCalledOnce();
    await menu.click('在 Cursor 中打开');
    expect(mocks.openApp).toHaveBeenLastCalledWith('D:/copies/child/src/report.md', 'cursor', 'Cursor');
    await menu.click('VS Code');
    expect(mocks.openApp).toHaveBeenLastCalledWith('D:/copies/child/src/report.md', 'vscode', 'Visual Studio Code');
    await menu.click(dict['chat.context.systemDefault']); expect(mocks.openDefault).toHaveBeenCalledWith('D:/copies/child/src/report.md');
    await menu.click(dict['chat.context.saveFileAs']);
    expect(mocks.download).toHaveBeenCalledWith('D:/copies/child/src/report.md', { directory: 'D:/copies/child' });
    await menu.click(dict['chat.context.copyFileContent']);
    expect(mocks.read).toHaveBeenCalledWith(resource); expect(mocks.resolveWorkspace).not.toHaveBeenCalled();
    expect(mocks.copy).toHaveBeenLastCalledWith('# 完整报告\n不是工具摘要\n');
    await menu.click(dict['chat.context.copyPath']); expect(mocks.copy).toHaveBeenLastCalledWith('D:/copies/child/src/report.md');
    await menu.click(dict['common.revealPath.fileExplorer']); expect(mocks.reveal).toHaveBeenCalledWith('D:/copies/child/src/report.md');
    expect(mocks.error).not.toHaveBeenCalled();
  } finally { menu.unmount(); }
});

it('resolves Markdown files through Documents and keeps binary data out of the text clipboard', async () => {
  mocks.resolveWorkspace.mockResolvedValue({ workspaceId: 'markdown-root' });
  mocks.read.mockResolvedValue({ status: 'binary' });
  const menu = await mount({ path: 'D:/project/report.pdf', directory: 'D:/project', runtimeKey: 'local', open() {} });
  try {
    await menu.click(dict['chat.context.copyFileContent']);
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith({ path: 'D:/project' });
    expect(mocks.read).toHaveBeenCalledWith({ workspaceId: 'markdown-root', resourceId: 'report.pdf' });
    expect(mocks.copy).not.toHaveBeenCalled(); expect(mocks.error).toHaveBeenCalledWith(dict['chat.context.fileNotText']);
  } finally { menu.unmount(); }
});

it('does not offer local app actions for remote files or copy a pending read after a Host switch', async () => {
  mocks.runtime = 'remote'; mocks.local = false;
  let finishRead!: (value: { status: string; content: string }) => void;
  mocks.read.mockReturnValue(new Promise(resolve => { finishRead = resolve; }));
  const menu = await mount({ path: '/work/report.txt', runtimeKey: 'remote', open() {}, resolve: async () => ({
    path: '/work/report.txt', directory: '/work', resource: { workspaceId: 'remote-root', resourceId: 'report.txt' },
  }) });
  try {
    expect(menu.container.textContent).not.toContain('Cursor');
    expect(menu.container.textContent).not.toContain(dict['chat.context.openWith']);
    expect(menu.container.textContent).not.toContain(dict['common.revealPath.fileExplorer']);
    await menu.click(dict['chat.context.copyFileContent']);
    mocks.runtime = 'another-host';
    await act(async () => finishRead({ status: 'ready', content: 'old Host contents' }));
    expect(mocks.copy).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
  } finally { menu.unmount(); }
});
