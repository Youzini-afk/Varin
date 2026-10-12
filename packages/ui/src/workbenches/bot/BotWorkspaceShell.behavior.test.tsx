import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotWorkspaceShell } from './BotWorkspaceShell';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
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
vi.mock('@/lib/pi-runtime/sessionNavigation', () => ({ openPiSessionFromNavigation: state.open }));
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
  BotNameDialog: ({ open, name, onNameChange, onSubmit, onRuntimeChange }: {
    onRuntimeChange?: (runtime: 'pi' | 'agent') => void;
    open: boolean;
    name: string;
    onNameChange: (value: string) => void;
    onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  }) => open ? <form onSubmit={onSubmit}>
    <input value={name} onChange={(event) => onNameChange(event.target.value)} />
    <button type="button" onClick={() => onNameChange('Named bot')}>set-name</button>
    <button type="button" onClick={() => onRuntimeChange?.('agent')}>use-agent</button>
    <button type="submit">settings.bots.save</button>
  </form> : null,
}));
vi.mock('@/components/layout/MainLayout', () => ({
  MainLayout: ({ renderNavigator, renderConversation }: { renderNavigator(visible: boolean): React.ReactNode; renderConversation(active: boolean): React.ReactNode }) => <>{renderNavigator(true)}{renderConversation(true)}</>,
}));

const bot = (id: string): BotSummary => ({
  id, name: `Bot ${id}`, entry: { runtime: 'pi', sessionId: `entry-${id}` }, archived: false,
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
    useBotNavigation.setState({ botId: null, entry: null });
    state.profileId = 'varin.bot';
    state.list.mockReset().mockResolvedValue([bot('a'), bot('b')]);
    state.ensure.mockReset().mockImplementation(async (id: string) => ({ bot: bot(id), model: null, entry: { runtime: 'pi', sessionId: `entry-${id}` } }));
    state.work.mockReset().mockResolvedValue([]);
    state.create.mockReset().mockResolvedValue(bot('new'));
    state.update.mockReset().mockResolvedValue(bot('a'));
    state.archive.mockReset().mockResolvedValue(bot('a'));
    state.change.mockReset().mockResolvedValue(bot('a'));
    state.open.mockReset().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      usePiSessionStore.setState({ currentSessionId: sessionId });
    });
    usePiSessionStore.setState({ runtimeKey: 'host-a', currentSessionId: 'ordinary', records: {} });
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
    expect(usePiSessionStore.getState().currentSessionId).toBe('ordinary');
  });

  it('reopens the current Bot identity and switches to another durable entry', async () => {
    usePiSessionStore.setState({ currentSessionId: 'entry-b' });
    await render();
    expect(state.ensure).toHaveBeenCalledWith('b', expect.any(AbortSignal));
    expect(state.open).toHaveBeenLastCalledWith({ sessionId: 'entry-b', directory: '/bots/b' });
    expect(container.querySelector('[data-chat]')).not.toBeNull();
    await click('Bot a');
    expect(state.open).toHaveBeenLastCalledWith({ sessionId: 'entry-a', directory: '/bots/a' });
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
    expect(state.create).toHaveBeenCalledWith({ name: 'Named bot', runtime: 'pi' });
    expect(state.open).toHaveBeenLastCalledWith({ sessionId: 'entry-new', directory: '/bots/new' });
  });

  it('opens the right-clicked Bot profile without switching the conversation', async () => {
    await render();
    await click('profile-b');
    expect(container.querySelector('[data-details]')?.getAttribute('data-details')).toBe('b');
    expect(usePiSessionStore.getState().currentSessionId).toBe('entry-a');
    expect(state.open).toHaveBeenCalledTimes(1);
  });

  it('views a sleeping Bot read-only without waking it', async () => {
    const sleeping = { ...bot('a'), activity: { state: 'asleep' as const, operationId: 'sleep-a', planned: true, work: [], machines: [], error: null } };
    state.list.mockResolvedValue([sleeping]);
    state.ensure.mockResolvedValue({ bot: sleeping, entry: { runtime: 'pi', sessionId: 'entry-a' } });
    await render();
    expect(container.querySelector('[data-chat]')?.getAttribute('data-readonly')).toBe('true');
    expect(state.change).not.toHaveBeenCalled();
    await click('settings.bots.wakeContinue');
    expect(state.change).toHaveBeenCalledWith('a', 'wake');
  });

  it('sleeps the clicked Bot without changing the selected Bot', async () => {
    await render();
    state.change.mockResolvedValue(bot('b'));
    await click('sleep-b');
    expect(state.change).toHaveBeenCalledWith('b', 'sleep');
    expect(usePiSessionStore.getState().currentSessionId).toBe('entry-a');
  });

  it('discards a pending entry after the shell unmounts', async () => {
    let finish!: (value: { bot: BotSummary; entry: BotSummary['entry'] }) => void;
    state.ensure.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    act(() => root.render(null));
    await act(async () => { finish({ bot: bot('a'), entry: { runtime: 'pi', sessionId: 'entry-a' } }); });
    expect(state.open).not.toHaveBeenCalled();
  });

  it('discards an old Host response and loads the new Host', async () => {
    let finish!: (value: { bot: BotSummary; entry: BotSummary['entry'] }) => void;
    state.ensure.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    state.list.mockResolvedValue([]);
    await act(async () => { usePiSessionStore.setState({ runtimeKey: 'host-b', currentSessionId: null }); });
    await act(async () => { finish({ bot: bot('a'), entry: { runtime: 'pi', sessionId: 'entry-a' } }); });
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
  it('opens native entry and child work from tagged Host identities without opening Pi', async () => {
    const entry = { runtime: 'agent' as const, threadId: 'root-work', branchId: 'root-branch' };
    const native = { ...bot('a'), entry };
    const child = { runtime: 'agent' as const, threadId: 'child-work', branchId: 'child-branch' };
    state.list.mockResolvedValue([native]); state.ensure.mockResolvedValue({ bot: native, entry, model: null });
    state.work.mockResolvedValue([{ runtime: 'agent', identity: child, purpose: 'work', activeRun: null,
      thread: { thread_id: child.threadId, bot_id: native.id, observer_project_ids: [null], branches: [{ branch_id: child.branchId, head: null, active_run_id: null, latest_run: null }] } }]);
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

  it('creates an Agent Bot only after explicit runtime selection', async () => {
    state.list.mockResolvedValue([]);
    const entry = { runtime: 'agent' as const, threadId: 'new-agent', branchId: 'new-agent-branch' };
    const native = { ...bot('new'), entry };
    state.create.mockResolvedValue(native); state.ensure.mockResolvedValue({ bot: native, entry, model: null });
    await render(); await click('settings.bots.create'); await click('set-name'); await click('use-agent');
    await act(async () => { document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    expect(state.create).toHaveBeenCalledWith({ name: 'Named bot', runtime: 'agent' });
    expect(container.querySelector('[data-agent]')?.getAttribute('data-agent')).toBe('new-agent');
    expect(state.open).not.toHaveBeenCalled();
  });

});
