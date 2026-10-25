import { requestFrame, type FrameHandle } from '@/lib/motion/frame';
import { documentMotionLevel } from '@/lib/motion/preference';
import { springTiming } from '@/lib/motion/tokens';

/**
 * Neighbouring tooltips read as one tooltip moving (docs/design/motion-and-interaction.md §3.10).
 *
 * Moving from one anchor to the next inside the grouping window opens the next tooltip at once
 * (`data-instant`). Each tooltip has its own popup, so the new one starts where the old one is and
 * slides to its own place on snap, while the old one, already closing, steps out of sight. The rail
 * keeps its single shared tooltip (`motion-tooltip-follow`), which moves without remounting.
 */

/** Further apart than this, the next tooltip is somewhere else rather than a neighbour. */
const NEIGHBOUR_PX = 320;
/** The previous tooltip counts while it is closing, and this long after it has gone. */
const RECENT_MS = 450;
const GROUPED_OPEN = new Set(['delay', 'group', 'trigger-change']);

interface Seen {
  popup: HTMLElement;
  rect: DOMRect;
  at: number;
}

let last: Seen | null = null;

const centre = (rect: DOMRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/** Where the tooltip shown before this one is now, if it was a moment ago. */
function previousFor(popup: HTMLElement): Seen | null {
  if (!last || last.popup === popup) return null;
  if (last.popup.isConnected) return { ...last, rect: last.popup.getBoundingClientRect() };
  return performance.now() - last.at <= RECENT_MS ? last : null;
}

function glideFrom(popup: HTMLElement, from: Seen): void {
  const rect = popup.getBoundingClientRect();
  if (!rect.width || !rect.height || !from.rect.width) return;
  const a = centre(from.rect);
  const b = centre(rect);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1 || distance > NEIGHBOUR_PX) return;
  // The old tooltip is closing at its place; only one is ever seen.
  if (from.popup.isConnected) from.popup.style.visibility = 'hidden';
  popup.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], springTiming('snap'));
}

/**
 * Callback ref for a tooltip popup. Records it as the latest tooltip, and when it opened at once next
 * to the previous one, slides it over from there once Floating UI has placed it.
 */
export function tooltipGlideRef(popup: HTMLElement | null): (() => void) | undefined {
  if (!popup) return undefined;
  const grouped = GROUPED_OPEN.has(popup.getAttribute('data-instant') ?? '');
  const from = grouped && documentMotionLevel() === 'full' && typeof popup.animate === 'function'
    ? previousFor(popup)
    : null;
  const seen: Seen = { popup, rect: popup.getBoundingClientRect(), at: performance.now() };
  last = seen;
  const positioner = popup.parentElement;
  let settled = false;
  let observer: MutationObserver | null = null;
  let frame: FrameHandle | null = null;
  // Base UI keeps the positioner transparent at the corner until Floating UI has placed it.
  const placed = (): boolean => !positioner || positioner.style.opacity !== '0';
  let frames = 0;
  const place = (): void => {
    if (settled) return;
    if (!placed() && frames < 3) {
      frames += 1;
      frame = requestFrame(place);
      return;
    }
    settled = true;
    observer?.disconnect();
    frame?.cancel();
    seen.rect = popup.getBoundingClientRect();
    if (from) glideFrom(popup, from);
  };
  // Floating UI writes the position into the positioner's style just after mount. Placing on that
  // mutation runs before paint, so the first frame is already at the old tooltip's place. If the
  // position was already final, the next frame places it.
  if (positioner && typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => { if (placed()) place(); });
    observer.observe(positioner, { attributes: true, attributeFilter: ['style'] });
  }
  frame = requestFrame(place);
  return () => {
    observer?.disconnect();
    frame?.cancel();
    if (last === seen) {
      seen.at = performance.now();
      if (popup.isConnected) seen.rect = popup.getBoundingClientRect();
    }
  };
}
