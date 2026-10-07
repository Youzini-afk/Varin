import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiAssistantMessage, PiSessionEntry } from '@varin/protocol';
import type { NativeScrollEvent, NativeSyntheticEvent } from '@legendapp/list/react';
import { DEFAULT_PI_TIMELINE_VIEW } from '@/lib/pi-runtime/piTimelineScrollState';
import { PiTimeline } from './PiTimeline';

const mocks = vi.hoisted(() => ({
  data: undefined as readonly unknown[] | undefined,
  dataReplacements: 0,
  retainAssignedGeneration: false,
  handoffs: [] as Array<{ id: string; rendered: boolean }>,
  firstVisibleChanged: undefined as ((input: { index: number }) => void) | undefined,
  scrollToIndex: vi.fn().mockResolvedValue(undefined),
  scrollToOffset: vi.fn().mockResolvedValue(undefined),
  viewport: null as HTMLElement | null,
  onScroll: undefined as ((event: NativeSyntheticEvent<NativeScrollEvent>) => void) | undefined,
  store: {
    currentSessionId: 'session-1',
    records: {} as Record<string, unknown>,
    cancelTimelineAutomation: vi.fn(),
    completeTimelineReturn: vi.fn(),
    requestTimelineReturn: vi.fn(() => 1),
    saveTimelineCheckpoint: vi.fn(),
  },
}));
vi.mock('@legendapp/list/react', () => ({
  LegendList: React.forwardRef((props: {
    data: readonly { id: string }[];
    renderItem(input: { item: unknown; index: number }): React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    onFirstVisibleItemChanged?(input: { index: number }): void;
    onScroll?(event: NativeSyntheticEvent<NativeScrollEvent>): void;
  }, ref) => {
    if (mocks.data !== props.data) mocks.dataReplacements += 1;
    mocks.data = props.data;
    mocks.firstVisibleChanged = props.onFirstVisibleItemChanged;
    mocks.onScroll = props.onScroll;
    React.useImperativeHandle(ref, () => ({
      getState: () => ({ contentLength: 1000, scroll: 400, scrollLength: 600, data: props.data, positionAtIndex: (index: number) => index * 200 }),
      getScrollableNode: () => mocks.viewport,
      scrollToIndex: mocks.scrollToIndex,
      scrollToOffset: mocks.scrollToOffset,
    }));
    // LegendList may render an old container assignment through the current
    // renderItem callback until its layout pass adopts the new data generation.
    const assigned = React.useRef({ data: props.data, item: props.data.at(-1) });
    const [, refreshAssignment] = React.useReducer((revision: number) => revision + 1, 0);
    const useAssignedGeneration = mocks.retainAssignedGeneration && assigned.current.data !== props.data;
    const item = useAssignedGeneration ? assigned.current.item : props.data.at(-1);
    React.useLayoutEffect(() => {
      if (assigned.current.data === props.data) return;
      assigned.current = { data: props.data, item: props.data.at(-1) };
      if (mocks.retainAssignedGeneration) refreshAssignment();
    }, [props.data]);
    const rendered = item ? props.renderItem({ item, index: props.data.length - 1 }) : null;
    if (useAssignedGeneration && item) mocks.handoffs.push({ id: item.id, rendered: rendered !== null });
    return <div>{rendered}{props.ListFooterComponent}</div>;
  }),
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (select: (state: Record<string, boolean>) => unknown) => select({
    isMobile: false, promptNavigatorEnabled: true, stickyUserHeader: false,
  }),
}));
vi.mock('@/stores/usePiSessionStore', () => {
  const hook = (select: (state: typeof mocks.store) => unknown) => select(mocks.store);
  hook.getState = () => mocks.store;
  return { usePiSessionStore: hook };
});
vi.mock('./ChatContextMenu', () => ({
  ChatContextMenu: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./PiTimelineEntries', () => ({
  PiTimelineEntryList: ({ liveAssistant }: { liveAssistant?: PiAssistantMessage }) =>
    <div data-live-answer>{liveAssistant?.content.map((part) => part.type === 'text' ? part.text : '').join('')}</div>,
  PiTurnUserMessage: () => null,
}));
vi.mock('./PiTurnAssistantChrome', () => ({ PiTurnAssistantChrome: () => null }));

