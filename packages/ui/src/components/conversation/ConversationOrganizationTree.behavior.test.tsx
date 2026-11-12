import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ConversationOrganizationSnapshot, ConversationOrganizationCommand, ConversationOrganizationEvent } from '@varin/application-client';
import { ConversationOrganizationTree } from './ConversationOrganizationTree';
import { useConversationOrganizationStore, readOrganizationActionScope, loadOrganizationPage, refreshConversationOrganization, submitOrganization } from '@/stores/useConversationOrganizationStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { DragEndEvent } from '@dnd-kit/core';
import { projectOrganization } from './organizationProjection';

const transport = vi.hoisted(() => ({ read: vi.fn(), command: vi.fn(), metadata: vi.fn(), observe: vi.fn(), listeners: new Set<(event: ConversationOrganizationEvent) => void>(), open: vi.fn(), create: vi.fn(), generation: 1, undo: undefined as (() => void) | undefined, drop: undefined as ((event: DragEndEvent) => void) | undefined }));
vi.mock('@dnd-kit/core', async load => {
  const original = await load<typeof import('@dnd-kit/core')>();
  return { ...original, DndContext: (props: React.ComponentProps<typeof original.DndContext>) => {
    transport.drop = props.onDragEnd;
    return React.createElement(original.DndContext, props);
  } };
});
vi.mock('./sidebarHighlights', () => ({ useHoverPill: () => {}, useSelectionGlide: () => {} }));
vi.mock('@/lib/desktop', () => ({ canUseElectronDesktopIPC: () => false, invokeDesktop: vi.fn() }));
vi.mock('@/workbenches/bot/botWorkspaceViews', () => ({ useBotWorkspaceNavigation: () => null }));
vi.mock('@/workbenches/bot/botPresentation', () => ({ workKey: (identity: { threadId: string; branchId: string }) => `${identity.threadId}:${identity.branchId}`, isWaitingStatus: () => false, runStatus: () => null }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/lib/i18n', async () => { const { conversationOrganizationZhCN } = await import('@/lib/i18n/messages/conversation-organization'); return { useI18n: () => ({ t: (key: keyof typeof conversationOrganizationZhCN, params: Record<string, unknown> = {}) => Object.entries(params).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), conversationOrganizationZhCN[key] ?? key) }) }; });
vi.mock('@/hooks/useRuntimeAPIs', () => { const apis = { conversationOrganization: { read: transport.read, command: transport.command, metadata: transport.metadata, observe: transport.observe }, bots: { list: async () => [] } }; return { useRuntimeAPIs: () => apis }; });
vi.mock('@varin/application-client', async original => ({ ...await original<object>(), getRuntimeEndpointGeneration: () => transport.generation }));
vi.mock('@/stores/useThreadStore', () => { const state = { get hostKey() { return String(transport.generation); }, threads: [], selectedIdentity: null, loadCatalog: async () => {} }; return { useThreadStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) }; });
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (s: unknown) => unknown) => select({ projects: [{ id: 'project', path: '/project', label: 'Project' }] }) }));
vi.mock('@/stores/useExternalAgentStore', () => { const state = { conversations: [], children: [], selectedId: null, refresh: async () => {} }; return { useExternalAgents: () => {}, useExternalAgentStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) }; });
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ startThreadFromNavigation: transport.create, openThreadFromNavigation: transport.open, openExternalConversationFromNavigation: transport.open }));
vi.mock('@/lib/bots', () => ({ openBotEntryFor: vi.fn(), useBotNavigation: (select: (state: { entry: null }) => unknown) => select({ entry: null }) }));
vi.mock('@/components/layout/ProjectActionsButton', () => ({ ProjectActionsButton: () => null }));
vi.mock('@/components/sections/projects/ProjectCreateDialog', () => ({ ProjectCreateDialog: () => null }));
vi.mock('@/lib/projectMeta', () => ({ ProjectIconImage: ({ fallback }: { fallback: React.ReactNode }) => fallback, PROJECT_ICON_MAP: {}, PROJECT_COLOR_MAP: {} }));
vi.mock('@/lib/workspaceEvents', () => ({ workspaceEvents: { requestDirectoryDialog: vi.fn() } }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: (_message: string, data: { action: { onClick(): void } }) => { transport.undo = data.action.onClick; return 'undo'; }, dismiss: () => {} } }));
vi.mock('@/components/ui/dialog', () => {
  const Part = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  return { Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null, DialogContent: Part, DialogHeader: Part, DialogTitle: Part, DialogDescription: Part, DialogFooter: Part };
});
vi.mock('@/components/ui/context-menu', () => {
  const Part = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const Item = ({ children, onClick }: React.PropsWithChildren<{ onClick?(): void }>) => <button onClick={onClick}>{children}</button>;
  return { ContextMenu: Part, ContextMenuTrigger: Part, ContextMenuContent: () => null, ContextMenuItem: Item, ContextMenuSeparator: () => <hr />, ContextMenuSub: Part, ContextMenuSubTrigger: Item, ContextMenuSubContent: Part };
});
vi.mock('@/components/ui/AgentAvatar', () => ({ AgentAvatar: () => <span /> }));
vi.mock('@/workbenches/bot/BotFigure', () => ({ BotFigure: () => <span /> }));
vi.mock('./FlipList', () => ({ FlipList: ({ children, containerRef }: React.PropsWithChildren<{ containerRef: React.Ref<HTMLDivElement> }>) => <div ref={containerRef}>{children}</div> }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onInput={onChange as React.FormEventHandler<HTMLInputElement>} /> }));
vi.mock('@/components/ui/dropdown-menu', () => {
  const Menu = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const Item = ({ children, onClick }: React.PropsWithChildren<{ onClick?(): void }>) => <button onClick={onClick}>{children}</button>;
  return { DropdownMenu: Menu, DropdownMenuTrigger: Menu, DropdownMenuContent: Menu, DropdownMenuSeparator: () => <hr />, DropdownMenuItem: Item, DropdownMenuSub: Menu, DropdownMenuSubTrigger: Item, DropdownMenuSubContent: Menu };
});
const original = (): ConversationOrganizationSnapshot => ({ initialized: true, revision: 1, rootRevision: 1, cursor: 1, nextCursor: null, containers: [
  { id: 'work', kind: 'group', parentId: null, order: 0, revision: 1, childrenRevision: 1, name: 'Work', icon: null, color: null, projectId: null },
  { id: 'project-node', kind: 'project', parentId: 'work', order: 0, revision: 1, childrenRevision: 1, name: null, icon: null, color: null, projectId: 'project' },
], conversations: ['Task', 'Child', 'Moved'].map((title, index) => ({ conversation: { kind: 'native', id: title }, title, archived: false, pinned: false, revision: 1, position: { conversation: { kind: 'native', id: title }, containerId: index === 2 ? 'work' : 'project-node', order: index, revision: 1, explicit: index !== 1, inheritedFrom: index === 1 ? { kind: 'native', id: 'Task' } : null }, origin: { botId: null, directBotId: null, conversation: null }, path: [] })) });
let root: Root, container: HTMLDivElement, snapshot: ConversationOrganizationSnapshot;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver'] as const) vi.stubGlobal(key, key === 'window' ? window : key === 'document' ? document : window[key]);
  vi.stubGlobal('navigator', { userAgent: 'test' }); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('getComputedStyle', () => ({ position: 'static', transform: 'none', getPropertyValue: () => '' }));
  transport.generation++; snapshot = original(); transport.read.mockReset().mockImplementation(async () => structuredClone(snapshot)); transport.command.mockReset(); transport.metadata.mockReset(); transport.open.mockReset().mockResolvedValue(undefined); transport.create.mockReset().mockResolvedValue(undefined); transport.listeners.clear();
  transport.undo = undefined;
  useSessionDisplayStore.setState({ organizationNavigationByHost: {} });
  transport.observe.mockReset().mockImplementation((_cursor: number, listener: (event: ConversationOrganizationEvent) => void, { signal }: { signal: AbortSignal }) => { transport.listeners.add(listener); return new Promise<void>(resolve => signal.addEventListener('abort', () => { transport.listeners.delete(listener); resolve(); })); });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const render = async (query = '') => { await act(async () => root.render(<ConversationOrganizationTree query={query} />)); };
