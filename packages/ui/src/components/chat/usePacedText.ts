import React from 'react';
import { requestFrame, type FrameHandle } from '@/lib/motion/frame';
import { PROSE_PACE, drainRate, revealIndex, stepPace, type PaceProfile } from '@/lib/motion/pace';

export interface PacedText {
  /** The revealed prefix of the content. */
  text: string;
  /** True while streaming or while the remaining backlog drains after it. */
  revealing: boolean;
}

/** Joining a stream already in progress reveals only its last stretch. */
const JOIN_REVEAL_CHARS = 160;
/** A remount within this window continues the reveal instead of restarting it. */
const RESUME_WINDOW_MS = 1500;
const RESUME_LIMIT = 32;

// Some layouts remount the live reply when it is persisted. Its reveal position
// survives that remount, so the end of a reply never jumps in.
const resumable = new Map<string, { shown: number; at: number }>();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const resumeFrom = (key: string | undefined, content: string): number | undefined => {
  if (!key) return undefined;
  const saved = resumable.get(key);
  resumable.delete(key);
  if (!saved || now() - saved.at > RESUME_WINDOW_MS) return undefined;
  return Math.min(saved.shown, content.length);
};

/**
 * Reveals streamed text at reading pace, one animation frame at a time.
 *
 * Arriving text only moves the target; the reveal front keeps its own speed:
 * `max(26/s, backlog / 0.24s)`. When `streaming` ends, the rest drains evenly
 * in 0.16s, and `revealing` stays true until it has. Text that was never
 * streamed, and environments without a window, show in full immediately.
 */
export function usePacedText(
  content: string,
  streaming: boolean,
  key?: string,
  profile: PaceProfile = PROSE_PACE,
): PacedText {
  const [shown, setShown] = React.useState(() => {
    const resumed = resumeFrom(key, content);
    if (resumed !== undefined) return resumed;
    return streaming ? Math.max(0, content.length - JOIN_REVEAL_CHARS) : content.length;
  });
  const position = React.useRef(shown);
  const shownRef = React.useRef(shown);
  const latest = React.useRef({ content, streaming });
  latest.current = { content, streaming };
  const fixedRate = React.useRef<number | null>(null);
  const frame = React.useRef<FrameHandle | null>(null);
  const lastTime = React.useRef<number | null>(null);

  const publish = React.useCallback((next: number) => {
    if (next === shownRef.current) return;
    shownRef.current = next;
    setShown(next);
  }, []);

  const tick = React.useCallback(function advance(time: number) {
    frame.current = null;
    const { content: text } = latest.current;
    const seconds = lastTime.current === null ? 1 / 60 : (time - lastTime.current) / 1000;
    lastTime.current = time;
    position.current = stepPace(profile, position.current, text.length, seconds, fixedRate.current);
    publish(revealIndex(text, position.current));
    if (position.current < text.length) {
      frame.current = requestFrame(advance);
      return;
    }
    lastTime.current = null;
    fixedRate.current = null;
  }, [profile, publish]);

  React.useEffect(() => {
    const length = content.length;
    if (position.current > length) {
      position.current = length;
      publish(length);
    }
    const finish = () => {
      frame.current?.cancel();
      frame.current = null;
      lastTime.current = null;
      fixedRate.current = null;
      position.current = length;
      publish(length);
    };
    if (typeof window === 'undefined') { finish(); return; }
    if (!streaming) {
      if (position.current >= length) { finish(); return; }
      // Whatever is left when the stream ends (or changes after it) drains at
      // one even rate over the drain time.
      fixedRate.current = drainRate(profile, length - position.current);
    } else {
      fixedRate.current = null;
    }
    if (frame.current === null && position.current < length) frame.current = requestFrame(tick);
  }, [content, streaming, profile, publish, tick]);

  React.useEffect(() => {
    // Mounted: any saved position for this key is ours, or stale.
    if (key) resumable.delete(key);
    return () => {
      frame.current?.cancel();
      frame.current = null;
      lastTime.current = null;
      const { content: text } = latest.current;
      if (key && position.current < text.length) {
        resumable.set(key, { shown: position.current, at: now() });
        while (resumable.size > RESUME_LIMIT) resumable.delete(resumable.keys().next().value!);
      }
    };
  }, [key]);

  const revealing = streaming || shown < content.length;
  return { text: revealing ? content.slice(0, Math.min(shown, content.length)) : content, revealing };
}
