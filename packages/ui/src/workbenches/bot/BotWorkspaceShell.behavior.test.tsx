import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotWorkspaceShell } from './BotWorkspaceShell';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import { useBotNavigation, type BotSummary } from '@/lib/bots';

const state = vi.hoisted(() => ({
  profileId: 'varin.bot',
  list: vi.fn(), ensure: vi.fn(), work: vi.fn(), create: vi.fn(), update: vi.fn(), archive: vi.fn(), open: vi.fn(), change: vi.fn(),
}));
vi.mock('@/lib/bots', async original => ({
  ...await original<typeof import('@/lib/bots')>(),
  listBots: state.list,
  ensureBotEntry: state.ensure,
  listBotWork: state.work,
  createBot: state.create,
  updateBot: state.update,
  archiveBot: state.archive,
  changeBotState: state.change,
  deleteBot: vi.fn(),
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ threads: {} }) }));
vi.mock('@/components/thread/ThreadConversation', () => ({ ThreadConversation: ({ identity, readOnly, preferredModel }: { identity: { threadId: string; branchId: string }; readOnly: boolean; preferredModel?: { providerId: string; modelId: string } | null }) => <div data-agent={identity.threadId} data-branch={identity.branchId} data-readonly={String(readOnly)} data-model={JSON.stringify(preferredModel)} /> }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: () => {} }) } }));
vi.mock('@/lib/workbench/profile-context', () => ({ useWorkbenchProfileId: () => state.profileId }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/layout/WorkbenchProfileSwitcher', () => ({ WorkbenchProfileSwitcher: () => null }));
vi.mock('@/components/views/ChatView', () => ({ ChatView: ({ readOnly }: { readOnly: boolean }) => <div data-chat="true" data-readonly={String(readOnly)} /> }));
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
vi.mock('@/components/layout/MainLayout', () => ({
  MainLayout: ({ renderNavigator, renderConversation }: { renderNavigator(visible: boolean): React.ReactNode; renderConversation(active: boolean): React.ReactNode }) => <>{renderNavigator(true)}{renderConversation(true)}</>,
}));

const bot = (id: string): BotSummary => ({
  id, name: `Bot ${id}`, entry: { runtime: 'agent', threadId: `entry-${id}`, branchId: `branch-${id}` }, archived: false,
  homeDir: `/bots/${id}`, coordinatorHostId: 'host-a', instructions: null, model: null,
  createdAt: '', updatedAt: '',
});

describe('Bot mode navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async () => { await act(async () => { root.render(<BotWorkspaceShell />); }); };
  const click = async (text: string) => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === text);
    expect(button).toBeTruthy();
    await act(async () => { button!.click(); });
  };

  beforeEach(() => {
    const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useBotNavigation.setState({ botId: null, entry: null, archived: undefined });
    state.profileId = 'varin.bot';
    state.list.mockReset().mockResolvedValue([bot('a'), bot('b')]);
    state.ensure.mockReset().mockImplementation(async (id: string) => ({ bot: bot(id), model: null, entry: { runtime: 'agent', threadId: `entry-${id}`, branchId: `branch-${id}` } }));
    state.work.mockReset().mockResolvedValue([]);
    state.create.mockReset().mockResolvedValue(bot('new'));
    state.update.mockReset().mockResolvedValue(bot('a'));
    state.archive.mockReset().mockResolvedValue(bot('a'));
    state.change.mockReset().mockResolvedValue(bot('a'));
    state.open.mockReset();
    useThreadStore.setState({ hostKey: 'host-a', selectedIdentity: { runtime: 'agent', threadId: 'ordinary', branchId: 'ordinary-main' }, threads: [] });
    useUIStore.setState({ isSettingsDialogOpen: false });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps a staged candidate inert and leaves the ordinary conversation hidden', async () => {
    state.profileId = 'default';
    await render();
    expect(state.list).not.toHaveBeenCalled();
    expect(state.ensure).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
    expect(container.querySelector('[data-chat]')).toBeNull();
    expect(useThreadStore.getState().selectedIdentity?.threadId).toBe('ordinary');
  });

  it('reopens the current Bot identity and switches to another durable entry', async () => {
    useBotNavigation.setState({ botId: 'b', entry: null });
    await render();
    expect(state.ensure).toHaveBeenCalledWith('b', expect.any(AbortSignal));
    expect(useBotNavigation.getState().entry).toEqual(bot('b').entry);
    expect(container.querySelector('[data-agent]')).not.toBeNull();
    await click('Bot a');
    expect(useBotNavigation.getState().entry).toEqual(bot('a').entry);
    expect(state.create).not.toHaveBeenCalled();
  });

  it('creates the first Bot only on explicit request', async () => {
    state.list.mockResolvedValue([]);
    await render();
    expect(state.create).not.toHaveBeenCalled();
    expect(container.textContent).toContain('settings.bots.empty');
    await click('settings.bots.create');
    const input = document.querySelector('input');
    expect(input).not.toBeNull();
    await click('set-name');
    const form = document.querySelector('form');
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.create).toHaveBeenCalledWith({ name: 'Named bot' });
    expect(useBotNavigation.getState().entry).toEqual(bot('new').entry);
  });

  it('opens the right-clicked Bot profile without switching the conversation', async () => {
    await render();
    await click('profile-b');
    expect(container.querySelector('[data-details]')?.getAttribute('data-details')).toBe('b');
    expect(useBotNavigation.getState().entry).toEqual(bot('a').entry);
    expect(useThreadStore.getState().selectedIdentity?.threadId).toBe('ordinary');
  });

  it('views a sleeping Bot read-only without waking it', async () => {
    const sleeping = { ...bot('a'), activity: { state: 'asleep' as const, operationId: 'sleep-a', planned: true, work: [], machines: [], error: null } };
    state.list.mockResolvedValue([sleeping]);
    state.ensure.mockResolvedValue({ bot: sleeping, entry: { runtime: 'agent', threadId: 'entry-a', branchId: 'branch-a' } });
    await render();
    expect(container.querySelector('[data-agent]')?.getAttribute('data-readonly')).toBe('true');
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
    state.list.mockResolvedValue([]);
    await act(async () => { useThreadStore.setState({ hostKey: 'host-b', selectedIdentity: null }); });
    await act(async () => { finish({ bot: bot('a'), entry: { runtime: 'agent', threadId: 'entry-a', branchId: 'branch-a' } }); });
    expect(state.open).not.toHaveBeenCalled();
    expect(container.textContent).toContain('settings.bots.empty');
  });

  it('shows catalog failure as an error without offering implicit creation', async () => {
    state.list.mockRejectedValue(new Error('Host unavailable'));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Host unavailable');
    expect(container.textContent).not.toContain('settings.bots.empty');
    expect(state.create).not.toHaveBeenCalled();
  });
  it('opens root and child work through their original native identities', async () => {
    const entry = { runtime: 'agent' as const, threadId: 'root-work', branchId: 'root-branch' };
    const native = { ...bot('a'), entry };
    const child = { runtime: 'agent' as const, threadId: 'child-work', branchId: 'child-branch' };
    state.list.mockResolvedValue([native]); state.ensure.mockResolvedValue({ bot: native, entry, model: null });
    state.work.mockResolvedValue([{ runtime: 'agent', identity: child, purpose: 'work', activeRun: null,
      thread: { thread_id: child.threadId, main_branch_id: child.branchId, title: child.threadId, revision: 1, created_at_ms: 0, updated_at_ms: 0, pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, bot_id: native.id, parent_thread_id: null, observer_project_ids: [null], branches: [{ branch_id: child.branchId, head: null, active_run_id: null, latest_run: null }] } }]);
    await render();
    expect(container.querySelector('[data-agent]')?.getAttribute('data-agent')).toBe('root-work');
    const updated = { ...native, model: { providerId: 'changed-provider', modelId: 'changed-model' } };
    state.list.mockResolvedValue([updated]); state.ensure.mockResolvedValue({ bot: updated, entry, model: updated.model });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="tasksHub.refresh"]')!.click(); });
    expect(container.querySelector('[data-agent]')?.getAttribute('data-model')).toBe(JSON.stringify(updated.model));
    await click('child-work');
    expect(container.querySelector('[data-agent]')?.getAttribute('data-branch')).toBe('child-branch');
    expect(container.querySelector('[data-agent]')?.hasAttribute('data-model')).toBe(false);
    expect(state.open).not.toHaveBeenCalled();
  });

  it('keeps sleeping native history read-only and does not ensure or wake it', async () => {
    const entry = { runtime: 'agent' as const, threadId: 'sleep-work', branchId: 'sleep-branch' };
    state.list.mockResolvedValue([{ ...bot('a'), entry, activity: { state: 'asleep', operationId: 'sleep', planned: true, work: [], machines: [], error: null } }]);
    await render();
    expect(container.querySelector('[data-agent]')?.getAttribute('data-readonly')).toBe('true');
    expect(state.ensure).not.toHaveBeenCalled(); expect(state.change).not.toHaveBeenCalled(); expect(state.open).not.toHaveBeenCalled();
  });

  it('opens a notification branch on another Bot in an already mounted shell, including archived history', async () => {
    const archived = { ...bot('b'), archived: true };
    state.list.mockResolvedValue([bot('a'), archived]);
    await render();
    expect(container.querySelector('[data-agent]')?.getAttribute('data-agent')).toBe('entry-a');
    state.ensure.mockClear();
    useThreadStore.setState({ threads: [{ thread_id: 'archived-work', main_branch_id: 'main', title: 'Work', revision: 1, created_at_ms: 0, updated_at_ms: 0, pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, bot_id: 'b', parent_thread_id: null, observer_project_ids: [], branches: [{ branch_id: 'review-branch', head: null, active_run_id: null, latest_run: null }] }] });
    await act(async () => useBotNavigation.setState({ botId: 'b', entry: { runtime: 'agent', threadId: 'archived-work', branchId: 'review-branch' }, archived: true, model: null }));
    expect(container.querySelector('[data-agent]')?.getAttribute('data-agent')).toBe('archived-work');
    expect(container.querySelector('[data-agent]')?.getAttribute('data-branch')).toBe('review-branch');
    expect(container.querySelector('[data-agent]')?.getAttribute('data-readonly')).toBe('true');
    expect(state.ensure).not.toHaveBeenCalled();
  });

  it('creates a native Bot without a runtime selector', async () => {
    state.list.mockResolvedValue([]);
    const entry = { runtime: 'agent' as const, threadId: 'new-agent', branchId: 'new-agent-branch' };
    const native = { ...bot('new'), entry };
    state.create.mockResolvedValue(native); state.ensure.mockResolvedValue({ bot: native, entry, model: null });
    await render(); await click('settings.bots.create'); await click('set-name');
    await act(async () => { document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    expect(state.create).toHaveBeenCalledWith({ name: 'Named bot' });
    expect(container.querySelector('[data-agent]')?.getAttribute('data-agent')).toBe('new-agent');
    expect(state.open).not.toHaveBeenCalled();
  });

});
