import { afterEach, describe, expect, test, vi } from 'vitest';
import { VARIN_BUILTIN_TRANSITION_SCENE_EXTENSION } from '@varin/extension-builtins';
import {
  VARIN_WORKBENCH_PROFILE_TRANSITION_SCENE,
  parseVarinTransitionSceneContributionData,
  varinTransitionSceneDuration,
} from '@varin/extension-contract';
import {
  buildAdaptiveSplashTiles,
  createSplashCanvasMountOptions,
  mountSplashTileCanvas,
  resolveSplashCanvasPlayback,
} from './varin-splash-canvas';
import {
  SPLASH_CAMERA_DISTANCE_PX,
  SPLASH_CAMERA_SPIN_DEG,
  SPLASH_CAMERA_TILT_DEG,
  projectFlatFloorPoint,
} from './varin-splash-camera';
import {
  CUBE_EDGE_PX,
  SPLASH_GROUND_ORIGIN_Y_PCT,
  SPLASH_GROUND_VISIBLE_FAR_RISE_PX,
  SPLASH_REDUCED_EXIT_DURATION_MS,
  splashWorkbenchPhaseDurationMs,
} from './varin-splash-lattice';

// Keep viewport coverage, renderer retirement, and the extension duration binding.
// Animation geometry and choreography remain editable presentation choices.

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

describe('the floor covers the window it has to cover', () => {

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

describe('splash lifecycle', () => {

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
});
