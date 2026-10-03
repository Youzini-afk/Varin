import {
  CAMERA_DYNAMIC_FLOOR_TRANSFORM,
  CAMERA_FLAT_FLOOR_TRANSFORM,
  floorInscribedRadius,
  floorReach,
  HORIZON_RISE_PX,
} from './varin-splash-camera';
import { WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE } from '../../lib/workbench/transition-paint-handoff';

/**
 * The splash floor: a grid put into the camera's floor plane, with the cube standing on one of its cells.
 *
 * The floor and the mark agree because one Canvas frame owns both camera samples. It projects the floor and
 * writes the same tilt into the mark's small preserve-3d camera before paint. A cell is exactly the cube's
 * edge with the cube's base centred on one cell, so the cube's footprint *is* a floor cell and the lines
 * leaving its base corners are the floor's own lines.
 *
 * The floor keeps one Canvas owner and projects an adaptive tile field through the same camera arithmetic,
 * so every visible tile keeps independent motion without promoting hundreds or thousands of DOM elements
 * while startup and Shell activation compete for the renderer.
 */

export type VarinSplashMode = 'boot' | 'switch';
export type VarinSplashDirection = 'forward' | 'backward';
export type VarinSplashPhase = 'covering' | 'covered' | 'revealing';
export type VarinSplashTempo = 'quick' | 'standard';
export const VARIN_SPLASH_STYLE_ELEMENT_ID = 'varin-splash-styles';

/**
 * Cube edge in pixels, and therefore the floor's cell size, which is what registers the two.
 *
 * One value for every viewport, not a breakpoint pair. A floor cell is a size in the scene, so on a
 * narrow viewport the right answer is fewer cells on screen rather than smaller ones — and a fixed edge
 * is what lets every host use the same scene geometry without a breakpoint-specific logo.
 */
export const CUBE_EDGE_PX = 96;

/**
 * Cells behind the cube and in front of it, along each floor axis.
 *
 * Wildly asymmetric on purpose. Receding cells compress toward the horizon, so covering the screen above
 * the origin takes many of them; approaching cells magnify, so a few cover everything below. Stretching
 * the floor equally in both directions would push its near corner through the camera and invert it.
 *
 * `BEHIND` stops well short of the horizon, because the rows there are already about a tenth as tall on
 * screen as the first one and hundreds more would buy nothing. The floor is faded out before that edge
 * instead — see `GROUND_FADE_RISE_PX`.
 *
 * `AHEAD` has a hard ceiling near thirteen: past that the near corner passes the camera plane, the
 * projection divides by zero and the image turns inside out. Nine leaves room and still puts the near
 * corner well below any window's bottom edge.
 *
 * These numbers now describe the contact footprint and reveal atmosphere, not a maximum tile field. The
 * Canvas renderer inverse-projects the actual viewport and allocates however many cells that composition
 * needs, so larger windows gain cells instead of stretching one fixed 24×24 board.
 */
const GROUND_CELLS_BEHIND = 14;
const GROUND_CELLS_AHEAD = 9;

/**
 * The visible field extends farther toward the horizon than the old contact geometry. These rows are real
 * Canvas tiles — not a repeating-gradient continuation — so they breathe and disperse like every nearer
 * row. The horizon mask stops only after their projected cells cease to be useful visual structure.
 */
const VISUAL_GROUND_CELLS_BEHIND = 28;

/** Cells per axis: the ones behind, the cube's own, and the ones in front. */
const GROUND_AXIS = GROUND_CELLS_BEHIND + 1 + GROUND_CELLS_AHEAD;
/** Floor-space extent from the origin, in each of the two directions. */
const GROUND_BEHIND_PX = (GROUND_CELLS_BEHIND + 0.5) * CUBE_EDGE_PX;
const GROUND_AHEAD_PX = (GROUND_CELLS_AHEAD + 0.5) * CUBE_EDGE_PX;
const VISUAL_GROUND_BEHIND_PX = (VISUAL_GROUND_CELLS_BEHIND + 0.5) * CUBE_EDGE_PX;

/** Where the cube stands, as a share of viewport height. Low enough to leave the far floor room. */
export const SPLASH_GROUND_ORIGIN_Y_PCT = 56;

export interface GroundShape {
  /** Cells per axis. */
  readonly axis: number;
  /** Cell edge in pixels, equal to the cube's edge. */
  readonly cellPx: number;
  /** Zero-based row and column of the cell the cube stands on. */
  readonly originCell: number;
  /**
   * Pre-transform offset that puts the cube's base centre on the floor's origin.
   *
   * Half a cell past a whole number of cells, because the cube's base is centred on the origin, so the
   * origin has to be a cell's centre and not a corner. Anchoring on a corner instead is what made the
   * cube straddle four cells in an earlier attempt.
   */
  readonly offsetPx: number;
}

/**
 * Fixed contact geometry for the cube and the reveal atmosphere.
 *
 * This is no longer the rendered tile count. It keeps the cube footprint, contact pulse and reveal radius
 * registered to the historical camera composition; the Canvas renderer measures the viewport separately
 * and derives its own min/max floor coordinates.
 */
export const GROUND_SHAPE: GroundShape = {
  axis: GROUND_AXIS,
  cellPx: CUBE_EDGE_PX,
  originCell: GROUND_CELLS_BEHIND,
  offsetPx: GROUND_BEHIND_PX,
};

