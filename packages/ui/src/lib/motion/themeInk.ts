import { documentMotionLevel } from './preference';
import { EASE_OUT } from './tokens';

/**
 * Theme ink (§3.12). A theme change spreads from where the user clicked as a
 * circle reaching the farthest corner, through a View Transition of the whole
 * page. Reduced motion cross-fades in 160ms; off, or a browser without View
 * Transitions, switches directly.
 */

const INK_MS = 660;
/** A click this recent is where the change came from; otherwise it spreads from the centre. */
const POINTER_WINDOW_MS = 2000;

let pointer: { x: number; y: number; at: number } | null = null;
let tracking = false;

/** Remember where the last press was, so the ink can start there. */
export function trackThemeInkPointer(): void {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  window.addEventListener('pointerdown', (event) => {
    pointer = { x: event.clientX, y: event.clientY, at: performance.now() };
  }, { capture: true, passive: true });
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

/** Run `update` (which applies the new theme) inside the ink transition when motion allows it. */
export function inkThemeChange(update: () => void): void {
  const doc = typeof document === 'undefined' ? null : document as ViewTransitionDocument;
  const level = documentMotionLevel();
  if (!doc?.startViewTransition || level === 'off' || doc.visibilityState !== 'visible') {
    update();
    return;
  }
  const root = doc.documentElement;
  root.dataset.themeInk = level === 'full' ? 'circle' : 'fade';
  const transition = doc.startViewTransition(update);
  const done = () => { delete root.dataset.themeInk; };
  void transition.finished.then(done, done);
  if (level !== 'full') return;
  const recent = pointer && performance.now() - pointer.at < POINTER_WINDOW_MS ? pointer : null;
  const x = recent?.x ?? window.innerWidth / 2;
  const y = recent?.y ?? window.innerHeight / 2;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  void transition.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: INK_MS, easing: `cubic-bezier(${EASE_OUT.join(', ')})`, pseudoElement: '::view-transition-new(root)' },
    );
  }, () => undefined);
}
