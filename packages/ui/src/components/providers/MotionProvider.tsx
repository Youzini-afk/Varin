import React from 'react';
import { MotionConfig } from 'motion/react';
import { useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { applyMotionLevel } from '@/lib/motion/preference';
import { springTransition } from '@/lib/motion/tokens';

const INSTANT = { duration: 0 } as const;
const GLIDE = springTransition('glide');

/**
 * One motion configuration for a React root.
 *
 * It writes `:root[data-motion]` for CSS and gives motion components the shared
 * default transition. Under Reduced or Off, motion skips transform and layout
 * animation; Off also makes the default transition instant. Components that set
 * their own transition read `usePrefersReducedMotion()` as before.
 */
export const MotionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const level = useMotionLevel();
  React.useLayoutEffect(() => applyMotionLevel(level), [level]);
  return <MotionConfig reducedMotion={level === 'full' ? 'never' : 'always'} transition={level === 'off' ? INSTANT : GLIDE}>
    {children}
  </MotionConfig>;
};
