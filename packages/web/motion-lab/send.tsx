import React from 'react';
import { ChatTimeline } from '@/components/conversation/ChatTimeline';
import { ConversationContext, type ConversationPresentation } from '@/components/conversation/ConversationContext';
import { MessageHandoff } from '@/components/conversation/messageHandoff';
import { useTimelineViewStore } from '@/components/conversation/timelineViewStore';
import type { ChatAssistantMessage, ChatSessionEntry, ChatSessionMessageEntry } from '@/components/conversation/types';
import type { ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { Departure } from '@/components/motion/Departure';
import { ThreadComposer } from '@/components/thread/ThreadComposer';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';
import { useUIStore, type MotionPreference } from '@/stores/useUIStore';

/**
 * Send scene: the empty home, the real composer and timeline laid out as
 * ThreadConversation lays them out, and a simulated Host round trip. Covers
 * the title and starters leaving, composer docking, the height glide, the
 * button icon swaps and the message flying into its bubble.
 */

const SESSION = 'motion-lab-send';
const REPLY = '好的。新的回合锚定在顶部，回复在下面生长；输入框已经停靠，发送按钮换成了停止。等回复写完，停止再换回箭头。';
const STARTERS = ['了解这个项目', '接续项目进展', '比较可选方案', '规划新功能', '创建持续任务', '安排计划任务', '排查问题', '审查当前改动'];

let sequence = 0;
let previousId: string | null = null;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const entry = (message: ChatSessionMessageEntry['message'], runId: string): ChatSessionMessageEntry => {
  sequence += 1;
  const next: ChatSessionMessageEntry = { id: `send-${sequence}`, parentId: previousId, timestamp: new Date(Date.UTC(2026, 9, 24, 9, 0, sequence)).toISOString(), type: 'message', runId, message };
  previousId = next.id;
  return next;
};
const reply = (id: string, text: string, done: boolean): ChatAssistantMessage => ({
  id, api: 'lab', content: [{ type: 'text', text }], model: 'lab-model', provider: 'lab', role: 'assistant', stopReason: done ? 'stop' : 'pending', timestamp: sequence,
});

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

interface SendSample {
  t: number;
  /** The composer input frame; `gliding` while the height glide holds it. */
  frame: { top: number; height: number; gliding: boolean } | null;
  /** The real heading, not a departing copy. */
  title: boolean;
  /** Departing copies and the mean opacity of what is still visible in them. */
  copies: number;
  copyOpacity: number;
  overlay: { left: number; top: number; width: number; height: number } | null;
  bubble: { left: number; top: number; width: number; height: number; opacity: string } | null;
  icon: string;
  leavingIcons: number;
}

const rectOf = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
};

