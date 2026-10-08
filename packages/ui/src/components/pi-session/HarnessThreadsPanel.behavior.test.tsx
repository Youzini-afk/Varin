import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '@varin/application-client';
import { HarnessThreadsPanel } from './HarnessThreadsPanel';
import { HarnessThreadStateContext, type HarnessThreadStateValue } from './HarnessThreadStateContext';
import type { PiSessionViewState } from '@/stores/usePiSessionStore';
import type { SessionEntriesResult, ThreadMessageRecord, ComputerAutomationState } from '@varin/protocol';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';
import type { WebSource } from '@/stores/useWebSourcesStore';
import { useWorkOverviewStore } from '@/stores/useWorkOverviewStore';
import { THREAD_EXCHANGE_OPEN_EVENT } from './threadMessages';
import type { VarinEvent } from '@/lib/varinEvents';

const mocks = vi.hoisted(() => ({
  runtimeKey: 'runtime-1',
  records: {} as Record<string, Partial<PiSessionViewState>>,
  webSources: [] as WebSource[],
  openSession: vi.fn(),
  prefetchSession: vi.fn(),
  timeline: vi.fn(),
  getGitStatus: vi.fn(),
  openContextSurface: vi.fn(),
  toggleContextPanel: vi.fn(),
  translate: (key: string) => key,
  events: new Set<(event: VarinEvent) => void>(),
  computer: { state: null as ComputerAutomationState | null, activities: [], busy: false, error: null, stop: vi.fn() },
}));
vi.mock('@varin/application-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  runtimeFetch: vi.fn(),
}));
vi.mock('@/lib/pi-runtime/sessionNavigation', () => ({ openPiSessionFromNavigation: mocks.openSession }));
vi.mock('@/lib/gitApiHttp', () => ({ getGitStatus: mocks.getGitStatus }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));
vi.mock('@legendapp/list/react', () => ({ LegendList: ({ data, renderItem }: {
  data: Array<{ id: string; messages: ThreadMessageRecord[] }>;
  renderItem(item: { item: { id: string; messages: ThreadMessageRecord[] }; index: number }): React.ReactNode;
}) => <div>{data.map((item, index) => <React.Fragment key={item.id}>{renderItem({ item, index })}</React.Fragment>)}</div> }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.translate }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ breakpoint: 'xl' }) }));
vi.mock('motion/react', () => ({
  useIsPresent: () => true,
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    section: ({ children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }: React.HTMLAttributes<HTMLElement> & {
      initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown;
    }) => <section {...props}>{children}</section>,
  },
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: (listener: (event: VarinEvent) => void) => {
  mocks.events.add(listener); return () => { mocks.events.delete(listener); };
} }));
vi.mock('@/stores/useComputerAutomation', () => ({ useComputerAutomation: () => mocks.computer }));
vi.mock('@/stores/useUIStore', () => ({
  normalizeContextPanelDirectoryKey: (value: string) => value,
  useUIStore: (select: (state: {
    openContextSurface: typeof mocks.openContextSurface;
    toggleContextPanel: typeof mocks.toggleContextPanel;
    contextPanelByDirectory: Record<string, unknown>;
  }) => unknown) => select({
    openContextSurface: mocks.openContextSurface,
    toggleContextPanel: mocks.toggleContextPanel,
    contextPanelByDirectory: {},
  }),
}));
vi.mock('@/stores/usePiSessionStore', () => ({
  usePiSessionStore: Object.assign(
    (select: (state: typeof mocks) => unknown) => select(mocks),
    { getState: () => mocks, subscribe: () => () => {} },
  ),
}));
vi.mock('@/stores/useWebSourcesStore', () => ({
  useWebSources: () => mocks.webSources,
  useWebSourcesStore: () => () => {},
}));
vi.mock('./HarnessKnowledgeReviewSection', () => ({ HarnessKnowledgeReviewSection: () => null }));
vi.mock('./HarnessThreadIntegrationPanel', () => ({ HarnessThreadIntegrationPanel: () => null }));
vi.mock('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: () => null }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('./PiTimeline', () => ({ PiTimeline: (props: { entries: unknown[] }) => {
  mocks.timeline(props); return <div data-testid="transcript">{JSON.stringify(props.entries)}</div>;
} }));


