/**
 * Workbench lattice wave (docs/design/motion-and-interaction.md §3.11): geometry and timing.
 *
 * Square cells grow out of the Workbench switcher in order of distance until they cover the window,
 * the Profile commits underneath, and a second wave takes them away. Everything here is plain arithmetic
 * so the scene (WorkbenchLatticeScene) and the declared durations in extension-builtins share one source.
 */

export type LatticePhase = 'covering' | 'revealing';

/** Marks the Workbench switcher in either Shell's title bar; the waves start from its centre. */
export const WORKBENCH_SWITCHER_ATTRIBUTE = 'data-varin-workbench-switcher';

/** The cell edge the design is drawn at; larger windows use larger cells so the count stays bounded. */
export const LATTICE_MIN_CELL_PX = 44;
export const LATTICE_MAX_CELL_PX = 96;
/** About a 1920×1080 window at 44px. Each animating cell is its own compositor layer. */
export const LATTICE_MAX_CELLS = 1100;
/** The nearest cell starts at 0, the farthest this much later. */
export const LATTICE_SPREAD_MS = 230;
export const LATTICE_COVER_CELL_MS = 150;
export const LATTICE_REVEAL_CELL_MS = 170;
/** Reduced motion: the cover fades in and out instead. */
export const LATTICE_REDUCED_MS = 160;
/**
 * Declared durations are Core's hard clock for a phase, armed after the scene mounts. The scene
 * completes each phase itself when its animations finish; the headroom keeps a slow first frame
 * from letting the clock commit the Profile before the last cell has closed.
 */
export const LATTICE_CLOCK_HEADROOM_MS = 200;
/** A cover held longer than this (the target Shell is still preparing) says what it is doing. */
export const LATTICE_HOLD_NOTICE_MS = 600;
/** Cells overlap their neighbours slightly so a closed lattice has no hairline seams. */
export const LATTICE_CLOSED_SCALE = 1.03;

export const latticePhaseMs = (phase: LatticePhase, reducedMotion: boolean): number => {
  if (reducedMotion) return LATTICE_REDUCED_MS;
  return LATTICE_SPREAD_MS + (phase === 'covering' ? LATTICE_COVER_CELL_MS : LATTICE_REVEAL_CELL_MS);
};

/** What the built-in Transition Scene declares to Core for each phase. */
export const latticeDeclaredDurationMs = (phase: LatticePhase, reducedMotion: boolean): number => (
  latticePhaseMs(phase, reducedMotion) + LATTICE_CLOCK_HEADROOM_MS
);

export interface LatticePoint {
  x: number;
  y: number;
}

export interface LatticeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LatticePlan {
  cellPx: number;
  cols: number;
  rows: number;
  /** Row-major: each cell centre's distance from the origin over the farthest one, 0–1. */
  reach: Float32Array;
}

export function latticeCellPx(width: number, height: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  // The area estimate ignores the overhanging last row and column, so step up until they fit too.
  let cellPx = Math.max(LATTICE_MIN_CELL_PX, Math.ceil(Math.sqrt((w * h) / LATTICE_MAX_CELLS)));
  while (cellPx < LATTICE_MAX_CELL_PX && Math.ceil(w / cellPx) * Math.ceil(h / cellPx) > LATTICE_MAX_CELLS) cellPx += 1;
  return Math.min(LATTICE_MAX_CELL_PX, cellPx);
}

/** Lays a grid over `width`×`height` (the last row and column may overhang) and orders it from `origin`. */
export function planLattice(width: number, height: number, origin: LatticePoint): LatticePlan {
  const cellPx = latticeCellPx(width, height);
  const cols = Math.max(1, Math.ceil(width / cellPx));
  const rows = Math.max(1, Math.ceil(height / cellPx));
  const reach = new Float32Array(cols * rows);
  let farthest = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const distance = Math.hypot(col * cellPx + cellPx / 2 - origin.x, row * cellPx + cellPx / 2 - origin.y);
      reach[row * cols + col] = distance;
      if (distance > farthest) farthest = distance;
    }
  }
  if (farthest > 0) for (let index = 0; index < reach.length; index += 1) reach[index] /= farthest;
  return { cellPx, cols, rows, reach };
}

/**
 * When a cell starts. Covering always spreads outward from the switcher. Revealing spreads outward
 * when moving forward through the Profiles and closes back toward the switcher when returning.
 */
export const latticeDelayMs = (reach: number, inward = false): number => (
  (inward ? 1 - reach : reach) * LATTICE_SPREAD_MS
);

/**
 * The switcher's centre in `bounds`, else a recent press, else the top centre (a window without a
 * title-bar switcher, such as mobile, switches from a menu or a sheet).
 */
export function latticeOrigin(
  bounds: LatticeRect,
  anchor: LatticeRect | null,
  pointer: LatticePoint | null,
): LatticePoint {
  const clamp = (point: LatticePoint): LatticePoint => ({
    x: Math.min(Math.max(point.x, 0), bounds.width),
    y: Math.min(Math.max(point.y, 0), bounds.height),
  });
  if (anchor && anchor.width > 0 && anchor.height > 0) {
    return clamp({
      x: anchor.left + anchor.width / 2 - bounds.left,
      y: anchor.top + anchor.height / 2 - bounds.top,
    });
  }
  if (pointer) return clamp({ x: pointer.x - bounds.left, y: pointer.y - bounds.top });
  return { x: bounds.width / 2, y: 0 };
}
