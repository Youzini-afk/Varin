import React from 'react';
import { cn } from '@/lib/utils';
import type { BotFigureState } from './botPresentation';
import { VarinFigureRig } from './varinFigureRig';

/** Below this width the figure shows only the head and holds its pose. */
const COMPACT_BELOW = 40;

/**
 * The Bot's figure (docs/design/bot-ui.md §5.7, docs/design/varin-figure.md): Varin leaning on a
 * window sill. It receives one state and owns the poses and the motion between them (varinFigureRig).
 * Small sizes only take the pose and never loop; loops stop while the figure is out of sight.
 */
export function BotFigure({ state, size, still = false, wide = false, className, label }: {
  state: BotFigureState;
  /** Width and height in px; with `wide`, the height. */
  size: number;
  /** Fill the container's width, the ledge running edge to edge (the Bot panel's stage). */
  wide?: boolean;
  /** Pose only, without looping motion, for the sidebar and title bar. */
  still?: boolean;
  className?: string;
  label?: string;
}) {
  const host = React.useRef<HTMLSpanElement>(null);
  const rig = React.useRef<VarinFigureRig | null>(null);
  const compact = size < COMPACT_BELOW;
  const posed = still || compact;
  const latest = React.useRef(state);
  React.useLayoutEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const figure = new VarinFigureRig(element, { state: latest.current, compact, still: posed, wide });
    rig.current = figure;
    return () => { figure.dispose(); rig.current = null; };
  }, [compact, posed, wide]);
  React.useLayoutEffect(() => { latest.current = state; rig.current?.setState(state); }, [state]);
  return <span ref={host} className={cn('bot-figure', className)} data-state={state} data-still={posed || undefined}
    style={{ width: wide ? '100%' : size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