/** How far the floor's extremes land from the origin on screen, under the shared camera. */
export const GROUND_REACH = floorReach(GROUND_BEHIND_PX, GROUND_AHEAD_PX);
const VISUAL_GROUND_REACH = floorReach(VISUAL_GROUND_BEHIND_PX, GROUND_AHEAD_PX);

/**
 * Where the floor stops being drawn and where it starts fading into the background, both as screen pixels
 * above the origin.
 *
 * The far edge is a real edge, and on a tall window it lands mid-screen, so it has to be faded rather
 * than merely masked at the periphery. The ramp covers the last few rows, which are the ones already too
 * compressed to read as separate cells — which is what a horizon looks like anyway.
 */
const GROUND_FADE_ROWS = 4;
export const GROUND_EDGE_RISE_PX = GROUND_REACH.farRise;
export const GROUND_FADE_RISE_PX = floorReach(
  GROUND_BEHIND_PX - GROUND_FADE_ROWS * CUBE_EDGE_PX,
  GROUND_AHEAD_PX,
).farRise;
const VISUAL_GROUND_EDGE_RISE_PX = VISUAL_GROUND_REACH.farRise;
const VISUAL_GROUND_FADE_RISE_PX = floorReach(
  VISUAL_GROUND_BEHIND_PX - GROUND_FADE_ROWS * CUBE_EDGE_PX,
  GROUND_AHEAD_PX,
).farRise;
/** Viewport-normalized peripheral fade: solid nearby, gently atmospheric at every screen edge. */
const GROUND_PERIPHERAL_FADE_START_PCT = 30;
const GROUND_PERIPHERAL_FADE_MID_PCT = 68;
const GROUND_PERIPHERAL_FADE_END_PCT = 100;
const GROUND_PERIPHERAL_UNMASK_PCT = 160;

/** The last screen-space row the adaptive Canvas needs to project before the horizon mask reaches zero. */
export const SPLASH_GROUND_VISIBLE_FAR_RISE_PX = Math.round(VISUAL_GROUND_EDGE_RISE_PX * 1e6) / 1e6;

/**
 * How far from the cube's feet the exit reveals the app tile by tile.
 *
 * The floor's tiles are the cover inside this radius: they are opaque, so as each one shrinks away the
 * app shows through the hole it leaves. That only works where the screen is actually paved with tiles at
 * full opacity, which bounds the radius twice over — by the floor's projected outline, which is a
 * quadrilateral and cannot reach the corners of a rectangular window, and by the horizon ramp, past which
 * the cells are no longer opaque enough to hide anything.
 *
 * Beyond it the backdrop is the cover and resolves with a fade instead. That is the same region the
 * peripheral falloff already treats as atmosphere, so a soft edge there is in keeping.
 */
export const GROUND_REVEAL_RADIUS_PX = Math.floor(Math.min(
  floorInscribedRadius(GROUND_BEHIND_PX, GROUND_AHEAD_PX),
  GROUND_FADE_RISE_PX,
));

const TILE_EXIT_MS = 520;
const MARK_EXIT_MS = 960;
/** The cube makes contact just before the first floor tile starts moving. */
const BOOT_TILE_RELEASE_MS = 860;
const FLOOR_FLATTEN_DELAY_MS = 40;
const FLOOR_FLATTEN_MS = 520;
/** The camera finishes its move first; only then does the cube travel through the floor. */
const CUBE_PRESS_START_PCT = 58;
const CUBE_CONTACT_PCT = 92;
/** The real cube faces are gone before its floor cell opens, so the buried mark cannot shine through. */
const CUBE_FACE_FADE_START_PCT = 72;
const CUBE_FACE_FADE_END_PCT = 86;
const CUBE_PRESS_DELAY_MS = Math.round(MARK_EXIT_MS * CUBE_PRESS_START_PCT / 100);
/** The contact light ends exactly as the centre tile is released. */
const CONTACT_PRESS_MS = BOOT_TILE_RELEASE_MS - CUBE_PRESS_DELAY_MS;
/** Widest per-tile delay either mode schedules. */
const MAX_TILE_DELAY_MS = 520;

/** How long a caller must keep the splash mounted after asking it to leave. */
export const SPLASH_EXIT_DURATION_MS = Math.max(
  BOOT_TILE_RELEASE_MS + MAX_TILE_DELAY_MS + TILE_EXIT_MS,
  MARK_EXIT_MS,
);
/** The reduced-motion path replaces every staged animation with one fade of the whole cover. */
export const SPLASH_REDUCED_EXIT_DURATION_MS = 260;

/**
 * The reveal's own timings.
 *
 * The hole opens roughly as fast as the tile wave travels, so a tile has usually gone by the time the
 * hole reaches it; the backdrop then fades once the hole has stopped growing, and finishes before the
 * outermost tiles do, so those are seen coming apart against the app rather than against flat colour.
 */
const REVEAL_MS = 480;
const BACKDROP_FADE_MS = 260;
/** Soft edge on the hole. Wide enough not to read as a circle, narrow enough not to leak past the cells. */
const REVEAL_EDGE_PX = 64;

/**
 * Fast workbench playback keeps the duration already accepted for profile switching instead of inventing
 * a new short cutoff, while still playing every camera, cube, contact, and floor keyframe in the full
 * mirrored sequence.
 */