const revealResults = async () => { const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '部分操作需要处理'); if (trigger?.getAttribute('aria-expanded') !== 'true') await act(async () => trigger?.click()); };
const click = async (label: string) => { if (label === '撤销移动') { expect(transport.undo).toBeTypeOf('function'); await act(async () => transport.undo!()); return; } if (label === '只重试未确认项') await revealResults(); const button = [...container.querySelectorAll('button')].find(b => b.textContent === label)!; expect(button).toBeTruthy(); await act(async () => button.click()); };
const destination = async (id: string) => {
  const name = snapshot.containers.find(container => container.id === id)?.name ?? 'Project';
  const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索目标分类"]')!;
  await act(async () => { search.value = name; search.dispatchEvent(new Event('input', { bubbles: true })); });
  const target = container.querySelector<HTMLButtonElement>(`button[data-organization-id="${id}"]`)!;
  expect(target).toBeTruthy(); await act(async () => target.click());
};
const row = (name: string) => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(r => [...r.querySelectorAll('button')].some(b => b.title === name))!;

it('keeps one observation for multiple views and nests inherited children only once', async () => {
  await act(async () => root.render(<><ConversationOrganizationTree /><ConversationOrganizationTree viewKey="ide" /></>));
  expect(transport.observe).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll('button[title="Child"]')).toHaveLength(2);
  for (const title of ['Work', 'Project', 'Task']) await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="展开 ${title}"]`)!.click());
  expect(row('Task').getAttribute('aria-expanded')).toBe('true');
  expect(row('Child').closest('[inert]')).toBeNull();
  expect(row('Moved')).toBeTruthy();
});
it('opens original identity and locks the nearest project and explicit container for a new draft', async () => {
  await render(); await click('Task'); expect(transport.open).toHaveBeenCalledWith({ threadId: 'Task' });
  await act(async () => [...row('Project').querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '新建会话')!.click());
  expect(transport.create).toHaveBeenCalledWith({ directory: '/project', projectId: 'project', organization: { containerId: 'project-node' } });
});

it('keeps direct Bot chats out of workbench and IDE views while retaining every dispatched task', async () => {
  const direct = { ...snapshot.conversations[0], conversation: { kind: 'native' as const, id: 'Bot main' }, title: 'Bot main', position: { ...snapshot.conversations[0].position, conversation: { kind: 'native' as const, id: 'Bot main' } }, origin: { botId: null, directBotId: 'bot', conversation: null } };
  snapshot.conversations.push(direct);
  snapshot.conversations[0].origin = { botId: 'bot', directBotId: null, conversation: direct.conversation };
  for (const viewKey of ['workbench', 'ide']) {
    await act(async () => root.render(<ConversationOrganizationTree viewKey={viewKey} />));
    expect(row('Bot main')).toBeUndefined(); expect(row('Task')).toBeTruthy(); expect(row('Child')).toBeTruthy();
    await click('最近');
    expect(row('Bot main')).toBeUndefined(); expect(row('Task')).toBeTruthy();
    await act(async () => root.render(<ConversationOrganizationTree viewKey={viewKey} query="Bot main" />));
    expect(row('Bot main')).toBeUndefined();
  }
  expect(transport.read.mock.calls.every(([query]) => query.excludeBotConversations)).toBe(true);
  await act(async () => root.render(<ConversationOrganizationTree viewKey="bot" />));
  expect(row('Bot main')).toBeTruthy();
});
it('search exposes only matching ancestry and restores collapsed state when cleared', async () => {
  await render(); await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="展开 Work"]')!.click()); const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="收起 Work"]')!;
  await act(async () => toggle.click()); expect(row('Work').getAttribute('aria-expanded')).toBe('false');
  await render('Child'); expect(row('Work').getAttribute('aria-expanded')).toBe('true'); expect(container.querySelector('button[title="Moved"]')).toBeNull();
  await render(); expect(row('Work').getAttribute('aria-expanded')).toBe('false');
});
it('submits group dialog edits with parent versions and keeps an ambiguous key for retry', async () => {
  await render(); await click('新建分组');
  const input = container.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')!;
  await act(async () => { input.value = 'Release'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  transport.command.mockRejectedValueOnce(new Error('response lost'));
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const first = transport.command.mock.calls[0][0] as ConversationOrganizationCommand;
  expect(first.operation).toMatchObject({ action: 'create', name: 'Release', parentId: null, parents: [{ containerId: null, childrenRevision: 1 }] });
  expect(useConversationOrganizationStore.getState().failed[first.key]).toEqual(first);
  transport.command.mockResolvedValueOnce({}); await click('检查结果'); expect(transport.command.mock.calls[1][0]).toEqual(first);
});
it('refreshes another client’s move without opening or recreating the selected conversation', async () => {
  await render(); await click('Task'); transport.open.mockClear();
  snapshot = { ...snapshot, revision: 2, cursor: 2, conversations: snapshot.conversations.map(e => e.title === 'Child' ? { ...e, position: { ...e.position, explicit: true, inheritedFrom: null, containerId: 'work' } } : e) };
  await act(async () => { for (const listener of transport.listeners) listener({ cursor: 2, kind: 'organization', revision: 2, subject: '', data: null }); });
  expect(container.querySelectorAll('button[title="Child"]')).toHaveLength(1); expect(transport.open).not.toHaveBeenCalled(); expect(transport.create).not.toHaveBeenCalled();
});

it('retires an ambiguous command when its original-key check returns a definitive conflict', async () => {
  const { ConversationOrganizationError } = await import('@varin/application-client');
  await render();
  const operation = { action: 'create' as const, id: 'new-group', kind: 'group' as const, parentId: null, name: 'Group', parents: [{ containerId: null, childrenRevision: 1 }] };
  transport.command.mockRejectedValueOnce(new Error('Response lost'));
  await act(async () => { await expect(submitOrganization(operation)).rejects.toThrow('Response lost'); });
  const command = Object.values(useConversationOrganizationStore.getState().failed)[0];
  transport.command.mockRejectedValueOnce(new ConversationOrganizationError('conflict', 'Parent changed', 409));
  await act(async () => { await expect(submitOrganization(command.operation, command)).rejects.toThrow('Parent changed'); });
  expect(transport.command.mock.calls[1][0]).toEqual(command);
  expect(useConversationOrganizationStore.getState().failed).toEqual({});
  expect(container.textContent).toContain('Parent changed');
  expect(container.textContent).not.toContain('检查结果');
});

it('moves through the keyboard-accessible menu with source and destination CAS, leaving the old row until committed', async () => {
  await render();
  const menu = [...row('Task').querySelectorAll('button')].find(b => b.textContent === '移动到…')!;
  await act(async () => menu.click());
  await destination('work');
  let finish!: () => void;
  transport.command.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(transport.command.mock.calls[0][0].operation).toMatchObject({ action: 'move', parentId: 'work', items: [{ object: { kind: 'native', id: 'Task' }, expectedRevision: 1, expectedParentId: 'project-node' }], parents: [{ containerId: 'project-node', childrenRevision: 1 }, { containerId: 'work', childrenRevision: 1 }] });
  expect(container.querySelectorAll('button[title="Task"]')).toHaveLength(1);
  expect(row('Task').closest('[aria-busy="true"]')).toBeTruthy();
  await act(async () => finish());
});

it('ignores self, descendant and original-location drops while accepting a real project move', async () => {
  await render();
  const work = projectOrganization(snapshot)[0], project = work.children.find(node => node.container)!;
  const drop = async (node: typeof work, parentId: string | null, before: typeof work.object | null = null) => act(async () => transport.drop!({
    active: { id: node.key, data: { current: node }, rect: { current: { initial: null, translated: null } } },
    over: { id: parentId ?? 'root', disabled: false, rect: { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }, data: { current: { parentId, before, label: '' } } },
    activatorEvent: new Event('pointerdown'), collisions: [], delta: { x: 20, y: 0 },
  }));
  await drop(work, work.container!.id);
  await drop(work, project.container!.id);
  await drop(project, project.parentId, project.object);
  await drop(project, project.parentId);
  expect(transport.command).not.toHaveBeenCalled();
  transport.command.mockResolvedValueOnce({ containers: [{ ...project.container, parentId: null, revision: 2 }], positions: [], removed: [] });
  await drop(project, null);
  expect(transport.command).toHaveBeenCalledOnce();
  expect(transport.command.mock.calls[0][0].operation).toMatchObject({ action: 'move', parentId: null, items: [{ object: project.object, expectedParentId: 'work' }] });
});

it('retains partial metadata outcomes and retries only the unresolved original items', async () => {
  await render();
  for (const title of ['Task', 'Moved']) {
    const select = [...row(title).querySelectorAll('button')].find(b => b.textContent === '选择并批量整理')!;
    await act(async () => select.click());
  }
  transport.metadata.mockResolvedValueOnce({ items: [
    { conversation: { kind: 'native', id: 'Task' }, status: 'succeeded' },
    { conversation: { kind: 'native', id: 'Moved' }, status: 'busy', message: 'Original operation is still settling' },
  ] });
  await click('归档');
  const first = transport.metadata.mock.calls[0][0];
  await revealResults();
  expect(first.items).toHaveLength(2); expect(container.textContent).toContain('当前正在执行');
  transport.metadata.mockResolvedValueOnce({ items: [{ conversation: { kind: 'native', id: 'Moved' }, status: 'succeeded' }] });
  await click('只重试未确认项');
  expect(transport.metadata.mock.calls[1][0]).toEqual({ key: first.key, items: [first.items.find((item: { conversation: { id: string } }) => item.conversation.id === 'Moved')] });
});

it('shows a missing origin Bot honestly and still follows its original typed conversation', async () => {
  snapshot.conversations[0].origin = { botId: 'deleted-bot', directBotId: null, conversation: { kind: 'native', id: 'Original conversation' } };
  await render();
  const source = container.querySelector<HTMLButtonElement>('button[aria-label="打开 来源 Bot 已不可用 (deleted-bot) 的发起会话"]')!;
  expect(source).toBeTruthy(); await act(async () => source.click());
  expect(transport.open).toHaveBeenCalledWith({ threadId: 'Original conversation' });
});

it('fences a previous Host’s pending response and clears its mutation targets without touching drafts', async () => {
  await render(); await click('新建分组');
  const input = container.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')!;
  await act(async () => { input.value = 'Old Host group'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  let finish!: () => void;
  transport.command.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  transport.generation++; snapshot = { ...original(), containers: [], conversations: [] };
  await render(); await act(async () => finish());
  expect(useConversationOrganizationStore.getState().host).toBe(transport.generation);
  expect(useConversationOrganizationStore.getState().snapshot?.containers).toEqual([]);
  expect(useConversationOrganizationStore.getState().pending).toEqual({});
  expect(container.querySelector('input[aria-label="分组名称"]')).toBeNull();
  expect(transport.create).not.toHaveBeenCalled();
});

it('loads only a root page and explicitly opened scopes, with continuation controlled by the person', async () => {
  const rootEntry = { ...snapshot.conversations[0], title: 'Second root page', position: { ...snapshot.conversations[0].position, containerId: null } };
  transport.read.mockImplementation(async (query: { rootOnly?: boolean; containerId?: string; cursor?: string } = {}) => {
    if (query.cursor === 'root-next') return { ...snapshot, conversations: [rootEntry], nextCursor: null };
    if (query.rootOnly) return { ...snapshot, conversations: [], nextCursor: 'root-next' };
    return { ...snapshot, conversations: snapshot.conversations.filter(e => e.position.containerId === query.containerId), nextCursor: null };
  });
  await render();
  expect(transport.read.mock.calls).toHaveLength(1);
  expect(transport.read.mock.calls[0][0]).toEqual({ pageNodes: true, rootOnly: true, archived: 'exclude', excludeBotConversations: true });
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="展开 Work"]')!.click());
  expect(transport.read.mock.calls.some(([query]) => query.containerId === 'work')).toBe(true);
  expect(transport.read.mock.calls.some(([query]) => query.containerId === 'project-node')).toBe(false);
  expect(transport.read.mock.calls.some(([query]) => query.cursor)).toBe(false);
  await click('继续读取');
  expect(transport.read.mock.calls.some(([query]) => query.cursor === 'root-next')).toBe(true);
  expect(container.querySelector('button[title="Second root page"]')).toBeTruthy();
});

it('an explicit descendant archive reads the complete server scope rather than visible filtered members', async () => {
  await render();
  transport.read.mockImplementation(async (query: { containerId?: string; recursive?: boolean; cursor?: string } = {}) => query.containerId === 'work' && query.recursive
    ? { ...snapshot, conversations: [snapshot.conversations[query.cursor ? 1 : 0]], nextCursor: query.cursor ? null : 'scope-next' }
    : snapshot);
  transport.metadata.mockResolvedValue({ items: [] });
  const archive = [...row('Work').querySelectorAll('button')].find(b => b.textContent === '归档所有后代会话')!;
  await act(async () => archive.click());
  expect(transport.read.mock.calls.some(([query]) => query.containerId === 'work' && query.recursive && query.cursor === 'scope-next')).toBe(true);
  expect(transport.metadata.mock.calls[0][0].items.map((item: { conversation: { id: string } }) => item.conversation.id)).toEqual(['Task', 'Child']);
});

it('undo restores inheritance using the original move receipt revision, never a later client’s position', async () => {
  await render();
  const menu = [...row('Child').querySelectorAll('button')].find(b => b.textContent === '移动到…')!;
  await act(async () => menu.click());
  await destination('work');
  transport.command.mockImplementationOnce(async (command: ConversationOrganizationCommand) => {
    const position = { ...snapshot.conversations[1].position, containerId: 'work', explicit: true, inheritedFrom: null, revision: 2 };
    snapshot = { ...snapshot, revision: 2, cursor: 2, conversations: snapshot.conversations.map(e => e.title === 'Child' ? { ...e, position } : e) };
    return { key: command.key, revision: 2, cursor: 2, positions: [position], containers: [], removed: [] };
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const first = transport.command.mock.calls[0][0];
  snapshot = { ...snapshot, revision: 3, cursor: 3, conversations: snapshot.conversations.map(e => e.title === 'Child' ? { ...e, position: { ...e.position, revision: 3, containerId: null } } : e) };
  await act(async () => { for (const listener of transport.listeners) listener({ cursor: 3, kind: 'organization', revision: 3, subject: '', data: null }); });
  // Recent can stop caching the old parent once the entry has moved elsewhere.
  await act(async () => useConversationOrganizationStore.setState(state => ({ snapshot: { ...state.snapshot!, containers: state.snapshot!.containers.filter(container => container.id !== 'project-node') } })));
  const { ConversationOrganizationError } = await import('@varin/application-client');
  transport.command.mockRejectedValueOnce(new ConversationOrganizationError('conflict', 'Another client moved the task'));
  await click('撤销移动');
  expect(transport.read.mock.calls.some(([query]) => query.containerId === 'project-node' && query.limit === 1)).toBe(true);
  const inverse = transport.command.mock.calls[1][0];
  expect(inverse.key).not.toBe(first.key);
  expect(inverse.operation).toMatchObject({ action: 'restore', items: [{ object: { kind: 'native', id: 'Child' }, expectedRevision: 2, expectedParentId: 'work', parentId: 'project-node', before: null, inherit: true }] });
  expect(container.textContent).toContain('Another client moved the task');
  expect(useConversationOrganizationStore.getState().snapshot?.conversations.find(e => e.title === 'Child')?.position.containerId).toBeNull();
});

it('keeps group and conversation editors open while an IME confirms or cancels composition', async () => {
  await render(); await click('新建分组');
  const compositionKey = async (input: HTMLInputElement, key: string, composing: boolean, keyCode = 0) => {
    const event = new Event('keydown', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { key: { value: key }, isComposing: { value: composing }, keyCode: { value: keyCode } });
    await act(async () => input.dispatchEvent(event));
    return event;
  };
  let input = container.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')!;
  expect((await compositionKey(input, 'Enter', true)).defaultPrevented).toBe(true);
  expect((await compositionKey(input, 'Escape', true)).defaultPrevented).toBe(true);
  expect(container.contains(input)).toBe(true);
  expect(transport.command).not.toHaveBeenCalled();
  await compositionKey(input, 'Escape', false);
  expect(container.contains(input)).toBe(false);
  const rename = [...row('Task').querySelectorAll('button')].find(button => button.textContent === '重命名')!;
  await act(async () => rename.click());
  input = container.querySelector<HTMLInputElement>('input[aria-label="会话名称"]')!;
  expect(input).toBeTruthy();
  expect((await compositionKey(input, 'Enter', false, 229)).defaultPrevented).toBe(true);
  expect((await compositionKey(input, 'Escape', true)).defaultPrevented).toBe(true);
  expect(container.contains(input)).toBe(true);
  expect(transport.metadata).not.toHaveBeenCalled();
  await compositionKey(input, 'Escape', false);
  expect(container.contains(input)).toBe(false);
});

/** Stateful owner boundary with real mixed page membership and ancestor context. */
function mixedPages(pageSize = 2) {
  transport.read.mockImplementation(async (query: import('@varin/application-client').ConversationOrganizationQuery = {}) => {
    const path = (id: string | null): string[] => { const result: string[] = []; while (id) { result.push(id); id = snapshot.containers.find(c => c.id === id)?.parentId ?? null; } return result; };
    const scope = (id: string | null) => query.rootOnly ? id === null : query.containerId ? id === query.containerId || Boolean(query.recursive && path(id).includes(query.containerId)) : true;
    const needle = query.query?.toLowerCase();
    const nodes = [
      ...snapshot.containers.filter(c => query.kind !== 'conversations' && scope(c.parentId) && (!needle || c.name?.toLowerCase().includes(needle))).map(c => ({ object: { kind: 'container' as const, id: c.id }, order: c.order })),
      ...snapshot.conversations.filter(c => query.kind !== 'containers' && scope(c.position.containerId) && (query.archived === 'include' || c.archived === (query.archived === 'only')) && (!needle || c.title.toLowerCase().includes(needle))).map(c => ({ object: c.conversation, order: c.position.order })),
    ].sort((a, b) => a.order - b.order || JSON.stringify(a.object).localeCompare(JSON.stringify(b.object)));
    const offset = Number(query.cursor ?? 0), items = nodes.slice(offset, offset + pageSize).map(node => node.object);
    const conversations = snapshot.conversations.filter(entry => items.some(item => item.kind === entry.conversation.kind && item.id === entry.conversation.id));
    const ids = new Set([...items.filter(item => item.kind === 'container').flatMap(item => path(item.id)), ...conversations.flatMap(entry => path(entry.position.containerId)), ...path(query.containerId ?? null)]);
    return structuredClone({ ...snapshot, items, containers: snapshot.containers.filter(c => ids.has(c.id)), conversations, nextCursor: offset + pageSize < nodes.length ? String(offset + pageSize) : null });
  });
}
const group = (id: string, order: number, parentId: string | null = null, name = id) => ({ ...original().containers[0], id, name, parentId, order });
const task = (id: string, order: number, containerId: string | null = null) => ({ ...original().conversations[0], conversation: { kind: 'native' as const, id }, title: id, position: { ...original().conversations[0].position, conversation: { kind: 'native' as const, id }, order, containerId } });
const toggle = async (title: string) => { await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="展开 ${title}"]`)!.click()); };

