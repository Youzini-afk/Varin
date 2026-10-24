import React from 'react';
import { requestFrame, type FrameHandle } from '@/lib/motion/frame';
import { PROSE_PACE, drainRate, revealIndex, stepPace, type PaceProfile } from '@/lib/motion/pace';

export interface PacedText {
  /** The revealed prefix of the content. */
  text: string;
  /** True while streaming or while the remaining backlog drains after it. */
  revealing: boolean;
}

export interface PacedLength {
  /** How much of the streamed length is revealed. */
  shown: number;
  /** True while streaming or while the remaining backlog drains after it. */
  revealing: boolean;
}

export interface PaceOptions {
  /** Identity that survives a remount within 1.5s, continuing the reveal. */
  key?: string;
  profile?: PaceProfile;
  /** Joining a stream already in progress reveals only its last stretch. */
  joinReveal?: number;
  /** Turn a fractional position into a revealed length (e.g. whole characters). */
  snap?: (position: number) => number;
}

const JOIN_REVEAL_CHARS = 160;
/** A remount within this window continues the reveal instead of restarting it. */
const RESUME_WINDOW_MS = 1500;
const RESUME_LIMIT = 32;

// Some layouts remount the live reply when it is persisted. Its reveal position
// survives that remount, so the end of a reply never jumps in.
const resumable = new Map<string, { shown: number; at: number }>();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const resumeFrom = (key: string | undefined, length: number): number | undefined => {
  if (!key) return undefined;
  const saved = resumable.get(key);
  resumable.delete(key);
  if (!saved || now() - saved.at > RESUME_WINDOW_MS) return undefined;
  return Math.min(saved.shown, length);
};

/**
 * Reveals a streamed length at reading pace, one animation frame at a time.
 *
 * Arriving content only moves the target; the reveal front keeps its own
 * speed: `max(minRate, backlog / catchUp)` (prose: 26/s and 0.24s). When
 * `streaming` ends, the rest drains evenly in the drain time, and `revealing`
 * stays true until it has. Content that was never streamed, and environments
 * without a window, show in full immediately.
 */
export function usePacedLength(length: number, streaming: boolean, options: PaceOptions = {}): PacedLength {
  const { key, profile = PROSE_PACE, joinReveal = JOIN_REVEAL_CHARS } = options;
  const [shown, setShown] = React.useState(() => {
    const resumed = resumeFrom(key, length);
    if (resumed !== undefined) return resumed;
    return streaming ? Math.max(0, length - joinReveal) : length;
  });
  const position = React.useRef(shown);
  const shownRef = React.useRef(shown);
  const latest = React.useRef({ length, snap: options.snap });
  latest.current = { length, snap: options.snap };
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
    const { length: target, snap } = latest.current;
    const seconds = lastTime.current === null ? 1 / 60 : (time - lastTime.current) / 1000;
    lastTime.current = time;
    position.current = stepPace(profile, position.current, target, seconds, fixedRate.current);
    publish(snap ? snap(position.current) : Math.floor(position.current));
    if (position.current < target) {
      frame.current = requestFrame(advance);
      return;
    }
    lastTime.current = null;
    fixedRate.current = null;
  }, [profile, publish]);

  React.useEffect(() => {
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
  }, [length, streaming, profile, publish, tick]);

  React.useEffect(() => {
    // Mounted: any saved position for this key is ours, or stale.
    if (key) resumable.delete(key);
    return () => {
      frame.current?.cancel();
      frame.current = null;
      lastTime.current = null;
      if (key && position.current < latest.current.length) {
        resumable.set(key, { shown: position.current, at: now() });
        while (resumable.size > RESUME_LIMIT) resumable.delete(resumable.keys().next().value!);
      }
    };
  }, [key]);

  return { shown: Math.min(shown, length), revealing: streaming || shown < length };
}

/** Streamed text at reading pace; see `usePacedLength`. */
export function usePacedText(
  content: string,
  streaming: boolean,
  key?: string,
  profile: PaceProfile = PROSE_PACE,
): PacedText {
  const snap = React.useCallback((position: number) => revealIndex(content, position), [content]);
  const { shown, revealing } = usePacedLength(content.length, streaming, { key, profile, snap });
  return { text: revealing ? content.slice(0, shown) : content, revealing };
}
