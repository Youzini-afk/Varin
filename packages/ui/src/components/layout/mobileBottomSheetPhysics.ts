/** Where the phone bottom sheet rests and where a released drag lands (docs/design/bot-ui.md §8). */

/** A fling faster than this (px/ms), or a drag past this share of the way, commits the move. */
export const FLING_PX_PER_MS = 0.5;
export const COMMIT_SHARE = 0.35;
/** The share of the host the sheet covers when it opens. */
export const HALF_SHARE = 0.55;
/** The conversation stays visible above a full-height sheet by this much. */
export const FULL_GAP_PX = 12;
/** Pulling above full height moves the sheet this fraction of the finger. */
export const OVERSHOOT = 0.3;

export type SheetSnap = 'half' | 'full';

/** Sheet offsets: translateY from the sheet's full-height position, for a host height. */
export function sheetOffsets(height: number): { full: number; half: number; closed: number } {
  const sheet = Math.max(0, height - FULL_GAP_PX);
  return { full: 0, half: Math.max(0, sheet - height * HALF_SHARE), closed: sheet };
}

/** `offset` is where the finger left the sheet and `velocity` its speed in px/ms, positive downward. */
export function settleSheet(from: SheetSnap, offset: number, velocity: number, height: number): SheetSnap | 'closed' {
  const stops = sheetOffsets(height);
  const moved = offset - stops[from];
  if (moved >= 0) {
    // Downward: a fling or enough travel goes one stop down; from full, far enough closes it.
    const travel = (from === 'full' ? stops.half - stops.full : stops.closed - stops.half) * COMMIT_SHARE;
    if (velocity <= FLING_PX_PER_MS && moved <= travel) return from;
    if (from === 'half') return 'closed';
    return offset > stops.half + (stops.closed - stops.half) * COMMIT_SHARE ? 'closed' : 'half';
  }
  const travel = (stops.half - stops.full) * COMMIT_SHARE;
  return from === 'half' && (velocity < -FLING_PX_PER_MS || -moved > travel) ? 'full' : from;
}
