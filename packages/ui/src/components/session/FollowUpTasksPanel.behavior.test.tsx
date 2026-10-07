import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@varin/application-client';
import { FollowUpTasksPanel } from './FollowUpTasksPanel';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  translate: (key: string) => key,
  state: { runtimeKey: 'host-a', summaries: [{ id: 's-1', name: 'My experiment', cwd: '/repo', firstMessage: '' }] },
}));
vi.mock('@varin/application-client', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
vi.mock('@/lib/pi-runtime/sessionNavigation', () => ({ openPiSessionFromNavigation: mocks.navigate }));
vi.mock('@/stores/usePiSessionStore', () => ({ usePiSessionStore: (select: (state: typeof mocks.state) => unknown) => select(mocks.state) }));

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: 'wait-1', workspaceId: 'ws', sessionId: 's-1', source: { kind: 'manual' },
  status: 'waiting', revision: '3', instruction: 'Inspect the result', waitingSummary: 'Wait for the experiment',
  createdAt: 1, updatedAt: 1, pausedGoal: true, ...overrides,
});
const response = (followUps: unknown[]) => new Response(JSON.stringify({ followUps }), { status: 200 });

describe('follow-up task overview', () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = async () => { await act(async () => { root.render(<FollowUpTasksPanel />); }); };
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === label);
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
  };

  beforeEach(() => {
    const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.mocked(runtimeFetch).mockReset();
    mocks.navigate.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('separates active waits and history and returns to the owning conversation', async () => {
    vi.mocked(runtimeFetch).mockImplementation(async () => response([
      entry(), entry({ id: 'wait-2', status: 'delivered', instruction: 'Finished instruction' }),
    ]));
    await render();
    expect(container.textContent).toContain('Inspect the result');
    expect(container.textContent).toContain('Finished instruction');
    await click('tasksHub.active');
    expect(container.textContent).not.toContain('Finished instruction');
    await click('My experiment');
    expect(mocks.navigate).toHaveBeenCalledWith({ sessionId: 's-1', directory: '/repo' });
    await click('tasksHub.history');
    expect(container.textContent).toContain('Finished instruction');
    expect(container.textContent).not.toContain('Inspect the result');
  });

  it('uses the existing session endpoint and revision when cancelling', async () => {
    let cancelled = false;
    vi.mocked(runtimeFetch).mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        expect(String(url)).toBe('/api/harness/sessions/s-1/follow-ups/wait-1/cancel');
        expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: '3' });
        cancelled = true;
        return new Response(JSON.stringify({ followUp: entry({ status: 'cancelled' }), occurrences: [] }), { status: 200 });
      }
      expect(String(url)).toBe('/api/harness/follow-ups?includeInactive=true');
      return response([entry({ status: cancelled ? 'cancelled' : 'waiting' })]);
    });
    await render();
    await click('chat.followup.action.cancel');
    await click('tasksHub.active');
    expect(container.textContent).toContain('tasksHub.empty');
    await click('tasksHub.history');
    expect(container.textContent).toContain('chat.followup.status.cancelled');
  });

  it('shows a retryable load failure rather than an empty task list', async () => {
    vi.mocked(runtimeFetch).mockResolvedValue(new Response('', { status: 503 }));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('503');
    expect(container.textContent).not.toContain('tasksHub.empty');
  });
});
