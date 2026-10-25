import React from 'react';
import { MotionConfig } from 'motion/react';
import { useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { trackPageVisibility } from '@/lib/motion/loops';
import { applyMotionLevel } from '@/lib/motion/preference';
import { INSTANT_TRANSITION, springTransition } from '@/lib/motion/tokens';

const GLIDE = springTransition('glide');

/**
 * One motion configuration for a React root.
 *
 * It writes `:root[data-motion]` for CSS (and `data-page-hidden`, which pauses
 * loops while the window is hidden) and gives motion components the shared
 * default transition. Under Reduced or Off, motion skips transform and layout
 * animation; Off also makes the default transition instant. Components that set
 * their own transition read `usePrefersReducedMotion()` as before.
 */
export const MotionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const level = useMotionLevel();
  React.useLayoutEffect(() => applyMotionLevel(level), [level]);
  React.useEffect(() => { trackPageVisibility(); }, []);
  return <MotionConfig reducedMotion={level === 'full' ? 'never' : 'always'} transition={level === 'off' ? INSTANT_TRANSITION : GLIDE}>
    {children}
  </MotionConfig>;
};