export const SPLASH_WORKBENCH_QUICK_DURATION_MS = MAX_TILE_DELAY_MS + TILE_EXIT_MS;
const WORKBENCH_QUICK_SCALE = SPLASH_WORKBENCH_QUICK_DURATION_MS / SPLASH_EXIT_DURATION_MS;

interface SplashTimeline {
  readonly backdropFadeMs: number;
  readonly tileExitMs: number;
  readonly contactDelayMs: number;
  readonly contactPressMs: number;
  readonly floorDelayMs: number;
  readonly floorDurationMs: number;
  readonly markExitMs: number;
  readonly maxTileDelayMs: number;
  readonly revealMs: number;
  readonly statusOutMs: number;
  readonly tileReleaseMs: number;
  readonly totalMs: number;
}

const timelineAt = (scale: number): SplashTimeline => {
  const at = (value: number): number => Math.round(value * scale);
  return {
    backdropFadeMs: at(BACKDROP_FADE_MS),
    tileExitMs: at(TILE_EXIT_MS),
    contactDelayMs: at(CUBE_PRESS_DELAY_MS),
    contactPressMs: at(CONTACT_PRESS_MS),
    floorDelayMs: at(FLOOR_FLATTEN_DELAY_MS),
    floorDurationMs: at(FLOOR_FLATTEN_MS),
    markExitMs: at(MARK_EXIT_MS),
    maxTileDelayMs: at(MAX_TILE_DELAY_MS),
    revealMs: at(REVEAL_MS),
    statusOutMs: at(180),
    tileReleaseMs: at(BOOT_TILE_RELEASE_MS),
    totalMs: at(SPLASH_EXIT_DURATION_MS),
  };
};

const WORKBENCH_TIMELINES: Readonly<Record<VarinSplashTempo, SplashTimeline>> = {
  quick: timelineAt(WORKBENCH_QUICK_SCALE),
  standard: timelineAt(1),
};

export const splashWorkbenchPhaseDurationMs = (
  tempo: VarinSplashTempo,
  reducedMotion = false,
): number => reducedMotion ? SPLASH_REDUCED_EXIT_DURATION_MS : WORKBENCH_TIMELINES[tempo].totalMs;

export interface SplashTilePlaybackTiming {
  readonly cameraDelayMs: number;
  readonly cameraDurationMs: number;
  readonly exitMs: number;
  readonly maxDelayMs: number;
  readonly releaseMs: number;
  readonly totalMs: number;
}

export const splashTilePlaybackTiming = (
  tempo: VarinSplashTempo,
): SplashTilePlaybackTiming => {
  const timeline = WORKBENCH_TIMELINES[tempo];
  const exactMaxDelayMs = Math.max(0, timeline.totalMs - timeline.tileReleaseMs - timeline.tileExitMs);
  return {
    cameraDelayMs: timeline.floorDelayMs,
    cameraDurationMs: timeline.floorDurationMs,
    exitMs: timeline.tileExitMs,
    // Scaling every base delay into the exact remaining interval avoids a one-millisecond rounding spill
    // in quick playback and keeps covering a true time reversal of revealing.
    maxDelayMs: exactMaxDelayMs,
    releaseMs: timeline.tileReleaseMs,
    totalMs: timeline.totalMs,
  };
};

export const splashWorkbenchTileDelays = (
  delayMs: number,
  tempo: VarinSplashTempo,
): { coverDelayMs: number; revealDelayMs: number } => {
  const timeline = WORKBENCH_TIMELINES[tempo];
  const exactMaxDelayMs = Math.max(0, timeline.totalMs - timeline.tileReleaseMs - timeline.tileExitMs);
  const scaledDelay = Math.round(delayMs * exactMaxDelayMs / MAX_TILE_DELAY_MS);
  const revealDelayMs = timeline.tileReleaseMs + scaledDelay;
  return {
    // Exact global time reversal: the tile that finishes last while revealing begins first while covering.
    coverDelayMs: Math.max(0, timeline.totalMs - revealDelayMs - timeline.tileExitMs),
    revealDelayMs,
  };
};

/**
 * Geometry for the floor element.
 *
 * `transform-origin: 0 0` pins the element's own origin wherever the stylesheet positions it, and the
 * translate, applied before the camera, slides the grid so the cube's cell centre is the point that
 * lands there.
 */
const CAMERA_STYLE = {
  transform: `${CAMERA_DYNAMIC_FLOOR_TRANSFORM} scale(1)`,
  flattenedTransform: `${CAMERA_FLAT_FLOOR_TRANSFORM} scale(1)`,
} as const;

const GROUND_STYLE = {
  height: `${GROUND_SHAPE.axis * GROUND_SHAPE.cellPx}px`,
  transform: `translate(${-GROUND_SHAPE.offsetPx}px, ${-GROUND_SHAPE.offsetPx}px)`,
  width: `${GROUND_SHAPE.axis * GROUND_SHAPE.cellPx}px`,
} as const;

