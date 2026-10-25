import React from 'react';
import { documentMotionLevel } from '@/lib/motion/preference';
import { boxWithin, createSlidingPill, placeInstantly, type SlidingPill } from '@/lib/motion/slidingPill';
import { springTiming } from '@/lib/motion/tokens';

const BAR_HEIGHT = 16;

/**
 * The rail's active bar. One bar for the whole rail slides to the active
 * button on the glide spring, carrying its velocity if the choice changes
 * again, instead of unmounting in one button and mounting in the next. It
 * appears in place when a panel opens and fades out in place when it closes.
 * `layoutKey` changes when the buttons are reordered, so the bar follows its
 * button to the new place.
 */
export function useRailIndicator(nav: React.RefObject<HTMLElement | null>, activeId: string | null, layoutKey: string): void {
  const bar = React.useRef<SlidingPill | null>(null);

  React.useLayoutEffect(() => () => {
    bar.current?.dispose();
    bar.current = null;
  }, []);

  React.useLayoutEffect(() => {
    const root = nav.current;
    if (!root) return;
    if (!bar.current || !root.contains(bar.current.element)) {
      bar.current?.dispose();
      bar.current = createSlidingPill(root, 'rail-indicator');
    }
    const button = activeId
      ? [...root.querySelectorAll<HTMLElement>('[data-rail-surface]')].find(candidate => candidate.getAttribute('data-rail-surface') === activeId)
      : undefined;
    if (!button) {
      bar.current.hide();
      return;
    }
    const box = boxWithin(button, root);
    bar.current.moveTo({ y: box.top + (box.height - BAR_HEIGHT) / 2 }, true);
  }, [nav, activeId, layoutKey]);
}

/** True once when `count` turns from nothing into something after mount, for a badge that settles in. */
export function useArrival(count: number | undefined): boolean {
  const previous = React.useRef<number | undefined>(count);
  const mounted = React.useRef(false);
  const [arrived, setArrived] = React.useState(false);
  React.useEffect(() => {
    const before = previous.current;
    previous.current = count;
    if (!mounted.current) { mounted.current = true; return; }
    if ((before ?? 0) === 0 && (count ?? 0) > 0) setArrived(true);
    else if ((count ?? 0) === 0) setArrived(false);
  }, [count]);
  return arrived;
}

/** A centred column in the main canvas, to measure where its content is drawn. */
const COLUMN_SELECTOR = '.chat-message-column, .chat-input-column, [data-main-glide-column]';

const visibleColumn = (main: HTMLElement): HTMLElement | null => {
  const frame = main.getBoundingClientRect();
  for (const node of main.querySelectorAll<HTMLElement>(COLUMN_SELECTOR)) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.bottom > frame.top && rect.top < frame.bottom) return node;
  }
  return null;
};

type CanvasGlide = { boundaries: Map<HTMLElement, number>; animations: Set<Animation> };
const canvasGlides = new WeakMap<HTMLElement, CanvasGlide>();
const outerWidth = (element: HTMLElement) => element.getBoundingClientRect().width + (Number.parseFloat(getComputedStyle(element).marginLeft) || 0);

/** Both sides can reverse independently. Their remaining widths contribute to
 * one content layout, so neither completion releases the other's width lock. */
function placeCanvas(main: HTMLElement, state: CanvasGlide): void {
  const before = visibleColumn(main)?.getBoundingClientRect().left;
  if (!state.boundaries.size) {
    for (const animation of state.animations) animation.cancel();
    state.animations.clear();
    main.removeAttribute('data-width-gliding');
    main.style.removeProperty('--main-glide-width');
    canvasGlides.delete(main);
    return;
  }
  let width = main.clientWidth;
  for (const [boundary, final] of state.boundaries) width += outerWidth(boundary) - final;
  if (!(width > 0)) return;
  main.style.setProperty('--main-glide-width', `${width}px`);
  main.setAttribute('data-width-gliding', '');
  const after = visibleColumn(main)?.getBoundingClientRect().left;
  const dx = before !== undefined && after !== undefined ? before - after : 0;
  if (Math.abs(dx) >= 0.5) for (const layer of main.querySelectorAll<HTMLElement>(':scope > .absolute.inset-0')) {
    const animation = layer.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], { ...springTiming('glide'), composite: 'add' });
    state.animations.add(animation);
    const done = () => state.animations.delete(animation);
    void animation.finished.then(done, done);
  }
}

/**
 * The docked panel and the main canvas beside it move as one (docs/design/motion-and-interaction.md
 * §3.10). The panel's width glides and the canvas, still flexible, gives up or takes back exactly that
 * much each frame, so there is never a gap between them. What would be expensive is the conversation
 * re-wrapping every frame; instead its content takes its final width once, when the move starts, and a
 * translate carries it from where it was drawn to its new place on the same glide, so a centred column
 * slides over rather than jumping. A move that reverses mid-way starts again from where everything is.
 */
