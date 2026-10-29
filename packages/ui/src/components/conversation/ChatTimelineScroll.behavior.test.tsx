import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ThreadHistoryItem, ThreadsAPI } from '@varin/application-client';
import type { LegendListProps } from '@legendapp/list/react';
import { ChatTimeline } from './ChatTimeline';
import { ConversationTimeline } from './ConversationTimeline';
import { DEFAULT_CHAT_TIMELINE_VIEW } from './chatTimelineScrollState';
import { useTimelineViewStore } from './timelineViewStore';
import { threadComposerKey, threadHostKey } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import { assistant } from './historyPresentation';
import type { ChatTimelineBlock } from './chatTimelineBlocks';

type ViewportProps = LegendListProps<ChatTimelineBlock>;
const viewport = vi.hoisted(() => ({
  props: null as ViewportProps | null,
  initial: [] as ViewportProps['initialScrollIndex'][],
  writes: [] as number[],
  height: 600, content: 2000, top: 1500,
}));
vi.mock('@legendapp/list/react', () => ({ LegendList: React.forwardRef((props: ViewportProps, ref) => {
  const node = React.useRef<HTMLDivElement>(null);
  viewport.props = props;
  React.useState(() => { viewport.initial.push(props.initialScrollIndex); });
  React.useImperativeHandle(ref, () => ({
    getScrollableNode: () => node.current,
    getState: () => ({ data: props.data, scroll: viewport.top, scrollLength: viewport.height,
      contentLength: viewport.content, positionAtIndex: (index: number) => index * 100, sizeAtIndex: () => 100 }),
    scrollToOffset: async ({ offset }: { offset: number }) => { viewport.top = offset; viewport.writes.push(offset); },
    scrollToIndex: async () => {}, scrollToEnd: async () => {},
  }), [props.data]);
  React.useLayoutEffect(() => {
    Object.defineProperties(node.current!, {
      clientHeight: { configurable: true, get: () => viewport.height },
      scrollHeight: { configurable: true, get: () => viewport.content },
      scrollTop: { configurable: true, get: () => viewport.top, set: value => { viewport.top = value; viewport.writes.push(value); } },
    });
    props.onLoad?.({ elapsedTimeInMs: 0 });
  }, []);
  return <div ref={node} onWheelCapture={props.onWheelCapture}>{props.ListFooterComponent as React.ReactNode}</div>;
}) }));
// Exercise the real entry preparation and scroll controller with controlled
// viewport measurements. Rendering message cards is covered by their suites.
vi.mock('./ChatTimelineBlockView', () => ({ ChatTimelineBlockView: () => null }));
vi.mock('./ChatTimelineEntries', () => ({ ChatToolDisclosureScope: ({ children }: React.PropsWithChildren) => children }));
vi.mock('./ToolTargetScope', () => ({ ToolTargetScope: ({ children }: React.PropsWithChildren) => children }));
vi.mock('./ChatContextMenu', () => ({ ChatContextMenu: ({ children }: React.PropsWithChildren) => children }));
vi.mock('./ChatTurnNavigator', () => ({ ChatTurnNavigator: () => null }));
vi.mock('@/components/thread/ThreadContent', () => ({ ThreadContent: () => null }));
vi.mock('@/components/thread/ThreadSkillMaterials', () => ({ ThreadSkillMaterials: () => null }));
vi.mock('@/components/thread/ReviewTransferActions', () => ({ ReviewTransferActions: () => null }));
vi.mock('@/components/thread/ThreadMedia', () => ({ ThreadMedia: () => null }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/extensions/workbench-registry', () => {
  const renderers: [] = [];
  return { useWorkbenchMatchRenderers: () => renderers };
});
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeKey: () => 'scroll-fixture-host', getRuntimeEndpointGeneration: () => 1,
}));

let root: Root, mount: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>, nextFrame: number, time: number;
const frame = () => act(() => {
  time += 16;
  const pending = [...frames.entries()];
  for (const [id, callback] of pending) if (frames.delete(id)) callback(time);
});
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('Event', window.Event); vi.stubGlobal('CustomEvent', window.CustomEvent);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  frames = new Map(); nextFrame = 0; time = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.hasAttribute('data-conversation-timeline-end-space') ? 300 : 600 } as DOMRect;
  });
  viewport.props = null; viewport.initial = []; viewport.writes = [];
  viewport.height = 600; viewport.content = 2000; viewport.top = 1500;
  useTimelineViewStore.setState({ views: {} });
  useUIStore.setState({ chatRenderMode: 'live', promptNavigatorEnabled: false, motionPreference: 'full' });
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount);
});
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('mounts a revisited conversation at its saved reading target, including background work=%s', async working => {
  const identity = { runtime: 'agent' as const, threadId: 'reading-fixture', branchId: 'main' };
  const key = threadComposerKey(threadHostKey(), identity);
  useTimelineViewStore.setState({ views: { [key]: { ...DEFAULT_CHAT_TIMELINE_VIEW,
    observedLeafId: working ? 'old-head' : 'latest', scrollMode: 'free-scrolling',
    viewport: { itemId: 'turn:earlier', mode: 'free-scrolling', offset: -24 } } } });
  const history: ThreadHistoryItem[] = ['earlier', 'latest'].map((id, index) => ({
    id, parent: index ? 'earlier' : null, thread_id: identity.threadId, run_id: id,
    source: 'user', provider: null, content: { text: id },
  }));
  await act(async () => root.render(<ConversationTimeline api={{} as ThreadsAPI} identity={identity}
    history={history} historyReady progress={[]} working={working} cwd="/workspace" onQuote={() => {}} />));
  expect(viewport.initial).toEqual([{ index: 0, viewOffset: -24, viewPosition: 0 }]);
  expect(viewport.writes).toEqual([]);
  expect(useTimelineViewStore.getState().views[key]?.scrollMode).toBe('free-scrolling');
});

