/**
 * Where the user last pressed. A change that was asked for with a click (theme ink, the Workbench
 * lattice when no switcher is on screen) starts there instead of at an arbitrary point.
 */

export interface RecentPointer {
  x: number;
  y: number;
}

/** A keyboard or assistive-technology click uses the control's centre. */
export function activationPoint(event: Pick<MouseEvent, 'clientX' | 'clientY' | 'detail'> & { currentTarget: HTMLElement }): RecentPointer {
  if (event.detail > 0) return { x: event.clientX, y: event.clientY };
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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
