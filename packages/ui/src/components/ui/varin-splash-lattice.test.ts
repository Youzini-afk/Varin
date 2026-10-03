import { afterEach, describe, expect, test, vi } from 'vitest';
import { VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION } from '@varin/extension-builtins';
import {
  VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
  parseVarinTransitionSceneContributionData,
  varinTransitionSceneDuration,
} from '@varin/extension-contract';
import { LOGO_GRID_SIZE } from './varin-logo-geometry';
import {
  buildAdaptiveSplashTiles,
  createSplashCanvasMountOptions,
  mountSplashTileCanvas,
  resolveSplashCanvasPlayback,
  splashTileBreathesInCycle,
} from './varin-splash-canvas';
import { splashCubeMarkup } from './varin-splash-cube';
import {
  HORIZON_RISE_PX,
  SPLASH_CAMERA_DISTANCE_PX,
  SPLASH_CAMERA_SPIN_DEG,
  SPLASH_CAMERA_TILT_DEG,
  cameraDepth,
  floorInscribedRadius,
  floorReach,
  projectFlatFloorPoint,
  projectPoint,
} from './varin-splash-camera';
import {
  CUBE_EDGE_PX,
  GROUND_FADE_RISE_PX,
  GROUND_REACH,
  GROUND_REVEAL_RADIUS_PX,
  GROUND_SHAPE,
  SPLASH_GROUND_ORIGIN_Y_PCT,
  SPLASH_GROUND_VISIBLE_FAR_RISE_PX,
  SPLASH_EXIT_DURATION_MS,
  SPLASH_REDUCED_EXIT_DURATION_MS,
  SPLASH_WORKBENCH_QUICK_DURATION_MS,
  splashTilePlaybackTiming,
  splashWorkbenchTileDelays,
  splashWorkbenchPhaseDurationMs,
} from './varin-splash-lattice';

/**
 * What these tests are for.
 *
 * Three earlier versions of this splash looked wrong for a reason no test would have caught, because
 * nothing asserted a relationship between the cube and the floor it was supposed to stand on. Each time
 * the floor was drawn with one set of numbers and the cube with another, and each time it read as a cube
 * hovering in front of a pattern. So these assert relationships, not appearance: that the projection
 * really converges, that the cube's base is one floor cell, and that the Canvas lifecycle leaves the final
 * frame intact until its host is detached.
 */

const SPLASH_TEST_RANDOM_SEED = 0x02f6e2b1;

afterEach(() => { vi.unstubAllGlobals(); });

const buildField = (
  viewportWidth = 1920,
  viewportHeight = 1080,
  overrides: Partial<Parameters<typeof buildAdaptiveSplashTiles>[0]> = {},
) => buildAdaptiveSplashTiles({
  breatheShare: 0,
  cameraDistancePx: SPLASH_CAMERA_DISTANCE_PX,
  cameraSpinDeg: SPLASH_CAMERA_SPIN_DEG,
  cameraTiltDeg: SPLASH_CAMERA_TILT_DEG,
  cellPx: CUBE_EDGE_PX,
  direction: 'forward',
  mode: 'boot',
  originYPct: SPLASH_GROUND_ORIGIN_Y_PCT,
  randomSeed: SPLASH_TEST_RANDOM_SEED,
  viewportHeight,
  viewportWidth,
  visibleFarRisePx: SPLASH_GROUND_VISIBLE_FAR_RISE_PX,
  ...overrides,
});

/**
 * A small 2D Canvas harness for the controller's observable lifecycle. The real mount drives the camera and
 * renderer attributes; this fallback context only supplies the browser calls needed to reach those effects.
 */