export function SendLab() {
  const [handoff] = React.useState(() => new MessageHandoff());
  const reduced = usePrefersReducedMotion();
  React.useLayoutEffect(() => { handoff.select('lab', SESSION, true, reduced); }, [handoff, reduced]);
  React.useState(() => useTimelineViewStore.getState().enter(SESSION, null, false));
  const [text, setText] = React.useState('');
  const [entries, setEntries] = React.useState<ChatSessionEntry[]>([]);
  const [pending, setPending] = React.useState(false);
  const [liveAssistant, setLiveAssistant] = React.useState<ChatAssistantMessage>();
  const [activeRunId, setActiveRunId] = React.useState<string>();
  const editor = React.useRef<ComposerEditorHandle | null>(null);
  const textRef = React.useRef(text);
  textRef.current = text;
  const options = React.useRef({ deliveryMs: 160, replyMs: 2200 });
  const empty = !entries.length && !pending && !activeRunId;

  React.useEffect(() => {
    let recording: SendSample[] | null = null;
    let frame = 0;
    const sample = () => {
      if (recording) {
        const input = document.querySelector('[data-conversation-composer-input-frame]');
        const copies = [...document.querySelectorAll<HTMLElement>('[data-departing]')];
        const parts = copies.flatMap(copy => {
          const chips = [...copy.querySelectorAll<HTMLElement>('.oc-draft-starters > *')];
          return chips.length ? chips : [copy];
        });
        const overlay = document.querySelector('.conversation-message-handoff');
        // The bubble is the message's first child; its actions row follows it.
        const bubble = [...document.querySelectorAll<HTMLElement>('[data-conversation-timeline="true"] [data-conversation-user-message]')].at(-1)?.querySelector<HTMLElement>(':scope > div');
        const button = document.querySelector('[data-conversation-composer-primary-action]');
        recording.push({
          t: performance.now(),
          frame: input instanceof HTMLElement ? { top: input.getBoundingClientRect().top, height: input.getBoundingClientRect().height, gliding: Boolean(input.style.height) } : null,
          title: Boolean(document.querySelector('h1')),
          copies: copies.length,
          copyOpacity: parts.length ? parts.reduce((sum, part) => sum + Number(getComputedStyle(part).opacity), 0) / parts.length : 0,
          overlay: overlay ? rectOf(overlay) : null,
          bubble: bubble ? { ...rectOf(bubble), opacity: bubble.style.opacity } : null,
          icon: button?.querySelector('.swap-icon-current use')?.getAttribute('href')?.replace('#oc-', '') ?? '',
          leavingIcons: button?.querySelectorAll('[data-swap-leaving]').length ?? 0,
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const lab = {
      setMotion(preference: MotionPreference) { useUIStore.getState().setMotionPreference(preference); },
      configure(next: Partial<typeof options.current>) { Object.assign(options.current, next); },
      record() { recording = []; },
      stopRecording() { const result = recording ?? []; recording = null; return result; },
      busy() { return Boolean(document.querySelector('[data-conversation-composer-primary-action="stop"]')); },
    };
    (window as unknown as { __send: typeof lab }).__send = lab;
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = textRef.current;
    if (!value.trim() || pending || activeRunId) return;
    // As ThreadConversation: capture the composer, then wait for the Host to accept.
    const source = handoff.captureDraft();
    setPending(true);
    void (async () => {
      await sleep(options.current.deliveryMs);
      const runId = `run-send-${sequence + 1}`;
      const user = entry({ role: 'user', content: value, timestamp: sequence }, runId);
      setText(current => (current === value ? '' : current));
      setEntries(current => [...current, user]);
      setPending(false);
      setActiveRunId(runId);
      useTimelineViewStore.getState().anchor(SESSION, user.id);
      handoff.submit(user.id, SESSION, source);
      handoff.accepted(user.id, user.id);
      const id = `reply-${runId}`;
      const started = performance.now();
      for (;;) {
        const progress = Math.min(1, (performance.now() - started) / options.current.replyMs);
        const shown = REPLY.slice(0, Math.max(1, Math.round(REPLY.length * progress)));
        if (progress >= 1) break;
        setLiveAssistant(reply(id, shown, false));
        await sleep(48);
      }
      setLiveAssistant(undefined);
      setEntries(current => [...current, entry(reply(id, REPLY, true), runId)]);
      setActiveRunId(undefined);
    })();
  };

  const noop = () => undefined;
  return <section ref={handoff.setRoot} className="regular-chat-view relative flex h-full min-h-0 min-w-0 bg-background text-foreground [container-type:inline-size]" aria-label="Send lab">
    <div className="thread-conversation-layout relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={cn('relative flex min-h-0 flex-1', empty && 'hidden')}>
          <ConversationContext.Provider value={presentation}>
            <ChatTimeline sessionId={SESSION} cwd="/workspace/lab" entries={entries} liveAssistant={liveAssistant}
              activeRunId={activeRunId} leafId={entries.at(-1)?.id ?? null} toolExecutions={{}} />
          </ConversationContext.Provider>
        </div>
        {empty && <div className="min-h-6 flex-1" />}
        <div className="thread-composer-stack shrink-0 space-y-5 pb-4">
          <Departure present={empty} animated={pending} exit="rise" className="chat-input-column flex flex-col items-center gap-5 pb-1 text-center">
            <VarinLogo width={24} height={24} decorative className="text-muted-foreground" />
            <h1 className="text-2xl font-medium tracking-tight text-foreground md:text-3xl">我们要在 lab 中做什么？</h1>
          </Departure>
          <form className="space-y-2" onSubmit={submit}>
            <ThreadComposer editorRef={editor} value={text} onChange={setText} identityKey={SESSION} placement={empty ? 'center' : 'bottom'}
              models={[]} providerId="" modelId="" thinkingLevel="off" onModelChange={noop}
              modelDisabled={false} attachmentDisabled={false} imageDisabled={false} sendDisabled={!text.trim() || pending}
              pending={pending} active={Boolean(activeRunId)} retrying={false} delivery="boundary" onDeliveryChange={noop} allowNextRun={false}
              onFiles={noop} onAttachImages={noop} onAttachPdfs={noop} onGoal={noop} onStop={activeRunId ? noop : undefined}
              hasInput={Boolean(text.trim())} onWorkspace={noop} workspaceLabel="lab" attachmentNames={[]} skills={[]} />
          </form>
          <Departure present={empty} animated={pending} exit="sink" stagger=".oc-draft-starters > *" className="conversation-starters">
            <div className="oc-draft-starters mx-auto flex max-w-3xl flex-wrap items-center justify-center gap-2">
              {STARTERS.map(label => <button key={label} type="button" className="draft-starter-trigger rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground">{label}</button>)}
            </div>
          </Departure>
        </div>
        {empty && <div className="min-h-6 flex-1" />}
      </div>
    </div>
  </section>;
}
