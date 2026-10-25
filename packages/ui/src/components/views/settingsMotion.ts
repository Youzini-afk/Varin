import React from 'react';
import { requestFrame } from '@/lib/motion/frame';
import { documentMotionLevel } from '@/lib/motion/preference';
import { SpringDriver, tokenSpring } from '@/lib/motion/spring';
import { springTiming, staggerDelay } from '@/lib/motion/tokens';

/**
 * The settings navigation's selection: one pill, moved between pages on the
 * glide spring (carrying its velocity if the page changes again), instead of
 * each item painting its own. Items stop painting theirs while the list is
 * marked `data-settings-nav-pill`. A collapsing group moves it with the item;
 * a page outside the list (About in the footer) hides it.
 */
export function useNavPill(root: HTMLElement | null, selected: string): void {
  const state = React.useRef<{ pill: HTMLElement | null; driver: SpringDriver | null; visible: boolean }>({ pill: null, driver: null, visible: false });

  const place = React.useCallback((list: HTMLElement, move: boolean) => {
    const { pill, driver } = state.current;
    if (!pill || !driver) return;
    const item = list.querySelector<HTMLElement>('[aria-current="page"]');
    const rect = item?.getBoundingClientRect();
    if (!item || !rect || !rect.height) {
      pill.setAttribute('data-hidden', '');
      state.current.visible = false;
      return;
    }
    const frame = list.getBoundingClientRect();
    const y = rect.top - frame.top - list.clientTop + list.scrollTop;
    pill.style.left = `${rect.left - frame.left - list.clientLeft}px`;
    pill.style.width = `${rect.width}px`;
    pill.style.height = `${rect.height}px`;
    if (move && state.current.visible && documentMotionLevel() === 'full') driver.to(y);
    else if (driver.active) driver.to(y);
    else driver.jump(y);
    pill.removeAttribute('data-hidden');
    state.current.visible = true;
  }, []);

  React.useLayoutEffect(() => {
    if (!root) return undefined;
    const pill = document.createElement('span');
    pill.className = 'settings-nav-pill';
    pill.setAttribute('aria-hidden', 'true');
    pill.setAttribute('data-hidden', '');
    root.prepend(pill);
    root.setAttribute('data-settings-nav-pill', '');
    const driver = new SpringDriver({ spring: tokenSpring('glide'), onUpdate: value => { pill.style.translate = `0 ${value}px`; } });
    state.current = { pill, driver, visible: false };
    // A group opening or closing moves the items under the pill; it keeps up.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place(root, false));
    observer?.observe(root);
    return () => {
      observer?.disconnect();
      driver.stop();
      pill.remove();
      root.removeAttribute('data-settings-nav-pill');
      state.current = { pill: null, driver: null, visible: false };
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
