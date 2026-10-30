import React from 'react';
import { documentMotionLevel } from '@/lib/motion/preference';
import { placeInstantly } from '@/lib/motion/slidingPill';

/**
 * Moves `knob` under the child of `row` that matches `selector`. It is placed without motion the
 * first time and when the row resizes, so only a change of choice moves it. With no match the
 * knob hides, and the next match places it in position rather than travelling there.
 */
export function useSegmentKnob(row: React.RefObject<HTMLElement | null>, knob: React.RefObject<HTMLElement | null>, selector: string, key: string): void {
  const placed = React.useRef(false);
  React.useLayoutEffect(() => {
    const root = row.current, pill = knob.current;
    if (!root || !pill) return undefined;
    const place = (animate: boolean) => {
      const active = root.querySelector<HTMLElement>(selector);
      if (!active) { pill.setAttribute('data-hidden', ''); placed.current = false; return; }
      const apply = () => { pill.style.translate = `${active.offsetLeft}px 0`; pill.style.width = `${active.offsetWidth}px`; pill.removeAttribute('data-hidden'); };
      if (animate && placed.current && documentMotionLevel() === 'full') apply();
      else placeInstantly(pill, apply);
      placed.current = true;
    };
    place(true);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(root);
    return () => observer.disconnect();
  }, [row, knob, selector, key]);
}
