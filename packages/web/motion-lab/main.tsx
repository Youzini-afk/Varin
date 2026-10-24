import '@varin/ui/styles/application';
import '@varin/ui/styles/fonts';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, initializeLocale } from '@/lib/i18n';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { MotionProvider } from '@/components/providers/MotionProvider';
import { ChatTimeline } from '@/components/conversation/ChatTimeline';
import { ConversationContext, type ConversationPresentation } from '@/components/conversation/ConversationContext';
import { useTimelineViewStore } from '@/components/conversation/timelineViewStore';
import { useUIStore, type MotionPreference } from '@/stores/useUIStore';
import type {
  ChatAssistantContent,
  ChatAssistantMessage,
  ChatSessionEntry,
  ChatSessionMessageEntry,
  ChatUserMessage,
} from '@/components/conversation/types';

/**
 * Motion lab. Real conversation components, fed by simulated streams, so the
 * motion system can be tuned and checked headlessly without a Host or model.
 * `window.__lab` drives scenarios and records per-frame measurements.
 */

const SESSION = 'motion-lab';
const PARAGRAPH = '对话优先的阅读节奏：新的内容在原位生长，视线不被推走。跟随是一根临界阻尼的弹簧，目标只增不减；用户一旦向上滚动，跟随立即让出所有权。';

let sequence = 0;
let previousId: string | null = null;
const at = (offset: number) => new Date(Date.UTC(2026, 9, 24, 8, 0, offset)).toISOString();

const messageEntry = (message: ChatSessionMessageEntry['message'], runId: string): ChatSessionMessageEntry => {
  sequence += 1;
  const entry: ChatSessionMessageEntry = { id: `lab-${sequence}`, parentId: previousId, timestamp: at(sequence), type: 'message', runId, message };
  previousId = entry.id;
  return entry;
};

const assistant = (id: string, content: ChatAssistantContent[], stopReason: ChatAssistantMessage['stopReason'] = 'stop'): ChatAssistantMessage => ({
  id, api: 'lab', content, model: 'lab-model', provider: 'lab', role: 'assistant', stopReason, timestamp: sequence,
});

const history = (turns: number): ChatSessionEntry[] => {
  const entries: ChatSessionEntry[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const runId = `run-${turn}`;
    entries.push(messageEntry({ role: 'user', content: `第 ${turn} 个问题：请说明这一段的动效原则。`, timestamp: sequence }, runId));
    entries.push(messageEntry(assistant(`a-${turn}`, [{ type: 'text', text: `${PARAGRAPH}\n\n${PARAGRAPH}\n\n- 第一条\n- 第二条\n- 第三条` }]), runId));
  }
  return entries;
};

interface FrameSample {
  t: number;
  scrollTop: number;
  /** Top of the tracked message relative to the viewport top. */
  turnTop: number | null;
  /** Content end (top of the end space) relative to the viewport bottom; negative is visible. */
  endGap: number;
  mode: string;
  pill: boolean;
}

interface LabState {
  entries: ChatSessionEntry[];
  liveAssistant?: ChatAssistantMessage;
  liveUser?: ChatUserMessage;
  activeRunId?: string;
}

const scroller = () => document.querySelector<HTMLElement>('[data-conversation-timeline="true"]');

// Every Thread API call resolves to nothing: the lab owns no Host.
const inertApi = new Proxy({}, { get: () => new Proxy(() => Promise.resolve(undefined), { get: () => () => Promise.resolve(undefined) }) });
const presentation: ConversationPresentation = {
  readOnly: true,
  api: inertApi as ConversationPresentation['api'],
  identity: { threadId: SESSION, branchId: 'main' } as ConversationPresentation['identity'],
  head: null,
  toolExecutions: {},
  quote: () => undefined,
  openFile: () => Promise.resolve(),
  fileTarget: () => Promise.reject(new Error('The motion lab has no files.')),
};

