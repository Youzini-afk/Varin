import { projectPoint } from './varin-splash-camera.js';
import { VARIN_MARK_PATHS, VARIN_MARK_POLYGONS, VARIN_MARK_VIEWBOX_SIZE } from './varin-mark.js';

/**
 * The startup cube projected through its shared camera, including the approved flat mark.
 *
 * The splash keeps a real CSS 3D cube because it has to move. This projection also lets previews show
 * that same object without a CSS 3D scene. Ordinary UI and app icons use varin-mark.ts directly.
 */

const LOGO_EDGE = 96;
const LOGO_HALF_EDGE = LOGO_EDGE / 2;
const LOGO_TOP_Z = LOGO_EDGE;
const LOGO_VIEWBOX_PADDING = 4;

export const LOGO_VIEWBOX = '0 0 100 100';
export const LOGO_GRID_SIZE = 4;

export interface LogoPoint {
  readonly x: number;
  readonly y: number;
}

interface LogoPoint3 extends LogoPoint {
  readonly z: number;
}

const round = (value: number): number => Math.round(value * 1_000) / 1_000;

const RAW_VERTICES = {
  top: { x: -LOGO_HALF_EDGE, y: -LOGO_HALF_EDGE, z: LOGO_TOP_Z },
  left: { x: -LOGO_HALF_EDGE, y: LOGO_HALF_EDGE, z: LOGO_TOP_Z },
  right: { x: LOGO_HALF_EDGE, y: -LOGO_HALF_EDGE, z: LOGO_TOP_Z },
  center: { x: LOGO_HALF_EDGE, y: LOGO_HALF_EDGE, z: LOGO_TOP_Z },
  bottomLeft: { x: -LOGO_HALF_EDGE, y: LOGO_HALF_EDGE, z: 0 },
  bottomRight: { x: LOGO_HALF_EDGE, y: -LOGO_HALF_EDGE, z: 0 },
  bottom: { x: LOGO_HALF_EDGE, y: LOGO_HALF_EDGE, z: 0 },
} as const satisfies Record<string, LogoPoint3>;

const rawProjectedVertices = Object.values(RAW_VERTICES).map(projectPoint);
const rawMinX = Math.min(...rawProjectedVertices.map((point) => point.x));
const rawMaxX = Math.max(...rawProjectedVertices.map((point) => point.x));
const rawMinY = Math.min(...rawProjectedVertices.map((point) => point.y));
const rawMaxY = Math.max(...rawProjectedVertices.map((point) => point.y));
const drawableSize = 100 - LOGO_VIEWBOX_PADDING * 2;
const projectionScale = Math.min(
  drawableSize / (rawMaxX - rawMinX),
  drawableSize / (rawMaxY - rawMinY),
);
const projectionOffsetX = 50 - (rawMinX + rawMaxX) * projectionScale / 2;
const projectionOffsetY = 50 - (rawMinY + rawMaxY) * projectionScale / 2;

/** One splash CSS pixel expressed in the normalized static-logo viewBox. */
export const LOGO_STROKE_WIDTH = round(projectionScale);

const projectLogoPoint = (point: LogoPoint3): LogoPoint => {
  const projected = projectPoint(point);
  return {
    x: round(projected.x * projectionScale + projectionOffsetX),
    y: round(projected.y * projectionScale + projectionOffsetY),
  };
};

/** Named vertices retained for consumers that inspect the mark's projected outline. */
export const LOGO_VERTICES = Object.fromEntries(
  Object.entries(RAW_VERTICES).map(([name, point]) => [name, projectLogoPoint(point)]),
) as Record<keyof typeof RAW_VERTICES, LogoPoint>;

const quadPath = (...points: LogoPoint[]): string =>
  `M${points.map((point) => `${point.x} ${point.y}`).join(' L')} Z`;