const createSplashCanvasHarness = (webgl?: WebGL2RenderingContext) => {
  let now = 0;
  let nextFrameId = 0;
  const pendingFrames = new Map<number, FrameRequestCallback>();
  const cameraValues = new Map<string, string>();
  const splashAttributes = new Map<string, string>();
  const canvasAttributes = new Map<string, string>();

  const context = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    beginPath: () => undefined,
    clearRect: () => undefined,
    closePath: () => undefined,
    fill: () => undefined,
    fillRect: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    lineTo: () => undefined,
    moveTo: () => undefined,
    setTransform: () => undefined,
    stroke: () => undefined,
  };

  const colorContext = {
    clearRect: () => undefined,
    fillRect: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    fillStyle: '',
  };
  const cameraStyle = {
    removeProperty: (name: string) => { cameraValues.delete(name); },
    setProperty: (name: string, value: string) => { cameraValues.set(name, value); },
  };
  const cameraElement = { style: cameraStyle };
  const splashElement = {
    getAttribute: (name: string) => splashAttributes.get(name) ?? null,
    removeAttribute: (name: string) => { splashAttributes.delete(name); },
    setAttribute: (name: string, value: string) => { splashAttributes.set(name, value); },
  };
  const parentElement = {
    append: () => undefined,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
    querySelector: () => cameraElement,
  };
  const view = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    innerHeight: 360,
    innerWidth: 640,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      pendingFrames.set(id, callback);
      return id;
    },
  };
  const document = {
    createElement: (tagName: string) => {
      if (tagName === 'canvas') {
        return {
          getContext: (kind: string) => kind === '2d' ? colorContext : null,
          height: 1,
          width: 1,
        };
      }
      return {
        remove: () => undefined,
        style: { color: '', cssText: '' },
      };
    },
    defaultView: view,
    documentElement: parentElement,
  };
  const canvas = {
    clientHeight: 360,
    clientWidth: 640,
    getContext: (kind: string) => kind === 'webgl2' ? webgl ?? null : kind === '2d' ? context : null,
    isConnected: true,
    ownerDocument: document,
    parentElement,
    closest: () => splashElement,
    removeAttribute: (name: string) => { canvasAttributes.delete(name); },
    setAttribute: (name: string, value: string) => { canvasAttributes.set(name, value); },
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;

  vi.stubGlobal('getComputedStyle', (element: { style: { color: string } }) => ({ color: element.style.color }));
  vi.stubGlobal('performance', { now: () => now, timeOrigin: 0 });
  vi.stubGlobal('requestAnimationFrame', view.requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { pendingFrames.delete(id); });

  return {
    cameraValues,
    canvas,
    canvasAttributes,
    detach: () => { (canvas as unknown as { isConnected: boolean }).isConnected = false; },
    nextFrame: (elapsed: number) => {
      now = elapsed;
      const callbacks = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const callback of callbacks) callback(now);
    },
    splashAttributes,
  };
};

