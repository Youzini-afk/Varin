import React from 'react';
import { useMotionValue } from 'motion/react';

/** Keep the dock's place and authored corner radius while its live editor expands. */
export function useComposerExpansion(
  shellRef: React.RefObject<HTMLElement | null>,
  frameRef: React.RefObject<HTMLElement | null>,
  expanded: boolean,
  reducedMotion: boolean,
) {
  const slotRef = React.useRef<HTMLDivElement>(null);
  const dockedHeight = React.useRef(0);
  const isExpanded = React.useRef(expanded);
  const radius = useMotionValue<string | number>('var(--radius-composer)');

  React.useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const measure = () => { if (!isExpanded.current) dockedHeight.current = shell.offsetHeight; };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(shell);
    return () => observer?.disconnect();
  }, [shellRef]);

  React.useLayoutEffect(() => {
    isExpanded.current = expanded;
    if (slotRef.current) slotRef.current.style.height = expanded ? `${dockedHeight.current}px` : '';
    if (!expanded && shellRef.current) dockedHeight.current = shellRef.current.offsetHeight;
  }, [expanded, shellRef]);

  React.useLayoutEffect(() => {
    if (reducedMotion || !frameRef.current) return;
    // Projection needs pixels to counter-scale corners; the CSS token still supplies the radius.
    const value = Number.parseFloat(getComputedStyle(frameRef.current).borderTopLeftRadius);
    if (Number.isFinite(value)) radius.set(value);
  }, [frameRef, radius, reducedMotion]);

  return { slotRef, radius };
}
