/// <reference lib="dom" />

import {
  SPLASH_CAMERA_DISTANCE_PX,
  SPLASH_CAMERA_SPIN_DEG,
  SPLASH_CAMERA_TILT_CSS_PROPERTY,
  SPLASH_CAMERA_TILT_DEG,
} from './varin-splash-camera';
import {
  CUBE_EDGE_PX,
  VARIN_SPLASH_COLORS,
  SPLASH_GROUND_ORIGIN_Y_PCT,
  SPLASH_GROUND_VISIBLE_FAR_RISE_PX,
  splashTilePlaybackTiming,
  type VarinSplashDirection,
  type VarinSplashMode,
  type VarinSplashPhase,
  type VarinSplashTempo,
  type SplashPlaneColors,
} from './varin-splash-lattice';

export type SplashCanvasPlaybackKind = 'covered' | 'covering' | 'idle' | 'revealing';

export interface SplashCanvasPlayback {
  readonly cameraDelayMs: number;
  readonly cameraDurationMs: number;
  readonly delayScale: number;
  readonly exitMs: number;
  readonly kind: SplashCanvasPlaybackKind;
  readonly reducedMotion: boolean;
  readonly releaseMs: number;
  readonly totalMs: number;
}

export interface SplashTile {
  readonly breatheDelayMs: number | null;
  readonly col: number;
  readonly delayMs: number;
  readonly key: string;
  readonly row: number;
  readonly scatterXPx: number;
  readonly scatterYPx: number;
  /** Centre of this tile in floor coordinates. The cube's footprint is tile `0:0`. */
  readonly xPx: number;
  readonly yPx: number;
}

export interface SplashTileField {
  readonly maxCol: number;
  readonly maxRow: number;
  readonly minCol: number;
  readonly minRow: number;
  readonly tiles: readonly SplashTile[];
}

export interface SplashTileFieldInput {
  readonly breatheShare: number;
  readonly cameraDistancePx: number;
  readonly cameraSpinDeg: number;
  readonly cameraTiltDeg: number;
  readonly cellPx: number;
  readonly direction: VarinSplashDirection;
  readonly mode: VarinSplashMode;
  readonly originYPct: number;
  readonly randomSeed: number;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  readonly visibleFarRisePx: number;
}

interface SplashCanvasCameraOptions {
  readonly distancePx: number;
  readonly originYPct: number;
  readonly spinDeg: number;
  readonly tiltProperty: string;
  readonly tiltDeg: number;
  readonly visibleFarRisePx: number;
}

interface SplashCanvasFieldOptions {
  readonly breatheShare: number;
  readonly direction: VarinSplashDirection;
  readonly mode: VarinSplashMode;
  readonly randomSeed: number;
}

export interface SplashCanvasMountOptions {
  readonly camera: SplashCanvasCameraOptions;
  readonly cellPx: number;
  readonly colors: Pick<SplashPlaneColors, 'background' | 'cell' | 'line'>;
  readonly field: SplashCanvasFieldOptions;
  readonly playback: SplashCanvasPlayback;
}

export interface SplashCanvasController {
  dispose(): void;
  setPlayback(playback: SplashCanvasPlayback): void;
}

const STANDARD_MAX_DELAY_MS = splashTilePlaybackTiming('standard').maxDelayMs;
const DEFAULT_BREATHE_SHARE = 0.1;
const DEFAULT_RANDOM_SEED = 0x02f6e2b1;

/**
 * Pick whether one tile breathes during one of its local pulse cycles.
 *
 * The hash is deterministic for a coordinate/cycle/seed tuple so a viewport rebuild does not pop the
 * field into a new state, while the cycle index changes the chosen set over time. The visual result is
 * random motion without calling Math.random on every frame or changing a tile halfway through its fade.
 */
export function splashTileBreathesInCycle(
  row: number,
  col: number,
  cycleIndex: number,
  breatheShare: number,
  randomSeed: number,
): boolean {
  const share = Math.min(1, Math.max(0, breatheShare));
  if (share <= 0) return false;
  if (share >= 1) return true;
  let value = randomSeed ^ 0x6d2b79f5;
  value = Math.imul(value ^ row, 0x45d9f3b);
  value = Math.imul(value ^ col, 0x119de1f3);
  value = Math.imul(value ^ cycleIndex, 0x27d4eb2d);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000 < share;
}

export const resolveSplashCanvasPlayback = (input: {
  leaving?: boolean;
  mode: VarinSplashMode;
  phase?: VarinSplashPhase;
  reducedMotion: boolean;
  tempo: VarinSplashTempo;
}): SplashCanvasPlayback => {
  const timing = splashTilePlaybackTiming(input.mode === 'boot' ? 'standard' : input.tempo);
  const kind: SplashCanvasPlaybackKind = input.mode === 'boot'
    ? (input.leaving ? 'revealing' : 'idle')
    : input.phase ?? 'covered';
  return {
    cameraDelayMs: timing.cameraDelayMs,
    cameraDurationMs: timing.cameraDurationMs,
    delayScale: timing.maxDelayMs / STANDARD_MAX_DELAY_MS,
    exitMs: timing.exitMs,
    kind,
    reducedMotion: input.reducedMotion,
    releaseMs: timing.releaseMs,
    totalMs: timing.totalMs,
  };
};