const snapshot = (): HarnessThreadSnapshot => ({
  thread: {
    purpose: 'task',
    id: 'thread-1', parent: { kind: 'session', id: 'parent-1' }, workspaceId: 'workspace-1',
    forkPoint: null, brief: 'Continue the implementation', preset: null, model: null,
    manifest: { workFocus: 'code', carryBlocks: true, concurrency: 12, draftBaselineId: null, scope: ['src'], systemPromptFragment: null, tools: ['read'], worktree: 'isolated' },
    createdBy: 'agent', kind: 'implementation', lifecycle: 'settled', attention: 'none',
    worktree: { path: '/old-cwd', base: 'base', materialized: false },
    waitingFor: null, integration: 'none', diffStats: null, report: null, activeRunId: 'run-1',
    createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z', eventSeq: 1, hidden: false,
  },
  activeRun: {
    id: 'run-1', threadId: 'thread-1', attempt: 1, runtimeId: 'runtime-1', sessionId: 'old-session',
    sessionOwner: 'spawned-child',
    workerState: 'exited', outcome: 'success', exitReason: null, tokens: { input: 0, output: 0, cacheRead: 0 },
    costUsd: null, steps: 1, lastToolCall: null, startedAt: '2026-09-10T00:00:00.000Z',
    lastActivityAt: '2026-09-10T00:00:00.000Z', endedAt: '2026-09-10T00:00:00.000Z',
  },
});

let root: Root;
let container: HTMLElement;
let state: HarnessThreadStateValue;
let finishPreview: (result: SessionEntriesResult) => void;
let failPreview: (error: Error) => void;

