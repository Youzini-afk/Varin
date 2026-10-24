import type { Transition } from 'motion/react';
import type { MotionLevel } from './preference';

/**
 * Shared motion tokens. Four springs and two tweens cover every UI movement:
 * the same kind of change should feel the same everywhere in the product.
 *
 * Springs use motion's `bounce` + `visualDuration` model (mass 1). The CSS
 * side is a `linear()` sampling of the same spring, so CSS transitions, WAAPI
 * keyframes and motion components share one curve. `styles/motion.css` keeps
 * the generated values; `tokens.test.ts` fails when they drift.
 */
export type SpringToken = 'snap' | 'glide' | 'travel' | 'settle';

export interface SpringSpec {
  bounce: number;
  /** Seconds until the motion visually arrives; the tail settles later. */
  visualDuration: number;
}

export const SPRINGS: Readonly<Record<SpringToken, SpringSpec>> = {
  /** Hover pills, menus, tooltips, press feedback. */
  snap: { bounce: 0, visualDuration: 0.18 },
  /** Default: arrivals, selection pills, size changes, panels. */
  glide: { bounce: 0, visualDuration: 0.32 },
  /** Cross-region movement: send handoff, composer docking, anchored scroll. */
  travel: { bounce: 0.06, visualDuration: 0.5 },
  /** Arrival moments only: new rows, badges, members joining. */
  settle: { bounce: 0.3, visualDuration: 0.42 },
};

/** Base out-curve, the existing `--wb-ease`. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
/** Exits leave faster than arrivals come in. */
export const EASE_EXIT = [0.4, 0, 1, 1] as const;

export const TWEENS = {
  fade: { duration: 0.16, ease: EASE_OUT },
  exit: { duration: 0.11, ease: EASE_EXIT },
} as const satisfies Record<string, Transition>;

export const INSTANT_TRANSITION = { duration: 0 } as const satisfies Transition;

/**
 * An element-level transition under the effective motion level. Off makes it
 * instant; under Reduced, `MotionConfig` already drops transform and layout
 * animation, so the remaining opacity change keeps its timing.
 */
export const transitionFor = (level: MotionLevel, transition: Transition): Transition => (
  level === 'off' ? INSTANT_TRANSITION : transition
);

/** Stagger between list items, capped so long lists do not trail. */
export const STAGGER_SECONDS = 0.02;
export const STAGGER_MAX_ITEMS = 6;
export const staggerDelay = (index: number): number => Math.min(Math.max(0, index), STAGGER_MAX_ITEMS - 1) * STAGGER_SECONDS;

export interface SpringCoefficients {
  stiffness: number;
  damping: number;
}

/** Same conversion motion applies to `visualDuration` / `bounce`. */
export function springCoefficients({ bounce, visualDuration }: SpringSpec): SpringCoefficients {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  const stiffness = root * root;
  const zeta = Math.min(1, Math.max(0.05, 1 - bounce));
  return { stiffness, damping: 2 * zeta * Math.sqrt(stiffness) };
}

/** A motion/react transition for a token. */
export function springTransition(token: SpringToken): Transition {
  const { bounce, visualDuration } = SPRINGS[token];
  return { type: 'spring', bounce, visualDuration };
}

interface SampledSpring {
  /** Position from 0 to 1, one sample per millisecond. */
  samples: number[];
  /** Milliseconds until the spring is at rest. */
  settleMs: number;
}

const sampled = new Map<SpringToken, SampledSpring>();

/** Integrates the unit spring from rest at 0 to rest at 1 in 1ms steps. */
export function sampleSpring(token: SpringToken): SampledSpring {
  const cached = sampled.get(token);
  if (cached) return cached;
  const { stiffness, damping } = springCoefficients(SPRINGS[token]);
  const step = 0.001;
  let x = 0;
  let v = 0;
  let t = 0;
  const samples = [0];
  while (t < 3) {
    v += (-stiffness * (x - 1) - damping * v) * step;
    x += v * step;
    t += step;
    samples.push(x);
    if (Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.03) break;
  }
  samples[samples.length - 1] = 1;
  const result = { samples, settleMs: Math.round(t * 1000) };
  sampled.set(token, result);
  return result;
}

/** Milliseconds a CSS / WAAPI animation needs to play the whole spring. */
export const springSettleMs = (token: SpringToken): number => sampleSpring(token).settleMs;

/** Eased progress for `p` in [0, 1] of the full settle duration. */
export function springProgress(token: SpringToken, p: number): number {
  const { samples } = sampleSpring(token);
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const position = p * (samples.length - 1);
  const index = Math.floor(position);
  const from = samples[index]!;
  return from + ((samples[index + 1] ?? 1) - from) * (position - index);
}

/** CSS `linear()` easing that reproduces the spring over `springSettleMs`. */
export function springLinearEasing(token: SpringToken): string {
  const { samples } = sampleSpring(token);
  const last = samples.length - 1;
  const points = Math.min(64, Math.max(24, Math.round(last / 12)));
  const values: number[] = [];
  for (let i = 0; i <= points; i += 1) values.push(Number(samples[Math.round((i / points) * last)]!.toFixed(4)));
  return `linear(${values.join(', ')})`;
}

/** WAAPI timing for a token; the caller decides fill and delay. */
export const springTiming = (token: SpringToken): { duration: number; easing: string } => ({
  duration: springSettleMs(token),
  easing: springLinearEasing(token),
});