export const createSplashCanvasMountOptions = (input: {
  breathe: boolean;
  colors?: Pick<SplashPlaneColors, 'background' | 'cell' | 'line'>;
  direction: VarinSplashDirection;
  mode: VarinSplashMode;
  playback: SplashCanvasPlayback;
  randomSeed?: number;
}): SplashCanvasMountOptions => {
  const colors = input.colors ?? VARIN_SPLASH_COLORS;
  return {
    camera: {
      distancePx: SPLASH_CAMERA_DISTANCE_PX,
      originYPct: SPLASH_GROUND_ORIGIN_Y_PCT,
      spinDeg: SPLASH_CAMERA_SPIN_DEG,
      tiltProperty: SPLASH_CAMERA_TILT_CSS_PROPERTY,
      tiltDeg: SPLASH_CAMERA_TILT_DEG,
      visibleFarRisePx: SPLASH_GROUND_VISIBLE_FAR_RISE_PX,
    },
    cellPx: CUBE_EDGE_PX,
    colors: {
      background: colors.background,
      cell: colors.cell,
      line: colors.line,
    },
    field: {
      breatheShare: input.breathe ? DEFAULT_BREATHE_SHARE : 0,
      direction: input.direction,
      mode: input.mode,
      randomSeed: input.randomSeed ?? DEFAULT_RANDOM_SEED,
    },
    playback: input.playback,
  };
};

/**
 * Build the smallest axis-aligned set of floor cells needed by this viewport.
 *
 * The calculation inverse-projects the viewport through several points on the camera's tilt path. This is
 * why a 5K ultrawide receives more tiles instead of stretching the same 24×24 board, and why no giant
 * transformed Canvas box has to cross the perspective camera plane. The function is self-contained so the
 * pre-paint hosts can serialize this exact implementation before the application bundle exists.
 */
export function buildAdaptiveSplashTiles(input: SplashTileFieldInput): SplashTileField {
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const width = Math.max(1, Number.isFinite(input.viewportWidth) ? input.viewportWidth : 1);
  const height = Math.max(1, Number.isFinite(input.viewportHeight) ? input.viewportHeight : 1);
  const cellPx = Math.max(Number.EPSILON, input.cellPx);
  const originY = height * input.originYPct / 100;
  const spin = input.cameraSpinDeg * Math.PI / 180;
  const cosSpin = Math.cos(spin);
  const sinSpin = Math.sin(spin);

  const inverseProject = (screenX: number, screenY: number, tiltDeg: number): { x: number; y: number } | null => {
    const tilt = tiltDeg * Math.PI / 180;
    const cosTilt = Math.cos(tilt);
    const sinTilt = Math.sin(tilt);
    const denominator = cosTilt + screenY * sinTilt / input.cameraDistancePx;
    if (denominator <= 1e-4) return null;
    const spunY = screenY / denominator;
    const perspectiveW = 1 - spunY * sinTilt / input.cameraDistancePx;
    const spunX = screenX * perspectiveW;
    return {
      x: spunX * cosSpin + spunY * sinSpin,
      y: -spunX * sinSpin + spunY * cosSpin,
    };
  };

  const floorPoints: Array<{ x: number; y: number }> = [];
  // Sampling the whole camera path avoids assuming that inverse bounds are monotonic between the
  // perspective and overhead endpoints. A step is at most one degree; the two-cell motion overscan below
  // is much wider than the projection change between adjacent samples.
  const tiltSteps = Math.max(1, Math.ceil(Math.abs(input.cameraTiltDeg)));
  for (let step = 0; step <= tiltSteps; step += 1) {
    const fraction = step / tiltSteps;
    const tilt = input.cameraTiltDeg * (1 - fraction);
    const top = tilt <= 1e-6 ? -originY : Math.max(-originY, -input.visibleFarRisePx);
    const bottom = height - originY;
    for (const screenX of [-width / 2, width / 2]) {
      for (const screenY of [top, bottom]) {
        const point = inverseProject(screenX, screenY, tilt);
        if (point) floorPoints.push(point);
      }
    }
  }
  floorPoints.push({ x: 0, y: 0 });

  // Two cells cover the largest authored scatter (0.54 cell), a complete tile at the boundary, and
  // antialiasing. It is derived from the scene's motion rather than a viewport-size ceiling.
  const overscanCells = 2;
  const minX = Math.min(...floorPoints.map((point) => point.x));
  const maxX = Math.max(...floorPoints.map((point) => point.x));
  const minY = Math.min(...floorPoints.map((point) => point.y));
  const maxY = Math.max(...floorPoints.map((point) => point.y));
  const minCol = Math.floor(minX / cellPx) - overscanCells;
  const maxCol = Math.ceil(maxX / cellPx) + overscanCells;
  const minRow = Math.floor(minY / cellPx) - overscanCells;
  const maxRow = Math.ceil(maxY / cellPx) + overscanCells;
  const maxRadius = Math.max(
    1,
    Math.hypot(minCol, minRow),
    Math.hypot(minCol, maxRow),
    Math.hypot(maxCol, minRow),
    Math.hypot(maxCol, maxRow),
  );
  const maxDelayMs = 520;
  const breatheSpreadMs = 2_200;

  const randomAt = (row: number, col: number, salt: number): number => {
    let value = input.randomSeed ^ salt;
    value = Math.imul(value ^ row, 0x45d9f3b);
    value = Math.imul(value ^ col, 0x119de1f3);
    value ^= value >>> 16;
    return (value >>> 0) / 0x1_0000_0000;
  };

  const tiles: SplashTile[] = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      const radius = Math.hypot(col, row);
      // Both boot and the built-in Workbench scene are centred on the cube's registered footprint. Reveal
      // starts at 0:0 and travels outward; covering is its exact global time reversal, so the perimeter
      // settles first and the field closes concentrically before the cube becomes visible. Profile ordering
      // remains in the public frame for custom scenes, but must not turn Varin's default scene into a
      // corner-origin wipe.
      const fraction = radius / maxRadius;
      const magnitude = radius === 0
        ? 0
        : cellPx * (0.18 + 0.36 * clamp(radius / 6, 0, 1));
      const scatterXPx = radius === 0 ? 0 : Math.round(col / radius * magnitude);
      const scatterYPx = radius === 0 ? 0 : Math.round(row / radius * magnitude);
      tiles.push({
        breatheDelayMs: input.breatheShare > 0
          ? Math.round(randomAt(row, col, 0x02e5be93) * breatheSpreadMs)
          : null,
        col,
        delayMs: Math.round(clamp(fraction, 0, 1) * maxDelayMs),
        key: `${row}:${col}`,
        row,
        scatterXPx,
        scatterYPx,
        xPx: col * cellPx,
        yPx: row * cellPx,
      });
    }
  }

  return { maxCol, maxRow, minCol, minRow, tiles };
}

