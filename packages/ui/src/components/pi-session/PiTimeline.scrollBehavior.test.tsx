import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegendListRef, NativeScrollEvent, NativeSyntheticEvent } from '@legendapp/list/react';
import type { PiTimelineViewState } from '@/lib/pi-runtime/piTimelineScrollState';
import { cancelPiTimelineAutomation, completePiTimelineReturn, requestPiTimelineReturn } from '@/lib/pi-runtime/piTimelineScrollState';
import { PiTimeline } from './PiTimeline';

interface MockLegendProps {
  ListFooterComponent?: React.ReactNode;
  contentContainerClassName?: string;
  maintainScrollAtEnd?: unknown;
  onItemSizeChanged?: (event: { itemKey: string }) => void;
  onLayout?: () => void;
  onLoad?: () => void;
  onMetricsChange?: () => void;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onWheelCapture?: (event: { ctrlKey: boolean; deltaY: number; target?: EventTarget }) => void;
}

interface MockStoreState {
  records: Record<string, {
    view: PiTimelineViewState;
    toolExecutions: Record<string, unknown>;
    assistantOutputDurationsMs: Record<string, number>;
  }>;
  cancelTimelineAutomation: ReturnType<typeof vi.fn>;
  completeTimelineReturn: ReturnType<typeof vi.fn>;
  requestTimelineReturn: ReturnType<typeof vi.fn>;
  saveTimelineCheckpoint: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  legendProps: null as MockLegendProps | null,
  cancelTimelineAutomation: vi.fn(),
  completeTimelineReturn: vi.fn(),
  requestTimelineReturn: vi.fn(() => 1),
  saveTimelineCheckpoint: vi.fn(),
  storeState: null as unknown as MockStoreState,
  listState: { contentLength: 1800, scroll: 1200, scrollLength: 600 },
  scrollToOffset: vi.fn(),
  scrollToEnd: vi.fn(),
  scrollToIndex: vi.fn(),
}));

vi.mock('@legendapp/list/react', () => ({
  LegendList: React.forwardRef<LegendListRef, MockLegendProps>((props, ref) => {
    mocks.legendProps = props;
    React.useImperativeHandle(ref, () => ({
      getState: () => mocks.listState,
      scrollToOffset: mocks.scrollToOffset,
      scrollToEnd: mocks.scrollToEnd,
      scrollToIndex: mocks.scrollToIndex,
      getScrollableNode: () => null,
    } as unknown as LegendListRef));
    return <div>{props.ListFooterComponent}</div>;
  }),
}));

vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: { isMobile: boolean }) => unknown) => selector({ isMobile: false }),
}));
vi.mock('@/stores/usePiSessionStore', () => {
  const hook = <T,>(selector: (state: MockStoreState) => T): T => selector(mocks.storeState);
  hook.getState = () => mocks.storeState;
  return { usePiSessionStore: hook };
});
vi.mock('./PiTimelineEntries', () => ({
  PiTimelineEntryList: () => null,
  PiTurnUserMessage: () => null,
}));
vi.mock('./PiTurnAssistantChrome', () => ({ PiTurnAssistantChrome: () => null }));
vi.mock('./PiTurnUsageFooter', () => ({ PiTurnUsageFooter: () => null }));