it('pages more than a page of empty containers and refreshes only the loaded mixed-node window', async () => {
  snapshot = { ...original(), containers: Array.from({ length: 7 }, (_, i) => group(`Empty ${i}`, i)), conversations: [] };
  mixedPages(); await render();
  expect([...container.querySelectorAll('[role="treeitem"]')]).toHaveLength(2);
  expect(transport.read.mock.calls).toHaveLength(1);
  await click('继续读取');
  expect([...container.querySelectorAll('[role="treeitem"]')]).toHaveLength(4);
  transport.read.mockClear();
  await act(async () => refreshConversationOrganization());
  expect(transport.read.mock.calls.map(([query]) => query.cursor ?? 'first')).toEqual(['first', '2']);
  expect([...container.querySelectorAll('[role="treeitem"]')]).toHaveLength(4);
  expect(transport.read.mock.calls.every(([query]) => query.pageNodes && query.rootOnly)).toBe(true);
  await click('继续读取'); await click('继续读取');
  expect([...container.querySelectorAll('[role="treeitem"]')]).toHaveLength(7);
  expect(useConversationOrganizationStore.getState().snapshot?.containers).toHaveLength(7);
  expect(container.textContent).not.toContain('继续读取');
});

it('merges mixed container/native/external pages, keeps newly discovered branches closed, and isolates search membership', async () => {
  snapshot = { ...original(), containers: [group('A', 0), group('B', 2), group('Nested', 0, 'A'), group('Deeper', 0, 'Nested')], conversations: [task('Root native', 1), { ...task('Root external', 3), conversation: { kind: 'external', id: 'Root external' }, position: { ...task('Root external', 3).position, conversation: { kind: 'external', id: 'Root external' } } }, task('Needle', 1, 'Nested'), task('Other child', 1, 'A')] };
  mixedPages(); await render(); await toggle('A');
  expect(row('Nested').getAttribute('aria-expanded')).toBe('false');
  expect(transport.read.mock.calls.some(([query]) => query.containerId === 'Nested')).toBe(false);
  await click('继续读取');
  expect(row('A')).toBeTruthy(); expect(row('B')).toBeTruthy(); expect(row('Root native')).toBeTruthy(); expect(row('Root external')).toBeTruthy();
  await render('Needle');
  expect(row('Needle')).toBeTruthy(); expect(row('A')).toBeTruthy(); expect(row('Nested')).toBeTruthy();
  expect(row('B')).toBeUndefined(); expect(row('Other child')).toBeUndefined(); expect(row('Root native')).toBeUndefined();
  await render();
  expect(row('B')).toBeTruthy(); expect(row('Nested').getAttribute('aria-expanded')).toBe('false');
  expect(row('Needle')).toBeUndefined();
});

