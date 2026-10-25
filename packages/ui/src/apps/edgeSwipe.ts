/**
 * The edge-swipe session switch's arithmetic (docs/design/motion-and-interaction.md §3.14), kept apart
 * from the touch listeners so it can be checked directly.
 *
 * The content follows the finger one to one toward the centre. A swipe that cannot switch (one
 * session) or that turns back past where it started meets a rubber band instead. On release it
 * commits when thrown (faster than 0.5px/ms toward the centre) or pulled past 35% of the width
 * without being flicked back; otherwise it springs home.
 */

export const SWIPE_DECIDE_PX = 10;
export const SWIPE_MAX_OFF_AXIS_RATIO = 0.7;
export const SWIPE_COMMIT_VELOCITY = 0.5;
export const SWIPE_COMMIT_SHARE = 0.35;
/** A pull past the threshold still cancels when flicked back at least this fast. */
const SWIPE_CANCEL_VELOCITY = 0.2;
/** Velocity is measured over the last part of the gesture only. */
export const SWIPE_VELOCITY_WINDOW_MS = 80;
/** How far the content dims at a full-width pull. */
export const SWIPE_DIM = 0.35;

export interface SwipeSample {
  t: number;
  x: number;
}

/** iOS-style rubber band: gives way less the further it is pulled, approaching `limit`. */
export const rubberBand = (distance: number, limit: number): number => {
  if (limit <= 0) return 0;
  const sign = Math.sign(distance);
  const magnitude = Math.abs(distance);
  return sign * limit * (1 - 1 / ((magnitude * 0.55) / limit + 1));
};

/**
 * Where the content sits for a finger `dx` from where it started. `toward` is +1 for a swipe from
 * the left edge (rightward is toward the centre) and -1 from the right edge.
 */
export function swipeOffset(dx: number, width: number, toward: 1 | -1, canSwitch: boolean): number {
  const along = dx * toward;
  const limit = Math.max(24, width * 0.12);
  if (along <= 0) return toward * rubberBand(along, limit * 0.5);
  return toward * (canSwitch ? along : rubberBand(along, limit));
}

/** Horizontal velocity in px/ms over the last `SWIPE_VELOCITY_WINDOW_MS`. */
export function swipeVelocity(samples: readonly SwipeSample[]): number {
  const last = samples.at(-1);
  if (!last) return 0;
  let first = last;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sample = samples[index]!;
    first = sample;
    if (last.t - sample.t >= SWIPE_VELOCITY_WINDOW_MS) break;
  }
  const elapsed = last.t - first.t;
  return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
}

export function shouldCommitSwipe(input: {
  dx: number;
  velocity: number;
  width: number;
  toward: 1 | -1;
  canSwitch: boolean;
}): boolean {
  if (!input.canSwitch || input.width <= 0) return false;
  const along = input.dx * input.toward;
  const speed = input.velocity * input.toward;
  if (along <= 0) return false;
  if (speed > SWIPE_COMMIT_VELOCITY) return true;
  return along > input.width * SWIPE_COMMIT_SHARE && speed > -SWIPE_CANCEL_VELOCITY;
}

/** Content opacity for an offset: dims a little as it is pulled away. */
export const swipeOpacity = (offset: number, width: number): number => (
  width > 0 ? 1 - SWIPE_DIM * Math.min(1, Math.abs(offset) / width) : 1
);