/**
 * Mount the adaptive tile field into one viewport drawing surface.
 *
 * This function is deliberately self-contained. React calls it directly, while pre-paint HTML serializes
 * the same function body before the application bundle exists. Keep browser helpers inside the function;
 * an outer closure would work in React and fail silently in the bootstrap projection.
 */
export function mountSplashTileCanvas(
  canvas: HTMLCanvasElement,
  options: SplashCanvasMountOptions,
  buildTileField: (input: SplashTileFieldInput) => SplashTileField = buildAdaptiveSplashTiles,
  breathesInCycle: (
    row: number,
    col: number,
    cycleIndex: number,
    breatheShare: number,
    randomSeed: number,
  ) => boolean = splashTileBreathesInCycle,
): SplashCanvasController {
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
  const mix = (from: number, to: number, progress: number): number => from + (to - from) * progress;
  const smoothstep = (from: number, to: number, value: number): number => {
    const progress = clamp((value - from) / Math.max(1e-6, to - from), 0, 1);
    return progress * progress * (3 - 2 * progress);
  };
  // Keep the generated script byte-stable while giving each mounted boot scene its own breathing sequence.
  // The seed is chosen once per controller, never per frame, so resize and animation frames remain coherent.
  let breathingRandomSeed = options.field.randomSeed ^ (Math.floor(performance.timeOrigin || Date.now()) >>> 0);
  try {
    const entropy = new Uint32Array(1);
    canvas.ownerDocument.defaultView?.crypto.getRandomValues(entropy);
    breathingRandomSeed ^= entropy[0] ?? 0;
  } catch {
    // The time-origin mix above remains a per-page fallback where Web Crypto is unavailable.
  }
  const cubicCoordinate = (a: number, b: number, value: number): number => {
    const inverse = 1 - value;
    return 3 * inverse * inverse * value * a + 3 * inverse * value * value * b + value * value * value;
  };
  const cubicEase = (progress: number, x1: number, x2: number): number => {
    const target = clamp(progress, 0, 1);
    let low = 0;
    let high = 1;
    for (let index = 0; index < 12; index += 1) {
      const candidate = (low + high) / 2;
      if (cubicCoordinate(x1, x2, candidate) < target) low = candidate;
      else high = candidate;
    }
    return cubicCoordinate(0, 1, (low + high) / 2);
  };
  // The floor and cube used to animate this angle on independent clocks: Canvas rAF for the floor and a
  // CSS animation for the cube. A delayed commit or frame could therefore put them at visibly different
  // tilts. While this controller owns the Canvas, it owns the DOM camera tilt too and writes both from the
  // same elapsed timestamp in draw(). The CSS camera animation remains only as a no-JavaScript fallback.
  const splashElement = canvas.closest<HTMLElement>('.varin-splash');
  const cameraElement = canvas.parentElement?.querySelector<HTMLElement>('.varin-splash-camera') ?? null;
  if (splashElement && cameraElement) {
    splashElement.setAttribute('data-varin-camera-owner', 'canvas');
  }

  const colorProbe = canvas.ownerDocument.createElement('span');
  colorProbe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  (canvas.parentElement ?? canvas.ownerDocument.documentElement).append(colorProbe);
  const resolveColor = (expression: string): string => {
    colorProbe.style.color = '';
    colorProbe.style.color = expression;
    return getComputedStyle(colorProbe).color;
  };
  const colorCanvas = canvas.ownerDocument.createElement('canvas');
  colorCanvas.width = 1;
  colorCanvas.height = 1;
  const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
  const rgba = (expression: string): [number, number, number, number] => {
    const resolved = resolveColor(expression);
    if (!colorContext) return [0, 0, 0, 1];
    colorContext.clearRect(0, 0, 1, 1);
    colorContext.fillStyle = resolved;
    colorContext.fillRect(0, 0, 1, 1);
    const value = colorContext.getImageData(0, 0, 1, 1).data;
    return [value[0] / 255, value[1] / 255, value[2] / 255, value[3] / 255];
  };
  const background = rgba(options.colors.background);
  const line = rgba(options.colors.line);
  const pulse = rgba(options.colors.cell);
  colorProbe.remove();

  interface Viewport {
    height: number;
    width: number;
  }
  interface TileFrame {
    fillMix: number;
    opacity: number;
    scale: number;
    x: number;
    y: number;
  }
  interface TileRenderer {
    readonly kind: '2d' | 'webgl2';
    dispose(): void;
    draw(values: readonly TileFrame[], viewport: Viewport, tiltDeg: number): void;
    resize(viewport: Viewport): void;
  }

  const measureViewport = (): Viewport => {
    const bounds = canvas.parentElement?.getBoundingClientRect();
    const view = canvas.ownerDocument.defaultView;
    return {
      height: Math.max(1, Math.round(bounds?.height || view?.innerHeight || canvas.clientHeight || 1)),
      width: Math.max(1, Math.round(bounds?.width || view?.innerWidth || canvas.clientWidth || 1)),
    };
  };

  const createWebGlRenderer = (): TileRenderer | null => {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: 'high-performance',
      premultipliedAlpha: true,
    });
    if (!gl) return null;

    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Unable to allocate splash shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'Splash shader compilation failed';
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    };

    try {
      const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
precision highp float;
layout(location=0) in vec2 aCenter;
layout(location=1) in float aScale;
layout(location=2) in float aOpacity;
layout(location=3) in float aFillMix;
uniform vec2 uViewport;
uniform vec2 uOrigin;
uniform float uCellSize;
uniform float uDistance;
uniform float uSpin;
uniform float uTilt;
out vec2 vUv;
out float vOpacity;
out float vFillMix;
const vec2 corners[6] = vec2[6](
  vec2(-0.5,-0.5), vec2(0.5,-0.5), vec2(-0.5,0.5),
  vec2(-0.5,0.5), vec2(0.5,-0.5), vec2(0.5,0.5)
);
void main() {
  vec2 corner = corners[gl_VertexID];
  vec2 floorPoint = aCenter + corner * uCellSize * aScale;
  float cosSpin = cos(uSpin);
  float sinSpin = sin(uSpin);
  float spunX = floorPoint.x * cosSpin - floorPoint.y * sinSpin;
  float spunY = floorPoint.x * sinSpin + floorPoint.y * cosSpin;
  float perspectiveW = 1.0 - spunY * sin(uTilt) / uDistance;
  if (perspectiveW <= 0.02) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    vOpacity = 0.0;
  } else {
    // Preserve the projection denominator as homogeneous W. Besides landing at the same screen point,
    // this lets the rasterizer perspective-correct vUv across both triangles, avoiding a derivative seam
    // through the middle of each diamond.
    vec2 projected = vec2(spunX, spunY * cos(uTilt));
    vec2 homogeneousClip = (projected + uOrigin * perspectiveW) / uViewport * 2.0 - vec2(perspectiveW);
    gl_Position = vec4(homogeneousClip.x, -homogeneousClip.y, 0.0, perspectiveW);
    vOpacity = aOpacity;
  }
  vUv = corner + 0.5;
  vFillMix = aFillMix;
}`);
      const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform vec4 uBackground;
uniform vec4 uLine;
uniform vec4 uPulse;
uniform float uBorder;
uniform float uRenderScale;
in vec2 vUv;
in float vOpacity;
in float vFillMix;
out vec4 outputColor;
void main() {
  vec4 tile = mix(uBackground, uPulse, vFillMix);
  // fwidth(vUv) is the UV distance covered by one physical framebuffer pixel. Converting both the
  // authored floor-space border and the distance to the tile edge through it keeps diagonal lines
  // continuous after perspective compresses them below a CSS pixel, without paying for full-canvas MSAA.
  vec2 footprint = max(fwidth(vUv), vec2(0.000001));
  vec2 edgeDistancePx = (vec2(1.0) - vUv) / footprint;
  vec2 projectedLinePx = vec2(uBorder) / footprint;
  vec2 lineWidthPx = max(projectedLinePx, vec2(uRenderScale));
  vec2 antialiasRadius = vec2(0.75);
  vec2 lineCoverage = vec2(1.0) - smoothstep(
    max(lineWidthPx - antialiasRadius, vec2(0.0)),
    lineWidthPx + antialiasRadius,
    edgeDistancePx
  );

  // Once one cell period is only a few line widths, a continuous grid has no readable gap left. Fade each
  // axis independently between three and six line widths instead of letting undersampled fragments turn
  // into dots or letting the two line families merge into a bright horizon band.
  vec2 cellSpanPx = vec2(1.0) / footprint;
  vec2 densityFade = smoothstep(vec2(uRenderScale * 3.0), vec2(uRenderScale * 6.0), cellSpanPx);
  float coverage = max(lineCoverage.x * densityFade.x, lineCoverage.y * densityFade.y);
  float lineMix = clamp(coverage * uLine.a, 0.0, 1.0);
  vec3 color = mix(tile.rgb, uLine.rgb, lineMix);
  // The line is composited over the opaque tile instead of replacing its alpha. Visually this matches the
  // semantic translucent line token while preserving the splash's promise that intact tiles are a cover.
  outputColor = vec4(color, tile.a * vOpacity);
}`);
      const program = gl.createProgram();
      if (!program) throw new Error('Unable to allocate splash program');
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const message = gl.getProgramInfoLog(program) || 'Splash program link failed';
        gl.deleteProgram(program);
        throw new Error(message);
      }

      gl.useProgram(program);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      const buffer = gl.createBuffer();
      const vertexArray = gl.createVertexArray();
      if (!buffer || !vertexArray) throw new Error('Unable to allocate splash instance buffer');
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);
      gl.vertexAttribDivisor(2, 1);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 4 * Float32Array.BYTES_PER_ELEMENT);
      gl.vertexAttribDivisor(3, 1);

      const uniform = (name: string): WebGLUniformLocation => {
        const location = gl.getUniformLocation(program, name);
        if (location === null) throw new Error(`Splash uniform ${name} is missing`);
        return location;
      };
      const uniforms = {
        background: uniform('uBackground'),
        border: uniform('uBorder'),
        cellSize: uniform('uCellSize'),
        distance: uniform('uDistance'),
        line: uniform('uLine'),
        origin: uniform('uOrigin'),
        pulse: uniform('uPulse'),
        renderScale: uniform('uRenderScale'),
        spin: uniform('uSpin'),
        tilt: uniform('uTilt'),
        viewport: uniform('uViewport'),
      };
      gl.uniform1f(uniforms.cellSize, options.cellPx);
      gl.uniform1f(uniforms.distance, options.camera.distancePx);
      gl.uniform1f(uniforms.spin, options.camera.spinDeg * Math.PI / 180);
      gl.uniform1f(uniforms.border, 1 / options.cellPx);
      gl.uniform4fv(uniforms.background, new Float32Array(background));
      gl.uniform4fv(uniforms.line, new Float32Array(line));
      gl.uniform4fv(uniforms.pulse, new Float32Array(pulse));
      let data = new Float32Array(0);

      return {
        kind: 'webgl2',
        // Detachment from the DOM does not mean Chromium has retired the GPU surface yet. Release our
        // objects without forcibly losing the context during that compositor handoff; the detached
        // Canvas and context become collectible when the controller drops the renderer reference.
        dispose: () => {
          gl.deleteBuffer(buffer);
          gl.deleteVertexArray(vertexArray);
          gl.deleteProgram(program);
        },
        draw: (values, viewport, tiltDeg) => {
          const requiredLength = values.length * 5;
          if (data.length !== requiredLength) {
            data = new Float32Array(requiredLength);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
          }
          for (let index = 0; index < values.length; index += 1) {
            const value = values[index] as TileFrame;
            const offset = index * 5;
            data[offset] = value.x;
            data[offset + 1] = value.y;
            data[offset + 2] = value.scale;
            data[offset + 3] = value.opacity;
            data[offset + 4] = value.fillMix;
          }
          gl.bindVertexArray(vertexArray);
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
          gl.uniform2f(uniforms.viewport, viewport.width, viewport.height);
          const originX = viewport.width / 2;
          const originY = viewport.height * options.camera.originYPct / 100;
          gl.uniform2f(uniforms.origin, originX, originY);
          gl.uniform1f(uniforms.tilt, tiltDeg * Math.PI / 180);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, values.length);
        },
        resize: (viewport) => {
          const maxRenderbuffer = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 1;
          const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
          const maxWidth = Math.min(maxRenderbuffer, Number(maxViewport[0]) || maxRenderbuffer);
          const maxHeight = Math.min(maxRenderbuffer, Number(maxViewport[1]) || maxRenderbuffer);
          const requestedScale = Math.max(1, canvas.ownerDocument.defaultView?.devicePixelRatio || 1);
          const renderScale = Math.max(
            Number.EPSILON,
            Math.min(requestedScale, maxWidth / viewport.width, maxHeight / viewport.height),
          );
          canvas.width = Math.max(1, Math.round(viewport.width * renderScale));
          canvas.height = Math.max(1, Math.round(viewport.height * renderScale));
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.uniform1f(uniforms.renderScale, renderScale);
        },
      };
    } catch {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return null;
    }
  };

  const createTwoDimensionalRenderer = (): TileRenderer | null => {
    const context = canvas.getContext('2d');
    if (!context) return null;
    const cssColor = (value: readonly number[]): string =>
      `rgba(${Math.round((value[0] ?? 0) * 255)},${Math.round((value[1] ?? 0) * 255)},${Math.round((value[2] ?? 0) * 255)},${value[3] ?? 1})`;
    const project = (
      x: number,
      y: number,
      viewport: Viewport,
      tiltDeg: number,
    ): { x: number; y: number } | null => {
      const spin = options.camera.spinDeg * Math.PI / 180;
      const tilt = tiltDeg * Math.PI / 180;
      const spunX = x * Math.cos(spin) - y * Math.sin(spin);
      const spunY = x * Math.sin(spin) + y * Math.cos(spin);
      const perspectiveW = 1 - spunY * Math.sin(tilt) / options.camera.distancePx;
      if (perspectiveW <= 0.02) return null;
      return {
        x: viewport.width / 2 + spunX / perspectiveW,
        y: viewport.height * options.camera.originYPct / 100 + spunY * Math.cos(tilt) / perspectiveW,
      };
    };
    return {
      kind: '2d',
      dispose: () => undefined,
      draw: (values, viewport, tiltDeg) => {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);
        for (const value of values) {
          if (value.opacity <= 0) continue;
          const half = options.cellPx * value.scale / 2;
          const corners = [
            project(value.x - half, value.y - half, viewport, tiltDeg),
            project(value.x + half, value.y - half, viewport, tiltDeg),
            project(value.x + half, value.y + half, viewport, tiltDeg),
            project(value.x - half, value.y + half, viewport, tiltDeg),
          ];
          if (corners.some((corner) => corner === null)) continue;
          const [topLeft, topRight, bottomRight, bottomLeft] = corners as Array<{ x: number; y: number }>;
          const fill = background.map((channel, index) => mix(channel, pulse[index] ?? channel, value.fillMix));
          context.globalAlpha = value.opacity;
          context.fillStyle = cssColor(fill);
          context.beginPath();
          context.moveTo(topLeft.x, topLeft.y);
          context.lineTo(topRight.x, topRight.y);
          context.lineTo(bottomRight.x, bottomRight.y);
          context.lineTo(bottomLeft.x, bottomLeft.y);
          context.closePath();
          context.fill();
          context.strokeStyle = cssColor(line);
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(topRight.x, topRight.y);
          context.lineTo(bottomRight.x, bottomRight.y);
          context.lineTo(bottomLeft.x, bottomLeft.y);
          context.stroke();
        }
        context.globalAlpha = 1;
      },
      // Canvas 2D is the compatibility renderer. One backing pixel per CSS pixel preserves the authored
      // line weight without allocating a multi-hundred-megabyte fallback surface on an 8K HiDPI display.
      resize: (viewport) => {
        canvas.width = viewport.width;
        canvas.height = viewport.height;
      },
    };
  };

  let viewport = measureViewport();
  const buildField = (): SplashTileField => buildTileField({
    ...options.field,
    cameraDistancePx: options.camera.distancePx,
    cameraSpinDeg: options.camera.spinDeg,
    cameraTiltDeg: options.camera.tiltDeg,
    cellPx: options.cellPx,
    originYPct: options.camera.originYPct,
    viewportHeight: viewport.height,
    viewportWidth: viewport.width,
    visibleFarRisePx: options.camera.visibleFarRisePx,
  });
  let field = buildField();
  let frames: TileFrame[] = field.tiles.map((tile) => ({
    fillMix: 0,
    opacity: 1,
    scale: 1,
    x: tile.xPx,
    y: tile.yPx,
  }));
  let hasBreathingTiles = field.tiles.some((tile) => tile.breatheDelayMs !== null);
  let renderer = createWebGlRenderer();
  if (!renderer) renderer = createTwoDimensionalRenderer();
  if (renderer) {
    renderer.resize(viewport);
    canvas.setAttribute('data-varin-splash-renderer', renderer.kind);
  }

  let playback = options.playback;
  let playbackStartedAt = performance.now();
  let appliedCameraTiltDeg: number | null = null;
  let animationFrame = 0;
  let disposed = false;

  const cameraTiltAt = (elapsed: number): number => {
    if (playback.reducedMotion || playback.kind === 'idle' || playback.kind === 'covered') {
      return options.camera.tiltDeg;
    }
    const delay = playback.kind === 'revealing'
      ? playback.cameraDelayMs
      : Math.max(0, playback.totalMs - playback.cameraDelayMs - playback.cameraDurationMs);
    const raw = clamp((elapsed - delay) / Math.max(1, playback.cameraDurationMs), 0, 1);
    const forwardProgress = playback.kind === 'revealing' ? raw : 1 - raw;
    return options.camera.tiltDeg * (1 - cubicEase(forwardProgress, 0.4, 0.2));
  };

  const updateFrames = (elapsed: number): void => {
    const motionByDelay = new Map<number, { eased: number; fillMix: number; opacity: number }>();
    const motionActive = !playback.reducedMotion
      && (playback.kind === 'covering' || playback.kind === 'revealing');
    const restingMotion = { eased: 0, fillMix: 0, opacity: 1 };
    for (let index = 0; index < field.tiles.length; index += 1) {
      const tile = field.tiles[index] as SplashTile;
      const frame = frames[index] as TileFrame;
      let motion = motionActive ? motionByDelay.get(tile.delayMs) : restingMotion;
      if (!motion) {
        let progress = 0;
        if (playback.kind === 'revealing') {
          const delay = playback.releaseMs + tile.delayMs * playback.delayScale;
          progress = clamp((elapsed - delay) / Math.max(1, playback.exitMs), 0, 1);
        } else if (playback.kind === 'covering') {
          const revealDelay = playback.releaseMs + tile.delayMs * playback.delayScale;
          const coverDelay = Math.max(0, playback.totalMs - revealDelay - playback.exitMs);
          progress = 1 - clamp((elapsed - coverDelay) / Math.max(1, playback.exitMs), 0, 1);
        }
        const eased = progress <= 0 ? 0 : progress >= 1 ? 1 : cubicEase(progress, 0.32, 0.24);
        motion = {
          eased,
          fillMix: smoothstep(0, 0.32, progress),
          opacity: progress <= 0.55 ? 1 : 1 - smoothstep(0.55, 1, progress),
        };
        motionByDelay.set(tile.delayMs, motion);
      }
      frame.x = tile.xPx + tile.scatterXPx * motion.eased;
      frame.y = tile.yPx + tile.scatterYPx * motion.eased;
      frame.scale = mix(1, 0.56, motion.eased);
      frame.opacity = motion.opacity;
      frame.fillMix = motion.fillMix;

      if (playback.kind === 'idle' && !playback.reducedMotion && tile.breatheDelayMs !== null) {
        const breathingElapsed = elapsed - 1_200 - tile.breatheDelayMs;
        if (breathingElapsed >= 0) {
          const cycleIndex = Math.floor(breathingElapsed / 2_800);
          if (breathesInCycle(
            tile.row,
            tile.col,
            cycleIndex,
            options.field.breatheShare,
            breathingRandomSeed,
          )) {
            const cycle = (breathingElapsed % 2_800) / 2_800;
            frame.fillMix = (1 - Math.cos(cycle * Math.PI * 2)) / 2;
          }
        }
      }
    }
  };

  const shouldContinue = (elapsed: number): boolean => {
    if (playback.reducedMotion || playback.kind === 'covered') return false;
    if (playback.kind === 'idle') return hasBreathingTiles;
    return elapsed < playback.totalMs;
  };

  const draw = (now: number): void => {
    if (disposed) return;
    const running = Math.max(0, now - playbackStartedAt);
    // Clamped, so the frame that ends an animated phase is the exact terminal frame rather than whichever
    // 99%-complete frame the last rAF happened to land on. The scene is retired against this frame, and a
    // floor left one step short of transparent is a floor that flickers back when the cover hands over.
    const animated = !playback.reducedMotion
      && (playback.kind === 'covering' || playback.kind === 'revealing');
    const elapsed = animated ? Math.min(running, playback.totalMs) : running;
    const tiltDeg = cameraTiltAt(elapsed);
    updateFrames(elapsed);
    if (cameraElement && (appliedCameraTiltDeg === null || Math.abs(appliedCameraTiltDeg - tiltDeg) > 1e-4)) {
      cameraElement.style.setProperty(options.camera.tiltProperty, `${tiltDeg}deg`);
      appliedCameraTiltDeg = tiltDeg;
    }
    renderer?.draw(frames, viewport, tiltDeg);
    if (shouldContinue(running)) animationFrame = requestAnimationFrame(draw);
    else animationFrame = 0;
  };

  const start = (): void => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    playbackStartedAt = performance.now();
    draw(playbackStartedAt);
  };

  const rebuildForViewport = (): void => {
    const nextViewport = measureViewport();
    if (nextViewport.width === viewport.width && nextViewport.height === viewport.height) return;
    viewport = nextViewport;
    field = buildField();
    frames = field.tiles.map((tile) => ({
      fillMix: 0,
      opacity: 1,
      scale: 1,
      x: tile.xPx,
      y: tile.yPx,
    }));
    hasBreathingTiles = field.tiles.some((tile) => tile.breatheDelayMs !== null);
    renderer?.resize(viewport);
    if (!animationFrame) draw(performance.now());
  };
  const view = canvas.ownerDocument.defaultView;
  view?.addEventListener('resize', rebuildForViewport);

  start();
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Everything here is invisible: the last drawn frame stays on the Canvas and every ownership claim
      // stays exactly as it is. React runs layout-effect cleanup while the node is still connected, and
      // each of the mutations below is a visible one:
      //   removing the tilt property returns the DOM camera to its authored tilt, standing the cube back up;
      //   removing the camera-owner attribute re-arms the CSS fallback flatten from its own start state;
      //   removing the renderer attribute restores the Canvas's opaque background across the whole viewport.
      // Doing any of that to a scene that can still be composited is a frame of the transition playing
      // backwards. It waits for detachment instead.
      view?.removeEventListener('resize', rebuildForViewport);
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;

      const releaseDetachedScene = (): void => {
        // A connected node means someone still owns these pixels: either the scene is on screen, or a
        // replacement controller has already re-staked the same claims. Both cases forbid touching them,
        // and in both cases there is nothing left for this controller to clean up.
        if (canvas.isConnected) return;
        renderer?.dispose();
        renderer = null;
        cameraElement?.style.removeProperty(options.camera.tiltProperty);
        if (splashElement?.getAttribute('data-varin-camera-owner') === 'canvas') {
          splashElement.removeAttribute('data-varin-camera-owner');
        }
        canvas.removeAttribute('data-varin-splash-renderer');
      };

      // React removes host nodes in the same commit as the cleanup that precedes them, so a microtask is
      // already past the detachment on that path. A frame boundary covers hosts that unmount their
      // container separately. Neither is a guessed delay, and if the node is still connected after both
      // then a live owner exists and this controller is finished either way.
      const retryAtFrame = (): void => {
        if (canvas.isConnected && typeof view?.requestAnimationFrame === 'function') {
          view.requestAnimationFrame(releaseDetachedScene);
          return;
        }
        releaseDetachedScene();
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(retryAtFrame);
      else retryAtFrame();
    },
    setPlayback: (next) => {
      if (disposed) return;
      const unchanged = playback.cameraDelayMs === next.cameraDelayMs
        && playback.cameraDurationMs === next.cameraDurationMs
        && playback.kind === next.kind
        && playback.delayScale === next.delayScale
        && playback.exitMs === next.exitMs
        && playback.reducedMotion === next.reducedMotion
        && playback.releaseMs === next.releaseMs
        && playback.totalMs === next.totalMs;
      if (unchanged) return;
      playback = next;
      start();
    },
  };
}