const showEnd = async (liveAssistant?: ReturnType<typeof assistant>) => {
  useTimelineViewStore.getState().enter('end-fixture', 'head', Boolean(liveAssistant));
  await act(async () => root.render(<ChatTimeline sessionId="end-fixture" cwd="/workspace"
    entries={[]} leafId="head" toolExecutions={{}} liveAssistant={liveAssistant} />));
};

it('corrects an overshot entry before following and places static layout changes without a spring', async () => {
  await showEnd(assistant('answer', [{ type: 'text', text: 'Saved answer' }], {}, false));
  expect(viewport.initial[0]).toEqual(expect.objectContaining({ viewOffset: 0, viewPosition: 1 }));
  // 2000px content, 600px viewport, 300px footer, and 96px reading gap.
  expect(viewport.writes).toEqual([1196]);
  frame(); viewport.writes = [];
  viewport.content += 240;
  act(() => viewport.props!.onMetricsChange?.({} as never));
  frame();
  expect(viewport.writes).toEqual([1436]);
  frame();
  expect(viewport.writes).toEqual([1436]);
});

it('keeps new streaming output animated and lets an upward gesture interrupt it', async () => {
  const live = assistant('answer', [{ type: 'text', text: 'First words' }], {}, true);
  await showEnd(live); frame();
  viewport.writes = []; viewport.content += 100;
  await act(async () => root.render(<ChatTimeline sessionId="end-fixture" cwd="/workspace"
    entries={[]} leafId="head" toolExecutions={{}} liveAssistant={{ ...live, content: [{ type: 'text', text: 'First words, continuing' }] }} />));
  frame(); frame();
  expect(viewport.top).toBeGreaterThan(1196);
  expect(viewport.top).toBeLessThan(1296);
  const interrupted = viewport.top;
  act(() => {
    const event = new window.Event('wheel', { bubbles: true });
    Object.assign(event, { deltaY: -80, ctrlKey: false }); mount.firstElementChild!.querySelector('div')!.dispatchEvent(event);
  });
  frame(); frame();
  expect(useTimelineViewStore.getState().views['end-fixture']?.scrollMode).toBe('free-scrolling');
  expect(viewport.top).toBe(interrupted);
});

it('retains manually revealed end space when following resumes after entry', async () => {
  await showEnd(); frame();
  viewport.top = 1400; viewport.writes = [];
  act(() => {
    const token = useTimelineViewStore.getState().requestTimelineReturn('end-fixture');
    useTimelineViewStore.getState().completeTimelineReturn('end-fixture', token);
  });
  frame();
  expect(viewport.top).toBe(1400);
  expect(viewport.writes).toEqual([]);
});

it('does not resume following when layout changes put a reader at the end', async () => {
  await showEnd(); frame();
  act(() => useTimelineViewStore.getState().cancelTimelineAutomation('end-fixture'));
  act(() => viewport.props!.onScroll?.({ nativeEvent: {
    contentOffset: { x: 0, y: 1196 }, contentSize: { width: 700, height: 2000 }, layoutMeasurement: { width: 700, height: 600 },
  } } as never));
  expect(useTimelineViewStore.getState().views['end-fixture']?.scrollMode).toBe('free-scrolling');
});

it('keeps manual wheel motion continuous across streaming updates and resumes after a deliberate return', async () => {
  const live = assistant('answer', [{ type: 'text', text: 'First words' }], {}, true);
  await showEnd(live); frame();
  const node = mount.querySelector('[tabindex]') ?? mount.firstElementChild!.querySelector('div')!;
  const wheel = (deltaY: number) => act(() => {
    const event = new window.Event('wheel', { bubbles: true, cancelable: true });
    Object.assign(event, { deltaY, deltaX: 0, deltaMode: 1 }); node.dispatchEvent(event);
  });
  wheel(-5); frame(); frame();
  const before = viewport.top;
  await act(async () => root.render(<ChatTimeline sessionId="end-fixture" cwd="/workspace" entries={[]} leafId="head" toolExecutions={{}}
    liveAssistant={{ ...live, content: [{ type: 'text', text: 'A new reply is arriving' }] }} />));
  frame();
  expect(viewport.top).toBeLessThan(before);
  expect(mount.textContent).toContain('chat.scrollToBottom.newReply');
  wheel(40);
  for (let i = 0; i < 45; i++) frame();
  expect(useTimelineViewStore.getState().views['end-fixture']?.scrollMode).toBe('following-end');
});

it('cancels a long return before relocation when the reader takes over', async () => {
  viewport.content = 20_000;
  await showEnd(); frame();
  act(() => useTimelineViewStore.getState().cancelTimelineAutomation('end-fixture'));
  viewport.top = 300;
  const node = mount.firstElementChild!.querySelector('div')! as HTMLElement;
  let finish!: () => void;
  node.animate = vi.fn(() => ({ finished: new Promise<void>(resolve => { finish = resolve; }), cancel: vi.fn() } as unknown as Animation));
  act(() => mount.querySelector<HTMLElement>('[data-conversation-return-latest]')!.click());
  expect(node.animate).toHaveBeenCalledTimes(1);
  expect(viewport.top).toBe(300);
  act(() => {
    const event = new window.Event('wheel', { bubbles: true });
    Object.assign(event, { deltaY: -4, deltaX: 0, deltaMode: 0 }); node.dispatchEvent(event);
  });
  await act(async () => finish()); frame(); frame();
  expect(viewport.top).toBe(300);
  expect(useTimelineViewStore.getState().views['end-fixture']?.scrollMode).toBe('free-scrolling');
});