beforeEach(() => {
  mocks.runtimeKey = 'runtime-1';
  mocks.events.clear();
  mocks.computer.state = null; mocks.computer.stop.mockReset();
  mocks.records = {};
  mocks.webSources = [];
  useWorkOverviewStore.setState({ bySession: {}, parentBySession: {} });
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('HTMLElement', dom.HTMLElement);
  vi.stubGlobal('Node', dom.Node);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  state = {
    workspaceId: 'workspace-1', parent: { kind: 'session', id: 'parent-1' },
    merge: vi.fn(), reload: vi.fn(async () => {}),
    threads: [snapshot()],
    rootThreads: [], branches: [], loadError: null,
  };
  mocks.openSession.mockResolvedValue(undefined);
  mocks.prefetchSession.mockImplementation(() => new Promise<SessionEntriesResult>((resolve, reject) => {
    finishPreview = resolve; failPreview = reject;
  }));
  mocks.getGitStatus.mockRejectedValue(new Error('not a git repository'));
  vi.mocked(runtimeFetch).mockResolvedValue(new Response(null, { status: 404 }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const clickOpen = async () => {
  await act(async () => root.render(
    <HarnessThreadStateContext.Provider value={state}>
      <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" fallbackCwd="/parent" />
    </HarnessThreadStateContext.Provider>,
  ));
  const overview = container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.expand"]')!;
  await act(async () => overview.click());
  const button = container.querySelector<HTMLButtonElement>('button[aria-label^="harness.threads.viewConversation:"]')!;
  await act(async () => button.click());
  return button;
};

describe('thread panel transcript is inspection, not execution', () => {
  it('opens a correlated exchange directly and lets the user navigate to its real conversation', async () => {
    state.threads[0]!.thread.messages = [
      { id: 'question', direction: 'in', from: { kind: 'user', id: 'parent-1' }, to: { kind: 'thread', id: 'thread-1' }, kind: 'request',
        text: 'Which interface should we use?', status: 'resolved', at: '2026-09-10T00:01:00.000Z' },
      { id: 'answer', direction: 'out', from: { kind: 'thread', id: 'thread-1' }, to: { kind: 'user', id: 'parent-1' }, kind: 'inform',
        text: 'Use the existing interface.', replyTo: 'question', status: 'delivered', at: '2026-09-10T00:02:00.000Z' },
    ];
    await act(async () => root.render(<HarnessThreadStateContext.Provider value={state}>
      <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" />
    </HarnessThreadStateContext.Provider>));
    const event = new window.Event(THREAD_EXCHANGE_OPEN_EVENT);
    Object.assign(event, { detail: { threadId: 'thread-1', messageId: 'answer' } });
    await act(async () => window.dispatchEvent(event));
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('harness.messages.exchange');
    expect(dialog.textContent).toContain('Which interface should we use?');
    expect(dialog.textContent).toContain('Use the existing interface.');
    expect(dialog.textContent).toContain('harness.messages.state.replied');
    expect(mocks.prefetchSession).not.toHaveBeenCalled();
    const sender = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === state.threads[0]!.thread.brief)!;
    await act(async () => sender.click());
    expect(mocks.openSession).toHaveBeenCalledWith({ sessionId: 'old-session', directory: '/old-cwd' });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(vi.mocked(runtimeFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  });

  it('keeps retained research branches inspectable in the inline research workspace', async () => {
    const branch = snapshot();
    branch.thread.parent = { kind: 'thread', id: 'research-root' };
    state.threads = [];
    state.branches = [branch];
    await act(async () => root.render(
      <HarnessThreadStateContext.Provider value={state}>
        <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" presentation="inline" title="Research branches" />
      </HarnessThreadStateContext.Provider>,
    ));
    expect(container.querySelector('summary')?.textContent).toContain('Research branches');
    expect(container.textContent).toContain(branch.thread.brief);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label^="harness.threads.viewConversation:"]')!;
    await act(async () => button.click());
    expect(mocks.prefetchSession).toHaveBeenCalledExactlyOnceWith('old-session');
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(vi.mocked(runtimeFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  });

  for (const lifecycle of ['settled', 'archived'] as const) {
    it(`reads ${lifecycle} history without restoring a directory, opening a worker or starting a Run`, async () => {
      state.threads[0]!.thread.lifecycle = lifecycle;
      await clickOpen();
      expect(mocks.prefetchSession).toHaveBeenCalledExactlyOnceWith('old-session');
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      const result: SessionEntriesResult = { sessionId: 'old-session', scope: 'branch', leafId: 'old-entry', entries: [{
        id: 'old-entry', parentId: null, timestamp: '2026-09-10T00:00:00.000Z', type: 'message',
        message: { role: 'user', content: 'PERSISTED_TRANSCRIPT_BODY', timestamp: 0 },
      }] };
      await act(async () => { finishPreview(result); });
      expect(container.textContent).toContain('PERSISTED_TRANSCRIPT_BODY');
      expect(mocks.timeline).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'old-session', entries: result.entries }));
      expect(mocks.openSession).not.toHaveBeenCalled();
      expect(state.merge).not.toHaveBeenCalled();
      expect(state.reload).not.toHaveBeenCalled();
      expect(vi.mocked(runtimeFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
      expect(state.threads[0]!.activeRun?.id).toBe('run-1');
    });
  }

  it('reports a missing transcript without converting the read into a restore', async () => {
    await clickOpen();
    await act(async () => { failPreview(new Error('Native transcript is unavailable')); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Native transcript is unavailable');
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(vi.mocked(runtimeFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  });
  it('updates the child preview from live session state and navigates only on Open conversation', async () => {
    await clickOpen();
    const result: SessionEntriesResult = { sessionId: 'old-session', scope: 'branch', leafId: null, entries: [] };
    await act(async () => { finishPreview(result); });
    const liveAssistant = {
      role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Still working' }],
      api: 'test', model: 'test', provider: 'test', stopReason: 'pending' as const, timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    mocks.records['old-session'] = { branchEntries: result, liveAssistant };
    await act(async () => root.render(
      <HarnessThreadStateContext.Provider value={state}>
        <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" fallbackCwd="/parent" />
      </HarnessThreadStateContext.Provider>,
    ));
    expect(mocks.timeline).toHaveBeenLastCalledWith(expect.objectContaining({ liveAssistant }));
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(mocks.openContextSurface).not.toHaveBeenCalled();
    const open = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'harness.threads.openConversation')!;
    await act(async () => open.click());
    expect(mocks.openSession).toHaveBeenCalledExactlyOnceWith({ sessionId: 'old-session', directory: '/old-cwd', launch: { scope: ['src'], tools: ['read'] } });
    expect(useWorkOverviewStore.getState().parentBySession[JSON.stringify(['runtime-1', 'old-session'])])
      .toEqual({ sessionId: 'parent-1', directory: '/parent' });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

});

describe('work overview presentation', () => {
  it('refreshes committed blocks by conversation identity and rejects an older empty response', async () => {
    state.threads = [];
    let finishInitial!: (response: Response) => void;
    let reads = 0;
    vi.mocked(runtimeFetch).mockImplementation(async input => {
      if (!String(input).endsWith('/blocks')) return new Response(null, { status: 404 });
      if (++reads === 1) return new Promise<Response>(resolve => { finishInitial = resolve; });
      return new Response(JSON.stringify({ branchLeafId: 'new-leaf', blocks: [
        { label: 'plan', content: '- [ ] Updated plan', updatedBy: 'agent', updatedAt: 2 },
      ] }));
    });
    const render = () => root.render(<HarnessThreadStateContext.Provider value={state}>
      <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" />
    </HarnessThreadStateContext.Provider>);
    await act(async () => render());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.expand"]')!.click());
    await act(async () => {
      for (const listener of mocks.events) listener({ type: 'harness-blocks-changed', workspaceId: 'workspace-1', sessionId: 'other-chat' });
    });
    expect(reads).toBe(1);
    await act(async () => {
      for (const listener of mocks.events) listener({ type: 'harness-blocks-changed', workspaceId: 'session:parent-1', sessionId: 'parent-1' });
    });
    expect(container.textContent).toContain('Updated plan');
    await act(async () => finishInitial(new Response(JSON.stringify({ blocks: [], branchLeafId: 'old-leaf' }))));
    expect(container.textContent).toContain('Updated plan');
  });

  it('refreshes successful todo changes without an SSE event and reloads a replaced branch', async () => {
    state.threads = [];
    let content: string | null = null;
    vi.mocked(runtimeFetch).mockImplementation(async input => String(input).endsWith('/blocks')
      ? new Response(JSON.stringify({ branchLeafId: 'leaf', blocks: content === null ? [] : [
        { label: 'plan', content, updatedBy: 'agent', updatedAt: 2 },
      ] })) : new Response(null, { status: 404 }));
    const render = () => root.render(<HarnessThreadStateContext.Provider value={state}>
      <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" />
    </HarnessThreadStateContext.Provider>);
    await act(async () => render());
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.expand"]')!.click());
    content = '- [ ] Written by todo';
    mocks.records['parent-1'] = { toolExecutions: { 'todo-call': {
      args: {}, name: 'todo', toolCallId: 'todo-call', status: 'success',
    } }, branchEntries: { sessionId: 'parent-1', scope: 'branch', leafId: 'old', entries: [{
      type: 'custom', id: 'old', parentId: null, timestamp: 'now', customType: 'branch', data: null,
    }] } };
    await act(async () => render());
    expect(container.textContent).toContain('Written by todo');
    content = '- [x] Other branch plan';
    mocks.records['parent-1'] = { ...mocks.records['parent-1'], branchEntries: {
      sessionId: 'parent-1', scope: 'branch', leafId: 'new', entries: [{
        type: 'custom', id: 'new', parentId: null, timestamp: 'now', customType: 'branch', data: null,
      }],
    } };
    await act(async () => render());
    expect(container.textContent).toContain('Other branch plan');
    expect(container.textContent).not.toContain('Written by todo');
  });

  it('turns raw session blocks into plan, progress and decisions instead of exposing block metadata', async () => {
    state.threads = [];
    const desktopView = vi.fn();
    vi.mocked(runtimeFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/blocks')) {
        return new Response(JSON.stringify({
          branchLeafId: null,
          blocks: [
            { label: 'plan', content: '- [x] Inspect\n- [x] Implement', updatedBy: 'agent', updatedAt: 1 },
            { label: 'progress', content: 'Working on tests', updatedBy: 'memory-agent', updatedAt: 2 },
            { label: 'decisions', content: 'Use vitest', updatedBy: 'user', updatedAt: 3 },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/knowledge/suggestions')) {
        return new Response(JSON.stringify({ suggestions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    });

    await act(async () => {
      root.render(
        <HarnessThreadStateContext.Provider value={state}>
          <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" onDesktopViewChange={desktopView} />
        </HarnessThreadStateContext.Provider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const peek = container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.peek"]')!;
    await act(async () => peek.click());
    expect(container.querySelector('[data-harness-overview-peek]')).not.toBeNull();
    expect(container.querySelector('[data-harness-overview-floating]')).toBeNull();
    expect(container.textContent).not.toContain('Inspect');
    expect(desktopView).toHaveBeenLastCalledWith('compact');
    const full = [...container.querySelectorAll<HTMLButtonElement>('[data-harness-overview-peek] button')]
      .find(button => button.textContent === 'harness.overview.details')!;
    await act(async () => full.click());
    expect(container.querySelector('[data-harness-overview-peek]')).toBeNull();
    expect(container.querySelector('[data-harness-overview-floating]')).not.toBeNull();
    expect(container.querySelector('button.workbench-overview-peek-trigger')).toBeNull();
    expect(desktopView).toHaveBeenLastCalledWith('full');
    expect(container.textContent).toContain('harness.overview.plan');
    expect(container.textContent).toContain('Inspect');
    expect(container.textContent).toContain('Implement');
    expect(container.textContent).toContain('harness.overview.memoryProgress');
    expect(container.textContent).toContain('Working on tests');
    expect(container.textContent).toContain('harness.overview.memoryDecisions');
    expect(container.textContent).toContain('Use vitest');
    expect(container.textContent).not.toContain('memory-agent');
    const sections = [...container.querySelectorAll('details')];
    expect(sections.find((section) => section.firstElementChild?.textContent?.includes('harness.overview.plan'))?.hasAttribute('open')).toBe(true);
    expect(sections.find((section) => section.firstElementChild?.textContent?.includes('harness.overview.memory'))?.hasAttribute('open')).toBe(true);
  });

  it('retains disclosure choices across reopen, session navigation and persistent hydration', async () => {
    mocks.webSources = [{
      id: 'source-1', sessionId: 'parent-1', title: 'Reference', url: 'https://example.com',
      fetchedAt: 1, toolCallId: 'call-1', tool: 'webfetch', pinned: false,
    }];
    const render = (sessionId = 'parent-1') => act(async () => root.render(
      <HarnessThreadStateContext.Provider value={state}>
        <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId={sessionId} fallbackCwd="/parent" />
      </HarnessThreadStateContext.Provider>,
    ));
    const section = (title: string) => [...container.querySelectorAll('details')]
      .find((details) => details.firstElementChild?.textContent?.includes(title))!;
    const toggleSection = (details: HTMLDetailsElement, open: boolean) => act(async () => {
      // Linkedom does not implement the native summary/default-toggle action.
      details.open = open;
      details.toggleAttribute('open', open);
      details.dispatchEvent(new window.Event('toggle'));
    });
    await render();

    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.expand"]');
    expect(expand).not.toBeNull();

    expect(container.querySelector('[data-harness-overview-floating="true"]')).toBeNull();

    await act(async () => expand!.click());
    expect(container.querySelector('[data-harness-overview-floating="true"]')).not.toBeNull();
    expect(section('harness.overview.threads').hasAttribute('open')).toBe(true);
    expect(section('harness.overview.sources').hasAttribute('open')).toBe(false);
    await toggleSection(section('harness.overview.threads'), false);
    await toggleSection(section('harness.overview.sources'), true);

    const outside = document.createElement('textarea');
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      outside.focus();
      outside.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
    expect(container.querySelector('[data-harness-overview-floating="true"]')).not.toBeNull();
    outside.remove();

    const close = container.querySelector<HTMLButtonElement>('[data-harness-overview-controls="true"] button[aria-label="harness.overview.collapse"]')!;
    await act(async () => close.click());
    expect(container.querySelector('[data-harness-overview-floating="true"]')).toBeNull();
    await act(async () => expand!.click());
    expect(section('harness.overview.threads').hasAttribute('open')).toBe(false);
    expect(section('harness.overview.sources').hasAttribute('open')).toBe(true);

    await render('parent-2');
    expect(container.querySelector('[data-harness-overview-floating="true"]')).toBeNull();
    await render();
    expect(container.querySelector('[data-harness-overview-floating="true"]')).not.toBeNull();
    expect(section('harness.overview.threads').hasAttribute('open')).toBe(false);

    mocks.runtimeKey = 'runtime-2';
    await render();
    expect(container.querySelector('[data-harness-overview-floating="true"]')).toBeNull();
    mocks.runtimeKey = 'runtime-1';
    await render();
    expect(container.querySelector('[data-harness-overview-floating="true"]')).not.toBeNull();

    const { name, storage } = useWorkOverviewStore.persist.getOptions();
    const saved = await storage!.getItem(name!);
    await act(async () => {
      root.render(null);
      useWorkOverviewStore.setState({ bySession: {} });
      await storage!.setItem(name!, saved!);
      await useWorkOverviewStore.persist.rehydrate();
    });
    await render();
    expect(container.querySelector('[data-harness-overview-floating="true"]')).not.toBeNull();
    expect(section('harness.overview.threads').hasAttribute('open')).toBe(false);
    expect(section('harness.overview.sources').hasAttribute('open')).toBe(true);

    const collapse = container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.collapse"]')!;
    await act(async () => collapse.click());
    expect(mocks.toggleContextPanel).not.toHaveBeenCalled();
    expect(container.querySelector('[data-harness-overview-floating="true"]')).toBeNull();
    await render('parent-2');
    await render();
    expect(container.querySelector('[data-harness-overview-floating="true"]')).toBeNull();
    const peek = container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.peek"]')!;
    await act(async () => peek.click());
    await render('parent-2');
    expect(container.querySelector('[data-harness-overview-peek]')).toBeNull();
    await render();
    expect(container.querySelector('[data-harness-overview-peek]')).not.toBeNull();
    expect(container.querySelector('[data-harness-overview-floating]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.expand"]')!.click());
    expect(container.querySelector('[data-harness-overview-peek]')).toBeNull();
    expect(container.querySelector('[data-harness-overview-floating]')).not.toBeNull();
  });

  it('lets the user stop Computer Use from the compact overview without opening a large panel', async () => {
    mocks.computer.state = { rootSessionId: 'parent-1', runId: 'run', active: true, status: 'enabled', requests: [], leases: [{ id: 'lease', desktopId: 'desktop', access: 'control', grantedAt: 'now', actor: {
      sessionId: 'parent-1', runId: 'run', rootSessionId: 'parent-1', rootRunId: 'run', scopeId: 'workspace-1', threadId: 'root', label: 'Main', readOnly: false,
    } }] };
    await act(async () => root.render(<HarnessThreadStateContext.Provider value={state}><HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" fallbackCwd="/parent" /></HarnessThreadStateContext.Provider>));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.peek"]')!.click());
    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="computer.automation.stop"]')!;
    expect(stop.closest('button')?.parentElement?.closest('button')).toBeNull();
    await act(async () => stop.click());
    expect(mocks.computer.stop).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-harness-overview-floating]')).toBeNull();
  });

  it('still appears for real workspace changes when no plan, memory, source or subtask exists', async () => {
    state.threads = [];
    mocks.getGitStatus.mockResolvedValue({
      current: 'main', tracking: 'origin/main', ahead: 0, behind: 0, isClean: false,
      files: [{ path: 'src/changed.ts', index: ' ', working_dir: 'M' }],
      diffStats: { 'src/changed.ts': { insertions: 7, deletions: 2 } },
    });

    await act(async () => {
      root.render(
        <HarnessThreadStateContext.Provider value={state}>
          <HarnessThreadsPanel workspaceId="workspace-1" parentSessionId="parent-1" fallbackCwd="/parent" />
        </HarnessThreadStateContext.Provider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const overview = container.querySelector<HTMLButtonElement>('button[aria-label="harness.overview.expand"]')!;
    await act(async () => overview.click());

    expect(container.textContent).toContain('harness.overview.outputs');
    expect(container.textContent).toContain('harness.overview.workspaceChanges');
    expect(container.textContent).toContain('src/changed.ts');
    expect(container.textContent).toContain('+7 −2');
  });
});
