/**
 * Where the user last pressed. A change that was asked for with a click (theme ink, the Workbench
 * lattice when no switcher is on screen) starts there instead of at an arbitrary point.
 */

export interface RecentPointer {
  x: number;
  y: number;
}

/** A press older than this did not ask for the change being animated now. */
export const RECENT_POINTER_WINDOW_MS = 2000;

let pointer: { x: number; y: number; at: number } | null = null;
let tracking = false;

/** Start remembering presses. Idempotent; capture phase so a stopped event still counts. */
export function trackRecentPointer(): void {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  window.addEventListener('pointerdown', (event) => {
    pointer = { x: event.clientX, y: event.clientY, at: performance.now() };
  }, { capture: true, passive: true });
}

/** The last press in viewport coordinates, if it was recent enough. */
export function recentPointer(windowMs = RECENT_POINTER_WINDOW_MS): RecentPointer | null {
  if (!pointer || performance.now() - pointer.at >= windowMs) return null;
  return { x: pointer.x, y: pointer.y };
}
