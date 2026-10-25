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
import { TooltipProvider } from '@/components/ui/tooltip';
import { SendLab } from './send';
import { SidebarLab } from './sidebar';
import { RailLab } from './rail';
import { SwitchLab } from './switch';
import type {
  ChatAssistantContent,
  ChatAssistantMessage,
  ChatSessionEntry,
  ChatSessionMessageEntry,
  ChatToolExecutionState,
  ChatUserMessage,
} from '@/components/conversation/types';

/**
 * Motion lab. Real conversation components, fed by simulated streams, so the
 * motion system can be tuned and checked headlessly without a Host or model.
 * `window.__lab` drives scenarios and records per-frame measurements.
 */

const SESSION = 'motion-lab';
const PARAGRAPH = '对话优先的阅读节奏：新的内容在原位生长，视线不被推走。跟随是一根临界阻尼的弹簧，目标只增不减；用户一旦向上滚动，跟随立即让出所有权。';
/** Formatted Markdown: emphasis, inline code, a link, a list and a code fence. */
const RICH = [
  '修复放在 **`thread-adapter.ts`** 的 `retainFrozenChildModels`：重新绑定时保留子 Run 冻结的模型集合，详见 [设计文档](https://example.com/design)。',
  '- 第一步：读取冻结的模型集合\n- 第二步：按 *原始所有者* 重新绑定\n- 第三步：写回检索上下文',
  '```ts\nexport function retainFrozenChildModels(run: Run): ModelSet {\n  const frozen = run.child?.models ?? [];\n  return new ModelSet(frozen.filter((model) => model.owner === run.id));\n}\n```',
  PARAGRAPH,
].join('\n\n');

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
  /** Paths of the cards in the folded row's tray, and the tray's height. */
  tray: string[];
  trayHeight: number;
  /** The last file change card: phase, name, visible rows, remounted rows, ghosts. */
  card: {
    phase: string;
    name: string;
    rows: Array<{ key: string; kind: string; top: number; bottom: number; opacity: number; pending: boolean; ahead: boolean; caret: boolean }>;
    remounts: number;
    ghosts: number;
    height: number;
  } | null;
  /** The last process row's label: identity, text, running state, leaving layers. */
  activity: { id: number; text: string; title: string; live: boolean; leaving: number; spinner: boolean } | null;
  /** Lines of a code fence still streaming, and how many of them have colour. */
  openFenceLines: number;
  openFenceColoured: number;
  /** Rendered text length of the last Markdown block in the timeline. */
  shown: number;
  /** Ink spans developing in it, and the end dot's state. */
  ink: number;
  caret: string | null;
  caretLast: boolean;
  caretWhere: string | null;
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
  executions: Record<string, ChatToolExecutionState>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let labelIds = 0;
const labelIdentity = new WeakMap<Element, number>();
// Diff rows by key: a key that comes back on a new element was remounted.
const rowElements = new Map<string, Element>();
let previousRowKeys = new Set<string>();
let rowRemounts = 0;

const scroller = () => document.querySelector<HTMLElement>('[data-conversation-timeline="true"]');

// Every Thread API call resolves to nothing: the lab owns no Host.
const inertApi = new Proxy({}, { get: () => new Proxy(() => Promise.resolve(undefined), { get: () => () => Promise.resolve(undefined) }) });
const presentationFor = (toolExecutions: Record<string, ChatToolExecutionState>): ConversationPresentation => ({
  readOnly: true,
  api: inertApi as ConversationPresentation['api'],
  identity: { threadId: SESSION, branchId: 'main' } as ConversationPresentation['identity'],
  head: null,
  toolExecutions,
  quote: () => undefined,
  openFile: () => Promise.resolve(),
  fileTarget: () => Promise.reject(new Error('The motion lab has no files.')),
});

