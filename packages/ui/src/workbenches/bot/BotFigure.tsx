import React from 'react';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';
import type { BotFigurePose } from './botPresentation';
import { BotStageRenderer, type BotStageFeed } from './botStageRenderer';
import { resolveFigureAccent } from './varinFigurePalette';
import { VarinFigureRig } from './varinFigureRig';

/** Below this width the figure shows only the head and holds its pose. */
const COMPACT_BELOW = 40;

/**
 * The Bot's figure (docs/design/bot-ui.md §5.7, docs/design/varin-figure.md): Varin leaning on a
 * window sill. It receives one pose and owns the poses and the motion between them (varinFigureRig).
 * Small sizes only take the pose and never loop; loops stop while the figure is out of sight. Her accent
 * parts follow the theme's accent, as the desktop companion does (varinFigurePalette). The wide panel
 * figure can also carry the stage: her team on the ledge and her reactions (botStageRenderer).
 */
export function BotFigure({ state, size, still = false, wide = false, stage, className, label }: {
  state: BotFigurePose;
  /** Width and height in px; with `wide`, the height. */
  size: number;
  /** Fill the container's width, the ledge running edge to edge (the Bot panel's stage). */
  wide?: boolean;
  /** Pose only, without looping motion, for the sidebar and title bar. */
  still?: boolean;
  /** Her team and its moments; only a wide, moving figure has a stage. */
  stage?: BotStageFeed | null;
  className?: string;
  label?: string;
}) {
  const host = React.useRef<HTMLSpanElement>(null);
  const rig = React.useRef<VarinFigureRig | null>(null);
  const scene = React.useRef<BotStageRenderer | null>(null);
  const compact = size < COMPACT_BELOW;
  const posed = still || compact;
  const staged = wide && !posed && stage !== undefined;
  const theme = useOptionalThemeSystem()?.currentTheme;
  const accent = React.useMemo(() => resolveFigureAccent(theme), [theme]);
  const latest = React.useRef(state);
  const latestAccent = React.useRef(accent);
  const latestStage = React.useRef(stage);
  React.useLayoutEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const figure = new VarinFigureRig(element, { state: latest.current, compact, still: posed, wide, accent: latestAccent.current });
    rig.current = figure;
    const team = staged && figure.stageLayers ? new BotStageRenderer(figure) : null;
    scene.current = team;
    if (team && latestStage.current) team.update(latestStage.current);
    return () => { team?.dispose(); scene.current = null; figure.dispose(); rig.current = null; };
  }, [compact, posed, wide, staged]);
  React.useLayoutEffect(() => { latest.current = state; rig.current?.setState(state); }, [state]);
  React.useLayoutEffect(() => { latestAccent.current = accent; rig.current?.setAccent(accent); }, [accent]);
  React.useLayoutEffect(() => { latestStage.current = stage; if (stage) scene.current?.update(stage); }, [stage]);
  return <span ref={host} className={cn('bot-figure', className)} data-state={state} data-still={posed || undefined}
    style={{ width: wide ? '100%' : size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
