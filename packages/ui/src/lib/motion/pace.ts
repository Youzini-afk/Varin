/**
 * Reading-paced reveal of streamed text. The network delivers bursts; the
 * reader sees a steady front that speeds up with the backlog and slows down
 * smoothly when the stream pauses. When the stream ends, what is left drains
 * at an even rate over a fixed short time instead of appearing at once.
 */
export interface PaceProfile {
  /** Characters per second while there is any backlog. */
  minRate: number;
  /** Time constant for catching up with the backlog. */
  catchUpSeconds: number;
  /** Time to reveal what remains once the stream has ended. */
  drainSeconds: number;
}

/** Prose: `max(26/s, backlog / 0.24s)`, drained in 0.16s. */
export const PROSE_PACE: Readonly<PaceProfile> = { minRate: 26, catchUpSeconds: 0.24, drainSeconds: 0.16 };
/** Code and diffs type faster: `max(140/s, backlog / 0.22s)`, drained in 0.12s. */
export const CODE_PACE: Readonly<PaceProfile> = { minRate: 140, catchUpSeconds: 0.22, drainSeconds: 0.12 };

const MAX_STEP_SECONDS = 0.05;

/** The fixed rate that reveals `backlog` in `drainSeconds`. */
export const drainRate = (profile: PaceProfile, backlog: number): number => (
  Math.max(profile.minRate, Math.max(0, backlog) / profile.drainSeconds)
);

/**
 * Advance a fractional reveal position toward `target`. A `fixedRate` (from
 * `drainRate`) replaces the catch-up rate once the stream has ended.
 */
export function stepPace(
  profile: PaceProfile,
  shown: number,
  target: number,
  seconds: number,
  fixedRate?: number | null,
): number {
  if (shown >= target) return target;
  const elapsed = Math.min(Math.max(0, seconds), MAX_STEP_SECONDS);
  const rate = fixedRate ?? Math.max(profile.minRate, (target - shown) / profile.catchUpSeconds);
  return Math.min(target, shown + rate * elapsed);
}

/** A reveal index that never splits a UTF-16 surrogate pair. */
export function revealIndex(text: string, position: number): number {
  let index = Math.min(text.length, Math.max(0, Math.floor(position)));
  const previous = text.charCodeAt(index - 1);
  if (index > 0 && index < text.length && previous >= 0xd800 && previous <= 0xdbff) index += 1;
  return index;
}