export interface SplashPlaneColors {
  /**
   * The cover's own background. Not optional: a splash whose job is to hide an unpainted frame cannot
   * be transparent, and each host's background comes from a different source.
   */
  readonly background: string;
  /** Floor line colour. Strong enough to read: an early attempt used 12% and vanished. */
  readonly line: string;
  /** Fill a breathing cell reaches at the top of its pulse. */
  readonly cell: string;
  /** Translucent wash over an opaque cube face. Used only when the host draws the mark. */
  readonly face?: string;
  /** Highlight colour for the cube's 4×4 wall cells. Used only when the host draws the mark. */
  readonly markCell?: string;
  /**
   * Ink for the mark and the status line. Omitted by hosts that draw no mark, which is also the only
   * case where it goes unused.
   */
  readonly stroke?: string;
}

/** Keeps the first application frame on the splash palette while the splash node is being detached. */
export const SPLASH_HANDOFF_ATTRIBUTE = 'data-varin-splash-handoff';

/**
 * Varin's own splash palette.
 *
 * Every colour is a `--splash-*` custom property that `packages/web/index.html` sets before paint from
 * the persisted theme. Reading the live theme instead would let the mark follow a theme change that the
 * floor and the background could not, and a cover that is half one palette and half another looks broken
 * in a way that a cover uniformly in one palette does not.
 *
 * Shared rather than restated per host so the two that embed generated output can be compared against
 * it exactly.
 */
export const VARIN_SPLASH_COLORS: SplashPlaneColors = {
  background: 'var(--splash-background, var(--color-background, #151313))',
  line: 'var(--splash-lattice-line, rgba(255, 255, 255, 0.22))',
  // Kept faint, and opaque: the cells are the cover, so a translucent pulse would open a hole in it at
  // every peak. The token is the background with a little ink mixed in rather than ink over transparency,
  // and the fallback is the plain background, so a host that forgets to define it loses the pulse instead
  // of the cover.
  cell: 'var(--splash-cell-pulse, var(--splash-background, #151313))',
  face: 'var(--splash-face-fill)',
  markCell: 'var(--splash-cell-fill)',
  stroke: 'var(--splash-stroke)',
};

/**
 * The splash's visual rules, as one string.
 *
 * The React component calls this while `index.html` and `mini-chat.html` embed its output verbatim.
 * Geometry tests assert those copies still equal it exactly.
 *
 * Emitted without leading indentation so an embedded copy can match character for character.
 */