export const LOGO_LEFT_FACE_PATH = quadPath(
  LOGO_VERTICES.center,
  LOGO_VERTICES.left,
  LOGO_VERTICES.bottomLeft,
  LOGO_VERTICES.bottom,
);
export const LOGO_RIGHT_FACE_PATH = quadPath(
  LOGO_VERTICES.center,
  LOGO_VERTICES.right,
  LOGO_VERTICES.bottomRight,
  LOGO_VERTICES.bottom,
);
export const LOGO_TOP_FACE_PATH = quadPath(
  LOGO_VERTICES.top,
  LOGO_VERTICES.left,
  LOGO_VERTICES.center,
  LOGO_VERTICES.right,
);

export const LOGO_MARK_PATH = VARIN_MARK_PATHS.join(' ');
export const LOGO_MARK_SCALE = 0.82;
const logoMarkWorldScale = LOGO_MARK_SCALE * LOGO_EDGE / VARIN_MARK_VIEWBOX_SIZE;

/** The splash's top-face glyph after the shared camera projection. */
export const LOGO_PROJECTED_MARK_PATHS = VARIN_MARK_POLYGONS.map((points) =>
  quadPath(...points.map(([x, y]) => projectLogoPoint({
    x: x * logoMarkWorldScale,
    y: y * logoMarkWorldScale,
    z: LOGO_TOP_Z,
  }))),
);
export const LOGO_PROJECTED_MARK_PATH = LOGO_PROJECTED_MARK_PATHS.join(' ');

export const LEFT_FACE_CELL_OPACITIES = [
  0.2, 0.45, 0.15, 0.55,
  0.35, 0.1, 0.5, 0.25,
  0.4, 0.3, 0.45, 0.15,
  0.55, 0.2, 0.35, 0.1,
] as const;

export const RIGHT_FACE_CELL_OPACITIES = [
  0.3, 0.15, 0.45, 0.25,
  0.5, 0.35, 0.1, 0.4,
  0.2, 0.55, 0.3, 0.15,
  0.45, 0.25, 0.4, 0.2,
] as const;

export interface LogoFaceCell {
  readonly path: string;
  readonly row: number;
  readonly col: number;
}

type SplashFace = 'x' | 'y';

/**
 * Reproduce the CSS cube's local face grid before projecting it.
 *
 * The X wall rotates local columns into height while the Y wall rotates local rows into height. Keeping
 * that mapping is what makes the static mosaic identical to the animated cube rather than merely similar.
 */
const generateSplashFaceGrid = (face: SplashFace): LogoFaceCell[] => {
  const cells: LogoFaceCell[] = [];
  const step = LOGO_EDGE / LOGO_GRID_SIZE;
  const worldPoint = (u: number, v: number): LogoPoint3 => face === 'x'
    ? { x: LOGO_HALF_EDGE, y: v, z: LOGO_HALF_EDGE - u }
    : { x: u, y: LOGO_HALF_EDGE, z: LOGO_HALF_EDGE - v };

  for (let row = 0; row < LOGO_GRID_SIZE; row += 1) {
    for (let col = 0; col < LOGO_GRID_SIZE; col += 1) {
      const u1 = -LOGO_HALF_EDGE + col * step;
      const u2 = u1 + step;
      const v1 = -LOGO_HALF_EDGE + row * step;
      const v2 = v1 + step;
      cells.push({
        path: quadPath(
          projectLogoPoint(worldPoint(u1, v1)),
          projectLogoPoint(worldPoint(u2, v1)),
          projectLogoPoint(worldPoint(u2, v2)),
          projectLogoPoint(worldPoint(u1, v2)),
        ),
        row,
        col,
      });
    }
  }

  return cells;
};

export const LOGO_LEFT_FACE_CELLS = generateSplashFaceGrid('y');
export const LOGO_RIGHT_FACE_CELLS = generateSplashFaceGrid('x');

export const leftFaceCellOpacity = (cell: LogoFaceCell): number =>
  LEFT_FACE_CELL_OPACITIES[cell.row * LOGO_GRID_SIZE + cell.col] ?? 0.35;

export const rightFaceCellOpacity = (cell: LogoFaceCell): number =>
  RIGHT_FACE_CELL_OPACITIES[cell.row * LOGO_GRID_SIZE + cell.col] ?? 0.35;