it('browses an unloaded destination page and searches identical labels by stable identity without polluting navigation', async () => {
  snapshot = { ...original(), containers: [group('first', 1), group('second', 2), group('later', 3), group('deep-one', 0, 'later', 'Same'), group('deep-two', 1, 'later', 'Same')], conversations: [task('Move me', 0)] };
  mixedPages(); await render();
  const menu = [...row('Move me').querySelectorAll('button')].find(button => button.textContent === '移动到…')!;
  await act(async () => menu.click());
  const picker = () => container.querySelector('[aria-label="浏览目标分类"]')!;
  expect(picker().textContent).not.toContain('later');
  const more = [...container.querySelectorAll('form button')].find(button => button.textContent === '继续读取')!;
  await act(async () => (more as HTMLButtonElement).click());
  const browse = picker().querySelector<HTMLButtonElement>('button[data-organization-id="later"]')!;
  await act(async () => browse.click());
  expect(picker().querySelector('button[data-organization-id="deep-one"]')).toBeTruthy();
  expect(picker().querySelector('button[data-organization-id="deep-two"]')).toBeTruthy();
  expect(picker().textContent).not.toContain('deep-one');
  const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索目标分类"]')!;
  await act(async () => { search.value = 'Same'; search.dispatchEvent(new Event('input', { bubbles: true })); });
  expect([...picker().querySelectorAll<HTMLButtonElement>('[data-organization-id]')].map(option => option.dataset.organizationId)).toEqual(['deep-one', 'deep-two']);
  await click('取消');
  expect(row('later')).toBeUndefined(); expect(row('Same')).toBeUndefined();
  expect(transport.command).not.toHaveBeenCalled();
});

