import React from 'react';
import { cn } from '@/lib/utils';
import { documentMotionLevel } from '@/lib/motion/preference';
import { EASE_EXIT, springTiming, TWEENS } from '@/lib/motion/tokens';

/** A label shown for less than this is hard to read; the next one waits. */
export const SWAP_TEXT_MIN_MS = 260;
const SHIFT_PX = 6;
const ENTER_DELAY_MS = 30;

const cubic = (points: readonly number[]) => `cubic-bezier(${points.join(', ')})`;

/**
 * Text that changes in place. The old text rises and fades out while the new
 * text enters from below in the same cell, instead of remounting and replaying
 * an entrance. A change that comes sooner than 260ms after the previous one
 * waits, so quick actions stay readable. `live` adds the running shimmer.
 *
 * Reduced motion cross-fades without movement; off swaps directly. The wait is
 * reading time and applies at every level.
 */
export function SwapText({ text, live = false, className, hold = SWAP_TEXT_MIN_MS }: {
  text: string;
  live?: boolean;
  className?: string;
  /** Minimum time a text stays; counters that only roll pass 0. */
  hold?: number;
}) {
  const [shown, setShown] = React.useState(text);
  const shownAt = React.useRef(0);
  const host = React.useRef<HTMLSpanElement>(null);
  const current = React.useRef<HTMLSpanElement>(null);
  const previous = React.useRef(text);

  React.useEffect(() => {
    if (text === shown) return undefined;
    const wait = shownAt.current + hold - Date.now();
    if (wait <= 0) { setShown(text); return undefined; }
    const timer = setTimeout(() => setShown(text), wait);
    return () => clearTimeout(timer);
  }, [text, shown, hold]);

  React.useLayoutEffect(() => {
    const before = previous.current;
    previous.current = shown;
    shownAt.current = Date.now();
    const node = current.current;
    const container = host.current;
    if (before === shown || !node || !container || typeof node.animate !== 'function') return;
    const level = documentMotionLevel();
    if (level === 'off') return;
    container.querySelectorAll(':scope > [data-swap-leaving]').forEach(leaving => leaving.remove());
    const leaving = node.cloneNode(false) as HTMLSpanElement;
    leaving.removeAttribute('id');
    leaving.setAttribute('data-swap-leaving', '');
    leaving.setAttribute('aria-hidden', 'true');
    leaving.textContent = before;
    container.prepend(leaving);
    const shift = level === 'full' ? SHIFT_PX : 0;
    const exit = leaving.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-shift}px)` }],
      { duration: TWEENS.exit.duration * 1000, easing: cubic(EASE_EXIT), fill: 'forwards' },
    );
    void exit.finished.then(() => leaving.remove(), () => leaving.remove());
    const enter = springTiming('glide');
    node.animate(
      [{ opacity: 0, transform: `translateY(${shift}px)` }, { opacity: 1, transform: 'none' }],
      { ...enter, delay: ENTER_DELAY_MS, fill: 'backwards' },
    );
  }, [shown]);

  return <span ref={host} className={cn('swap-text', className)} data-live={live || undefined} data-swap-pending={text !== shown || undefined}>
    <span ref={current} className="swap-text-current">{shown}</span>
  </span>;
}