// The lab is an entry point, not a module other code imports.
// eslint-disable-next-line react-refresh/only-export-components
function Lab() {
  const [state, setState] = React.useState<LabState>(() => {
    const entries = history(8);
    // As ConversationTimeline does when a Thread opens.
    useTimelineViewStore.getState().enter(SESSION, entries.at(-1)?.id ?? null, false);
    return { entries, executions: {} };
  });
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const presentation = React.useMemo(() => presentationFor(state.executions), [state.executions]);

  React.useEffect(() => {
    let recording: FrameSample[] | null = null;
    let trackedTurn: string | null = null;
    let frame = 0;
    const sample = () => {
      const node = scroller();
      const end = document.querySelector<HTMLElement>('[data-conversation-timeline-end-space]');
      if (node && end && recording) {
        const turn = trackedTurn ? document.querySelector<HTMLElement>(`[data-conversation-entry-id="${CSS.escape(trackedTurn)}"]`) : null;
        const markdown = [...node.querySelectorAll<HTMLElement>('[data-markdown-content]')].at(-1);
        const caret = markdown?.querySelector<HTMLElement>('.markdown-caret');
        const openFence = markdown?.querySelector<HTMLElement>('pre:not([data-md-lang]) > code[class*="language-"]');
        const card = [...node.querySelectorAll<HTMLElement>('[data-conversation-file-preview]')].at(-1);
        const rows = card ? [...card.querySelectorAll<HTMLElement>('[data-row-key]')].filter(row => !row.closest('[aria-hidden="true"]')) : [];
        // A key present in consecutive samples on a different element was remounted.
        const present = new Set<string>();
        for (const row of rows) {
          const key = row.dataset.rowKey!;
          const known = rowElements.get(key);
          if (known && known !== row && previousRowKeys.has(key)) rowRemounts += 1;
          rowElements.set(key, row);
          present.add(key);
        }
        previousRowKeys = present;
        const activity = [...node.querySelectorAll<HTMLElement>('.dialogue-activity-label')].at(-1);
        if (activity && !labelIdentity.has(activity)) labelIdentity.set(activity, ++labelIds);
        const swap = activity?.querySelector('.swap-text');
        if (swap && !labelIdentity.has(swap)) labelIdentity.set(swap, ++labelIds);
        const tray = [...node.querySelectorAll<HTMLElement>('[data-conversation-file-tray]')].at(-1);
        recording.push({
          tray: tray ? [...tray.querySelectorAll<HTMLElement>('[data-conversation-file-preview]')].map(preview => preview.getAttribute('data-conversation-file-preview') || '?') : [],
          trayHeight: tray?.getBoundingClientRect().height ?? 0,
          card: card ? {
            phase: card.dataset.phase ?? '',
            name: card.querySelector('header .swap-text-current')?.textContent ?? '',
            rows: rows.map(row => {
              const rect = row.getBoundingClientRect();
              return { key: row.dataset.rowKey!, kind: row.dataset.changeKind!, top: rect.top, bottom: rect.bottom, opacity: Number(getComputedStyle(row).opacity), pending: row.hasAttribute('data-pending'), ahead: row.hasAttribute('data-ahead'), caret: Boolean(row.querySelector('.workbench-diff-caret')) };
            }),
            remounts: rowRemounts,
            ghosts: card.querySelectorAll('[aria-hidden="true"] > [data-row-key]').length,
            height: card.querySelector<HTMLElement>('[data-conversation-tool-scroll]')?.getBoundingClientRect().height ?? 0,
          } : null,
          activity: activity ? {
            id: labelIdentity.get(activity)!,
            text: activity.querySelector('.swap-text-current')?.textContent ?? '',
            live: Boolean(activity.querySelector('.swap-text[data-live]')),
            leaving: activity.querySelectorAll('[data-swap-leaving]').length,
            title: `${activity.getAttribute('title') ?? ''} #${swap ? labelIdentity.get(swap) : '-'}`,
            spinner: Boolean(activity.querySelector('.animate-spin')),
          } : null,
          openFenceLines: openFence?.querySelectorAll(':scope > .line').length ?? 0,
          openFenceColoured: openFence ? [...openFence.querySelectorAll(':scope > .line')].filter(line => line.querySelector('[style*="color"]')).length : 0,
          shown: markdown?.textContent?.length ?? 0,
          ink: markdown?.querySelectorAll('.markdown-ink').length ?? 0,
          caret: caret?.dataset.state ?? null,
          caretLast: Boolean(caret && markdown && (() => {
            // Nothing but whitespace or controls may follow the dot.
            const range = document.createRange();
            range.setStartAfter(caret);
            range.setEnd(markdown, markdown.childNodes.length);
            const after = range.cloneContents();
            after.querySelectorAll('button, svg, [aria-hidden="true"]').forEach(node => node.remove());
            return !after.textContent?.trim();
          })()),
          caretWhere: caret ? `${caret.parentElement?.tagName}.${caret.parentElement?.className}|next=${caret.nextSibling?.nodeName}:${(caret.nextSibling?.textContent ?? '').slice(0, 12)}|prev=${(caret.previousSibling?.textContent ?? '').slice(-8)}` : null,
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
      /**
       * A reply with a conversation-first process row: thinking, three quick
       * tools, then the spoken answer. `pace` stretches every step.
       */
      async process({ pace = 1 } = {}) {
        const runId = `run-process-${Date.now()}`;
        let step = 0;
        // Each model step streams live, then persists; tools run between steps
        // and report through their own result entries, as the Host delivers them.
        const live = (id: string, content: ChatAssistantContent[]) => setState(current => ({
          ...current, activeRunId: runId, liveAssistant: assistant(id, content.map(part => ({ ...part })), 'pending'),
        }));
        const persist = (id: string, content: ChatAssistantContent[], stopReason: ChatAssistantMessage['stopReason']) => setState(current => ({
          ...current, liveAssistant: undefined, entries: [...current.entries, messageEntry(assistant(id, content, stopReason), runId)],
        }));
        const execute = (callId: string, name: string, args: Record<string, string>, status: ChatToolExecutionState['status']) => setState(current => ({
          ...current, executions: { ...current.executions, [callId]: { toolCallId: callId, name, args, status } },
        }));
        const report = (callId: string, name: string) => setState(current => ({
          ...current, entries: [...current.entries, messageEntry({ role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: sequence }, runId)],
        }));
        const thought = '先确认刷新令牌在哪里被丢弃，再看会话恢复是否复用了旧的绑定。';
        const tools: Array<[string, string, Record<string, string>, number]> = [
          ['read-1', 'file_read', { path: 'src/auth/login.ts' }, 420],
          ['search-1', 'file_search', { pattern: 'refreshToken' }, 160],
          ['read-2', 'file_read', { path: 'src/auth/session.ts' }, 120],
        ];
        for (const [index, [callId, name, args, duration]] of tools.entries()) {
          const id = `a-process-${runId}-${step += 1}`;
          const content: ChatAssistantContent[] = [];
          if (index === 0) {
            for (let length = 2; length <= thought.length; length += 2) {
              content[0] = { type: 'thinking', id: `${id}:thinking`, thinking: thought.slice(0, length) };
              live(id, content);
              await sleep(40 * pace);
            }
          }
          content.push({ type: 'toolCall', id: callId, name, arguments: args });
          live(id, content);
          await sleep(60 * pace);
          persist(id, content, 'toolUse');
          execute(callId, name, args, 'running');
          await sleep(duration * pace);
          execute(callId, name, args, 'success');
          report(callId, name);
          await sleep(40 * pace);
        }
        const id = `a-process-${runId}-${step + 1}`;
        const answer = '根因在会话恢复：它复用了旧的绑定，刷新令牌因此被丢弃。';
        for (let length = 2; length <= answer.length; length += 2) {
          live(id, [{ type: 'text', id: `${id}:text`, text: answer.slice(0, length) }]);
          await sleep(60 * pace);
        }
        persist(id, [{ type: 'text', id: `${id}:text`, text: answer }], 'stop');
        setState(current => ({ ...current, activeRunId: undefined }));
      },
      /**
       * A `file_edit` whose arguments stream in network chunks, then applies.
       * `pathLast` sends the path after the edits, as JSON order allows.
       */
      async fileEdit({ pace = 1, pathLast = false, chunk = 18, interval = 48 } = {}) {
        const runId = `run-file-${Date.now()}`;
        const id = `a-file-${runId}`;
        const callId = `edit-${runId}`;
        const path = 'src/auth/login.ts';
        const oldText = 'export async function login(user: User) {\n  const token = await issue(user);\n  cache.set(user.id, token);\n  return token;\n}\n';
        const newText = 'export async function login(user: User) {\n  const token = await issue(user, { refresh: true });\n  sessions.remember(user.id, token);\n  cache.set(user.id, token);\n  return token;\n}\n';
        const fields = [oldText, newText];
        const total = fields.join('').length;
        const argumentsAt = (received: number): Record<string, unknown> => {
          let left = received;
          const take = (text: string) => { const part = text.slice(0, Math.max(0, left)); left -= part.length; return part; };
          const old = take(oldText);
          const edits = [old.length < oldText.length ? { oldText: old } : { oldText: old, newText: take(newText) }];
          const hasPath = !pathLast || received >= total;
          return hasPath ? { path, edits } : { edits };
        };
        for (let received = 0; received <= total; received += chunk) {
          const message = assistant(id, [{ type: 'toolCall', id: callId, name: 'file_edit', arguments: argumentsAt(received) as Extract<ChatAssistantContent, { type: 'toolCall' }>['arguments'] }], 'pending');
          setState(current => ({ ...current, activeRunId: runId, liveAssistant: message }));
          await sleep(interval * pace);
        }
        const final = assistant(id, [{ type: 'toolCall', id: callId, name: 'file_edit', arguments: argumentsAt(total) as Extract<ChatAssistantContent, { type: 'toolCall' }>['arguments'] }], 'toolUse');
        setState(current => ({ ...current, liveAssistant: undefined, entries: [...current.entries, messageEntry(final, runId)],
          executions: { ...current.executions, [callId]: { toolCallId: callId, name: 'file_edit', args: argumentsAt(total) as ChatToolExecutionState['args'], status: 'running' } } }));
        await sleep(420 * pace);
        setState(current => ({ ...current,
          executions: { ...current.executions, [callId]: { toolCallId: callId, name: 'file_edit', args: argumentsAt(total) as ChatToolExecutionState['args'], status: 'success', result: { status: 'applied' } } },
          entries: [...current.entries, messageEntry({ role: 'toolResult', toolCallId: callId, toolName: 'file_edit', content: [{ type: 'text', text: 'applied' }], details: { status: 'applied' }, isError: false, timestamp: sequence }, runId)] }));
        await sleep(200 * pace);
        setState(current => ({ ...current, activeRunId: undefined }));
      },
      /**
       * Conversation-first tray: a read, then two writes streamed in one step
       * and applied concurrently, a pause, a third write, then the answer.
       * `holdAt` (ms after the pair finishes) is when a check may point in.
       */
      async tray({ pace = 1 } = {}) {
        const runId = `run-tray-${Date.now()}`;
        let step = 0;
        const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall' as const, id: callId, name, arguments: args as Extract<ChatAssistantContent, { type: 'toolCall' }>['arguments'] });
        const live = (id: string, content: ChatAssistantContent[]) => setState(current => ({ ...current, activeRunId: runId, liveAssistant: assistant(id, content, 'pending') }));
        const persist = (id: string, content: ChatAssistantContent[], stopReason: ChatAssistantMessage['stopReason']) => setState(current => ({
          ...current, liveAssistant: undefined, entries: [...current.entries, messageEntry(assistant(id, content, stopReason), runId)] }));
        const execute = (callId: string, name: string, args: Record<string, unknown>, status: ChatToolExecutionState['status'], result?: Record<string, unknown>) => setState(current => ({
          ...current, executions: { ...current.executions, [callId]: { toolCallId: callId, name, args: args as ChatToolExecutionState['args'], status, ...(result ? { result: result as ChatToolExecutionState['result'] } : {}) } } }));
        const report = (callId: string, name: string, details?: Record<string, unknown>) => setState(current => ({
          ...current, entries: [...current.entries, messageEntry({ role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: sequence, ...(details ? { details: details as ChatToolExecutionState['result'] } : {}) }, runId)] }));
        const files = {
          a: { path: 'src/auth/session.ts', content: 'export function remember(user: string, token: string) {\n  sessions.set(user, token);\n  return token;\n}\n' },
          b: { path: 'tests/auth.refresh.test.ts', content: "import { remember } from '../src/auth/session';\n\nit('keeps the refresh token', () => {\n  expect(remember('u', 't')).toBe('t');\n});\n" },
          c: { path: 'src/auth/login.ts', content: "import { remember } from './session';\n\nexport const login = (user: string) => remember(user, issue(user));\n" },
        };
        // 1. A quick read, so the work folds into one process row.
        let id = `a-tray-${runId}-${step += 1}`;
        live(id, [{ type: 'thinking', id: `${id}:t`, thinking: '先补上会话记忆，再加一个刷新令牌的测试。' }, toolCall('read', 'file_read', { path: 'src/auth/login.ts' })]);
        await sleep(160 * pace);
        persist(id, [{ type: 'thinking', id: `${id}:t`, thinking: '先补上会话记忆，再加一个刷新令牌的测试。' }, toolCall('read', 'file_read', { path: 'src/auth/login.ts' })], 'toolUse');
        execute('read', 'file_read', { path: 'src/auth/login.ts' }, 'running');
        await sleep(200 * pace);
        execute('read', 'file_read', { path: 'src/auth/login.ts' }, 'success');
        report('read', 'file_read');
        // 2. Two writes streamed in one step, then applied together.
        id = `a-tray-${runId}-${step += 1}`;
        const streamWrites = async (keys: Array<keyof typeof files>) => {
          const calls: ChatAssistantContent[] = [];
          for (const key of keys) {
            const { path, content } = files[key];
            for (let length = 0; length <= content.length; length += 14) {
              live(id, [...calls, toolCall(`write-${key}`, 'file_write', { path, content: content.slice(0, length) })]);
              await sleep(48 * pace);
            }
            calls.push(toolCall(`write-${key}`, 'file_write', { path, content }));
          }
          persist(id, calls, 'toolUse');
          return calls;
        };
        await streamWrites(['a', 'b']);
        execute('write-a', 'file_write', files.a, 'running');
        execute('write-b', 'file_write', files.b, 'running');
        await sleep(300 * pace);
        execute('write-a', 'file_write', files.a, 'success', { status: 'applied' });
        report('write-a', 'file_write', { status: 'applied' });
        await sleep(400 * pace);
        execute('write-b', 'file_write', files.b, 'success', { status: 'applied' });
        report('write-b', 'file_write', { status: 'applied' });
        (window as unknown as { __trayPairDone?: number }).__trayPairDone = performance.now();
        // 3. Reading time passes; a later write opens a new batch.
        await sleep(1500 * pace);
        id = `a-tray-${runId}-${step += 1}`;
        await streamWrites(['c']);
        execute('write-c', 'file_write', files.c, 'running');
        await sleep(300 * pace);
        execute('write-c', 'file_write', files.c, 'success', { status: 'applied' });
        report('write-c', 'file_write', { status: 'applied' });
        await sleep(200 * pace);
        // 4. The answer: the segment ends and a finished batch retracts at once.
        id = `a-tray-${runId}-${step += 1}`;
        const answer = '会话记忆已补上，并加了刷新令牌的测试。';
        for (let length = 2; length <= answer.length; length += 2) {
          live(id, [{ type: 'text', id: `${id}:text`, text: answer.slice(0, length) }]);
          await sleep(50 * pace);
        }
        persist(id, [{ type: 'text', id: `${id}:text`, text: answer }], 'stop');
        setState(current => ({ ...current, activeRunId: undefined }));
      },
      /** Submit a user turn and anchor it, as ThreadConversation does once the Host accepts it. */
      send(text = '新的问题：请继续展开。', { track = false } = {}) {
        const user = messageEntry({ role: 'user', content: text, timestamp: sequence }, `run-send-${sequence}`);
        if (track) { recording = []; trackedTurn = user.id; }
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
      stream({ chars = 1600, cps = 120, interval = 48, burstEvery = 0, burst = 360, rich = false, pauseAt = -1, pauseMs = 0 } = {}) {
        if (timer) clearInterval(timer);
        const runId = `run-live-${Date.now()}`;
        const messageId = `a-live-${runId}`;
        const source = rich ? RICH : PARAGRAPH;
        const text = Array.from({ length: Math.ceil(chars / source.length) + 1 }, () => source).join('\n\n').slice(0, chars);
        let written = 0;
        let ticks = 0;
        let pausedUntil = 0;
        return new Promise<void>((resolve) => {
          timer = setInterval(() => {
            if (performance.now() < pausedUntil) return;
            if (pauseAt >= 0 && written >= pauseAt && pausedUntil === 0) {
              pausedUntil = performance.now() + pauseMs;
              return;
            }
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
            setState(current => ({ entries: [...current.entries, messageEntry(live, runId)], executions: current.executions }));
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
          toolExecutions={state.executions}
        />
        </ConversationContext.Provider>
      </div>
    </div>
  );
}

initializeLocale();
// `?scene=send` opens the empty home with the real composer instead of a long Thread.
const scene = new URLSearchParams(location.search).get('scene');
createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <ThemeSystemProvider>
      <ThemeProvider>
        <MotionProvider>
          <TooltipProvider>
            {scene === 'send' ? <SendLab /> : scene === 'sidebar' ? <SidebarLab /> : scene === 'rail' ? <RailLab /> : scene === 'switch' ? <SwitchLab /> : <Lab />}
          </TooltipProvider>
        </MotionProvider>
      </ThemeProvider>
    </ThemeSystemProvider>
  </I18nProvider>,
);
