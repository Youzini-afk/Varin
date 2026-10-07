import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@varin/application-client';
import { PiFollowUpsStrip } from './PiFollowUpsStrip';
import type { VarinEvent } from '@/lib/varinEvents';

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: VarinEvent) => void>(),
  toastErrors: [] as string[],
  translate: (key: string, params?: Record<string, unknown>) => (
    params ? `${key}:${JSON.stringify(params)}` : key
  ),
}));
vi.mock('@varin/application-client', () => ({
  runtimeFetch: vi.fn(), getRuntimeKey: () => 'host-a', subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/toast', () => ({ toast: { error: (message: string) => mocks.toastErrors.push(message) } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/varinEvents', () => ({
  subscribeVarinEvents: (listener: (event: VarinEvent) => void) => {
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); };
  },
}));

const followUp = (over: Record<string, unknown> = {}) => ({
  createdAt: 1,
  id: 'fu-1',
  instruction: 'when the run fails, diagnose and retry the data step',
  pausedGoal: false,
  revision: '2',
  sessionId: 'session-1',
  source: { attemptId: 'attempt-7', kind: 'experiment' },
  status: 'waiting',
  threadId: 'thread-1',
  updatedAt: 1,
  waitingSummary: 'Waiting for experiment attempt-7 to reach completed/failed',
  workspaceId: 'workspace-1',
  ...over,
});

const listResponse = (items: unknown[]) =>
  new Response(JSON.stringify({ followUps: items }), { status: 200 });

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('PiFollowUpsStrip', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const { document } = parseHTML('<!doctype html><html><body></body></html>');
    (globalThis as { document?: unknown }).document = document;
    (globalThis as { window?: unknown }).window = document.defaultView;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    mocks.listeners.clear();
    mocks.toastErrors.length = 0;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.mocked(runtimeFetch).mockReset();
  });

  it('renders nothing when the session has no follow-ups', async () => {
    vi.mocked(runtimeFetch).mockResolvedValue(listResponse([]));
    await act(async () => {
      root = createRoot(container);
      root.render(<PiFollowUpsStrip sessionId="session-1" />);
    });
    await flush();
    expect(container.textContent ?? '').not.toContain('Waiting for');
  });

  it('shows what the session waits for and what runs next', async () => {
    vi.mocked(runtimeFetch).mockResolvedValue(listResponse([followUp()]));
    await act(async () => {
      root = createRoot(container);
      root.render(<PiFollowUpsStrip sessionId="session-1" />);
    });
    await flush();
    expect(container.textContent).toContain('Waiting for experiment attempt-7');
    expect(container.textContent).toContain('diagnose and retry the data step');
    expect(container.textContent).toContain('chat.followup.status.waiting');
  });

  it('posts check, fire and cancel to the session-scoped routes', async () => {
    let cancelled = false;
    vi.mocked(runtimeFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/follow-ups')) return listResponse(cancelled ? [] : [followUp()]);
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: '2' });
      if (url.endsWith('/check')) {
        return new Response(JSON.stringify({ fired: false, followUp: followUp(), observed: {} }), { status: 200 });
      }
      cancelled = url.endsWith('/cancel');
      return new Response(JSON.stringify({ followUp: followUp({ status: cancelled ? 'cancelled' : 'waiting' }), occurrences: [] }), { status: 200 });
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<PiFollowUpsStrip sessionId="session-1" />);
    });
    await flush();

    const buttons = [...container.querySelectorAll('button')];
    const byText = (key: string) => buttons.find((b) => b.textContent === `chat.followup.action.${key}`);
    await act(async () => { byText('check')?.click(); });
    await flush();
    expect(vi.mocked(runtimeFetch).mock.calls.some(([url]) => String(url).endsWith('/follow-ups/fu-1/check'))).toBe(true);

    await act(async () => { byText('fire')?.click(); });
    await flush();
    expect(vi.mocked(runtimeFetch).mock.calls.some(([url]) => String(url).endsWith('/follow-ups/fu-1/fire'))).toBe(true);

    await act(async () => { byText('cancel')?.click(); });
    await flush();
    expect(vi.mocked(runtimeFetch).mock.calls.some(([url]) => String(url).endsWith('/follow-ups/fu-1/cancel'))).toBe(true);
    expect(mocks.toastErrors).toEqual([]);
    expect(container.textContent ?? '').not.toContain('Waiting for experiment');
  });

  it('refreshes on a followup fact broadcast, not on unrelated facts', async () => {
    vi.mocked(runtimeFetch).mockImplementation(async () => listResponse([followUp()]));
    await act(async () => {
      root = createRoot(container);
      root.render(<PiFollowUpsStrip sessionId="session-1" />);
    });
    await flush();
    const baseline = vi.mocked(runtimeFetch).mock.calls.length;

    for (const listener of mocks.listeners) {
      listener({ fact: 'attempt', type: 'harness-experiment-changed', workspaceId: 'workspace-1' });
    }
    await flush();
    expect(vi.mocked(runtimeFetch).mock.calls.length).toBe(baseline);

    for (const listener of mocks.listeners) {
      listener({ fact: 'followup', type: 'harness-experiment-changed', workspaceId: 'workspace-1' });
    }
    await flush();
    expect(vi.mocked(runtimeFetch).mock.calls.length).toBeGreaterThan(baseline);
    const afterFact = vi.mocked(runtimeFetch).mock.calls.length;
    for (const listener of mocks.listeners) listener({ type: 'stream-ready' });
    await flush();
    expect(vi.mocked(runtimeFetch).mock.calls.length).toBeGreaterThan(afterFact);
  });

  it('does not restore the prior session registration when its delayed read finishes', async () => {
    let finishPrevious!: (response: Response) => void;
    vi.mocked(runtimeFetch).mockImplementation(async (url) => {
      if (String(url).includes('/sessions/session-1/')) return new Promise<Response>(resolve => { finishPrevious = resolve; });
      return listResponse([]);
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<PiFollowUpsStrip sessionId="session-1" />);
    });
    await act(async () => { root.render(<PiFollowUpsStrip sessionId="session-2" />); });
    await flush();
    await act(async () => { finishPrevious(listResponse([followUp()])); });
    await flush();
    expect(container.textContent ?? '').not.toContain('Waiting for experiment');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('refreshes a stale registration after its cancel is rejected', async () => {
    let rejected = false;
    vi.mocked(runtimeFetch).mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        rejected = true;
        return new Response(JSON.stringify({ error: 'unknown follow-up' }), { status: 404 });
      }
      return listResponse(rejected ? [] : [followUp()]);
    });
    await act(async () => {
      root = createRoot(container);
      root.render(<PiFollowUpsStrip sessionId="session-1" />);
    });
    await flush();
    await act(async () => {
      [...container.querySelectorAll('button')].find(button => button.textContent === 'chat.followup.action.cancel')?.click();
    });
    await flush();
    expect(container.textContent ?? '').not.toContain('Waiting for experiment');
    expect(mocks.toastErrors).toEqual(['unknown follow-up']);
  });
});
