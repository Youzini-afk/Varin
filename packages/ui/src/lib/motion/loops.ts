/**
 * Loop animations (the running label's shimmer, spinners, the ink dot, marquees) stop while nobody can
 * see them (docs/design/motion-and-interaction.md §4). The main window keeps rendering in the background
 * (Electron `backgroundThrottling: false`), so a hidden window would otherwise keep repainting them, and
 * a long conversation keeps rows mounted above and below the viewport.
 *
 * This module only marks what is out of sight: the root while the document is hidden, and each observed
 * row while it is scrolled away. styles/motion.css pauses the loops inside a marked element; finite
 * animations are left alone, so nothing is found half-finished on return.
 */

export const PAGE_HIDDEN_ATTRIBUTE = 'data-page-hidden';
export const OFFSCREEN_ATTRIBUTE = 'data-offscreen';
/** A row about to scroll in is already running when it arrives. */
const OFFSCREEN_MARGIN = '64px 0px';

let pageTracked: Document | null = null;

/** Mark the root while the document is hidden. Idempotent per document. */
export function trackPageVisibility(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc || pageTracked === doc) return;
  pageTracked = doc;
  const sync = (): void => {
    doc.documentElement.toggleAttribute(PAGE_HIDDEN_ATTRIBUTE, doc.visibilityState === 'hidden');
  };
  sync();
  doc.addEventListener('visibilitychange', sync);
}

let observer: IntersectionObserver | null = null;

const sharedObserver = (): IntersectionObserver | null => {
  if (observer) return observer;
  if (typeof IntersectionObserver !== 'function') return null;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.toggleAttribute(OFFSCREEN_ATTRIBUTE, !entry.isIntersecting);
  }, { rootMargin: OFFSCREEN_MARGIN });
  return observer;
};

/**
 * A callback ref: loops inside the element pause while it is out of view. Stable, so React attaches it
 * once per element and runs the returned cleanup when the element goes.
 */
export const pauseLoopsOffscreen = (element: Element | null): (() => void) | undefined => {
  const io = element ? sharedObserver() : null;
  if (!element || !io) return undefined;
  io.observe(element);
  return () => {
    io.unobserve(element);
    element.removeAttribute(OFFSCREEN_ATTRIBUTE);
  };
};

/** Test seam. */
export function resetLoopTrackingForTests(): void {
  observer?.disconnect();
  observer = null;
  pageTracked = null;
}