// The lab is an entry point, not a module other code imports.
// eslint-disable-next-line react-refresh/only-export-components
function Lab() {
  const [state, setState] = React.useState<LabState>(() => {
    const entries = history(8);
    // As ConversationTimeline does when a Thread opens.
    useTimelineViewStore.getState().enter(SESSION, entries.at(-1)?.id ?? null, false);
    return { entries };
  });
  const stateRef = React.useRef(state);
  stateRef.current = state;

  React.useEffect(() => {
    let recording: FrameSample[] | null = null;
    let trackedTurn: string | null = null;
    let frame = 0;
    const sample = () => {
      const node = scroller();
      const end = document.querySelector<HTMLElement>('[data-conversation-timeline-end-space]');
      if (node && end && recording) {
        const turn = trackedTurn ? document.querySelector<HTMLElement>(`[data-conversation-entry-id="${CSS.escape(trackedTurn)}"]`) : null;
        recording.push({
          t: performance.now(),
          scrollTop: node.scrollTop,
          turnTop: turn ? turn.getBoundingClientRect().top - node.getBoundingClientRect().top : null,
          endGap: end.getBoundingClientRect().top - node.getBoundingClientRect().bottom,
          mode: useTimelineViewStore.getState().views[SESSION]?.scrollMode ?? 'following-end',
          pill: Boolean(document.querySelector('[data-conversation-return-latest]')),
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);

    let timer: ReturnType<typeof setInterval> | undefined;
    const lab = {
      setMotion(preference: MotionPreference) { useUIStore.getState().setMotionPreference(preference); },
      record(turnId: string | null = null) { recording = []; trackedTurn = turnId; },
      stopRecording() { const result = recording ?? []; recording = null; return result; },
      view() { return useTimelineViewStore.getState().views[SESSION]; },
      /** Re-enter the Thread at its end, as reopening it does. */
      enter() { useTimelineViewStore.getState().enter(SESSION, stateRef.current.entries.at(-1)?.id ?? null, false); },
      metrics() {
        const node = scroller();
        return node ? { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight } : null;
      },
      /** Submit a user turn and anchor it, as ThreadConversation does once the Host accepts it. */
      send(text = '新的问题：请继续展开。') {
        const user = messageEntry({ role: 'user', content: text, timestamp: sequence }, `run-send-${sequence}`);
        setState(current => ({ ...current, entries: [...current.entries, user] }));
        useTimelineViewStore.getState().anchor(SESSION, user.id);
        return user.id;
      },
      /** Viewport offset of a message's top edge, for anchoring checks. */
      entryTop(entryId: string) {
        const node = scroller();
        const entry = document.querySelector<HTMLElement>(`[data-conversation-entry-id="${CSS.escape(entryId)}"]`);
        return node && entry ? entry.getBoundingClientRect().top - node.getBoundingClientRect().top : null;
      },
      /**
       * Stream an assistant reply: `cps` characters per second delivered in
       * network-sized chunks every `interval` ms, with an occasional burst.
       */
      stream({ chars = 1600, cps = 120, interval = 48, burstEvery = 0, burst = 360 } = {}) {
        if (timer) clearInterval(timer);
        const runId = `run-live-${Date.now()}`;
        const messageId = `a-live-${runId}`;
        const text = Array.from({ length: Math.ceil(chars / PARAGRAPH.length) + 1 }, () => PARAGRAPH).join('\n\n').slice(0, chars);
        let written = 0;
        let ticks = 0;
        return new Promise<void>((resolve) => {
          timer = setInterval(() => {
            ticks += 1;
            const extra = burstEvery && ticks % burstEvery === 0 ? burst : 0;
            written = Math.min(text.length, written + Math.max(1, Math.round(cps * interval / 1000)) + extra);
            const live = assistant(messageId, [{ type: 'text', text: text.slice(0, written) }], written < text.length ? 'pending' : 'stop');
            if (written < text.length) {
              setState(current => ({ ...current, liveAssistant: live, activeRunId: runId }));
              return;
            }
            clearInterval(timer);
            timer = undefined;
            setState(current => ({ entries: [...current.entries, messageEntry(live, runId)] }));
            resolve();
          }, interval);
        });
      },
    };
    (window as unknown as { __lab: typeof lab }).__lab = lab;
    return () => { cancelAnimationFrame(frame); if (timer) clearInterval(timer); };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col" style={{ width: 760, margin: '0 auto' }}>
        <ConversationContext.Provider value={presentation}>
        <ChatTimeline
          sessionId={SESSION}
          cwd="/workspace/lab"
          entries={state.entries}
          liveAssistant={state.liveAssistant}
          liveUser={state.liveUser}
          activeRunId={state.activeRunId}
          leafId={state.entries.at(-1)?.id ?? null}
          toolExecutions={{}}
        />
        </ConversationContext.Provider>
      </div>
    </div>
  );
}

initializeLocale();
createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <ThemeSystemProvider>
      <ThemeProvider>
        <MotionProvider>
          <Lab />
        </MotionProvider>
      </ThemeProvider>
    </ThemeSystemProvider>
  </I18nProvider>,
);
