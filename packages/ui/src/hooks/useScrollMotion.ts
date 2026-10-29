import React from 'react';
import { installScrollMotion } from '@/lib/motion/scroll';

export function useScrollMotion(ref: React.RefObject<HTMLElement | null>, enabled = true): void {
  React.useLayoutEffect(() => {
    const viewport = ref.current;
    if (enabled && viewport) return installScrollMotion(viewport);
  }, [ref, enabled]);
}