/** Generated pre-paint bootstrap that runs the same adaptive renderer before React or the catalog exists. */
export const splashGroundScript = (
  elementId: string,
  colors: Pick<SplashPlaneColors, 'background' | 'cell' | 'line'> = VARIN_SPLASH_COLORS,
): string => {
  const playback = resolveSplashCanvasPlayback({
    leaving: false,
    mode: 'boot',
    reducedMotion: false,
    tempo: 'standard',
  });
  const options = createSplashCanvasMountOptions({
    breathe: true,
    colors,
    direction: 'forward',
    mode: 'boot',
    playback,
  });
  const reducedPlayback = resolveSplashCanvasPlayback({
    leaving: true,
    mode: 'boot',
    reducedMotion: true,
    tempo: 'standard',
  });
  const revealingPlayback = resolveSplashCanvasPlayback({
    leaving: true,
    mode: 'boot',
    reducedMotion: false,
    tempo: 'standard',
  });
  return `(function(){
var ground=document.getElementById(${JSON.stringify(elementId)});
if(!ground)return;
var splash=ground.closest('.varin-splash');
var horizon=ground.closest('.varin-splash-horizon');
if(!horizon)return;
var canvas=document.createElement('canvas');
canvas.className='varin-splash-ground-canvas';
canvas.setAttribute('aria-hidden','true');
horizon.insertBefore(canvas,horizon.firstChild);
var build=(${buildAdaptiveSplashTiles.toString()});
var breathes=(${splashTileBreathesInCycle.toString()});
var mount=(${mountSplashTileCanvas.toString()});
var controller=mount(canvas,${JSON.stringify(options)},build,breathes);
var reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
var observer=new MutationObserver(function(){
if(!splash||splash.getAttribute('data-leaving')!=='true')return;
observer.disconnect();
controller.setPlayback(reduced?${JSON.stringify(reducedPlayback)}:${JSON.stringify(revealingPlayback)});
});
if(splash)observer.observe(splash,{attributes:true,attributeFilter:['data-leaving']});
if(splash&&splash.parentNode){
var removalObserver=new MutationObserver(function(){
if(splash.isConnected)return;
removalObserver.disconnect();
controller.dispose();
});
removalObserver.observe(splash.parentNode,{childList:true});
}
})();`;
};