it('captures an unread mixed sibling anchor before moving and restores before its stable original identity', async () => {
  snapshot = { ...original(), containers: [group('Before', 0), group('Unread anchor', 2), group('Destination', 3)], conversations: [task('Move me', 1)] };
  mixedPages(); await render();
  await act(async () => [...row('Move me').querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '移动到…')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('form button')].find(button => button.textContent === '继续读取')!.click());
  await destination('Destination');
  transport.command.mockImplementationOnce(async (command: ConversationOrganizationCommand) => {
    expect(transport.read.mock.calls.some(([query]) => query.rootOnly && query.archived === 'include' && query.cursor === '2')).toBe(true);
    const position = { ...snapshot.conversations[0].position, containerId: 'Destination', revision: 2 };
    snapshot = { ...snapshot, revision: 2, cursor: 2, rootRevision: 2, conversations: [{ ...snapshot.conversations[0], position }] };
    return { key: command.key, revision: 2, cursor: 2, containers: [], positions: [position], removed: [] };
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(transport.command).toHaveBeenCalledOnce();
  transport.command.mockResolvedValueOnce({}); await click('撤销移动');
  expect(transport.command.mock.calls[1][0].operation).toMatchObject({ action: 'restore', items: [{ object: { kind: 'native', id: 'Move me' }, parentId: null, before: { kind: 'container', id: 'Unread anchor' }, expectedRevision: 2 }] });
});

it('aborts explicit scope reads without continuing pages and fences a pending page after Host replacement', async () => {
  snapshot = { ...original(), containers: [group('A', 0), group('B', 1), group('C', 2)], conversations: [] };
  mixedPages(); await render();
  let finish!: (snapshot: ConversationOrganizationSnapshot) => void;
  transport.read.mockImplementationOnce((_query, signal: AbortSignal) => new Promise(resolve => { finish = resolve; expect(signal.aborted).toBe(false); }));
  const controller = new AbortController();
  const pending = readOrganizationActionScope({ rootOnly: true, archived: 'include' }, controller.signal);
  controller.abort();
  finish({ ...snapshot, items: [{ kind: 'container', id: 'A' }], nextCursor: 'next' });
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(transport.read.mock.calls.some(([query]) => query.cursor === 'next')).toBe(false);
  transport.read.mockImplementationOnce((_query, signal: AbortSignal) => new Promise(resolve => { finish = resolve; signal.addEventListener('abort', () => expect(signal.aborted).toBe(true)); }));
  let page!: Promise<void>;
  await act(async () => { page = loadOrganizationPage({ rootOnly: true, archived: 'exclude', excludeBotConversations: true }, true); });
  transport.generation++; snapshot = { ...original(), containers: [], conversations: [], items: [] };
  mixedPages(); await render();
  await act(async () => { finish({ ...original(), items: [{ kind: 'container', id: 'stale' }], containers: [group('stale', 0)], conversations: [], nextCursor: null }); await page; });
  expect(useConversationOrganizationStore.getState().snapshot?.containers).toEqual([]);
  expect(row('stale')).toBeUndefined();
});

it('accepts unrelated global revision changes across a scope cursor but refuses changed source-parent versions before dispatch', async () => {
  snapshot = { ...original(), containers: [group('A', 0), group('B', 1), group('C', 3)], conversations: [task('Move me', 2)] };
  mixedPages(); await render();
  const read = transport.read.getMockImplementation()!;
  transport.read.mockImplementation(async (query, signal) => ({ ...await read(query, signal), revision: query.cursor ? 9 : 1 }));
  const scope = await readOrganizationActionScope({ rootOnly: true, archived: 'include' });
  expect(scope.items).toHaveLength(4);
  await click('继续读取');
  await act(async () => [...row('Move me').querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '移动到…')!.click());
  transport.read.mockImplementation(async (query, signal) => ({ ...await read(query, signal), rootRevision: query.archived === 'include' ? 2 : 1 }));
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(transport.command).not.toHaveBeenCalled();
  expect(row('Move me')).toBeTruthy();
});

it('does not let a newer picker read cursor hide an earlier durable event affecting the visible root page', async () => {
  snapshot = { ...original(), containers: [group('Visible', 0)], conversations: [] };
  mixedPages(); await render();
  const read = transport.read.getMockImplementation()!;
  transport.read.mockImplementation(async (query, signal) => ({ ...await read(query, signal), cursor: query.archived === 'include' ? 10 : 1 }));
  await act(async () => loadOrganizationPage({ rootOnly: true, archived: 'include' }));
  expect(useConversationOrganizationStore.getState().snapshot?.cursor).toBe(10);
  snapshot = { ...snapshot, containers: [group('Visible', 0, null, 'Updated visible')] };
  await act(async () => { for (const listener of transport.listeners) listener({ cursor: 9, kind: 'organization', revision: 2, subject: '', data: null }); });
  expect(row('Updated visible')).toBeTruthy();
});

it('keeps a Bot-matching container page visible before its matching child page is opened', async () => {
  const entry = { ...task('Bot child', 0, 'Bot scope'), origin: { botId: 'bot-a', directBotId: null, conversation: null } };
  const folder = group('Bot scope', 0);
  transport.read.mockImplementation(async (query: import('@varin/application-client').ConversationOrganizationQuery = {}) => ({ ...original(), items: query.containerId ? [entry.conversation] : [{ kind: 'container', id: folder.id }], containers: [folder], conversations: query.containerId ? [entry] : [], nextCursor: null }));
  await act(async () => root.render(<ConversationOrganizationTree botId="bot-a" />));
  expect(row('Bot scope')).toBeTruthy(); expect(row('Bot child')).toBeUndefined();
  await toggle('Bot scope');
  expect(transport.read.mock.calls.some(([query]) => query.containerId === 'Bot scope' && query.botId === 'bot-a')).toBe(true);
  expect(row('Bot child')).toBeTruthy();
});

it('keeps recent tasks under their dispatch parent, loads children on expansion and remembers both fold choices', async () => {
  const parent = { ...task('Parent', 0), hasChildren: true };
  const child = { ...task('Child', 0, 'another-category'), hasChildren: true, origin: { botId: null, directBotId: null, conversation: parent.conversation } };
  const grandchild = { ...task('Grandchild', 1, 'another-category'), hasChildren: false, origin: { botId: null, directBotId: null, conversation: child.conversation } };
  const standalone = { ...task('Standalone', 2), hasChildren: false };
  transport.read.mockImplementation(async (query: import('@varin/application-client').ConversationOrganizationQuery = {}) => {
    const entries = !query.conversationTree ? [] : query.conversationTree.parent?.id === 'Parent' ? [child] : query.conversationTree.parent?.id === 'Child' ? [grandchild] : [parent, standalone];
    return { ...original(), containers: [], conversations: entries, items: entries.map(entry => entry.conversation), nextCursor: null };
  });
  await render(); await click('最近');
  expect(row('Parent').getAttribute('aria-expanded')).toBe('false');
  expect(row('Child')).toBeUndefined();
  expect(transport.read.mock.calls.some(([query]) => query.conversationTree?.parent)).toBe(false);
  await toggle('Parent');
  expect(row('Child').closest('.organization-task-children')).not.toBeNull();
  expect(row('Child').closest('[inert]')).toBeNull();
  expect(row('Child').getAttribute('aria-expanded')).toBe('false');
  expect(row('Grandchild')).toBeUndefined();
  await toggle('Child');
  expect(row('Grandchild').closest('[inert]')).toBeNull();
  await act(async () => root.render(null)); await render();
  expect(row('Parent').getAttribute('aria-expanded')).toBe('true');
  expect(row('Child').getAttribute('aria-expanded')).toBe('true');
  expect(row('Grandchild').closest('[inert]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="收起 Parent"]')!.click());
  await act(async () => root.render(null)); await render();
  expect(row('Parent').getAttribute('aria-expanded')).toBe('false');
  expect(row('Grandchild').closest('[inert]')).not.toBeNull();
  await toggle('Parent');
  expect(row('Child').getAttribute('aria-expanded')).toBe('true');
  expect(row('Grandchild').closest('[inert]')).toBeNull();
});

it('uses the owner’s recent page order without leaking expanded category pages, and retains display choices on remount', async () => {
  const folder = group('Work', 0);
  const first = { ...task('Recent first', 1, 'Work'), updatedAtMs: 20 };
  const second = { ...task('Recent second', 0, 'Work'), updatedAtMs: 10 };
  const categoryOnly = task('Outside recent page', 2, 'Work');
  transport.read.mockImplementation(async (query: import('@varin/application-client').ConversationOrganizationQuery = {}) => {
    const entries = query.sort === 'recent' ? [first, second] : query.containerId ? [categoryOnly] : [];
    return { ...original(), containers: [folder], conversations: entries, items: query.rootOnly ? [{ kind: 'container', id: folder.id }] : entries.map(entry => entry.conversation), nextCursor: null };
  });
  await render(); await toggle('Work'); expect(row('Outside recent page')).toBeTruthy();
  await click('最近');
  expect(transport.read.mock.calls.some(([query]) => query.kind === 'conversations' && query.sort === 'recent' && query.recursive)).toBe(true);
  expect([...container.querySelectorAll<HTMLButtonElement>('[role="treeitem"] button[title]')].map(button => button.title)).toEqual(['Recent first', 'Recent second']);
  expect(row('Outside recent page')).toBeUndefined();
  await act(async () => root.render(null)); await render();
  expect(container.querySelector('button[role="tab"][aria-selected="true"]')?.textContent).toBe('最近');
  await click('分类');
  expect(row('Work').getAttribute('aria-expanded')).toBe('true');
  expect(row('Outside recent page')).toBeTruthy();
  expect(transport.open).not.toHaveBeenCalled(); expect(transport.create).not.toHaveBeenCalled();
});


it('does not render an open destination picker against a cleared Host snapshot', async () => {
  snapshot = { ...original(), containers: [group('Moving group', 0)], conversations: [] };
  mixedPages(); await render();
  await act(async () => [...row('Moving group').querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '移动到…')!.click());
  expect(container.querySelector('form')).toBeTruthy();
  await act(async () => useConversationOrganizationStore.setState({ snapshot: null, pages: {} }));
  expect(container.querySelector('form')).toBeNull();
  expect(container.textContent).not.toBe('');
});

it('keeps original partial metadata intent and receipts across full same-Host unmount and retries only unknown items', async () => {
  await render();
  for (const title of ['Task', 'Moved']) await act(async () => [...row(title).querySelectorAll('button')].find(button => button.textContent === '选择并批量整理')!.click());
  transport.metadata.mockResolvedValueOnce({ items: [
    { conversation: { kind: 'native', id: 'Task' }, status: 'succeeded' },
    { conversation: { kind: 'native', id: 'Moved' }, status: 'unknown', message: 'Response was lost' },
  ] });
  await click('归档'); const first = structuredClone(transport.metadata.mock.calls[0][0]);
  await act(async () => root.render(null));
  // A later object joins the visible scope; the original fixed selection must not grow.
  snapshot.conversations.push({ ...snapshot.conversations[0], conversation: { kind: 'native', id: 'Later' }, title: 'Later' });
  await render(); await revealResults();
  expect(container.textContent).toContain('Task'); expect(container.textContent).toContain('已完成'); expect(container.textContent).toContain('Moved'); expect(container.textContent).toContain('结果待确认');
  transport.metadata.mockResolvedValueOnce({ items: [{ conversation: { kind: 'native', id: 'Moved' }, status: 'succeeded' }] });
  await click('只重试未确认项');
  expect(transport.metadata.mock.calls[1][0]).toEqual({ key: first.key, items: [first.items[1]] });
  expect(useConversationOrganizationStore.getState().metadata[first.key]).toBeUndefined();
  expect(container.textContent).not.toContain('只重试未确认项');
  expect(container.textContent).not.toContain('结果待确认');
});

it('does not duplicate an in-flight batch on same-Host remount and retains unknown failure for original-key retry', async () => {
  await render(); let reject!: (error: Error) => void;
  transport.metadata.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => [...row('Task').querySelectorAll('button')].find(button => button.textContent === '归档会话')!.click());
  const first = structuredClone(transport.metadata.mock.calls[0][0]);
  await act(async () => root.render(null)); await render(); await revealResults();
  expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '只重试未确认项')?.disabled).toBe(true);
  expect(transport.metadata).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Disconnected after acceptance')));
  expect(container.textContent).toContain('结果待确认');
  transport.metadata.mockResolvedValueOnce({ items: [{ conversation: { kind: 'native', id: 'Task' }, status: 'succeeded' }] });
  await click('只重试未确认项'); expect(transport.metadata.mock.calls[1][0]).toEqual(first);
});

