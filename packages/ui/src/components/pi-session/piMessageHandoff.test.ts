import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import type { PiAgentEvent, QueuedUserMessage } from '@varin/protocol';
import type { PiSessionViewState } from '@/stores/usePiSessionStore';
import { DEFAULT_PI_TIMELINE_VIEW, armPiTimelineTurn, remapPiTimelineAnchor } from '@/lib/pi-runtime/piTimelineScrollState';
import { PiMessageHandoff } from './piMessageHandoff';

let root: HTMLElement;
let handoff: PiMessageHandoff;
let frames: Map<number, FrameRequestCallback>;
let animations: Array<{ element: HTMLElement; frames: Keyframe[]; cancel: ReturnType<typeof vi.fn>; complete(): void }>;
const rect = (x: number, y: number, width: number, height: number) => ({
  x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {},
});
const position = (element: HTMLElement, x: number, y: number, width = 250, height = 50) => {
  element.getBoundingClientRect = () => rect(x, y, width, height) as DOMRect;
  return element;
};
const record = (lastAgentEvent?: PiAgentEvent): PiSessionViewState => ({
  sessionId: 'session', open: true, extensionStates: {}, toolExecutions: {},
  ...(lastAgentEvent ? { lastAgentEvent } : {}),
});
const user = (timestamp: number) => ({ role: 'user' as const, timestamp, content: 'identical text' });
const target = (id: string) => {
  const turn = document.createElement('section'); turn.dataset.turnId = id;
  turn.innerHTML = '<article data-pi-user-message><div>identical text</div></article>';
  root.append(turn);
  return position(turn.querySelector('div')!, 300, 80);
};
const paint = () => {
  for (let pass = 0; pass < 2; pass++) {
    const batch = [...frames.values()]; frames.clear();
    for (const frame of batch) frame(0);
  }
};

beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  window.innerWidth = 900; window.innerHeight = 800;
  vi.stubGlobal('getComputedStyle', () => ({ borderRadius: '12px', font: '14px sans-serif', color: '#eee', backgroundColor: '#222' }));
  frames = new Map(); let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => { frames.set(++sequence, frame); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  animations = [];
  window.HTMLElement.prototype.animate = function (keyframes: Keyframe[]) {
    let complete!: () => void;
    const animation = { finished: new Promise<void>(resolve => { complete = resolve; }), cancel: vi.fn() };
    animations.push({ element: this, frames: keyframes, cancel: animation.cancel, complete });
    return animation as unknown as Animation;
  };
  root = position(document.createElement('main'), 0, 0, 900, 800); document.body.append(root);
  handoff = new PiMessageHandoff(); handoff.select('runtime', 'session', true, false); handoff.setRoot(root);
});
afterEach(() => { handoff.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('one submitted message crosses from draft through live and native entry without replay; navigation releases its paint', () => {
  const editor = position(document.createElement('div'), 40, 600); editor.dataset.piComposerInputFrame = 'true'; root.append(editor);
  handoff.submit('submit', 'session', handoff.captureDraft());
  const pending = { ...record(), view: armPiTimelineTurn(DEFAULT_PI_TIMELINE_VIEW, 'submit', 'turn:live-user:1') };
  handoff.observe(pending);
  const live = target('turn:live-user:1'); paint();
  expect(root.querySelectorAll('.pi-message-handoff')).toHaveLength(1);
  expect(live.style.opacity).toBe('0');
  live.parentElement!.parentElement!.remove();
  const saved = target('turn:entry');
  handoff.observe({ ...pending, view: remapPiTimelineAnchor(pending.view, 'turn:entry') }); paint();
  expect(animations).toHaveLength(1);
  expect(saved.style.opacity).toBe('0');
  handoff.select('runtime', 'other-session', true, false);
  expect(saved.style.opacity).not.toBe('0');
  expect(root.querySelector('.pi-message-handoff')).toBeNull();
  expect(animations[0]!.cancel).toHaveBeenCalled();
});

test('equal queued text uses the consumed native ID, and removal alone never fabricates a message', () => {
  const messages: QueuedUserMessage[] = ['first', 'second'].map(id => ({ id, revision: 0, mode: 'followUp', text: 'identical text', imageCount: 0 }));
  for (const [index, message] of messages.entries()) {
    const row = document.createElement('div'); row.dataset.piQueuedMessage = message.id; row.innerHTML = '<p>identical text</p>'; root.append(row);
    position(row.querySelector('p')!, 40, 400 + index * 100);
  }
  const previous = { ...record(), snapshot: { queuedMessages: messages } } as PiSessionViewState;
  const drained = record({ type: 'queue_update', queuedMessages: [], followUp: [], steering: [] });
  handoff.observe(drained, previous); paint();
  expect(animations).toHaveLength(0);
  handoff.observe(record({ type: 'message_start', queuedMessageId: 'second', message: user(2) }), drained);
  target('turn:live-user:2'); paint();
  expect(animations[0]!.frames[0]!.transform).toBe('translate(-260px, 420px)');
  expect(root.querySelectorAll('.pi-message-handoff')).toHaveLength(1);
});

test('a failed submission releases the real message immediately; reduced motion leaves no projection', () => {
  const editor = position(document.createElement('div'), 40, 600); editor.dataset.piComposerInputFrame = 'true'; root.append(editor);
  handoff.submit('failed', 'session', handoff.captureDraft());
  const pending = { ...record(), view: armPiTimelineTurn(DEFAULT_PI_TIMELINE_VIEW, 'failed', 'turn:live-user:1') };
  handoff.observe(pending); const bubble = target('turn:live-user:1'); paint();
  handoff.cancelSubmission('failed');
  expect(bubble.style.opacity).not.toBe('0');
  expect(root.querySelector('.pi-message-handoff')).toBeNull();
  handoff.select('runtime', 'session', true, true);
  handoff.submit('reduced', 'session', handoff.captureDraft());
  handoff.observe({ ...record(), view: armPiTimelineTurn(DEFAULT_PI_TIMELINE_VIEW, 'reduced', 'turn:live-user:1') }); paint();
  expect(animations).toHaveLength(1);
  expect(frames.size).toBe(0);
});
