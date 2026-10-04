import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiAssistantMessage, PiSessionEntry } from '@varin/protocol';
import { DEFAULT_PI_TIMELINE_VIEW } from '@/lib/pi-runtime/piTimelineScrollState';
import { PiTimeline } from './PiTimeline';

const mocks = vi.hoisted(() => ({
  data: undefined as readonly unknown[] | undefined,
  dataReplacements: 0,
  retainAssignedGeneration: false,
  handoffs: [] as Array<{ id: string; rendered: boolean }>,
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
  }, ref) => {
    if (mocks.data !== props.data) mocks.dataReplacements += 1;
    mocks.data = props.data;
    React.useImperativeHandle(ref, () => ({
      getState: () => ({ contentLength: 1000, scroll: 400, scrollLength: 600 }),
      getScrollableNode: () => null,
      scrollToIndex: vi.fn().mockResolvedValue(undefined),
      scrollToOffset: vi.fn().mockResolvedValue(undefined),
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
vi.mock('@/components/ui/dropdown-menu', () => {
  const Menu = React.createContext({ open: false, toggle: () => {} });
  return {
    DropdownMenu: ({ children, open, onOpenChange }: {
      children: React.ReactNode; open?: boolean; onOpenChange?(open: boolean): void;
    }) => {
      const [localOpen, setLocalOpen] = React.useState(false);
      const actualOpen = open ?? localOpen;
      return <Menu.Provider value={{ open: actualOpen, toggle: () => {
        setLocalOpen(!actualOpen); onOpenChange?.(!actualOpen);
      } }}>{children}</Menu.Provider>;
    },
    DropdownMenuTrigger: ({ children }: { children: React.ReactElement<{ onClick?: () => void }> }) =>
      React.cloneElement(children, { onClick: React.useContext(Menu).toggle }),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      React.useContext(Menu).open ? <div role="menu">{children}</div> : null,
    DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?(): void }) =>
      <button type="button" role="menuitem" onClick={onSelect}>{children}</button>,
  };
});

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

  it('updates the live answer without rebuilding list data or reading prompts for a closed navigator', async () => {
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
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(promptReads).toBe(0);
    expect(mocks.dataReplacements).toBe(0);
  });

  it('opens current prompts on demand and discards an open navigator when the session changes', async () => {
    const entries = history(3, () => {});
    await render(entries, assistant('first session', 20));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="settings.chat.navigator"]')!;
    await act(async () => trigger.click());
    expect([...container.querySelectorAll('[role="menuitem"]')].map((element) => element.textContent))
      .toEqual(['Prompt 0', 'Prompt 1', 'Prompt 2']);
    await render(entries, assistant('another delta', 20));
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    await render(history(2, () => {}), assistant('second session', 30), 'session-2');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[data-live-answer]')?.textContent).toBe('second session');
  });
  it('drops old live content and navigation state when another Host has the same session ID', async () => {
    await render(history(2, () => {}), assistant('old Host answer', 10));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="settings.chat.navigator"]')!.click());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    await render(history(2, () => {}), assistant('new Host answer', 10), 'session-1', 'host-b');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[data-live-answer]')?.textContent).toBe('new Host answer');
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