describe('PiTimeline scroll ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.legendProps = null;
    mocks.storeState = {
      records: {
        'session-1': {
          view: {
            entry: { epoch: 0, generation: 0, target: { kind: 'end' } },
            generation: 0,
            scrollMode: 'following-end',
          },
          toolExecutions: {},
          assistantOutputDurationsMs: {},
        },
      },
      cancelTimelineAutomation: mocks.cancelTimelineAutomation,
      completeTimelineReturn: mocks.completeTimelineReturn,
      requestTimelineReturn: mocks.requestTimelineReturn,
      saveTimelineCheckpoint: mocks.saveTimelineCheckpoint,
    };
  });

  const renderTimeline = (rightSafeInset = false) => renderToStaticMarkup(
    <PiTimeline
      cwd="/workspace"
      entries={[]}
      rightSafeInset={rightSafeInset}
      sessionId="session-1"
      toolExecutions={{}}
    />,
  );

  it('keeps following when the user wheels farther down at the live edge', () => {
    renderTimeline();
    const onWheelCapture = mocks.legendProps?.onWheelCapture as ((event: { ctrlKey: boolean; deltaY: number }) => void);
    expect(onWheelCapture).toBeTypeOf('function');

    onWheelCapture({ ctrlKey: false, deltaY: 120 });
    expect(mocks.cancelTimelineAutomation).not.toHaveBeenCalled();

    onWheelCapture({ ctrlKey: false, deltaY: -120 });
    expect(mocks.cancelTimelineAutomation).toHaveBeenCalledTimes(1);
  });

  it('renders a real desktop footer spacer so the latest turn can rest above the composer', () => {
    const markup = renderTimeline();
    expect(markup).toContain('data-pi-timeline-end-space="true"');
    expect(markup).toContain('42dvh');
  });

  it('shows a submitted compaction in the scrolling conversation before the end spacer', () => {
    const markup = renderToStaticMarkup(
      <PiTimeline cwd="/workspace" entries={[]} sessionId="session-1" toolExecutions={{}}
        compactionStatus="running" onOpenCompaction={() => undefined} />,
    );
    expect(markup).toContain('chat.compaction.inProgress');
    expect(markup.indexOf('chat.compaction.inProgress')).toBeLessThan(markup.indexOf('data-pi-timeline-end-space'));
  });

  it('reserves a temporary desktop safe area while the floating work overview is open', () => {
    renderTimeline(true);
    expect(mocks.legendProps?.contentContainerClassName).toContain('xl:pr-[24rem]');
    expect(mocks.legendProps?.contentContainerClassName).toContain('duration-200');
  });

  describe('streaming follow', () => {
    let container: HTMLDivElement;
    let root: Root;
    let frames: Map<number, FrameRequestCallback>;
    beforeEach(async () => {
      const { document, window } = parseHTML('<html><body></body></html>');
      vi.stubGlobal('document', document);
      vi.stubGlobal('window', window);
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      frames = new Map();
      let nextFrame = 0;
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
      mocks.listState = { contentLength: 1800, scroll: 1200, scrollLength: 600 };
      mocks.scrollToOffset.mockImplementation(({ offset }: { offset: number }) => {
        mocks.listState.scroll = offset;
        return Promise.resolve();
      });
      mocks.scrollToEnd.mockResolvedValue(undefined);
      mocks.cancelTimelineAutomation.mockImplementation(() => {
        const record = mocks.storeState.records['session-1']!;
        record.view = cancelPiTimelineAutomation(record.view);
      });
      mocks.requestTimelineReturn.mockImplementation(() => {
        const record = mocks.storeState.records['session-1']!;
        const requested = requestPiTimelineReturn(record.view);
        record.view = requested.view;
        return requested.token;
      });
      mocks.completeTimelineReturn.mockImplementation((_sessionId: string, token: number) => {
        const record = mocks.storeState.records['session-1']!;
        record.view = completePiTimelineReturn(record.view, token)!;
      });
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      await render();
      const spacer = container.querySelector<HTMLDivElement>('[data-pi-timeline-end-space]')!;
      spacer.getBoundingClientRect = () => ({ height: 300 } as DOMRect);
      await act(async () => mocks.legendProps!.onLoad!());
    });
    afterEach(async () => {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    });
    const render = async () => act(async () => root.render(
      <PiTimeline cwd="/workspace" entries={[]} sessionId="session-1" toolExecutions={{}} />,
    ));
    const flush = async () => act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    });
    const resizeContent = async (height: number) => {
      mocks.listState.contentLength = height;
      mocks.legendProps!.onItemSizeChanged!({ itemKey: 'streaming-turn' });
      await render();
      await flush();
    };

    it('keeps a manually revealed gap stationary until the response reaches the content edge', async () => {
      expect(mocks.legendProps!.maintainScrollAtEnd).toBe(false);
      await resizeContent(2000);
      expect(mocks.scrollToOffset).not.toHaveBeenCalled();
      expect(mocks.scrollToEnd).not.toHaveBeenCalled();
      await resizeContent(2150);
      expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1250 });
      await resizeContent(2250);
      expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1350 });
      expect(mocks.scrollToEnd).not.toHaveBeenCalled();
    });

    it('keeps following when scrolling down from the content edge into the spacer', async () => {
      mocks.legendProps!.onScroll!({ nativeEvent: {
        contentOffset: { y: 900 }, contentSize: { height: 1800 }, layoutMeasurement: { height: 600 },
      } } as NativeSyntheticEvent<NativeScrollEvent>);
      mocks.legendProps!.onWheelCapture!({ ctrlKey: false, deltaY: 120 });
      expect(mocks.cancelTimelineAutomation).not.toHaveBeenCalled();
      mocks.legendProps!.onWheelCapture!({ ctrlKey: false, deltaY: -120 });
      expect(mocks.cancelTimelineAutomation).toHaveBeenCalledOnce();
      mocks.storeState.records['session-1']!.view.scrollMode = 'free-scrolling';
      await resizeContent(2400);
      expect(mocks.scrollToOffset).not.toHaveBeenCalled();
    });

    it('lets an overflowing file preview own wheel navigation without cancelling conversation following', () => {
      vi.stubGlobal('HTMLElement', window.HTMLElement);
      const preview = document.createElement('div');
      preview.setAttribute('data-pi-file-scroll', 'true');
      Object.defineProperties(preview, { scrollHeight: { value: 440, configurable: true }, clientHeight: { value: 176 } });
      const line = document.createElement('span');
      preview.append(line);
      mocks.legendProps!.onWheelCapture!({ ctrlKey: false, deltaY: -120, target: line });
      expect(mocks.cancelTimelineAutomation).not.toHaveBeenCalled();
      // Short previews do not consume page scrolling.
      Object.defineProperty(preview, 'scrollHeight', { value: 44 });
      mocks.legendProps!.onWheelCapture!({ ctrlKey: false, deltaY: -120, target: line });
      expect(mocks.cancelTimelineAutomation).toHaveBeenCalledOnce();
    });

    it('follows footer content and viewport resizes without restoring the spacer gap', async () => {
      mocks.listState.scroll = 900;
      mocks.listState.contentLength += 60;
      mocks.legendProps!.onMetricsChange!();
      await flush();
      expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 960 });
      mocks.listState.scrollLength = 500;
      mocks.legendProps!.onLayout!();
      await flush();
      expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1060 });
    });

    it('resumes following from manual end space without scrolling backward or toward the physical end', async () => {
      mocks.cancelTimelineAutomation('session-1');
      await render();
      mocks.legendProps!.onScroll!({ nativeEvent: {
        contentOffset: { y: 1200 }, contentSize: { height: 1800 }, layoutMeasurement: { height: 600 },
      } } as NativeSyntheticEvent<NativeScrollEvent>);
      await render();
      await flush();
      expect(mocks.storeState.records['session-1']!.view.scrollMode).toBe('following-end');
      expect(mocks.scrollToOffset).not.toHaveBeenCalled();
      expect(mocks.scrollToEnd).not.toHaveBeenCalled();
      await resizeContent(2150);
      expect(mocks.scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1250 });
    });

    it('applies another session’s saved reading position even when its entry epoch matches', async () => {
      mocks.storeState.records['session-2'] = {
        toolExecutions: {}, assistantOutputDurationsMs: {},
        view: {
          generation: 0, scrollMode: 'free-scrolling',
          entry: { epoch: 0, generation: 0, target: { kind: 'turn', itemId: 'turn:other-user', offset: -40 } },
        },
      };
      await act(async () => root.render(
        <PiTimeline cwd="/workspace" sessionId="session-2" toolExecutions={{}} entries={[{
          id: 'other-user', type: 'message', parentId: null, timestamp: '1',
          message: { role: 'user', content: 'Earlier question', timestamp: 1 },
        }]} />,
      ));
      expect(mocks.scrollToIndex).toHaveBeenCalledWith({ animated: false, index: 0, viewOffset: -40, viewPosition: 0 });
    });

    it('lets the user apply a ready summary and removes the action while application is pending', async () => {
      const apply = vi.fn();
      const renderSummary = (status: 'ready' | 'applying') => act(async () => root.render(
        <PiTimeline cwd="/workspace" sessionId="session-1" entries={[]} toolExecutions={{}}
          compactionStatus={status} onApplyCompaction={apply} />,
      ));
      await renderSummary('ready');
      const button = [...container.querySelectorAll('button')].find(node => node.textContent === 'chat.compaction.applyNow');
      expect(button).toBeDefined();
      await act(async () => button!.click());
      expect(apply).toHaveBeenCalledOnce();
      await renderSummary('applying');
      expect([...container.querySelectorAll('button')].some(node => node.textContent === 'chat.compaction.applyNow')).toBe(false);
      expect(container.textContent).toContain('chat.compaction.applying');
    });
  });
});
