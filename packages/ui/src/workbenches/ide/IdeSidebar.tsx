import { useRef, useState, type ReactNode, type MouseEventHandler } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/** Animates the existing layout weight; content unmounts only after the closing transition. */
export function IdeSidebar({ children, side, weight, resizing, onResize }: {
  children: ReactNode;
  side: 'primary' | 'secondary';
  weight: number;
  resizing: boolean;
  onResize: MouseEventHandler<HTMLDivElement>;
}) {
  const present = useIsPresent();
  const reducedMotion = usePrefersReducedMotion();
  const contentRef = useRef<HTMLDivElement>(null);
  const [heldWidth, setHeldWidth] = useState<number | null>(null);
  return <motion.aside
    className={`${side === 'primary' ? 'ide-primary' : 'ide-agent-canvas'} relative flex min-h-0 min-w-0 flex-col overflow-hidden`}
    initial={{ flexGrow: 0, opacity: 0, paddingLeft: 0 }}
    animate={{ flexGrow: weight, opacity: 1, paddingLeft: side === 'secondary' ? 8 : 0 }}
    exit={{ flexGrow: 0, opacity: 0, paddingLeft: 0 }}
    transition={{ duration: reducedMotion || resizing ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
    onAnimationStart={() => {
      if (present || reducedMotion || resizing) return;
      const width = contentRef.current?.getBoundingClientRect().width;
      // Clip the departing content instead of wrapping its text through a zero-width column.
      if (width) setHeldWidth(current => current ?? width);
    }}
    onAnimationComplete={() => { if (present) setHeldWidth(null); }}
    style={{ flexBasis: 0, flexShrink: 1 }}
    inert={!present} aria-hidden={!present}>
    <div ref={contentRef} className="ide-sidebar-content flex h-full min-h-0 w-full shrink-0 flex-col"
      style={{ width: reducedMotion || resizing ? undefined : heldWidth ?? undefined }}>
      {children}
    </div>
    <div role="separator" aria-orientation="vertical"
      className={`ide-sidebar-resizer absolute inset-y-0 z-20 w-1 cursor-col-resize ${side === 'primary' ? 'right-0' : 'left-0'}`}
      onMouseDown={onResize} />
  </motion.aside>;
}
