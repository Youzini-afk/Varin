import React from 'react';
import { useEdgeSwipeSessionChat } from '@/apps/useEdgeSwipeSessionSwitch';
import { useThreadStore } from '@/stores/useThreadStore';

/**
 * Mobile scene: a phone-sized chat with the real edge swipe and entrance, over the real thread store
 * with three Threads. The store's Host calls are replaced so navigation resolves locally. Touches come
 * from the check through CDP; `window.__mobile` records the surface's offset and opacity per frame.
 */

const THREADS = ['甲', '乙', '丙'].map((name, index) => ({
  thread_id: `t${index + 1}`, title: `会话 ${name}`, bot_id: null, archived: false, deleted_at_ms: null,
  pinned: false, updated_at_ms: 1_000 - index,
}));

const seed = (): void => {
  useThreadStore.setState({
    threads: THREADS,
    selectedIdentity: { threadId: 't1', branchId: 'main' },
    resolveThread: async (target: { threadId: string }) => ({ identity: { threadId: target.threadId, branchId: 'main' }, botId: null }),
    selectThread: async (identity: { threadId: string; branchId: string }) => { useThreadStore.setState({ selectedIdentity: identity } as never); },
  } as never);
};

interface MobileSample {
  t: number;
  thread: string | null;
  x: number;
  opacity: number;
}

export function MobileLab() {
  React.useState(seed);
  // A desktop browser treats a horizontal edge drag as history navigation; the app's WebViews do not.
  React.useLayoutEffect(() => {
    document.documentElement.style.overscrollBehaviorX = 'none';
    document.body.style.overscrollBehaviorX = 'none';
  }, []);
  const threadId = useThreadStore(state => state.selectedIdentity?.threadId ?? null);
  const main = React.useRef<HTMLElement>(null);
  const surface = React.useRef<HTMLDivElement>(null);
  useEdgeSwipeSessionChat(main, surface, threadId);

  React.useEffect(() => {
    let recording: MobileSample[] | null = null;
    let frame = 0;
    const sample = () => {
      if (recording && surface.current) {
        const style = getComputedStyle(surface.current);
        recording.push({
          t: performance.now(),
          thread: useThreadStore.getState().selectedIdentity?.threadId ?? null,
          x: new DOMMatrixReadOnly(style.transform).m41,
          opacity: Number(style.opacity),
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const lab = {
      record() { recording = []; },
      stopRecording() { const result = recording ?? []; recording = null; return result; },
      thread: () => useThreadStore.getState().selectedIdentity?.threadId ?? null,
      offset: () => surface.current ? new DOMMatrixReadOnly(getComputedStyle(surface.current).transform).m41 : 0,
    };
    (window as unknown as { __mobile: typeof lab }).__mobile = lab;
    return () => cancelAnimationFrame(frame);
  }, []);

  const title = THREADS.find(thread => thread.thread_id === threadId)?.title ?? '';
  return <div className="flex h-full items-center justify-center bg-background text-foreground">
    <div className="flex h-[780px] w-[390px] flex-col overflow-hidden border border-border">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-4 typography-ui-label" data-mobile-title>{title}</header>
      <main ref={main} className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={surface} className="flex h-full w-full flex-col gap-3 p-4" data-mobile-surface>
          {[0, 1, 2].map(turn => (
            <div key={turn} className="flex flex-col gap-2">
              <div className="self-end rounded-2xl bg-interactive-hover px-3 py-2 typography-markdown">{title} 的第 {turn + 1} 个问题</div>
              <div className="typography-markdown text-foreground/90">从屏幕边缘向内滑动切换会话：内容跟手，松手后按速度或距离决定切换或回弹。</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  </div>;
}
