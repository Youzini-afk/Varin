import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotWorkspaceShell } from './BotWorkspaceShell';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import type { BotSummary } from '@/lib/bots';

const state = vi.hoisted(() => ({
  profileId: 'varin.bot',
  list: vi.fn(), ensure: vi.fn(), work: vi.fn(), create: vi.fn(), open: vi.fn(),
}));
vi.mock('@/lib/bots', () => ({ listBots: state.list, ensureBotEntry: state.ensure, listBotWork: state.work, createBot: state.create }));
vi.mock('@/lib/pi-runtime/sessionNavigation', () => ({ openPiSessionFromNavigation: state.open }));
vi.mock('@/lib/workbench/profile-context', () => ({ useWorkbenchProfileId: () => state.profileId }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/layout/WorkbenchProfileSwitcher', () => ({ WorkbenchProfileSwitcher: () => null }));
vi.mock('@/components/views/ChatView', () => ({ ChatView: () => <div data-chat="true" /> }));
vi.mock('@/components/layout/MainLayout', () => ({
  MainLayout: ({ renderNavigator, renderConversation }: { renderNavigator(visible: boolean): React.ReactNode; renderConversation(active: boolean): React.ReactNode }) => <>{renderNavigator(true)}{renderConversation(true)}</>,
}));

const bot = (id: string): BotSummary => ({
  id, name: `Bot ${id}`, entrySessionId: `entry-${id}`, archived: false,
  homeDir: `/bots/${id}`, coordinatorHostId: 'host-a', instructions: null, model: null,
  createdAt: '', updatedAt: '',
});

describe('Bot mode navigation', () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async () => { await act(async () => { root.render(<BotWorkspaceShell />); }); };
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
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
    state.profileId = 'varin.bot';
    state.list.mockReset().mockResolvedValue([bot('a'), bot('b')]);
    state.ensure.mockReset().mockImplementation(async (id: string) => ({ bot: bot(id), sessionId: `entry-${id}` }));
    state.work.mockReset().mockResolvedValue([]);
    state.create.mockReset().mockResolvedValue(bot('new'));
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
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.open).toHaveBeenLastCalledWith({ sessionId: 'entry-new', directory: '/bots/new' });
  });

  it('discards a pending entry after the shell unmounts', async () => {
    let finish!: (value: { bot: BotSummary; sessionId: string }) => void;
    state.ensure.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    act(() => root.render(null));
    await act(async () => { finish({ bot: bot('a'), sessionId: 'entry-a' }); });
    expect(state.open).not.toHaveBeenCalled();
  });

  it('discards an old Host response and loads the new Host', async () => {
    let finish!: (value: { bot: BotSummary; sessionId: string }) => void;
    state.ensure.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    state.list.mockResolvedValue([]);
    await act(async () => { usePiSessionStore.setState({ runtimeKey: 'host-b', currentSessionId: null }); });
    await act(async () => { finish({ bot: bot('a'), sessionId: 'entry-a' }); });
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
});
