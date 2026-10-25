import React from 'react';
import { requestFrame } from '@/lib/motion/frame';
import { documentMotionLevel } from '@/lib/motion/preference';
import { boxWithin, createSlidingPill, type SlidingPill } from '@/lib/motion/slidingPill';
import { springTiming, staggerDelay } from '@/lib/motion/tokens';

/**
 * The settings navigation's selection: one pill, moved between pages on the
 * glide spring (carrying its velocity if the page changes again), instead of
 * each item painting its own. Items stop painting theirs while the list is
 * marked `data-settings-nav-pill`. A collapsing group moves it with the item;
 * a page outside the list (About in the footer) hides it.
 */
export function useNavPill(root: HTMLElement | null, selected: string): void {
  const pill = React.useRef<SlidingPill | null>(null);

  const place = React.useCallback((list: HTMLElement, move: boolean) => {
    const current = pill.current;
    if (!current) return;
    const item = list.querySelector<HTMLElement>('[aria-current="page"]');
    if (!item || !item.getBoundingClientRect().height) {
      current.hide();
      return;
    }
    const box = boxWithin(item, list);
    // The pill sits at the item's left inside the list, whatever the list's horizontal scroll.
    current.moveTo({ y: box.top, left: box.left - list.scrollLeft, width: box.width, height: box.height }, move);
  }, []);

  React.useLayoutEffect(() => {
    if (!root) return undefined;
    const current = createSlidingPill(root, 'settings-nav-pill');
    pill.current = current;
    root.setAttribute('data-settings-nav-pill', '');
    // A group opening or closing moves the items under the pill; it keeps up.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place(root, false));
    observer?.observe(root);
    return () => {
      observer?.disconnect();
      current.dispose();
      root.removeAttribute('data-settings-nav-pill');
      pill.current = null;
    };
  }, [root, place]);

  React.useLayoutEffect(() => {
    if (root) place(root, true);
  }, [root, place, selected]);
}

/**
 * A page's header and first sections arrive one after another from the side
 * the user moved toward in the navigation; later sections are already there.
 */
export function staggerSettingsPage(scene: HTMLElement, direction: 1 | -1): void {
  const level = documentMotionLevel();
  if (level === 'off' || typeof scene.animate !== 'function') return;
  const shift = level === 'full' ? direction * 6 : 0;
  let tries = 0;
  const run = () => {
    if (!scene.isConnected) return;
    const page = scene.querySelector<HTMLElement>('[data-settings-page]');
    // A lazy page may draw its sections a frame later.
    if (!page && tries++ < 12) { requestFrame(run); return; }
    const parts = [...(page ?? scene).children].slice(0, 6) as HTMLElement[];
    parts.forEach((part, index) => part.animate(
      [{ opacity: 0, transform: shift ? `translateY(${shift}px)` : 'none' }, { opacity: 1, transform: 'none' }],
      { ...springTiming('glide'), delay: (0.04 + staggerDelay(index)) * 1000, fill: 'backwards' },
    ));
  };
  run();
}

/** On opening the window, the navigation groups arrive one after another. */
export function useNavEntrance(root: HTMLElement | null, enabled: boolean): void {
  const played = React.useRef(false);
  React.useLayoutEffect(() => {
    if (played.current || !enabled || !root || documentMotionLevel() !== 'full' || typeof root.animate !== 'function') return;
    [...root.querySelectorAll<HTMLElement>(':scope > .settings-nav-group')].slice(0, 6).forEach((group, index) => group.animate(
      [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { ...springTiming('glide'), delay: (0.06 + staggerDelay(index)) * 1000, fill: 'backwards' },
    ));
    // Once per mount: the window opening, not a list redrawn later.
    played.current = true;
  }, [root, enabled]);
}