describe('the camera is a perspective camera', () => {
  test('equal steps away from the viewer project to shrinking steps on screen', () => {
    // The property isometric could never have. Without it there is no vanishing point, no size gradient,
    // and nothing to tell the eye whether the plane recedes or tilts up toward it.
    const step = (n: number): number => {
      const near = projectPoint({ x: -n * CUBE_EDGE_PX, y: -n * CUBE_EDGE_PX, z: 0 });
      const far = projectPoint({ x: -(n + 1) * CUBE_EDGE_PX, y: -(n + 1) * CUBE_EDGE_PX, z: 0 });
      return near.y - far.y;
    };

    const steps = [0, 1, 2, 4, 8, 14].map(step);
    for (const [index, value] of steps.entries()) {
      expect(value).toBeGreaterThan(0);
      if (index > 0) expect(value).toBeLessThan(steps[index - 1] as number);
    }
    // Not a token amount of convergence: even after lifting the camera, the far rows are less than a
    // third the depth of the near ones.
    expect(steps.at(-1) as number).toBeLessThan((steps[0] as number) / 3);
  });

  test('the floor origin projects to the origin, so the two coordinate systems share a point', () => {
    expect(projectPoint({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0 });
  });

  test('receding points approach the horizon and never pass it', () => {
    for (const distance of [1_000, 100_000, 10_000_000]) {
      const rise = -projectPoint({ x: -distance, y: -distance, z: 0 }).y;
      expect(rise).toBeLessThan(HORIZON_RISE_PX);
    }
    expect(-projectPoint({ x: -10_000_000, y: -10_000_000, z: 0 }).y)
      .toBeCloseTo(HORIZON_RISE_PX, 0);
  });

  test('height above the floor reads as up the screen and toward the viewer', () => {
    const standing = projectPoint({ x: 0, y: 0, z: CUBE_EDGE_PX });
    expect(standing.y).toBeLessThan(0);
    expect(cameraDepth({ x: 0, y: 0, z: CUBE_EDGE_PX })).toBeGreaterThan(0);
  });

  test('the overhead projection preserves the authored floor scale', () => {
    const xStep = projectFlatFloorPoint({ x: CUBE_EDGE_PX, y: 0 });
    const yStep = projectFlatFloorPoint({ x: 0, y: CUBE_EDGE_PX });
    expect(Math.hypot(xStep.x, xStep.y)).toBeCloseTo(CUBE_EDGE_PX, 8);
    expect(Math.hypot(yStep.x, yStep.y)).toBeCloseTo(CUBE_EDGE_PX, 8);
  });

  test('reach is measured from the corners, which is exact for a projective map', () => {
    // A projective map takes lines to lines, so the image of a rectangle is a quadrilateral and its
    // extremes are its vertices. Sampling the boundary densely must therefore find nothing further out.
    const far = 900;
    const near = 400;
    const reach = floorReach(far, near);

    for (let i = 0; i <= 40; i += 1) {
      const t = -far + ((far + near) * i) / 40;
      for (const point of [
        { x: t, y: -far },
        { x: t, y: near },
        { x: -far, y: t },
        { x: near, y: t },
      ]) {
        const projected = projectPoint({ ...point, z: 0 });
        expect(-projected.y).toBeLessThanOrEqual(reach.farRise + 1e-6);
        expect(projected.y).toBeLessThanOrEqual(reach.nearDrop + 1e-6);
        expect(Math.abs(projected.x)).toBeLessThanOrEqual(reach.halfWidth + 1e-6);
      }
    }
  });
});

describe('the cube stands on the floor', () => {
  const mark = splashCubeMarkup();

  test('a floor cell is exactly the cube base', () => {
    // Not "about the same size". The cube's footprint has to be one cell of the floor, because that is
    // what makes the lines leaving its base corners the floor's own lines rather than a near miss.
    expect(GROUND_SHAPE.cellPx).toBe(CUBE_EDGE_PX);
  });

  test('the origin is a cell centre, not a cell corner', () => {
    // The cube's base is centred on the origin, so a corner there would leave it straddling four cells.
    const offsetInCells = GROUND_SHAPE.offsetPx / GROUND_SHAPE.cellPx;
    expect(offsetInCells % 1).toBe(0.5);
    expect(Math.floor(offsetInCells)).toBe(GROUND_SHAPE.originCell);
  });

  test('the projected base is asymmetric, which is what proves it is not still isometric', () => {
    const half = CUBE_EDGE_PX / 2;
    const nearCorner = projectPoint({ x: half, y: half, z: 0 });
    const farCorner = projectPoint({ x: -half, y: -half, z: 0 });

    // The near corner reaches further from the origin than the far corner. Under a parallel projection
    // these two distances are equal, and that equality is what made the old floor read as tilting up.
    expect(nearCorner.y).toBeGreaterThan(-farCorner.y);
    // Sideways it stays symmetric, because the spin is 45 degrees.
    expect(projectPoint({ x: half, y: -half, z: 0 }).x)
      .toBeCloseTo(-projectPoint({ x: -half, y: half, z: 0 }).x, 6);
  });

  test('only the three faces the camera can see are drawn', () => {
    expect(mark.match(/class="varin-splash-cube-face /g) ?? [])
      .toHaveLength(3);
    expect(mark.match(/class="varin-splash-cube-cell"/g) ?? [])
      .toHaveLength(LOGO_GRID_SIZE ** 2 * 2);
  });

  test('the hidden faces are absent, not merely covered', () => {
    expect(mark).not.toContain('face-bottom');
    expect(mark).not.toContain('face-back');
  });

});

describe('the floor covers the window it has to cover', () => {
  // A share of height above the origin, and the rest below, at each window size.
  const VIEWPORTS: ReadonlyArray<readonly [number, number]> = [
    [390, 700],
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ];

  test.each(VIEWPORTS)('%ix%i: the floor reaches past the sides and the bottom', (width, height) => {
    const originY = height * 0.56;
    expect(GROUND_REACH.halfWidth).toBeGreaterThanOrEqual(width / 2);
    expect(GROUND_REACH.nearDrop).toBeGreaterThanOrEqual(height - originY);
  });

  test('the near corner stays in front of the camera', () => {
    // Past the camera plane the projection divides by zero and the image turns inside out. This is the
    // ceiling on how far the floor may extend toward the viewer, and it is easy to cross by accident.
    const ahead = (GROUND_SHAPE.axis - GROUND_SHAPE.originCell - 0.5) * GROUND_SHAPE.cellPx;
    expect(cameraDepth({ x: ahead, y: ahead, z: 0 })).toBeLessThan(SPLASH_CAMERA_DISTANCE_PX);
    expect(GROUND_REACH.nearDrop).toBeGreaterThan(0);
  });

  test('the camera shows the floor instead of grazing it', () => {
    // The first perspective pass put the camera so low that the foreground drop was five times the far
    // reach. The plane was mathematically correct but read as a wall rising toward the viewer.
    expect(GROUND_REACH.farRise).toBeGreaterThan(500);
    expect(GROUND_REACH.nearDrop / GROUND_REACH.farRise).toBeLessThan(4);
  });

  test('tile count grows with the viewport behind one drawing owner', () => {
    const desktop = buildField(1920, 1080).tiles;
    const ultrawide = buildField(5120, 1440).tiles;
    const eightK = buildField(7680, 4320).tiles;
    expect(desktop.length).toBeGreaterThan(0);
    expect(ultrawide.length).toBeGreaterThan(desktop.length);
    expect(eightK.length).toBeGreaterThan(ultrawide.length);
    expect(new Set(eightK.map((tile) => tile.key)).size).toBe(eightK.length);

  });

  test.each([
    [390, 700],
    [1280, 800],
    [2048, 1024],
    [2550, 1275],
    [3840, 2160],
    [5120, 1440],
    [7680, 4320],
  ] as const)('the adaptive overhead field contains every %ix%i viewport corner', (width, height) => {
    const field = buildField(width, height);
    const minX = (field.minCol - 0.5) * CUBE_EDGE_PX;
    const maxX = (field.maxCol + 0.5) * CUBE_EDGE_PX;
    const minY = (field.minRow - 0.5) * CUBE_EDGE_PX;
    const maxY = (field.maxRow + 0.5) * CUBE_EDGE_PX;
    const outline = [
      projectFlatFloorPoint({ x: minX, y: minY }),
      projectFlatFloorPoint({ x: maxX, y: minY }),
      projectFlatFloorPoint({ x: maxX, y: maxY }),
      projectFlatFloorPoint({ x: minX, y: maxY }),
    ];
    const originY = height * SPLASH_GROUND_ORIGIN_Y_PCT / 100;
    const corners = [
      { x: -width / 2, y: -originY },
      { x: width / 2, y: -originY },
      { x: width / 2, y: height - originY },
      { x: -width / 2, y: height - originY },
    ];
    for (const corner of corners) {
      const crosses = outline.map((point, index) => {
        const next = outline[(index + 1) % outline.length] as typeof point;
        return (next.x - point.x) * (corner.y - point.y)
          - (next.y - point.y) * (corner.x - point.x);
      });
      expect(crosses.every((cross) => cross >= -1e-6)).toBe(true);
    }
  });
});

describe('the splash reveal bounds', () => {
  test('the hole stops inside the region the cells actually pave at full opacity', () => {
    // Two independent bounds, and the reveal has to respect the smaller. Past the floor's outline there
    // are no cells to reveal through; past the horizon ramp the cells are no longer opaque.
    const inscribed = floorInscribedRadius(
      GROUND_SHAPE.offsetPx,
      (GROUND_SHAPE.axis - GROUND_SHAPE.originCell - 0.5) * GROUND_SHAPE.cellPx,
    );
    expect(GROUND_REVEAL_RADIUS_PX).toBeLessThanOrEqual(inscribed);
    expect(GROUND_REVEAL_RADIUS_PX).toBeLessThanOrEqual(GROUND_FADE_RISE_PX);
    expect(GROUND_REVEAL_RADIUS_PX).toBeGreaterThan(CUBE_EDGE_PX);
  });

});

describe('exit choreography', () => {
  test('boot starts at the tile under the cube and ends at the far corner', () => {
    const field = buildField();
    const tiles = field.tiles;
    const atCube = tiles.find((tile) => tile.key === '0:0');
    const delays = tiles.map((tile) => tile.delayMs);

    expect(atCube?.delayMs).toBe(0);
    expect(Math.min(...delays)).toBe(0);
    const furthest = tiles.reduce((best, tile) => (
      Math.hypot(tile.xPx, tile.yPx) > Math.hypot(best.xPx, best.yPx) ? tile : best
    ));
    expect(furthest?.delayMs).toBe(Math.max(...delays));
    expect(atCube?.scatterXPx).toBe(0);
    expect(atCube?.scatterYPx).toBe(0);
    expect(tiles.find((tile) => tile.key === '0:1')?.scatterXPx)
      .toBeGreaterThan(0);
    expect(tiles.find((tile) => tile.key === '-1:0')?.scatterYPx)
      .toBeLessThan(0);
  });

  test('switch closes from the perimeter and reveals from the cube regardless of profile ordering', () => {
    const forwardField = buildField(1920, 1080, { mode: 'switch', direction: 'forward' });
    const backwardField = buildField(1920, 1080, { mode: 'switch', direction: 'backward' });
    const forward = forwardField.tiles;
    const backward = backwardField.tiles;

    expect(backward).toEqual(forward);
    const centre = forward.find((cell) => cell.key === '0:0');
    const furthest = forward.reduce((best, tile) => (
      Math.hypot(tile.xPx, tile.yPx) > Math.hypot(best.xPx, best.yPx) ? tile : best
    ));
    expect(centre).toMatchObject({ delayMs: 0, scatterXPx: 0, scatterYPx: 0 });
    expect(furthest.delayMs).toBe(Math.max(...forward.map((tile) => tile.delayMs)));
    expect(forward.find((cell) => cell.key === '0:1')?.scatterXPx).toBeGreaterThan(0);
    expect(forward.find((cell) => cell.key === '0:-1')?.scatterXPx).toBeLessThan(0);
    expect(forward.find((cell) => cell.key === '1:0')?.scatterYPx).toBeGreaterThan(0);
    expect(forward.find((cell) => cell.key === '-1:0')?.scatterYPx).toBeLessThan(0);

    for (const tempo of ['quick', 'standard'] as const) {
      const centreTiming = splashWorkbenchTileDelays(centre?.delayMs ?? -1, tempo);
      const perimeterTiming = splashWorkbenchTileDelays(furthest.delayMs, tempo);
      expect(perimeterTiming.coverDelayMs).toBeLessThan(centreTiming.coverDelayMs);
      expect(centreTiming.revealDelayMs).toBeLessThan(perimeterTiming.revealDelayMs);
    }
  });

  /**
   * The scene's terminal frame has to survive until its nodes are gone.
   *
   * React runs layout-effect cleanup while the Canvas is still connected and still composited, so every
   * mutation the controller used to make there was a visible one: the DOM camera returned to its authored
   * tilt and stood the cube back up, the camera-owner attribute stopped suppressing the CSS fallback
   * flatten and re-armed it from its own start state, and the renderer attribute stopped suppressing the
   * Canvas's opaque background across the whole viewport. That is the flash, and it is a lifecycle bug
   * rather than anything a browser or a machine decides.
   */
  test('retiring the Canvas leaves a connected scene untouched', async () => {
    const harness = createSplashCanvasHarness();
    const playback = resolveSplashCanvasPlayback({
      mode: 'switch',
      phase: 'covered',
      reducedMotion: false,
      tempo: 'standard',
    });
    const options = createSplashCanvasMountOptions({
      breathe: false,
      direction: 'forward',
      mode: 'switch',
      playback,
    });
    const controller = mountSplashTileCanvas(harness.canvas, options);

    expect(harness.splashAttributes.get('data-varin-camera-owner')).toBe('canvas');
    expect(harness.canvasAttributes.get('data-varin-splash-renderer')).toBe('2d');
    expect(harness.cameraValues.get(options.camera.tiltProperty)).toBe(`${SPLASH_CAMERA_TILT_DEG}deg`);

    controller.dispose();
    await Promise.resolve();

    // Cleanup is deferred while the Canvas remains in the composed scene, so its last frame and camera
    // ownership stay intact through the whole connected interval.
    expect(harness.splashAttributes.get('data-varin-camera-owner')).toBe('canvas');
    expect(harness.canvasAttributes.get('data-varin-splash-renderer')).toBe('2d');
    expect(harness.cameraValues.get(options.camera.tiltProperty)).toBe(`${SPLASH_CAMERA_TILT_DEG}deg`);

    harness.detach();
    harness.nextFrame(0);
    expect(harness.splashAttributes.has('data-varin-camera-owner')).toBe(false);
    expect(harness.canvasAttributes.has('data-varin-splash-renderer')).toBe(false);
    expect(harness.cameraValues.has(options.camera.tiltProperty)).toBe(false);
  });

  test('WebGL retirement releases owned objects without forcing the compositor context to be lost', async () => {
    const loseContext = vi.fn();
    const deleteBuffer = vi.fn();
    const deleteProgram = vi.fn();
    const deleteVertexArray = vi.fn();
    const noop = () => undefined;
    const allocate = () => ({});
    const gl = {
      MAX_RENDERBUFFER_SIZE: 0x84e8,
      MAX_VIEWPORT_DIMS: 0x0d3a,
      attachShader: noop, bindBuffer: noop, bindVertexArray: noop, blendFunc: noop,
      bufferData: noop, bufferSubData: noop, clear: noop, clearColor: noop, compileShader: noop,
      createBuffer: allocate, createProgram: allocate, createShader: allocate, createVertexArray: allocate,
      deleteBuffer, deleteProgram, deleteShader: noop, deleteVertexArray,
      disable: noop, drawArraysInstanced: noop, enable: noop, enableVertexAttribArray: noop,
      getExtension: () => ({ loseContext }),
      getParameter: (parameter: number) => parameter === 0x84e8 ? 4096 : new Int32Array([4096, 4096]),
      getProgramParameter: () => true, getShaderParameter: () => true, getUniformLocation: allocate,
      linkProgram: noop, shaderSource: noop, uniform1f: noop, uniform2f: noop, uniform4fv: noop,
      useProgram: noop, vertexAttribDivisor: noop, vertexAttribPointer: noop, viewport: noop,
    } as unknown as WebGL2RenderingContext;
    const harness = createSplashCanvasHarness(gl);
    const controller = mountSplashTileCanvas(harness.canvas, createSplashCanvasMountOptions({
      breathe: false,
      direction: 'forward',
      mode: 'boot',
      playback: resolveSplashCanvasPlayback({ mode: 'boot', reducedMotion: false, tempo: 'standard' }),
    }));
    expect(harness.canvasAttributes.get('data-varin-splash-renderer')).toBe('webgl2');

    controller.dispose();
    await Promise.resolve();
    expect(deleteProgram).not.toHaveBeenCalled();
    harness.detach();
    harness.nextFrame(0);
    expect(deleteBuffer).toHaveBeenCalledTimes(1);
    expect(deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(deleteProgram).toHaveBeenCalledTimes(1);
    expect(loseContext).not.toHaveBeenCalled();
  });

  test('the camera reaches true overhead in one motion before the floor opens', () => {
    const timing = splashTilePlaybackTiming('standard');
    expect(timing.cameraDelayMs + timing.cameraDurationMs).toBeLessThan(timing.releaseMs);

    const harness = createSplashCanvasHarness();
    const playback = resolveSplashCanvasPlayback({
      mode: 'switch',
      phase: 'revealing',
      reducedMotion: false,
      tempo: 'standard',
    });
    const options = createSplashCanvasMountOptions({
      breathe: false,
      direction: 'forward',
      mode: 'switch',
      playback,
    });
    const controller = mountSplashTileCanvas(harness.canvas, options);
    const readTilt = (): number => Number.parseFloat(harness.cameraValues.get(options.camera.tiltProperty) ?? 'NaN');
    const cameraEnd = timing.cameraDelayMs + timing.cameraDurationMs;

    harness.nextFrame(cameraEnd - 1);
    expect(readTilt()).toBeGreaterThan(0);
    harness.nextFrame(cameraEnd);
    expect(readTilt()).toBeLessThan(1e-4);
    harness.nextFrame(timing.releaseMs);
    expect(readTilt()).toBeLessThan(1e-4);

    harness.detach();
    controller.dispose();
  });

  test('every delay stays within the budget the exit duration is built from', () => {
    for (const mode of ['boot', 'switch'] as const) {
      for (const cell of buildField(5120, 1440, { mode }).tiles) {
        expect(cell.delayMs).toBeGreaterThanOrEqual(0);
        expect(cell.delayMs).toBeLessThanOrEqual(520);
      }
    }
  });

  test('workbench covering is the exact time reversal of revealing at both tempos', () => {
    const cells = buildField(1920, 1080, { mode: 'switch' }).tiles;
    for (const tempo of ['quick', 'standard'] as const) {
      const timings = cells.map((cell) => splashWorkbenchTileDelays(cell.delayMs, tempo));
      const mirroredSums = new Set(timings.map((timing) => timing.coverDelayMs + timing.revealDelayMs));
      expect(mirroredSums.size).toBe(1);
      const firstReveal = timings.reduce((best, timing) => (
        timing.revealDelayMs < best.revealDelayMs ? timing : best
      ));
      const firstCover = timings.reduce((best, timing) => (
        timing.coverDelayMs < best.coverDelayMs ? timing : best
      ));
      expect(firstReveal.coverDelayMs).toBeGreaterThan(firstCover.coverDelayMs);
      expect(firstCover.revealDelayMs).toBeGreaterThan(firstReveal.revealDelayMs);
    }
  });

  test('quick workbench playback keeps every phase and the accepted transition duration', () => {
    expect(splashWorkbenchPhaseDurationMs('quick')).toBe(SPLASH_WORKBENCH_QUICK_DURATION_MS);
    expect(splashWorkbenchPhaseDurationMs('standard')).toBe(SPLASH_EXIT_DURATION_MS);
    expect(splashWorkbenchPhaseDurationMs('quick', true)).toBe(SPLASH_REDUCED_EXIT_DURATION_MS);
  });

  test('the built-in extension declares the exact duration of the scene it renders', () => {
    const contribution = VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION.manifest.contributions?.[0];
    expect(contribution?.kind).toBe('transition-scene');
    const data = parseVarinTransitionSceneContributionData(contribution?.data);
    for (const phase of ['covering', 'revealing'] as const) {
      for (const tempo of ['quick', 'standard'] as const) {
        expect(varinTransitionSceneDuration(data, {
          phase,
          reducedMotion: false,
          scene: VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
          tempo,
        })).toBe(splashWorkbenchPhaseDurationMs(tempo));
      }
      expect(varinTransitionSceneDuration(data, {
        phase,
        reducedMotion: true,
        scene: VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
        tempo: 'standard',
      })).toBe(SPLASH_REDUCED_EXIT_DURATION_MS);
    }
  });

  test('breathing is opt-in, changes cells between cycles, and reaches the real far tiles', () => {
    const none = buildField(5120, 1440, { breatheShare: 0 }).tiles;
    expect(none.every((cell) => cell.breatheDelayMs === null)).toBe(true);

    const all = buildField(5120, 1440, { breatheShare: 1 }).tiles;
    expect(all.every((cell) => cell.breatheDelayMs !== null)).toBe(true);

    const normal = buildField(5120, 1440, { breatheShare: 0.1 }).tiles;
    expect(normal).toEqual(buildField(5120, 1440, { breatheShare: 0.1 }).tiles);
    expect(normal.every((cell) => cell.breatheDelayMs !== null)).toBe(true);

    const activeKeys = (cycleIndex: number): string[] => normal
      .filter((cell) => splashTileBreathesInCycle(
        cell.row,
        cell.col,
        cycleIndex,
        0.1,
        SPLASH_TEST_RANDOM_SEED,
      ))
      .map((cell) => cell.key);
    const firstCycle = activeKeys(0);
    const secondCycle = activeKeys(1);
    expect(firstCycle.length).toBeGreaterThan(0);
    expect(firstCycle.length).toBeLessThan(normal.length);
    expect(secondCycle).not.toEqual(firstCycle);

    const farRadius = Math.max(...normal.map((cell) => Math.hypot(cell.xPx, cell.yPx)));
    const farCells = normal.filter((cell) => Math.hypot(cell.xPx, cell.yPx) === farRadius);
    expect(farCells.some((cell) => Array.from({ length: 32 }, (_, cycle) => cycle).some((cycle) => (
      splashTileBreathesInCycle(cell.row, cell.col, cycle, 0.1, SPLASH_TEST_RANDOM_SEED)
    )))).toBe(true);
  });
});
