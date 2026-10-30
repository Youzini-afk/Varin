import React from 'react';
import { documentMotionLevel } from '@/lib/motion/preference';

/** Flashes once when `active` turns on for a new token, then lets the row return to rest (§5.3). */
export function useFlash(active: boolean, token: number | undefined): string | undefined {
  const [flashing, setFlashing] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!active || token === undefined) return undefined;
    setFlashing(token);
    const timer = setTimeout(() => setFlashing(current => current === token ? null : current), 1150);
    return () => clearTimeout(timer);
  }, [active, token]);
  return flashing !== null && flashing === token ? 'bot-flash' : undefined;
}

/** Scrolls a focused row into view inside its pane. */
export function useScrollIntoFocus(ref: React.RefObject<HTMLElement | null>, active: boolean, token: number | undefined): void {
  React.useEffect(() => {
    if (!active || token === undefined) return;
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: documentMotionLevel() === 'full' ? 'smooth' : 'auto' });
  }, [ref, active, token]);
}
