import React from 'react';
import { ChatTimeline } from '@/components/conversation/ChatTimeline';
import { ConversationContext, type ConversationPresentation } from '@/components/conversation/ConversationContext';
import { ConversationSurface } from '@/components/conversation/ConversationSurface';
import { useTimelineViewStore } from '@/components/conversation/timelineViewStore';
import type { ChatSessionEntry, ChatSessionMessageEntry } from '@/components/conversation/types';
import { SwapText } from '@/components/motion/SwapText';
import { noteSwitchDirection, recentSwitchDirection } from '@/lib/motion/switchDirection';

/**
 * Switch scene: three conversations in the real surface and timeline, with a
 * title above. `window.__switch.go(id, direction)` switches as the sidebar
 * does, and frames record the leaving scene, the arriving turns and the title.
 */

const SESSIONS = ['甲', '乙', '丙'];
let sequence = 0;
const conversation = (name: string): ChatSessionEntry[] => {
  let parentId: string | null = null;
  return Array.from({ length: 4 }, (_, turn) => {
    const pair: ChatSessionMessageEntry[] = [];
    for (const role of ['user', 'assistant'] as const) {
      sequence += 1;
      const message = role === 'user'
        ? { role, content: `${name} 的第 ${turn + 1} 个问题`, timestamp: sequence }
        : { id: `a-${name}-${turn}`, api: 'lab', model: 'lab', provider: 'lab', role, stopReason: 'stop' as const, timestamp: sequence,
          content: [{ type: 'text' as const, text: `${name} 的回答 ${turn + 1}：会话切换时，旧内容向列表移动的反方向淡出，新内容按回合依次进入。` }] };
      const entry: ChatSessionMessageEntry = { id: `${name}-${sequence}`, parentId, timestamp: new Date(Date.UTC(2026, 9, 24, 10, 0, sequence)).toISOString(), type: 'message', runId: `run-${name}-${turn}`, message: message as ChatSessionMessageEntry['message'] };
      parentId = entry.id;
      pair.push(entry);
    }
    return pair;
  }).flat();
};
const HISTORY = Object.fromEntries(SESSIONS.map(name => [name, conversation(name)]));

const inertApi = new Proxy({}, { get: () => new Proxy(() => Promise.resolve(undefined), { get: () => () => Promise.resolve(undefined) }) });
const presentationFor = (session: string): ConversationPresentation => ({
  readOnly: true, api: inertApi as ConversationPresentation['api'],
  identity: { threadId: session, branchId: 'main' } as ConversationPresentation['identity'],
  head: null, toolExecutions: {}, quote: () => undefined, openFile: () => Promise.resolve(),
  fileTarget: () => Promise.reject(new Error('The motion lab has no files.')),
});

interface SwitchSample {
  t: number;
  leaving: { opacity: number; y: number } | null;
  turns: number[];
  title: { current: number; leaving: number | null };
}

export function SwitchLab() {
  const [session, setSession] = React.useState(SESSIONS[0]);
  React.useState(() => { for (const name of SESSIONS) useTimelineViewStore.getState().enter(`switch:${name}`, HISTORY[name].at(-1)!.id, false); });
  const presentation = React.useMemo(() => presentationFor(session), [session]);

  React.useEffect(() => {
    let recording: SwitchSample[] | null = null;
    let frame = 0;
    const sample = () => {
      if (recording) {
        const leaving = document.querySelector<HTMLElement>('.conversation-scene[aria-hidden="true"]');
        const current = document.querySelector<HTMLElement>('.conversation-scene:not([aria-hidden="true"])');
        const title = document.querySelector<HTMLElement>('[data-lab-title]');
        const matrix = leaving ? new DOMMatrixReadOnly(getComputedStyle(leaving).transform) : null;
        recording.push({
          t: performance.now(),
          leaving: leaving ? { opacity: Number(getComputedStyle(leaving).opacity), y: matrix?.m42 ?? 0 } : null,
          turns: current ? [...current.querySelectorAll<HTMLElement>('[data-turn-id]')].map(block => Number(getComputedStyle(block).opacity)) : [],
          title: {
            current: title?.querySelector('.swap-text-current')?.getBoundingClientRect().top ?? 0,
            leaving: title?.querySelector('[data-swap-leaving]')?.getBoundingClientRect().top ?? null,
          },
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const lab = {
      record() { recording = []; },
      stopRecording() { const result = recording ?? []; recording = null; return result; },
      go(next: string, direction: number) { noteSwitchDirection(direction); setSession(next); },
    };
    (window as unknown as { __switch: typeof lab }).__switch = lab;
    return () => cancelAnimationFrame(frame);
  }, []);

  return <div className="flex h-full flex-col bg-background text-foreground">
    <header className="flex h-11 shrink-0 items-center border-b border-border px-4" data-lab-title>
      <SwapText text={`会话 ${session}`} hold={0} direction={recentSwitchDirection() === -1 ? -1 : 1} className="typography-ui-label text-[14px]" />
    </header>
    <div className="relative flex min-h-0 flex-1" style={{ width: 760, margin: '0 auto' }}>
      <ConversationSurface owner="lab" identity={session} ready loadingLabel="…">
        <ConversationContext.Provider value={presentation}>
          <ChatTimeline key={session} sessionId={`switch:${session}`} cwd="/workspace/lab" entries={HISTORY[session]} leafId={HISTORY[session].at(-1)!.id} toolExecutions={{}} />
        </ConversationContext.Provider>
      </ConversationSurface>
    </div>
  </div>;
}