export const splashPlaneCss = (
  colors: SplashPlaneColors,
  options: { withMark: boolean },
): string => {
  const ink = colors.stroke ?? colors.line;
  const face = colors.face ?? colors.cell;
  const markCell = colors.markCell ?? ink;

  const workbenchPhaseRules = options.withMark
    ? (Object.entries(WORKBENCH_TIMELINES) as Array<[VarinSplashTempo, SplashTimeline]>)
      .map(([tempo, timeline]) => {
        const revealFadeDelay = timeline.tileReleaseMs + timeline.revealMs;
        const coverFloorDelay = timeline.totalMs - timeline.floorDelayMs - timeline.floorDurationMs;
        const coverMarkDelay = timeline.totalMs - timeline.markExitMs;
        const coverOpenDelay = timeline.totalMs - timeline.tileReleaseMs - timeline.revealMs;
        const coverFadeDelay = timeline.totalMs - revealFadeDelay - timeline.backdropFadeMs;
        const coverContactDelay = timeline.totalMs - timeline.contactDelayMs - timeline.contactPressMs;
        const coverStatusDelay = timeline.totalMs - timeline.statusOutMs;
        const covering = `.varin-splash[data-mode='switch'][data-phase='covering'][data-tempo='${tempo}']`;
        const revealing = `.varin-splash[data-mode='switch'][data-phase='revealing'][data-tempo='${tempo}']`;
        return `
${covering} {
animation: varin-splash-floor-mask ${timeline.floorDurationMs}ms ${coverFloorDelay}ms steps(1, end) both;
}
${revealing} {
pointer-events: none;
animation: varin-splash-floor-unmask ${timeline.floorDurationMs}ms ${timeline.floorDelayMs}ms steps(1, end) both;
}
${covering} .varin-splash-phase-clock,
${revealing} .varin-splash-phase-clock {
animation-duration: ${timeline.totalMs}ms;
animation-timing-function: linear;
animation-fill-mode: both;
}
${covering} .varin-splash-phase-clock { animation-name: varin-splash-cover-clock; }
${revealing} .varin-splash-phase-clock { animation-name: varin-splash-reveal-clock; }
${covering} .varin-splash-backdrop {
animation:
varin-splash-open ${timeline.revealMs}ms ${coverOpenDelay}ms cubic-bezier(0.25, 0.6, 0.3, 1) reverse both,
varin-splash-backdrop-out ${timeline.backdropFadeMs}ms ${coverFadeDelay}ms ease reverse both;
}
${revealing} .varin-splash-backdrop {
animation:
varin-splash-open ${timeline.revealMs}ms ${timeline.tileReleaseMs}ms cubic-bezier(0.25, 0.6, 0.3, 1) both,
varin-splash-backdrop-out ${timeline.backdropFadeMs}ms ${revealFadeDelay}ms ease both;
}
${covering}:not([data-varin-camera-owner='canvas']) .varin-splash-camera {
animation: varin-splash-camera-flatten ${timeline.floorDurationMs}ms ${coverFloorDelay}ms cubic-bezier(0.4, 0, 0.2, 1) reverse both;
}
${revealing}:not([data-varin-camera-owner='canvas']) .varin-splash-camera {
animation: varin-splash-camera-flatten ${timeline.floorDurationMs}ms ${timeline.floorDelayMs}ms cubic-bezier(0.4, 0, 0.2, 1) both;
}
${covering} .varin-splash-mark {
animation: varin-splash-mark-press ${timeline.markExitMs}ms ${coverMarkDelay}ms cubic-bezier(0.3, 0, 0.2, 1) reverse both;
}
${revealing} .varin-splash-mark {
animation: varin-splash-mark-press ${timeline.markExitMs}ms cubic-bezier(0.3, 0, 0.2, 1) both;
}
${covering} .varin-splash-cube-face {
animation: varin-splash-cube-bury ${timeline.markExitMs}ms ${coverMarkDelay}ms linear reverse both;
}
${revealing} .varin-splash-cube-face {
animation: varin-splash-cube-bury ${timeline.markExitMs}ms linear both;
}
${covering} .varin-splash-ground::after {
animation: varin-splash-contact-press ${timeline.contactPressMs}ms ${coverContactDelay}ms cubic-bezier(0.3, 0, 0.2, 1) reverse both;
}
${revealing} .varin-splash-ground::after {
animation: varin-splash-contact-press ${timeline.contactPressMs}ms ${timeline.contactDelayMs}ms cubic-bezier(0.3, 0, 0.2, 1) both;
}
${covering} .varin-splash-status {
animation: varin-splash-status-out ${timeline.statusOutMs}ms ${coverStatusDelay}ms ease reverse both;
}
${revealing} .varin-splash-status {
animation: varin-splash-status-out ${timeline.statusOutMs}ms ease both;
}`;
      })
      .join('\n')
    : '';

  const markRules = options.withMark
    ? `
/* Unlike the old pre-projected SVG, this is a small real cube inside the floor's camera. Only its three
   visible faces participate in preserve-3d; the floor remains one flattened layer, so moving the camera
   reprojects the logo without promoting the entire tile field behind it. */
.varin-splash-mark {
position: absolute;
left: -${CUBE_EDGE_PX / 2}px;
top: -${CUBE_EDGE_PX / 2}px;
width: ${CUBE_EDGE_PX}px;
height: ${CUBE_EDGE_PX}px;
transform-style: preserve-3d;
transform: translateZ(${CUBE_EDGE_PX / 2}px);
}
.varin-splash-cube-face {
position: absolute;
inset: 0;
box-sizing: border-box;
display: grid;
grid-template-columns: repeat(4, 1fr);
grid-template-rows: repeat(4, 1fr);
backface-visibility: hidden;
background-color: ${colors.background};
background-image: linear-gradient(${face}, ${face});
box-shadow: inset 0 0 0 1px ${ink};
}
.varin-splash-cube-face-top { display: block; transform: translateZ(${CUBE_EDGE_PX / 2}px); }
.varin-splash-cube-face-x { transform: rotateY(90deg) translateZ(${CUBE_EDGE_PX / 2}px); }
.varin-splash-cube-face-y { transform: rotateX(-90deg) translateZ(${CUBE_EDGE_PX / 2}px); }
.varin-splash-cube-cell {
background: ${markCell};
opacity: var(--varin-cube-cell-opacity);
}
.varin-splash-cube-glyph {
display: block;
width: 100%;
height: 100%;
overflow: visible;
fill: ${ink};
animation: varin-splash-glyph-pulse 1.8s ease-in-out infinite;
}
@keyframes varin-splash-glyph-pulse {
0%, 100% { filter: drop-shadow(0 0 0 transparent); }
50% { filter: drop-shadow(0 0 4px ${ink}); }
}
/* The one animated floor element during the wait state is the cube's own footprint. It is positioned in
   floor coordinates and receives the same camera as every cell, so the glyph pulse has a physical answer
   on the plane rather than a separate screen-space glow. */
.varin-splash:not([data-mode='switch']) .varin-splash-ground::after,
.varin-splash[data-mode='switch'][data-phase] .varin-splash-ground::after {
content: '';
position: absolute;
left: ${GROUND_SHAPE.offsetPx - CUBE_EDGE_PX / 2}px;
top: ${GROUND_SHAPE.offsetPx - CUBE_EDGE_PX / 2}px;
box-sizing: border-box;
width: ${CUBE_EDGE_PX}px;
height: ${CUBE_EDGE_PX}px;
pointer-events: none;
background: ${colors.background};
box-shadow: inset 0 0 0 1px ${ink};
opacity: 0.32;
animation: varin-splash-contact-pulse 1.8s ease-in-out infinite;
}
@keyframes varin-splash-contact-pulse {
0%, 100% { opacity: 0.22; background: ${colors.background}; }
50% { opacity: 0.72; background: ${colors.cell}; }
}
.varin-splash-status {
position: absolute;
left: 50%;
top: calc(${SPLASH_GROUND_ORIGIN_Y_PCT}% + 52px);
translate: -50% 0;
min-height: 1rem;
max-width: 32ch;
font-size: 11px;
font-weight: 600;
letter-spacing: 0.11em;
text-transform: uppercase;
text-align: center;
color: ${ink};
opacity: 0;
animation: varin-splash-status-in 480ms 700ms ease both;
}
@keyframes varin-splash-status-in { to { opacity: 0.5; } }
.varin-splash:not([data-mode='switch'])[data-leaving='true'] .varin-splash-mark {
animation: varin-splash-mark-press ${MARK_EXIT_MS}ms cubic-bezier(0.3, 0, 0.2, 1) both;
}
.varin-splash:not([data-mode='switch'])[data-leaving='true'] .varin-splash-cube-face {
animation: varin-splash-cube-bury ${MARK_EXIT_MS}ms linear both;
}
.varin-splash[data-leaving='true'] .varin-splash-cube-glyph {
animation: none;
filter: none;
}
.varin-splash[data-mode='switch'][data-phase] .varin-splash-cube-glyph {
animation: none;
filter: none;
}
.varin-splash[data-mode='switch'][data-leaving='true'] .varin-splash-mark {
animation: varin-splash-mark-out ${MARK_EXIT_MS}ms 60ms cubic-bezier(0.4, 0, 0.3, 1) both;
}
.varin-splash[data-leaving='true'] .varin-splash-status {
animation: varin-splash-status-out 180ms ease both;
}
.varin-splash:not([data-mode='switch'])[data-leaving='true'] .varin-splash-ground::after {
animation: varin-splash-contact-press ${CONTACT_PRESS_MS}ms ${CUBE_PRESS_DELAY_MS}ms cubic-bezier(0.3, 0, 0.2, 1) both;
}
@keyframes varin-splash-mark-press {
0%, ${CUBE_PRESS_START_PCT}% { transform: translateZ(${CUBE_EDGE_PX / 2}px); }
${CUBE_CONTACT_PCT}% { transform: translateZ(${-CUBE_EDGE_PX / 2}px); }
100% { transform: translateZ(${-CUBE_EDGE_PX / 2 - 6}px); }
}
@keyframes varin-splash-cube-bury {
0%, ${CUBE_FACE_FADE_START_PCT}% { opacity: 1; }
${CUBE_FACE_FADE_END_PCT}%, 100% { opacity: 0; }
}
@keyframes varin-splash-contact-press {
0% { opacity: 0.35; transform: scale(1); }
50% { opacity: 0.95; transform: scale(0.9); }
100% { opacity: 0; transform: scale(1.18); }
}
@keyframes varin-splash-mark-out {
to { opacity: 0; }
}
@keyframes varin-splash-status-out {
to { opacity: 0; transform: translateY(5px); }
}`
    : '';

  const reducedMarkRules = options.withMark
    ? `,
.varin-splash[data-leaving='true'] .varin-splash-mark,
.varin-splash:not([data-mode='switch'])[data-leaving='true'] .varin-splash-cube-face,
.varin-splash[data-leaving='true'] .varin-splash-status,
.varin-splash:not([data-mode='switch']) .varin-splash-ground::after,
.varin-splash-cube-glyph,
.varin-splash-status`
    : '';

  const reducedStatusRule = options.withMark
    ? `
.varin-splash-status { opacity: 0.5; }`
    : '';

  const reducedWorkbenchSelectors = options.withMark
    ? `,
.varin-splash[data-mode='switch'][data-phase],
.varin-splash[data-mode='switch'][data-phase] .varin-splash-backdrop,
.varin-splash[data-mode='switch'][data-phase] .varin-splash-camera,
.varin-splash[data-mode='switch'][data-phase] .varin-splash-mark,
.varin-splash[data-mode='switch'][data-phase] .varin-splash-cube-face,
.varin-splash[data-mode='switch'][data-phase] .varin-splash-ground::after,
.varin-splash[data-mode='switch'][data-phase] .varin-splash-status`
    : '';

  const reducedWorkbenchRules = options.withMark
    ? `
.varin-splash[data-mode='switch'][data-phase='covering'] {
opacity: 0;
animation: varin-splash-cover-fade ${SPLASH_REDUCED_EXIT_DURATION_MS}ms ease both;
}
.varin-splash[data-mode='switch'][data-phase='revealing'] {
opacity: 1;
animation: varin-splash-reveal-fade ${SPLASH_REDUCED_EXIT_DURATION_MS}ms ease both;
}
.varin-splash[data-mode='switch'][data-phase] .varin-splash-phase-clock {
animation-duration: ${SPLASH_REDUCED_EXIT_DURATION_MS}ms;
animation-timing-function: linear;
animation-fill-mode: both;
}
.varin-splash[data-mode='switch'][data-phase='covering'] .varin-splash-phase-clock { animation-name: varin-splash-cover-clock; }
.varin-splash[data-mode='switch'][data-phase='revealing'] .varin-splash-phase-clock { animation-name: varin-splash-reveal-clock; }
@keyframes varin-splash-cover-fade { to { opacity: 1; } }
@keyframes varin-splash-reveal-fade { to { opacity: 0; } }`
    : '';

  // Percentages are measured on an explicit viewport-shaped ellipse. The same progress therefore reaches
  // the horizontal and vertical edges on ultrawide, portrait, and ordinary windows; pixel-radius circles
  // made the left and right disappear much earlier on wide screens.
  const floorMask = `var(--varin-splash-floor-mask, ${GROUND_PERIPHERAL_FADE_START_PCT}%)`;
  const falloff = [
    `rgba(0,0,0,1) ${floorMask}`,
    `rgba(0,0,0,0.78) calc(${floorMask} + ${GROUND_PERIPHERAL_FADE_MID_PCT - GROUND_PERIPHERAL_FADE_START_PCT}%)`,
    `rgba(0,0,0,0.46) calc(${floorMask} + ${GROUND_PERIPHERAL_FADE_END_PCT - GROUND_PERIPHERAL_FADE_START_PCT}%)`,
  ].join(', ');
  const vignette = `radial-gradient(ellipse 50% ${SPLASH_GROUND_ORIGIN_Y_PCT}% at 50% ${SPLASH_GROUND_ORIGIN_Y_PCT}%, ${falloff})`;
  const hole = `radial-gradient(circle at 50% ${SPLASH_GROUND_ORIGIN_Y_PCT}%, rgba(0,0,0,0) var(--varin-splash-open, 0px), rgba(0,0,0,1) calc(var(--varin-splash-open, 0px) + ${REVEAL_EDGE_PX}px))`;

  return `
/* Keep the application's canvas opaque throughout compositor retirement. Once its theme is present,
   use that live background; the captured splash palette belongs only to the splash itself. */
html:root[${SPLASH_HANDOFF_ATTRIBUTE}='true'],
html:root[${WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE}='true'],
html:root[${SPLASH_HANDOFF_ATTRIBUTE}='true'] body,
html:root[${WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE}='true'] body,
html:root[${SPLASH_HANDOFF_ATTRIBUTE}='true'] #root,
html:root[${WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE}='true'] #root,
html:root.desktop-runtime[${SPLASH_HANDOFF_ATTRIBUTE}='true'] body,
html:root.desktop-runtime[${WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE}='true'] body,
html:root.desktop-runtime[${SPLASH_HANDOFF_ATTRIBUTE}='true'] #root,
html:root.desktop-runtime[${WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE}='true'] #root {
background: var(--surface-background, ${colors.background}) !important;
background-color: var(--surface-background, ${colors.background}) !important;
}
.varin-splash {
position: fixed;
inset: 0;
z-index: 9998;
overflow: hidden;
}
.varin-splash[data-leaving='true'] { pointer-events: none; }
.varin-splash[data-mode='switch'][data-phase='revealing'] { pointer-events: none; }

/* The cover is the floor's cells, not this element.
   That is the whole exit: each cell is opaque, so when one shrinks away the app shows through the gap it
   leaves, and the staggered delays turn that into a wave travelling out from the cube's feet. An opaque
   container would have made the same wave reveal nothing — the lines would vanish and the screen would
   stay a flat colour until the element was removed, which is a hard cut. */
/* A registered custom property, so it interpolates. Read with a zero fallback too: without @property the
   hole never opens and the backdrop resolves with its fade alone, which is the previous behaviour rather
   than a hole in the middle of the cover. */
@property --varin-splash-open {
syntax: '<length>';
inherits: false;
initial-value: 0px;
}
@property --varin-splash-floor-mask {
syntax: '<percentage>';
inherits: true;
initial-value: ${GROUND_PERIPHERAL_FADE_START_PCT}%;
}
@property --varin-splash-horizon-lift {
syntax: '<length>';
inherits: true;
initial-value: 0px;
}
.varin-splash:not([data-mode='switch'])[data-leaving='true'] {
animation: varin-splash-floor-unmask ${FLOOR_FLATTEN_MS}ms ${FLOOR_FLATTEN_DELAY_MS}ms steps(1, end) both;
}
@keyframes varin-splash-floor-unmask {
from {
--varin-splash-floor-mask: ${GROUND_PERIPHERAL_FADE_START_PCT}%;
--varin-splash-horizon-lift: 0px;
}
to {
--varin-splash-floor-mask: ${GROUND_PERIPHERAL_UNMASK_PCT}%;
--varin-splash-horizon-lift: 160vmax;
}
}
@keyframes varin-splash-floor-mask {
from {
--varin-splash-floor-mask: ${GROUND_PERIPHERAL_UNMASK_PCT}%;
--varin-splash-horizon-lift: 160vmax;
}
to {
--varin-splash-floor-mask: ${GROUND_PERIPHERAL_FADE_START_PCT}%;
--varin-splash-horizon-lift: 0px;
}
}
/* The floor is a quadrilateral in projection and a window is a rectangle, so the cells cannot cover the
   screen's corners. The backdrop covers everything they miss, and the hole opens from the cube's feet so
   that where the cells *are* the cover, they are the only cover. */
.varin-splash-backdrop {
position: absolute;
inset: 0;
background: ${colors.background};
-webkit-mask-image: ${hole};
mask-image: ${hole};
}
/* Boot only, which is also the default: the three hosts that paint before any module is evaluated set no
   mode, and boot is the only thing they cover. Workbench transitions use explicit phase rules above;
   the leaving flag on a switch is only a compatibility fade and does not own their concentric choreography. */
.varin-splash:not([data-mode='switch'])[data-leaving='true'] .varin-splash-backdrop {
animation:
varin-splash-open ${REVEAL_MS}ms ${BOOT_TILE_RELEASE_MS}ms cubic-bezier(0.25, 0.6, 0.3, 1) both,
varin-splash-backdrop-out ${BACKDROP_FADE_MS}ms ${BOOT_TILE_RELEASE_MS + REVEAL_MS}ms ease both;
}
.varin-splash[data-mode='switch'][data-leaving='true'] .varin-splash-backdrop {
animation: varin-splash-backdrop-out ${REVEAL_MS + BACKDROP_FADE_MS}ms ease both;
}
@keyframes varin-splash-open {
to { --varin-splash-open: ${GROUND_REVEAL_RADIUS_PX}px; }
}
@keyframes varin-splash-backdrop-out {
to { opacity: 0; }
}

/* Two fades, on two untransformed wrappers, because they answer two different questions and a mask
   applies in its own element's coordinate space. Masking the floor itself meant a local circle came out
   a sheared ellipse once the camera had run, and the screen's corners were cut first: the floor visibly
   stopped short of them. Nesting instead multiplies the two alphas without needing mask-composite. */
.varin-splash-ground-clip {
position: absolute;
inset: 0;
overflow: hidden;
-webkit-mask-image: ${vignette};
mask-image: ${vignette};
}
/* The horizon. Receding floor points crowd toward a line ${Math.round(HORIZON_RISE_PX)}px above the
   origin and never reach it, so a floor drawn to any finite depth always ends somewhere, and on a tall
   window that end lands mid-screen where the peripheral fade cannot reach it. Anchoring the ramp to the
   origin's own percentage keeps it in place at every window size. */
.varin-splash-horizon {
position: absolute;
inset: 0;
overflow: hidden;
-webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0) calc(${SPLASH_GROUND_ORIGIN_Y_PCT}% - ${Math.round(VISUAL_GROUND_EDGE_RISE_PX)}px - var(--varin-splash-horizon-lift, 0px)), rgba(0,0,0,1) calc(${SPLASH_GROUND_ORIGIN_Y_PCT}% - ${Math.round(VISUAL_GROUND_FADE_RISE_PX)}px - var(--varin-splash-horizon-lift, 0px)));
mask-image: linear-gradient(to bottom, rgba(0,0,0,0) calc(${SPLASH_GROUND_ORIGIN_Y_PCT}% - ${Math.round(VISUAL_GROUND_EDGE_RISE_PX)}px - var(--varin-splash-horizon-lift, 0px)), rgba(0,0,0,1) calc(${SPLASH_GROUND_ORIGIN_Y_PCT}% - ${Math.round(VISUAL_GROUND_FADE_RISE_PX)}px - var(--varin-splash-horizon-lift, 0px)));
}
/* The adaptive Canvas owns the live tilt and writes it here in the same rAF that draws the floor. The
   fallback value is the authored idle camera, so the cube remains valid before the controller mounts. */
.varin-splash-camera {
position: absolute;
left: 50%;
top: ${SPLASH_GROUND_ORIGIN_Y_PCT}%;
transform-origin: 0 0;
transform-style: preserve-3d;
transform: ${CAMERA_STYLE.transform};
}
.varin-splash:not([data-mode='switch']):not([data-varin-camera-owner='canvas'])[data-leaving='true'] .varin-splash-camera {
animation: varin-splash-camera-flatten ${FLOOR_FLATTEN_MS}ms ${FLOOR_FLATTEN_DELAY_MS}ms cubic-bezier(0.4, 0, 0.2, 1) both;
}
@keyframes varin-splash-camera-flatten {
to { transform: ${CAMERA_STYLE.flattenedTransform}; }
}
/* The logical ground remains in the shared camera only as the cube's registered contact footprint. The
   adaptive tile field is a viewport Canvas beside this camera and performs the same projection itself. */
.varin-splash-ground {
position: absolute;
left: 0;
top: 0;
transform-origin: 0 0;
width: ${GROUND_STYLE.width};
height: ${GROUND_STYLE.height};
transform: ${GROUND_STYLE.transform};
}
/* The runtime projects an adaptive field of real tiles into this one viewport Canvas. Its opaque fallback
   keeps startup covered if neither renderer can start; it deliberately draws no fake far-field tiles. */
.varin-splash-ground-canvas {
position: absolute;
inset: 0;
display: block;
width: 100%;
height: 100%;
pointer-events: none;
background-color: ${colors.background};
}
.varin-splash-ground-canvas[data-varin-splash-renderer] {
background: none;
}
${markRules}
${options.withMark ? `
.varin-splash-phase-clock {
position: absolute;
width: 0;
height: 0;
opacity: 0;
pointer-events: none;
}
@keyframes varin-splash-cover-clock {
from { opacity: 0; }
to { opacity: 0.001; }
}
@keyframes varin-splash-reveal-clock {
from { opacity: 0; }
to { opacity: 0.001; }
}
.varin-splash[data-mode='switch'][data-phase='covered'] .varin-splash-status {
opacity: 0.5;
animation: none;
}
${workbenchPhaseRules}` : ''}

/* Reduced motion drops the staged animation for one fade of the whole cover. It must still show the
   cover: hiding it would put the unpainted first frame back. */
@media (prefers-reduced-motion: reduce) {
.varin-splash:not([data-mode='switch'])[data-leaving='true'],
.varin-splash:not([data-mode='switch'])[data-leaving='true'] .varin-splash-camera${reducedWorkbenchSelectors},
.varin-splash[data-leaving='true'] .varin-splash-backdrop,
.varin-splash:not([data-mode='switch'])[data-leaving='true'] .varin-splash-backdrop${reducedMarkRules} {
animation: none;
}${reducedStatusRule}${reducedWorkbenchRules}
.varin-splash { transition: opacity ${SPLASH_REDUCED_EXIT_DURATION_MS}ms ease; }
.varin-splash[data-leaving='true'] { opacity: 0; }
}
`;
};
