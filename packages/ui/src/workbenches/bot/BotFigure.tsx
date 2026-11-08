import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged, type BotAppearance, type BotAppearanceAsset, type BotSummary } from '@varin/application-client';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';
import type { BotFigurePose } from './botPresentation';
import { BotStageRenderer, type BotStageFeed } from './botStageRenderer';
import { DEFAULT_FIGURE_ACCENT, resolveFigureAccent, resolveFigureColor } from './varinFigurePalette';
import { VarinFigureRig } from './varinFigureRig';
import { CustomBotStage } from './customBotStage';
import { BotImageArtwork } from './BotImageArtwork';
import { acquireBotImage, useBotAppearanceAsset, useBotFigureAppearance } from './botAppearanceResources';
import { RiImageLine } from '@remixicon/react';
import './bot-image-figure.css';

/** Below this width the figure shows only the head and holds its pose. */
const COMPACT_BELOW = 40;

/**
 * The Bot's figure (docs/design/bot-ui.md §5.7, docs/design/varin-figure.md): Varin leaning on a
 * window sill. It receives one pose and owns the poses and the motion between them (varinFigureRig).
 * Small sizes only take the pose and never loop; loops stop while the figure is out of sight. Her accent
 * parts follow the theme's accent, as the desktop companion does (varinFigurePalette). The wide panel
 * figure can also carry the stage: her team on the ledge and her reactions (botStageRenderer).
 */
export interface BotFigureProps {
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
  bot?: Pick<BotSummary, 'id' | 'appearance'>;
  botId?: string;
  appearance?: BotAppearance;
  asset?: BotAppearanceAsset;
  /** Large editing preview of the same crop used by small avatars. */
  portrait?: boolean;
  onReady?(ready: boolean): void;
  onError?(message: string): void;
}

export function BotFigure(props: BotFigureProps) {
  const host = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeEndpointGeneration, getRuntimeEndpointGeneration);
  return <BotFigureForHost key={host} {...props} />;
}

function BotFigureForHost(props: BotFigureProps) {
  const inherited = useBotFigureAppearance(!props.bot && !props.appearance ? props.botId : undefined);
  const appearance = props.appearance ?? props.bot?.appearance ?? inherited;
  const assetId = appearance?.kind === 'custom' ? appearance.assetId : '';
  const resource = useBotAppearanceAsset(assetId, props.asset);
  const [prepared, setPrepared] = React.useState<{ appearance: BotAppearance; asset?: BotAppearanceAsset } | null>(null);
  const latestAppearance = React.useRef(appearance); latestAppearance.current = appearance;
  const key = appearance?.kind === 'custom' ? assetId : JSON.stringify(appearance);
  const { onReady, onError } = props;
  React.useEffect(() => {
    if (!appearance || appearance.kind === 'varin') { setPrepared({ appearance: appearance ?? { kind: 'varin', color: 'theme' } }); onReady?.(true); return; }
    onReady?.(false);
    if (!resource.asset) { if (resource.error) onError?.(resource.error); return; }
    let active = true;
    const loaded = acquireBotImage(assetId, resource.asset.image.poster);
    void loaded.promise.then(() => { if (active) { setPrepared({ appearance: latestAppearance.current ?? appearance, asset: resource.asset }); onReady?.(true); } }).catch(error => { if (active) onError?.(String(error)); });
    return () => { active = false; loaded.release(); };
  // The serialized value represents this small immutable profile setting.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, assetId, resource.asset, resource.error, onReady, onError]);
  const shown = appearance?.kind === 'custom'
    ? prepared?.asset?.id === assetId ? { ...prepared, appearance } : prepared
    : { appearance: appearance ?? { kind: 'varin' as const, color: 'theme' } };
  if (shown?.appearance.kind === 'custom' && shown.asset) return <CustomBotFigure {...props} appearance={shown.appearance} asset={shown.asset} />;
  if (shown?.appearance.kind === 'varin' || !assetId) return <BuiltinBotFigure {...props} color={shown?.appearance.kind === 'varin' ? shown.appearance.color : 'theme'} />;
  return <span className={cn('bot-figure bot-image-pending', props.className)} style={{ width: props.wide ? '100%' : props.size, height: props.size }} title={resource.error}><RiImageLine className="size-1/2 text-muted-foreground/40" /></span>;
}

function BuiltinBotFigure({ state, size, still = false, wide = false, stage, className, label, color }: BotFigureProps & { color: string }) {
  const host = React.useRef<HTMLSpanElement>(null);
  const rig = React.useRef<VarinFigureRig | null>(null);
  const scene = React.useRef<BotStageRenderer | null>(null);
  const compact = size < COMPACT_BELOW;
  const posed = still || compact;
  const staged = wide && !posed && stage !== undefined;
  const theme = useOptionalThemeSystem()?.currentTheme;
  const accent = React.useMemo(() => color === 'original' ? DEFAULT_FIGURE_ACCENT : color === 'theme' ? resolveFigureAccent(theme) : resolveFigureColor(color), [theme, color]);
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

function CustomBotFigure({ state, size, still = false, wide = false, stage, className, label, appearance, asset, portrait }: BotFigureProps & { appearance: Extract<BotAppearance, { kind: 'custom' }>; asset: BotAppearanceAsset }) {
  const host = React.useRef<HTMLSpanElement>(null), actor = React.useRef<CustomBotStage | null>(null), scene = React.useRef<BotStageRenderer | null>(null);
  const compact = portrait || size < COMPACT_BELOW, posed = still || compact;
  const staged = wide && !posed && stage !== undefined;
  const theme = useOptionalThemeSystem()?.currentTheme;
  const accent = React.useMemo(() => resolveFigureAccent(theme), [theme]);
  const latest = React.useRef({ state, stage, accent }); latest.current = { state, stage, accent };
  React.useLayoutEffect(() => {
    if (!staged || !host.current) return;
    const rig = new CustomBotStage(host.current, latest.current.state, latest.current.accent, posed);
    const renderer = new BotStageRenderer(rig); actor.current = rig; scene.current = renderer;
    if (latest.current.stage) renderer.update(latest.current.stage);
    return () => { renderer.dispose(); rig.dispose(); actor.current = null; scene.current = null; };
  }, [staged, posed]);
  React.useLayoutEffect(() => { actor.current?.setState(state); }, [state]);
  React.useLayoutEffect(() => { actor.current?.setAccent(accent); }, [accent]);
  React.useLayoutEffect(() => { if (stage) scene.current?.update(stage); }, [stage]);
  return <span ref={host} className={cn('bot-figure bot-custom-figure', className)} data-state={state} data-wide={wide || undefined} data-still={posed || undefined}
    style={{ width: wide ? '100%' : size, height: size }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <span className="bot-custom-body"><BotImageArtwork asset={asset} state={state} compact={compact} still={posed} crop={compact ? appearance.portrait : appearance.figure} /></span>
  </span>;
}
