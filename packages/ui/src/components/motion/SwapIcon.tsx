import React from 'react';
import { cn } from '@/lib/utils';
import { documentMotionLevel } from '@/lib/motion/preference';
import { EASE_EXIT, springTiming, TWEENS } from '@/lib/motion/tokens';

const SHIFT_PX = 5;
const ENTER_DELAY_MS = 30;

/**
 * An icon that changes in place. The previous icon rises and fades out while
 * the next one arrives in the same cell: `glide` comes up from below, `settle`
 * drops in with a small overshoot for arrival moments, such as Stop appearing
 * once a run starts. The cell animates, not the icon, so a spinning icon keeps
 * its own rotation.
 *
 * The children must be fully determined by `swapKey`: the leaving copy is the
 * icon as it was rendered for the previous key. Reduced motion cross-fades
 * without movement; off swaps directly.
 */
export function SwapIcon({ swapKey, enter = 'glide', className, children }: {
  swapKey: string;
  enter?: 'glide' | 'settle';
  className?: string;
  children: React.ReactNode;
}) {
  const host = React.useRef<HTMLSpanElement>(null);
  const current = React.useRef<HTMLSpanElement>(null);
  const previous = React.useRef<{ key: string; copy: HTMLElement | null }>({ key: swapKey, copy: null });

  React.useLayoutEffect(() => {
    const before = previous.current;
    const node = current.current;
    const container = host.current;
    previous.current = { key: swapKey, copy: node ? node.cloneNode(true) as HTMLElement : null };
    if (before.key === swapKey || !before.copy || !node || !container || typeof node.animate !== 'function') return;
    const level = documentMotionLevel();
    if (level === 'off') return;
    container.querySelectorAll(':scope > [data-swap-leaving]').forEach(leaving => leaving.remove());
    const leaving = before.copy;
    leaving.className = 'swap-icon-leaving';
    leaving.setAttribute('data-swap-leaving', '');
    leaving.setAttribute('aria-hidden', 'true');
    container.prepend(leaving);
    const shift = level === 'full' ? SHIFT_PX : 0;
    const exit = leaving.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: shift ? `translateY(${-shift}px) scale(.8)` : 'none' }],
      { duration: TWEENS.exit.duration * 1000, easing: `cubic-bezier(${EASE_EXIT.join(', ')})`, fill: 'forwards' },
    );
    void exit.finished.then(() => leaving.remove(), () => leaving.remove());
    const from = !shift ? 'none' : enter === 'settle' ? `translateY(${-shift}px) scale(.6)` : `translateY(${shift}px)`;
    node.animate(
      [{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }],
      { ...springTiming(enter), delay: ENTER_DELAY_MS, fill: 'backwards' },
    );
  }, [swapKey, enter]);

  return <span ref={host} className={cn('swap-icon', className)}>
    <span ref={current} className="swap-icon-current">{children}</span>
  </span>;
}