export function useMainColumnGlide(panel: React.RefObject<HTMLElement | null>, open: boolean, docked: boolean, targetWidth?: number, side: 'panel' | 'sidebar' = 'panel'): void {
  const previous = React.useRef({ open, targetWidth, docked });
  const active = React.useRef<(() => void) | null>(null);

  React.useLayoutEffect(() => () => { active.current?.(); active.current = null; }, []);

  React.useLayoutEffect(() => {
    const was = previous.current;
    previous.current = { open, targetWidth, docked };
    const aside = panel.current;
    const main = side === 'sidebar'
      ? aside?.parentElement?.querySelector<HTMLElement>('.agent-conversation-canvas')
      : aside?.parentElement?.querySelector<HTMLElement>(':scope > main');
    if (was.open === open && was.targetWidth === targetWidth && was.docked === docked) return;
    if (!aside || !main || !docked || documentMotionLevel() !== 'full') {
      active.current?.();
      active.current = null;
      return;
    }
    // Preserve the currently painted position through a reversal. Retiring a
    // boundary doesn't unlock content until its replacement has joined.
    const state = canvasGlides.get(main) ?? { boundaries: new Map(), animations: new Set<Animation>() };
    canvasGlides.set(main, state);
    const style = getComputedStyle(aside);
    const gap = side === 'panel' ? Number.parseFloat(style.getPropertyValue('--wb-canvas-gap')) || 0 : 0;
    const outerFinal = open ? (targetWidth ?? (Number.parseFloat(style.getPropertyValue('--varin-context-panel-width')) || 0)) + gap : 0;
    state.boundaries.set(aside, outerFinal);
    const retiring = active.current;
    active.current = null;
    // The old cleanup must not remove the new boundary during retargeting.
    aside.setAttribute('data-glide-retargeting', '');
    retiring?.();
    aside.removeAttribute('data-glide-retargeting');
    aside.setAttribute('data-gliding', '');
    const area = side === 'sidebar' ? main.parentElement : null;
    if (area) {
      area.dataset.layoutTargetWidth = String(Math.max(0, area.clientWidth + outerWidth(aside) - outerFinal));
      area.dispatchEvent(new Event('varin:layout-target'));
    }
    placeCanvas(main, state);
    const glide = springTiming('glide');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      aside.removeEventListener('transitionend', onEnd);
      if (aside.hasAttribute('data-glide-retargeting')) return;
      state.boundaries.delete(aside);
      placeCanvas(main, state);
      if (area) { delete area.dataset.layoutTargetWidth; area.dispatchEvent(new Event('varin:layout-target')); }
      aside.removeAttribute('data-gliding');
    };
    const onEnd = (event: TransitionEvent) => { if (event.target === aside && event.propertyName === 'width') release(); };
    aside.addEventListener('transitionend', onEnd);
    // A transition that never runs (no change, a hidden tab) still lets go.
    const timer = setTimeout(release, glide.duration + 300);
    active.current = release;
  }, [panel, open, docked, targetWidth, side]);
}

/**
 * One underline for a row of tabs, sliding on glide to the tab marked
 * `aria-pressed="true"` or `aria-selected="true"`. It is placed without motion
 * the first time and whenever the row resizes, so only a change of tab moves it.
 */
export function useSlidingUnderline(underline: React.RefObject<HTMLElement | null>, activeKey: string): void {
  const placed = React.useRef(false);
  React.useLayoutEffect(() => {
    const line = underline.current;
    const row = line?.parentElement;
    if (!line || !row) return undefined;
    const place = (animate: boolean) => {
      const tab = row.querySelector<HTMLElement>(':scope > [aria-pressed="true"], :scope > [aria-selected="true"]');
      if (!tab) { line.setAttribute('data-hidden', ''); return; }
      const apply = () => {
        line.style.translate = `${tab.offsetLeft}px 0`;
        line.style.width = `${tab.offsetWidth}px`;
        line.removeAttribute('data-hidden');
      };
      if (animate && placed.current && documentMotionLevel() === 'full') apply();
      else placeInstantly(line, apply);
      placed.current = true;
    };
    place(true);
    if (typeof ResizeObserver === 'undefined') return undefined;
    // Only a real change of the tabs' geometry re-places (fonts loading, the row
    // resizing); the observer's first report is the layout it already has.
    const geometry = () => [...row.children].map(child => child instanceof HTMLElement ? `${child.offsetLeft}:${child.offsetWidth}` : '').join('|');
    let size = geometry();
    const observer = new ResizeObserver(() => {
      const next = geometry();
      if (next === size) return;
      size = next;
      place(false);
    });
    observer.observe(row);
    for (const child of row.children) if (child !== line) observer.observe(child);
    return () => observer.disconnect();
  }, [underline, activeKey]);
}
