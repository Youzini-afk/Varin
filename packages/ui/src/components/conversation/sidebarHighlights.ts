import React from 'react';
import { requestFrame, type FrameHandle } from '@/lib/motion/frame';
import { documentMotionLevel } from '@/lib/motion/preference';
import { boxWithin, placeInstantly, type Box } from '@/lib/motion/slidingPill';
import { springAtRest, stepSpring, tokenSpring, type SpringState } from '@/lib/motion/spring';

/** Highlights for the sidebar list (see FlipList.tsx for its rows). */
const rowFor = (root: HTMLElement, id: string | null): HTMLElement | null => (
  id ? [...root.querySelectorAll<HTMLElement>('[data-sidebar-row]')].find(row => row.getAttribute('data-sidebar-row') === id) ?? null : null
);
/** Draw one frame with transitions off, so a background handed between layers does not fade. */
const withoutTransition = (element: HTMLElement, change: () => void): void => {
  element.style.transition = 'none';
  change();
  void element.offsetWidth;
  element.style.transition = '';
};

/**
 * The selection moves between rows. A copy of the selection colour travels on
 * the glide spring from the previous row to the live position of the new one,
 * carrying its velocity when the selection changes again mid-way, then hands
 * back to the row. With no previous row (a new or a draft session) the row's
 * colour fades in place. Reduced motion keeps the fade only.
 */
export function useSelectionGlide(container: React.RefObject<HTMLElement | null>, currentId: string | null): void {
  const state = React.useRef<{
    id: string | null;
    ghost: HTMLElement | null;
    target: HTMLElement | null;
    springs: Record<keyof Box, SpringState> | null;
    frame: FrameHandle | null;
    last: number | null;
  }>({ id: currentId, ghost: null, target: null, springs: null, frame: null, last: null });

  React.useLayoutEffect(() => () => {
    const current = state.current;
    current.frame?.cancel();
    current.ghost?.remove();
    current.target?.removeAttribute('data-selection-arriving');
  }, []);

  React.useLayoutEffect(() => {
    const root = container.current;
    const current = state.current;
    const previous = current.id;
    current.id = currentId;
    if (!root || previous === currentId) return;
    const leaving = rowFor(root, previous);
    const arriving = rowFor(root, currentId);
    const land = () => {
      current.frame?.cancel();
      current.frame = null;
      current.last = null;
      current.springs = null;
      current.ghost?.remove();
      current.ghost = null;
      const row = current.target;
      current.target = null;
      if (row?.isConnected) withoutTransition(row, () => row.removeAttribute('data-selection-arriving'));
    };
    if (current.target && current.target !== arriving) current.target.removeAttribute('data-selection-arriving');
    if (!arriving || documentMotionLevel() !== 'full' || typeof requestAnimationFrame !== 'function') { land(); return; }
    const from = current.springs
      ? null
      : leaving ? boxWithin(leaving, root) : null;
    if (!current.springs && !from) { land(); return; }
    if (from) {
      current.springs = {
        top: { position: from.top, velocity: 0 }, left: { position: from.left, velocity: 0 },
        width: { position: from.width, velocity: 0 }, height: { position: from.height, velocity: 0 },
      };
      const ghost = document.createElement('span');
      ghost.className = 'sidebar-selection';
      ghost.setAttribute('aria-hidden', 'true');
      root.prepend(ghost);
      current.ghost = ghost;
      // The old row's colour is now the copy's; it must not fade out on top of it.
      if (leaving) withoutTransition(leaving, () => undefined);
    }
    current.target = arriving;
    withoutTransition(arriving, () => arriving.setAttribute('data-selection-arriving', ''));
    const spring = tokenSpring('glide');
    const paint = () => {
      const springs = current.springs!;
      Object.assign(current.ghost!.style, {
        transform: `translate(${springs.left.position}px, ${springs.top.position}px)`,
        width: `${springs.width.position}px`, height: `${springs.height.position}px`,
      });
    };
    const tick = (time: number) => {
      const row = current.target;
      if (!row?.isConnected || !current.springs || !current.ghost) { land(); return; }
      const seconds = current.last === null ? 1 / 60 : (time - current.last) / 1000;
      current.last = time;
      const goal = boxWithin(row, root);
      let resting = true;
      for (const key of ['top', 'left', 'width', 'height'] as const) {
        const next = stepSpring(current.springs[key], goal[key], spring, seconds);
        current.springs[key] = next;
        if (!springAtRest(next, goal[key], 0.5, 8)) resting = false;
      }
      paint();
      if (resting) { land(); return; }
      current.frame = requestFrame(tick);
    };
    paint();
    if (!current.frame) current.frame = requestFrame(tick);
  }, [container, currentId]);
}

/**
 * One hover highlight for the whole list. It moves to the row under the
 * pointer on snap and leans a couple of pixels toward the pointer within the
 * row, instead of each row lighting up on its own. Touch has no hover.
 */
export function useHoverPill(container: React.RefObject<HTMLElement | null>): void {
  React.useLayoutEffect(() => {
    const root = container.current;
    if (!root || typeof document === 'undefined') return undefined;
    const pill = document.createElement('span');
    pill.className = 'sidebar-hover';
    pill.setAttribute('aria-hidden', 'true');
    pill.setAttribute('data-hidden', '');
    root.prepend(pill);
    root.setAttribute('data-sidebar-hover', '');
    let row: HTMLElement | null = null;
    const hide = () => { pill.setAttribute('data-hidden', ''); row = null; };
    const place = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-sidebar-row]') : null;
      if (!target || !root.contains(target) || target.hasAttribute('data-current') || target.closest('[data-flip-ghost]')) { hide(); return; }
      const box = boxWithin(target, root);
      const rect = target.getBoundingClientRect();
      const lean = (value: number, size: number, reach: number) => Math.max(-1, Math.min(1, (value / (size / 2)))) * reach;
      const x = lean(event.clientX - (rect.left + rect.width / 2), rect.width, 2);
      const y = lean(event.clientY - (rect.top + rect.height / 2), rect.height, 1.5);
      const first = row === null;
      row = target;
      const apply = () => {
        pill.style.setProperty('--hover-x', `${box.left + x}px`);
        pill.style.setProperty('--hover-y', `${box.top + y}px`);
        pill.style.setProperty('--hover-width', `${box.width}px`);
        pill.style.setProperty('--hover-height', `${box.height}px`);
        pill.removeAttribute('data-hidden');
      };
      // The first row lights up in place; later ones are reached by sliding.
      if (first) placeInstantly(pill, apply);
      else apply();
    };
    root.addEventListener('pointermove', place);
    root.addEventListener('pointerleave', hide);
    root.addEventListener('scroll', hide, { passive: true });
    return () => {
      root.removeEventListener('pointermove', place);
      root.removeEventListener('pointerleave', hide);
      root.removeEventListener('scroll', hide);
      root.removeAttribute('data-sidebar-hover');
      pill.remove();
    };
  }, [container]);
}