const assistant = (text: string, timestamp: number): PiAssistantMessage => ({
  api: 'messages', content: [{ type: 'text', text }], model: 'model', provider: 'provider',
  role: 'assistant', stopReason: 'pending', timestamp,
  usage: { cacheRead: 0, cacheWrite: 0, cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0, output: 0, totalTokens: 0 },
});

const history = (turns: number, onRead: () => void): PiSessionEntry[] => Array.from({ length: turns }, (_, index) => [
  { type: 'message' as const, id: `user-${index}`, parentId: null, timestamp: String(index * 2),
    message: { role: 'user' as const, timestamp: index * 2,
      get content() { onRead(); return `Prompt ${index}`; } } },
  { type: 'message' as const, id: `assistant-${index}`, parentId: null, timestamp: String(index * 2 + 1),
    message: { ...assistant('Completed answer', index * 2 + 1), stopReason: 'stop' as const } },
]).flat();

describe('PiTimeline streaming work', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    mocks.data = undefined;
    mocks.dataReplacements = 0;
    mocks.retainAssignedGeneration = false;
    mocks.handoffs = [];
    mocks.firstVisibleChanged = undefined;
    mocks.scrollToIndex.mockClear();
    mocks.scrollToOffset.mockClear();
    mocks.viewport = null;
    mocks.store.cancelTimelineAutomation.mockClear();
    mocks.store.currentSessionId = 'session-1';
    mocks.store.records = {
      'session-1': { view: DEFAULT_PI_TIMELINE_VIEW, toolExecutions: {}, assistantOutputDurationsMs: {} },
      'session-2': { view: DEFAULT_PI_TIMELINE_VIEW, toolExecutions: {}, assistantOutputDurationsMs: {} },
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  const render = async (entries: PiSessionEntry[], liveAssistant: PiAssistantMessage | undefined, sessionId = 'session-1', owner = 'host-a') => {
    mocks.store.currentSessionId = sessionId;
    await act(async () => root.render(
      <PiTimeline key={JSON.stringify([owner, sessionId])} cwd="/workspace" entries={entries} liveAssistant={liveAssistant} sessionId={sessionId} toolExecutions={{}} />,
    ));
  };

  const marker = (ordinal: number) => container.querySelector<HTMLButtonElement>(`[data-pi-turn-marker="${ordinal}"]`)!;

  it('updates the live answer without rebuilding list data or reading messages for the idle turn rail', async () => {
    let promptReads = 0;
    const turns = 2000;
    const updates = 100;
    const entries = history(turns, () => { promptReads += 1; });
    await render(entries, assistant('initial', turns * 2 + 1));
    promptReads = 0;
    mocks.dataReplacements = 0;
    const started = performance.now();
    for (let delta = 0; delta < updates; delta += 1) {
      await render(entries, assistant(`delta-${delta}`, turns * 2 + 1));
    }
    const elapsedMs = performance.now() - started;
    if (process.env.VARIN_PERF_UI === '1') console.info(JSON.stringify({
      fixture: 'timeline-streaming', turns, updates, elapsedMs,
      listDataReplacements: mocks.dataReplacements, promptReads,
    }));
    expect(container.querySelector('[data-live-answer]')?.textContent).toBe('delta-99');
    expect(container.querySelectorAll('[data-pi-turn-marker]')).toHaveLength(turns * 2 + 1);
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(promptReads).toBe(0);
    expect(mocks.dataReplacements).toBe(0);
  });

  it('reads only the previewed turn and discards that preview when the session changes', async () => {
    let reads = 0;
    const entries = history(3, () => { reads += 1; });
    await render(entries, assistant('first session', 20));
    reads = 0;
    await act(async () => marker(2).dispatchEvent(new window.Event('pointerover', { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('Prompt 1');
    expect(container.querySelector('[role="tooltip"]')?.textContent).not.toContain('Completed answer');
    expect(reads).toBe(1);
    await act(async () => marker(3).dispatchEvent(new window.Event('pointerover', { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('Completed answer');
    expect(container.querySelector('[role="tooltip"]')?.textContent).not.toContain('Prompt 1');
    expect(reads).toBe(1);
    await render(entries, assistant('another delta', 20));
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
    expect(reads).toBe(1);
    await render(history(2, () => {}), assistant('second session', 30), 'session-2');
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector('[data-live-answer]')?.textContent).toBe('second session');
  });
  it('drops old live content and navigation state when another Host has the same session ID', async () => {
    await render(history(2, () => {}), assistant('old Host answer', 10));
    await act(async () => marker(0).dispatchEvent(new window.Event('focusin', { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
    await render(history(2, () => {}), assistant('new Host answer', 10), 'session-1', 'host-b');
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector('[data-live-answer]')?.textContent).toBe('new Host answer');
  });

  it('highlights the viewed message and gives an explicit marker jump ownership of scrolling', async () => {
    await render(history(3, () => {}), undefined);
    await act(async () => mocks.firstVisibleChanged!({ index: 1 }));
    expect(marker(2).getAttribute('aria-current')).toBe('location');
    expect(marker(0).getAttribute('aria-current')).toBeNull();
    await act(async () => marker(0).click());
    expect(mocks.store.cancelTimelineAutomation).toHaveBeenCalledWith('session-1');
    expect(mocks.scrollToIndex).toHaveBeenLastCalledWith({ index: 0, viewPosition: 0, animated: true });
    // Highlight follows the list's actual location, rather than assuming a clicked jump has finished.
    expect(marker(2).getAttribute('aria-current')).toBe('location');
    await act(async () => mocks.firstVisibleChanged!({ index: 0 }));
    expect(marker(0).getAttribute('aria-current')).toBe('location');
  });

  it('tracks reading within a turn and jumps to the Agent message instead of its user prompt', async () => {
    await render(history(1, () => {}), undefined);
    const viewport = document.createElement('div');
    viewport.innerHTML = '<div data-turn-entry="turn:user-0"><article data-pi-user-message data-pi-message-role="user" data-pi-entry-id="user-0"></article><article data-pi-message-role="assistant" data-pi-entry-id="assistant-0"></article></div>';
    const rect = (top: number) => ({ top, bottom: top + 100, height: 100, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) });
    viewport.getBoundingClientRect = () => rect(0);
    const user = viewport.querySelector<HTMLElement>('[data-pi-user-message]')!;
    const answer = viewport.querySelector<HTMLElement>('[data-pi-message-role="assistant"]')!;
    user.getBoundingClientRect = () => rect(-50);
    let answerTop = 150;
    answer.getBoundingClientRect = () => rect(answerTop);
    container.querySelector<HTMLElement>('[data-pi-timeline-end-space]')!.getBoundingClientRect = () => ({ ...rect(0), height: 0 });
    mocks.viewport = viewport;
    await act(async () => mocks.firstVisibleChanged!({ index: 0 }));
    expect(marker(0).getAttribute('aria-current')).toBe('location');
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    answerTop = -4;
    await act(async () => {
      mocks.onScroll!({ nativeEvent: { contentOffset: { x: 0, y: 400 }, contentSize: { width: 600, height: 3000 }, layoutMeasurement: { width: 600, height: 600 } } } as NativeSyntheticEvent<NativeScrollEvent>);
      while (frames.length) frames.shift()!(0);
    });
    expect(marker(1).getAttribute('aria-current')).toBe('location');
    await act(async () => marker(1).click());
    expect(mocks.store.cancelTimelineAutomation).toHaveBeenCalledWith('session-1');
    expect(mocks.scrollToIndex).not.toHaveBeenCalled();
    expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ offset: 380, animated: true });
  });

  it.each(['withdraw', 'persist', 'replace'] as const)(
    'retires a standalone row from the assigned generation during %s',
    async (transition) => {
      mocks.retainAssignedGeneration = true;
      const entries: PiSessionEntry[] = [];
      const live = assistant('old payload', 10);
      await render(entries, live);
      if (transition === 'persist') {
        await render([{
          id: 'persisted-answer', type: 'message', parentId: null, timestamp: '10',
          message: { ...live, stopReason: 'stop' },
        }], undefined);
      } else {
        await render(entries, transition === 'replace' ? assistant('new payload', 20) : undefined);
      }
      expect(mocks.handoffs).toEqual([{ id: 'live-assistant:10', rendered: false }]);
      expect(container.querySelector('[data-live-answer]')?.textContent ?? '')
        .toBe(transition === 'replace' ? 'new payload' : '');
    },
  );

});
