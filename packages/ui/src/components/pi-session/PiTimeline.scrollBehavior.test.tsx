import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiTimelineViewState } from '@/lib/pi-runtime/piTimelineScrollState';
import { PiTimeline } from './PiTimeline';

interface MockLegendProps {
  ListFooterComponent?: React.ReactNode;
  contentContainerClassName?: string;
  onWheelCapture?: (event: { ctrlKey: boolean; deltaY: number }) => void;
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
}));

vi.mock('@legendapp/list/react', () => ({
  LegendList: (props: MockLegendProps) => {
    mocks.legendProps = props;
    return <div>{props.ListFooterComponent}</div>;
  },
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
});
