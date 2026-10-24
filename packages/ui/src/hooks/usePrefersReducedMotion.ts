import React from 'react';
import { resolveMotionLevel, type MotionLevel } from '@/lib/motion/preference';
import { useUIStore } from '@/stores/useUIStore';

const QUERY = '(prefers-reduced-motion: reduce)';

/** The operating system preference alone. */
export const prefersSystemReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
};

/** Effective motion level outside React: the Appearance choice lowered by the OS preference. */
export const currentMotionLevel = (): MotionLevel =>
  resolveMotionLevel(useUIStore.getState().motionPreference, prefersSystemReducedMotion());

/**
 * Read the reduced-motion preference outside React.
 *
 * True when the user chose Reduced or Off in Appearance, or when the OS asks for
 * reduced motion. Returns `false` without `matchMedia` and with the default
 * preference, because a server or test environment cannot know it.
 */
export const prefersReducedMotion = (): boolean => currentMotionLevel() !== 'full';

const useSystemReducedMotion = (): boolean => {
  const [reduced, setReduced] = React.useState(prefersSystemReducedMotion);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    const apply = () => setReduced(media.matches);
    apply();
    // Safari below 14 exposes only the deprecated listener API.
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    media.addListener(apply);
    return () => media.removeListener(apply);
  }, []);

  return reduced;
};

/** Subscribe to the effective motion level: `full`, `reduced` or `off`. */
export const useMotionLevel = (): MotionLevel => {
  const preference = useUIStore(state => state.motionPreference);
  return resolveMotionLevel(preference, useSystemReducedMotion());
};

/**
 * Subscribe to the reduced-motion preference.
 *
 * CSS keyed on `:root[data-motion]` and `@media (prefers-reduced-motion: reduce)`
 * covers anything expressible as a stylesheet rule. This hook is for the cases CSS
 * cannot reach: choosing not to mount an animated subtree, or skipping a timed
 * sequence entirely rather than running it with its animations disabled.
 */
export const usePrefersReducedMotion = (): boolean => useMotionLevel() !== 'full';
