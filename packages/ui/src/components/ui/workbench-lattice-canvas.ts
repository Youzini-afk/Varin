import { EASE_EXIT, EASE_OUT } from '@/lib/motion/tokens';
import { LATTICE_CLOSED_SCALE, LATTICE_COVER_CELL_MS, LATTICE_REVEAL_CELL_MS,
  LATTICE_SPREAD_MS, type LatticePlan, type LatticePhase } from './workbench-lattice';

export interface LatticeCanvas {
  layout(plan: LatticePlan, width: number, height: number): void;
  draw(elapsed: number, phase: LatticePhase | 'closed'): boolean;
  direction(inward: boolean): void;
  dispose(): void;
}

/** The same squares, seams and curves in one surface; fixed instance data is uploaded per layout. */
export function createLatticeCanvas(field: HTMLElement, onContextLost?: () => void): LatticeCanvas | null {
  const canvas = field.ownerDocument.createElement('canvas');
  let gl: WebGL2RenderingContext | null = null;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  const lost = () => onContextLost?.();
  const dispose = () => {
    if (gl) { shaders.forEach(s => gl!.deleteShader(s)); gl.deleteBuffer(buffer); gl.deleteVertexArray(vao); gl.deleteProgram(program); }
    canvas.remove();
    canvas.removeEventListener('webglcontextlost', lost);
  };
  try {
    gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false });
    if (!gl) return null;
    const g = gl;
    const compile = (type: number, source: string) => {
      const shader = g.createShader(type);
      if (!shader) throw new Error('Unable to allocate lattice shader');
      shaders.push(shader); g.shaderSource(shader, source); g.compileShader(shader);
      if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) throw new Error('Unable to compile lattice shader');
      return shader;
    };
    const vertex = compile(g.VERTEX_SHADER, `#version 300 es
precision highp float;
layout(location=0) in vec3 cell;
uniform vec2 viewport;
uniform float edge, elapsed, phase, inward, renderScale;
uniform vec4 easing;
out vec2 uv;
out float opacity;
const vec2 corners[6]=vec2[6](vec2(-.5,-.5),vec2(.5,-.5),vec2(-.5,.5),vec2(-.5,.5),vec2(.5,-.5),vec2(.5,.5));
float cubic(float a,float b,float t){float r=1.-t;return 3.*r*r*t*a+3.*r*t*t*b+t*t*t;}
float ease(float t){if(t<=0.||t>=1.)return t;float lo=0.,hi=1.;for(int i=0;i<16;i++){float m=(lo+hi)*.5;if(cubic(easing.x,easing.z,m)<t)lo=m;else hi=m;}return cubic(easing.y,easing.w,(lo+hi)*.5);}
void main(){
  float duration=phase<.5?${LATTICE_COVER_CELL_MS}.:${LATTICE_REVEAL_CELL_MS}.;
  float reach=inward>.5?1.-cell.z:cell.z;
  float t=ease(clamp((elapsed-reach*${LATTICE_SPREAD_MS}.)/duration,0.,1.));
  float scale=phase<.5?t:1.-t;
  opacity=phase<.5?mix(.35,1.,t):mix(1.,.2,t);
  if(phase>1.5){scale=1.;opacity=1.;}
  vec2 corner=corners[gl_VertexID];
  float extent=edge*${LATTICE_CLOSED_SCALE}*scale;
  float padded=extent+2./renderScale;
  if(extent<=0.)opacity=0.;
  vec2 p=cell.xy+corner*padded;
  gl_Position=vec4(p.x/viewport.x*2.-1.,1.-p.y/viewport.y*2.,0.,1.);
  uv=corner*padded/max(extent,.000001)+.5;
}`);
    const fragment = compile(g.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform vec4 fillColor, seamColor;
uniform float edge;
in vec2 uv;
in float opacity;
out vec4 color;
void main(){
  vec2 distance=min(uv,1.-uv);
  vec2 feather=max(fwidth(uv),vec2(.000001));
  vec2 border=1.-smoothstep(vec2(.5/edge)-feather*.5,vec2(.5/edge)+feather*.5,distance);
  vec3 rgb=mix(fillColor.rgb,seamColor.rgb,max(border.x,border.y)*seamColor.a);
  vec2 coverage=smoothstep(-feather*.5,feather*.5,distance);
  color=vec4(rgb,opacity*min(coverage.x,coverage.y));
}`);
    program = g.createProgram(); if (!program) throw new Error('Unable to allocate lattice program');
    g.attachShader(program, vertex); g.attachShader(program, fragment); g.linkProgram(program);
    if (!g.getProgramParameter(program, g.LINK_STATUS)) throw new Error('Unable to link lattice program');
    g.useProgram(program);
    buffer = g.createBuffer(); vao = g.createVertexArray();
    if (!buffer || !vao) throw new Error('Unable to allocate lattice geometry');
    g.bindVertexArray(vao); g.bindBuffer(g.ARRAY_BUFFER, buffer);
    g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 3, g.FLOAT, false, 12, 0); g.vertexAttribDivisor(0, 1);
    g.enable(g.BLEND); g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
    const uniform = (name: string) => g.getUniformLocation(program!, name);
    const u = { viewport: uniform('viewport'), edge: uniform('edge'), elapsed: uniform('elapsed'),
      phase: uniform('phase'), inward: uniform('inward'), easing: uniform('easing'), renderScale: uniform('renderScale') };
    // Resolve theme paint once. Composite the translucent tint over its opaque base exactly as CSS does.
    const probe = field.ownerDocument.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'; field.append(probe);
    const pixel = field.ownerDocument.createElement('canvas'); pixel.width = pixel.height = 1;
    const ctx = pixel.getContext('2d', { willReadFrequently: true });
    if (!ctx) { probe.remove(); throw new Error('Unable to resolve lattice colors'); }
    const paint = (expression: string) => {
      probe.style.color = expression; ctx.fillStyle = getComputedStyle(probe).color; ctx.fillRect(0, 0, 1, 1);
    };
    paint('var(--splash-background, var(--background, #151313))'); paint('var(--wb-lattice-tint)');
    g.uniform4fv(uniform('fillColor'), Float32Array.from(ctx.getImageData(0, 0, 1, 1).data, x => x / 255));
    ctx.clearRect(0, 0, 1, 1); paint('color-mix(in srgb, var(--foreground) 6%, transparent)');
    g.uniform4fv(uniform('seamColor'), Float32Array.from(ctx.getImageData(0, 0, 1, 1).data, x => x / 255));
    probe.remove();
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    field.append(canvas);
    canvas.addEventListener('webglcontextlost', lost);
    let count = 0;
    return {
      layout: (plan, width, height) => {
        const max = Number(g.getParameter(g.MAX_RENDERBUFFER_SIZE));
        const dims = g.getParameter(g.MAX_VIEWPORT_DIMS) as Int32Array;
        const dpr = Math.min(field.ownerDocument.defaultView?.devicePixelRatio || 1, max / width, max / height, dims[0]! / width, dims[1]! / height);
        const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        g.viewport(0, 0, w, h); g.uniform2f(u.viewport, width, height); g.uniform1f(u.edge, plan.cellPx);
        g.uniform1f(u.renderScale, dpr);
        count = plan.reach.length;
        const data = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) { data[i * 3] = (i % plan.cols + .5) * plan.cellPx; data[i * 3 + 1] = (Math.floor(i / plan.cols) + .5) * plan.cellPx; data[i * 3 + 2] = plan.reach[i]!; }
        g.bindBuffer(g.ARRAY_BUFFER, buffer); g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW);
      },
      direction: inward => g.uniform1f(u.inward, inward ? 1 : 0),
      draw: (elapsed, phase) => {
        if (g.isContextLost()) return false;
        g.uniform1f(u.elapsed, elapsed); g.uniform1f(u.phase, phase === 'closed' ? 2 : phase === 'covering' ? 0 : 1);
        g.uniform4fv(u.easing, phase === 'covering' ? EASE_OUT : EASE_EXIT);
        g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT);
        g.drawArraysInstanced(g.TRIANGLES, 0, 6, count); return true;
      },
      dispose,
    };
  } catch { dispose(); return null; }
}
