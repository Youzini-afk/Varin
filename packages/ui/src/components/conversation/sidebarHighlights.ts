import React from 'react';
import { requestAfterFrame, type FrameHandle } from '@/lib/motion/frame';
import { boxWithin, createSlidingPill, placeInstantly, type Box, type SlidingPill } from '@/lib/motion/slidingPill';

/** Highlights for the sidebar list (see FlipList.tsx for its rows). */
const rowFor = (root: HTMLElement, id: string | null): HTMLElement | null => (
  id ? [...root.querySelectorAll<HTMLElement>('[data-sidebar-row]')].find(row => row.getAttribute('data-sidebar-row') === id && !row.closest('[data-flip-ghost], [inert]')) ?? null : null
);

/**
 * One persistent selection, using the settings navigation's glide spring.
 * Retargeting keeps its current position and velocity; rows never take over
 * painting the active background. Follow moving row geometry after frame writes.
 */
export function useSelectionGlide(container: React.RefObject<HTMLElement | null>, currentId: string | null, layoutKey = ''): void {
  const state = React.useRef<{
    id: string | null;
    root: HTMLElement | null;
    pill: SlidingPill | null;
    target: HTMLElement | null;
    goal: Box | null;
    resize: ResizeObserver | null;
    frame: FrameHandle | null;
  }>({ id: currentId, root: null, pill: null, target: null, goal: null, resize: null, frame: null });

  const release = React.useCallback(() => {
    const current = state.current;
    current.frame?.cancel();
    current.resize?.disconnect();
    current.pill?.dispose();
    current.root?.removeAttribute('data-sidebar-selection');
    Object.assign(current, { root: null, pill: null, target: null, goal: null, resize: null, frame: null });
  }, []);
  React.useLayoutEffect(() => release, [release]);

  const sync = React.useCallback(function syncSelection() {
    const current = state.current;
    const { root, pill } = current;
    if (!root || !pill) return;
    const target = rowFor(root, current.id);
    if (target !== current.target) {
      if (current.target) current.resize?.unobserve(current.target);
      current.target = target;
      if (target) current.resize?.observe(target);
    }
    const goal = target ? boxWithin(target, root) : null;
    if (!goal?.height) {
      current.frame?.cancel();
      current.frame = null;
      current.goal = null;
      pill.hide();
      return;
    }
    const previous = current.goal;
    if (!pill.visible || !previous || (Object.keys(goal) as Array<keyof Box>).some(key => goal[key] !== previous[key])) {
      const move = () => pill.moveTo({ y: goal.top, left: goal.left, width: goal.width, height: goal.height }, true);
      if (pill.visible) move();
      else placeInstantly(pill.element, move);
      current.goal = goal;
    }
    if (pill.active && !current.frame) current.frame = requestAfterFrame(() => { current.frame = null; syncSelection(); });
  }, []);

  // Also reconcile rows arriving or being replaced while the selected identity stays the same.
  React.useLayoutEffect(() => {
    const root = container.current;
    const current = state.current;
    current.id = currentId;
    if (current.root !== root) {
      release();
      if (!root) return;
      current.root = root;
      current.pill = createSlidingPill(root, 'sidebar-selection');
      root.setAttribute('data-sidebar-selection', '');
      if (typeof ResizeObserver !== 'undefined') {
        current.resize = new ResizeObserver(sync);
        current.resize.observe(root);
      }
    }
    sync();
  }, [container, currentId, layoutKey, release, sync]);
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
