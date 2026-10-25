import React from 'react';
import { documentMotionLevel } from '@/lib/motion/preference';
import { boxWithin, createSlidingPill, placeInstantly, type SlidingPill } from '@/lib/motion/slidingPill';

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

/**
 * While the docked panel opens or closes, the main column beside it holds a
 * single width instead of reflowing every frame of the panel's glide. Opening
 * narrows it to its final width at once; closing keeps it until the panel has
 * gone, then it widens once. The space between shows the frame behind.
 */
export function useMainColumnLock(panel: React.RefObject<HTMLElement | null>, open: boolean, docked: boolean): void {
  const previous = React.useRef(open);
  React.useLayoutEffect(() => {
    const was = previous.current;
    previous.current = open;
    const aside = panel.current;
    const main = aside?.parentElement?.querySelector<HTMLElement>(':scope > main');
    if (was === open || !aside || !main || !docked || documentMotionLevel() !== 'full') return undefined;
    const parent = aside.parentElement!;
    const style = getComputedStyle(aside);
    // Opening: the column takes what the panel leaves once it arrives. Closing: what it has now.
    const width = open
      ? parent.clientWidth - (Number.parseFloat(style.getPropertyValue('--oc-context-panel-width')) || 0) - (Number.parseFloat(style.getPropertyValue('--wb-canvas-gap')) || 0)
      : main.getBoundingClientRect().width;
    if (!(width > 0)) return undefined;
    Object.assign(main.style, { flex: 'none', width: `${width}px` });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      aside.removeEventListener('transitionend', onEnd);
      main.style.flex = '';
      main.style.width = '';
    };
    const onEnd = (event: TransitionEvent) => { if (event.target === aside && event.propertyName === 'width') release(); };
    aside.addEventListener('transitionend', onEnd);
    // A transition that never runs (no change, a hidden tab) still lets go.
    const timer = setTimeout(release, 900);
    return () => { clearTimeout(timer); release(); };
  }, [panel, open, docked]);
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
