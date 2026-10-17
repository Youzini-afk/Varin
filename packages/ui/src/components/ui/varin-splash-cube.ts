import {
  LEFT_FACE_CELL_OPACITIES,
  LOGO_MARK_SCALE,
  RIGHT_FACE_CELL_OPACITIES,
} from './varin-logo-geometry.js';
import { VARIN_MARK_PATHS, VARIN_MARK_SECONDARY_OPACITY, VARIN_MARK_VIEWBOX } from './varin-mark.js';

/**
 * Markup for the one real 3D object in the splash scene.
 *
 * The floor projects a viewport-adaptive field of independently choreographed tiles through one Canvas
 * owner. Only this cube participates in `preserve-3d`, so moving the shared camera reprojects the logo
 * without turning startup into hundreds or thousands of composited DOM or 3D layers.
 *
 * The camera never rotates around the cube, only from its initial tilt to directly overhead. Consequently
 * the same two walls stay visible until they become edge-on; the two permanently hidden walls and the base
 * are intentionally absent rather than paid for and hidden.
 */

const faceCells = (opacities: readonly number[]): string => opacities
  .map((opacity) => `<span class="varin-splash-cube-cell" style="--varin-cube-cell-opacity:${opacity}"></span>`)
  .join('');

export const splashCubeMarkup = (): string => [
  '<span class="varin-splash-cube-face varin-splash-cube-face-top">',
  `<svg class="varin-splash-cube-glyph" viewBox="${VARIN_MARK_VIEWBOX}" aria-hidden="true" focusable="false"><g transform="scale(${LOGO_MARK_SCALE})">${VARIN_MARK_PATHS.map((path, index) => `<path d="${path}" opacity="${index === 0 ? 1 : VARIN_MARK_SECONDARY_OPACITY}"/>`).join('')}</g></svg>`,
  '</span>',
  `<span class="varin-splash-cube-face varin-splash-cube-face-x">${faceCells(RIGHT_FACE_CELL_OPACITIES)}</span>`,
  `<span class="varin-splash-cube-face varin-splash-cube-face-y">${faceCells(LEFT_FACE_CELL_OPACITIES)}</span>`,
].join('');