it('retains ambiguous navigation commands across same-Host rebind but fences old metadata after a Host change', async () => {
  await render(); await click('新建分组');
  const input = container.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')!;
  await act(async () => { input.value = 'Unknown group'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  transport.command.mockRejectedValueOnce(new Error('Response lost')); await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const command = transport.command.mock.calls[0][0];
  await act(async () => root.render(null)); await render();
  expect(useConversationOrganizationStore.getState().failed[command.key]).toEqual(command);
  let finish!: (value: unknown) => void;
  transport.metadata.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => [...row('Task').querySelectorAll('button')].find(button => button.textContent === '归档会话')!.click());
  await act(async () => root.render(null)); transport.generation++; await render();
  expect(useConversationOrganizationStore.getState().failed).toEqual({}); expect(useConversationOrganizationStore.getState().metadata).toEqual({});
  await act(async () => finish({ items: [{ conversation: { kind: 'native', id: 'Task' }, status: 'succeeded' }] }));
  expect(useConversationOrganizationStore.getState().metadata).toEqual({});
});

it('settles an original in-flight navigation command after same-Host remount without duplicating acceptance', async () => {
  await render(); await click('新建分组');
  const input = container.querySelector<HTMLInputElement>('input[aria-label="分组名称"]')!;
  await act(async () => { input.value = 'Pending group'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  let reject!: (error: Error) => void;
  transport.command.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const originalCommand = structuredClone(transport.command.mock.calls[0][0]);
  await act(async () => root.render(null)); await render();
  expect(useConversationOrganizationStore.getState().pending[originalCommand.key]).toEqual(originalCommand);
  await act(async () => reject(new Error('Original receipt unknown')));
  expect(useConversationOrganizationStore.getState().pending[originalCommand.key]).toBeUndefined();
  expect(useConversationOrganizationStore.getState().failed[originalCommand.key]).toEqual(originalCommand);
  transport.command.mockResolvedValueOnce({}); await click('检查结果');
  expect(transport.command.mock.calls[1][0]).toEqual(originalCommand);
});
