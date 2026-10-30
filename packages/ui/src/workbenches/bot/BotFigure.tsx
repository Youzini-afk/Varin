import React from 'react';
import { cn } from '@/lib/utils';
import type { BotFigureState } from './botPresentation';

/**
 * The Bot's figure (docs/design/bot-ui.md §5.7). It receives one state and owns the poses and the
 * transitions between them. This is the placeholder drawing from the design prototype; the final
 * artwork replaces the SVG and keeps the same state contract. Small sizes only take the pose and
 * never loop, and loops pause while the window is hidden (styles/bot.css).
 */
export function BotFigure({ state, size, still = false, className, label }: {
  state: BotFigureState;
  /** Width in px; the drawing keeps its 76:68 proportion. */
  size: number;
  /** Pose only, without looping motion, for the sidebar and title bar. */
  still?: boolean;
  className?: string;
  label?: string;
}) {
  return <span className={cn('bot-figure', className)} data-state={state} data-still={still || size < 40 || undefined}
    style={{ width: size, height: Math.round(size * 68 / 76) }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <i className="bot-figure-glow" />
    {/* Drawn artwork, like an Agent avatar: the button icon reset in index.css leaves its fills alone. */}
    <svg viewBox="0 0 76 68" aria-hidden="true" focusable="false" data-agent-avatar="bot-figure">
      <g className="bot-figure-body">
        <rect className="bot-figure-shell" x="2.5" y="2.5" width="71" height="63" rx="22" />
        <rect className="bot-figure-visor" x="11" y="11" width="54" height="40" rx="14" />
        <g className="bot-figure-eyes">
          <rect className="bot-figure-eye" x="25" y="25" width="8" height="13" rx="4" />
          <rect className="bot-figure-eye" x="43" y="25" width="8" height="13" rx="4" />
        </g>
        <path className="bot-figure-closed" d="M24 32Q29 37 34 32M42 32Q47 37 52 32" />
        <path className="bot-figure-happy" d="M24 34Q29 27 34 34M42 34Q47 27 52 34" />
      </g>
      <g className="bot-figure-zz">
        <text x="62" y="8">z</text>
        <text x="68" y="0" style={{ fontSize: 9 }}>z</text>
        <text x="73" y="-7" style={{ fontSize: 7 }}>z</text>
      </g>
    </svg>
  </span>;
}
