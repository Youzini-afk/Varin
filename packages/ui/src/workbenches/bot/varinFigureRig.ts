import { requestFrame, type FrameHandle } from '@/lib/motion/frame';
import { documentMotionLevel, type MotionLevel } from '@/lib/motion/preference';
import type { BotFigureState } from './botPresentation';
import { VARIN_FIGURE_BLUSH, VARIN_FIGURE_LAYERS, type VarinFigureLayer } from './varinFigureArt';

/**
 * The Bot figure's rig (docs/design/varin-figure.md): Varin leaning on a window sill, drawn from the
 * traced layers and driven by springs. One instance owns one SVG inside the host element. There is no
 * frame: she stands on the page itself, leaning on a light ledge that follows the theme.
 *
 * - Every state has a pose and, at full motion, a loop; one-shot moves (wink, nod, tilt, poke) play
 *   on top. Eyes and mouth change shape by closing and reopening, never by cross-fading.
 * - Still figures (small sizes, `still`) and Reduced / Off motion render the resting pose only; under
 *   Reduced a pose change fades in. Without `requestAnimationFrame` (tests, SSR) the figure is still.
 * - The frame loop runs only while the figure is animated, on screen and the page is visible.
 */

const NS = 'http://www.w3.org/2000/svg';
type View = readonly [x: number, y: number, width: number, height: number];
const VIEW_FULL: View = [34, -24, 1192, 1192];
const VIEW_HEAD: View = [330, 236, 750, 750];
const CENTER_X = 628;
const PIVOT = [628, 1100] as const;
const SILL = 1100;
const EYE = { L: [489, 706], R: [763, 706] } as const;
const HL = { L: [511, 651], R: [741, 651] } as const;
const HL2 = { L: [471, 716], R: [781, 716] } as const;
const BROW = { L: [486, 548], R: [757, 542] } as const;
const HAND = { L: [473, 1097], R: [767, 1097] } as const;
const AHOGE = [240, 466] as const;
const SKIN = '#fae5dd';
// Sleep z's, thinking bubbles and the question mark use the theme's muted ink.
const MARK_FILL = 'fill: var(--bot-figure-mark, #9aa0ad)';
const MARK_STROKE = 'stroke: var(--bot-figure-mark, #9aa0ad)';
const LASH = '#2f3555';

type Side = 'L' | 'R';
type Attrs = Record<string, string | number>;
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(NS, tag);
  for (const key in attrs) node.setAttribute(key, String(attrs[key]));
  parent?.appendChild(node);
  return node;
};
const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const bump = (x: number, a: number, b: number): number => (x <= a || x >= b ? 0 : Math.sin(Math.PI * (x - a) / (b - a)));
const ramp = (x: number, a: number, b: number): number => clamp((x - a) / (b - a));
const smooth = (x: number): number => x * x * (3 - 2 * x);
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// ---------------------------------------------------------------- parameters and springs
const P0 = {
  fy: 0, frot: 0, fsx: 1, fsy: 1, featX: 0, featY: 0, lookX: 0, lookY: 0, eyeS: 1, eyeY: 1, eyeDim: 0, spark: 0,
  browL: 0, browR: 0, browLr: 0, browRr: 0, blush: 1, shy: 0,
  hLx: HAND.L[0], hLy: HAND.L[1], hRx: HAND.R[0], hRy: HAND.R[1], hLs: 1, hRs: 1,
  glow: 0, gr: 143, gg: 176, gb: 234, grey: 0, droop: 0,
};
type Param = keyof typeof P0;
type Params = Record<Param, number>;
const PARAMS = Object.keys(P0) as Param[];
type SpringGroup = 'body' | 'face' | 'look' | 'hand' | 'slow';
const GROUP: Record<Param, SpringGroup> = {
  fy: 'body', frot: 'body', fsx: 'body', fsy: 'body', featX: 'face', featY: 'face', lookX: 'look', lookY: 'look', eyeS: 'face', eyeY: 'face', eyeDim: 'slow', spark: 'slow',
  browL: 'face', browR: 'face', browLr: 'face', browRr: 'face', blush: 'slow', shy: 'slow', hLx: 'hand', hLy: 'hand', hRx: 'hand', hRy: 'hand', hLs: 'hand', hRs: 'hand',
  glow: 'slow', gr: 'slow', gg: 'slow', gb: 'slow', grey: 'slow', droop: 'slow',
};
const SPRING: Record<SpringGroup, readonly [stiffness: number, damping: number]> = { body: [190, 15], face: [280, 29], look: [420, 38], hand: [170, 16.5], slow: [38, 11.5] };

// ---------------------------------------------------------------- face parts
type EyeShape = 'open' | 'closed' | 'happy' | 'squeezeL' | 'squeezeR';
type EyeRequest = EyeShape | 'squeeze';
const ALT: Record<Exclude<EyeShape, 'open'>, (cx: number) => string> = {
  closed: cx => `M${cx - 44} 682 Q${cx} 716 ${cx + 44} 682`,
  happy: cx => `M${cx - 44} 706 Q${cx} 650 ${cx + 44} 706`,
  squeezeL: cx => `M${cx - 30} 662 L${cx + 26} 690 L${cx - 30} 718`,
  squeezeR: cx => `M${cx + 30} 662 L${cx - 26} 690 L${cx + 30} 718`,
};
const LIP = '#e7a19c', MOUTH_IN = '#e2827f', TONGUE = '#f3aaa6';
const stroke = { fill: 'none', stroke: LIP, 'stroke-width': 5.5, 'stroke-linecap': 'round' };
const MOUTHS = {
  smile: [['path', { ...stroke, d: 'M610 755 Q627 768 644 755' }]],
  open: [['path', { d: 'M609 753 Q627 757 645 753 Q643 776 627 778 Q611 776 609 753 Z', fill: MOUTH_IN }], ['ellipse', { cx: 627, cy: 771, rx: 8, ry: 4.5, fill: TONGUE }]],
  grin: [['path', { d: 'M600 750 Q627 757 654 750 Q652 788 627 790 Q602 788 600 750 Z', fill: MOUTH_IN }], ['ellipse', { cx: 627, cy: 780, rx: 13, ry: 7, fill: TONGUE }]],
  o: [['ellipse', { cx: 627, cy: 766, rx: 10, ry: 12, fill: MOUTH_IN }]],
  sleep: [['ellipse', { cx: 627, cy: 765, rx: 6.5, ry: 7.5, fill: '#e79a96' }]],
  yawn: [['ellipse', { cx: 627, cy: 772, rx: 17, ry: 24, fill: '#d9777a' }], ['ellipse', { cx: 627, cy: 786, rx: 10, ry: 7, fill: '#f0a3a2' }]],
  flat: [['path', { ...stroke, d: 'M614 762 L640 762' }]],
  cat: [['path', { ...stroke, d: 'M603 755 Q614 769 627 758 Q640 769 651 755', 'stroke-linejoin': 'round' }]],
  pout: [['path', { ...stroke, d: 'M611 765 Q619 756 627 763 Q635 770 643 761' }]],
} satisfies Record<string, readonly (readonly ['path' | 'ellipse', Attrs])[]>;
type Mouth = keyof typeof MOUTHS;

// ---------------------------------------------------------------- states (docs/design/bot-ui.md §5.7)
type Fx = Partial<Record<'alert' | 'zz' | 'dots' | 'bits' | 'sparkle', 1>>;
type Pose = Partial<Params> & { eyes?: EyeRequest; eyeL?: EyeRequest; eyeR?: EyeRequest; mouth?: Mouth; fx?: Fx };
interface StateDef {
  glow: number;
  pulse?: boolean;
  blink?: boolean;
  /** Eyes follow the pointer while it moves nearby. */
  follow?: boolean;
  /** Glances around and plays small moves now and then. */
  micro?: boolean;
  noLoops?: boolean;
  fx?: Fx;
  eyes?: EyeRequest;
  mouth?: Mouth;
  /** Seconds into the state that a still figure shows. */
  stillAt?: number;
  enter?(f: VarinFigureRig): void;
  /** `t` seconds in state; `L` is 1 when loops may play and 0 for a still pose. */
  pose(t: number, f: VarinFigureRig, L: number): Pose;
  tick?(t: number, f: VarinFigureRig, L: number): void;
}
// A soft aura behind her, light enough for both themes; most states keep it faint or off.
const GLOW: Record<BotFigureState, string> = {
  idle: '#8fb0ea', listening: '#7aa2ff', thinking: '#a08cff', working: '#5cc6d6', waiting: '#f3b562',
  result: '#f49ab4', sleeping: '#7f8bd6', waking: '#ffd38a', offline: '#8fb0ea',
};
const typing = (t: number, rate: number): [number, number] => ((t % 2.3) < 1.7
  ? [Math.max(0, Math.sin(t * rate)) ** 2, Math.max(0, Math.sin(t * rate + Math.PI)) ** 2]
  : [0, 0]);
const STATES: Record<BotFigureState, StateDef> = {
  idle: { blink: true, follow: true, micro: true, glow: 0,
    pose: (t, f, L) => ({ fy: -3 * L * Math.sin(t * 1.75), fsy: 1 + .006 * L * Math.sin(t * 1.75), lookX: f.glance.x, lookY: f.glance.y, featX: f.glance.x * 5 }) },
  // Leans in; the eyes read along as you type, with a small nod on each burst of keys.
  listening: { blink: true, follow: true, glow: .22,
    enter: f => f.kick('fy', -260),
    pose: (t, _f, L) => {
      const read = L ? -.55 + ((t * .32) % 1) * 1.1 : 0;
      return { fy: -16 - 3 * L * Math.sin(t * 2), fsx: 1.03, fsy: 1.03, frot: 1.3, eyeS: 1.07, spark: 1, lookX: read, lookY: .35, featX: read * 4, browL: -9, browR: -9, hLx: 548, hRx: 706, blush: 1.1 };
    },
    tick: (t, f, L) => {
      if (!L || t <= f.mem.nextKey) return;
      if ((t % 2.6) < 1.8) f.kick('fy', 70 + Math.random() * 50);
      f.mem.nextKey = t + .11 + Math.random() * .16;
    } },
  thinking: { blink: true, glow: .22, fx: { dots: 1 }, mouth: 'pout',
    pose: (t, _f, L) => {
      const drift = .32 * L * Math.sin(t * .85), tap = L * bump((t % 1.6) / 1.6, .55, .75);
      return { frot: -2.8, fy: -6, lookX: -.72 + drift, lookY: -.9, featX: -7 + drift * 6, featY: -4, browL: -13, browR: 2, browLr: -4, browRr: 3, hRx: 688, hRy: 868 - 7 * tap };
    } },
  working: { blink: true, glow: .14, fx: { bits: 1 }, mouth: 'flat',
    pose: (t, _f, L) => {
      const [a, b] = L ? typing(t, 15) : [0, 0];
      return { fy: 10 + 3 * L * Math.sin(t * 2.2), lookY: .95, lookX: .18 * L * Math.sin(t * .7), eyeY: .82, featY: 6, browL: 5, browR: 5, browLr: 6, browRr: -6, hLy: HAND.L[1] - 20 * a, hRy: HAND.R[1] - 20 * b, hLx: HAND.L[0] + 18, hRx: HAND.R[0] - 18 };
    },
    tick: (t, f, L) => {
      if (!L) return;
      const taps = typing(t, 15);
      (['L', 'R'] as const).forEach((side, i) => {
        const was = f.mem[`tap${side}`] ?? 0;
        if (taps[i] > .9 && was <= .9 && Math.random() < .55) f.bit(side);
        f.mem[`tap${side}`] = taps[i];
      });
    } },
  // Hops in, warm glow breathing, a badge, and a wave every few seconds.
  waiting: { blink: true, follow: true, glow: .42, pulse: true, fx: { alert: 1 }, mouth: 'open',
    enter: f => { f.kick('fy', -950); f.kick('fsy', 1.4); },
    pose: (t, _f, L) => {
      const c = t % 3.6, wave = L ? ramp(c, 0, .15) * (1 - ramp(c, 1.25, 1.45)) : 0;
      return { fy: -14, frot: 2.4, eyeS: 1.04, spark: 1, browL: -9, browR: -9, blush: 1.15, hRx: 905 + 30 * wave * Math.sin(c * 15), hRy: 850 - 12 * wave * Math.abs(Math.sin(c * 15)) };
    } },
  // Presses down, pops up with both hands raised, happy eyes and a burst of sparkles.
  result: { glow: .32, eyes: 'happy', mouth: 'grin',
    enter: f => { f.kick('fsy', -2); f.kick('fy', 380); f.later(.18, () => { f.kick('fy', -1100); f.burst(22); f.sheen(); }); },
    pose: (t, _f, L) => {
      const up = ramp(t, .15, .35), hop = L * Math.abs(Math.sin(t * 4.2)) * ramp(t, .9, 1.1);
      return { fy: -10 - 6 * hop, browL: -8, browR: -8, blush: 1.35,
        hLx: lerp(HAND.L[0], 338, up), hLy: lerp(HAND.L[1], 826, up) + 16 * L * Math.sin(t * 8.4),
        hRx: lerp(HAND.R[0], 918, up), hRy: lerp(HAND.R[1], 826, up) + 16 * L * Math.sin(t * 8.4 + Math.PI) };
    } },
  // Sinks below the sill, chin on her hands, eyes closed, the flyaway lock drooping.
  sleeping: { glow: .12, fx: { zz: 1 }, eyes: 'closed', mouth: 'sleep', stillAt: 3,
    pose: (t, _f, L) => ({ fy: 150 + 5 * L * Math.sin(t * 1.35), fsy: 1 + .012 * L * Math.sin(t * 1.35), frot: -3, featY: 4, browL: 6, browR: 6, blush: .85, hLx: 560, hRx: 696, hLy: 1092, hRy: 1092, droop: 1 }) },
  // Rises, rubs an eye and yawns, stretches, then blinks awake.
  waking: { glow: .2, stillAt: 1,
    pose: t => {
      const rise = ramp(t, .3, .9), rub = ramp(t, .95, 1.1) * (1 - ramp(t, 1.85, 2.05)), stretch = ramp(t, 2, 2.25) * (1 - ramp(t, 2.6, 2.95));
      const fy = lerp(150, -4, rise), hLx = lerp(560, 506 + 16 * Math.cos(t * 13), rub), hLy = lerp(1092, 694 + 10 * Math.sin(t * 13), rub), hRx = lerp(696, HAND.R[0], rise);
      const q: Pose = { frot: lerp(-3, 0, rise), droop: 1 - ramp(t, 2.1, 2.4), featY: 4 * (1 - rise), blush: 1,
        fy: fy - 16 * stretch, fsy: 1 + .045 * stretch,
        hLx: lerp(hLx, 250, stretch), hLy: lerp(hLy, 330, stretch), hRx: lerp(hRx, 1005, stretch), hRy: lerp(1094, 330, stretch) };
      q.eyeL = t < .9 || rub > .3 ? 'closed' : stretch > .3 ? 'squeezeL' : 'open';
      q.eyeR = t < .9 ? 'closed' : stretch > .3 ? 'squeezeR' : 'open';
      q.eyeY = t < 2.6 ? .45 : 1;
      q.mouth = t > 1.05 && t < 1.8 ? 'yawn' : stretch > .3 ? 'o' : t < 1 ? 'sleep' : 'smile';
      q.fx = t > 2.95 && t < 3.1 ? { sparkle: 1 } : {};
      return q;
    },
    tick: (t, f) => { if (!f.mem.wakeBlinked && t > 3.05) { f.mem.wakeBlinked = 1; f.blinkNow(true); f.sheen(); } } },
  // Greyed, sunk to the eyes, no loops.
  offline: { glow: 0, mouth: 'flat', noLoops: true,
    pose: () => ({ fy: 330, grey: 1, eyeDim: 1, browL: 4, browR: 4, blush: .5, hLy: 1330, hRy: 1330 }) },
};

// ---------------------------------------------------------------- one-shot moves
interface ActionPose { set?: Partial<Params>; add?: Partial<Params>; eyes?: EyeRequest; eyeL?: EyeRequest; eyeR?: EyeRequest; mouth?: Mouth }
interface ActionDef { dur: number; start?(f: VarinFigureRig): void; pose(x: number, t: number): ActionPose }
type Move = 'wink' | 'nod' | 'tilt' | 'tap' | 'poke';
const ACTIONS: Record<Move, ActionDef> = {
  wink: { dur: 1, start: f => f.later(.12, () => f.pop('sparkle')), pose: () => ({ set: { blush: 1.25, frot: -1.5 }, eyeR: 'happy', mouth: 'cat' }) },
  nod: { dur: 1.05, pose: x => ({ add: { fy: 24 * (bump(x, .05, .45) + bump(x, .5, .9)), featY: 8 * (bump(x, .05, .45) + bump(x, .5, .9)) }, eyes: 'happy', mouth: 'smile' }) },
  tilt: { dur: 1.7, start: f => f.pop('question'), pose: () => ({ set: { frot: 6, featX: 9, lookX: .55, lookY: -.35, browL: -13, browR: 4, browLr: -5, browRr: 4 }, mouth: 'pout' }) },
  tap: { dur: .9, pose: (_x, t) => ({ set: { hLy: HAND.L[1] - 22 * bump(t, 0, .2) - 22 * bump(t, .4, .6), hRy: HAND.R[1] - 22 * bump(t, .2, .4) - 22 * bump(t, .6, .8) } }) },
  poke: { dur: 1.3, start: f => { f.kick('fsy', -2.4); f.kick('fy', 520); f.flick(-26); f.pop('heart'); },
    pose: () => ({ set: { blush: 1.7, shy: 1, browL: -6, browR: -6 }, eyes: 'squeeze', mouth: 'cat' }) },
};
const MICRO: readonly (Move | 'flick')[] = ['wink', 'nod', 'tilt', 'flick', 'tap'];

// ---------------------------------------------------------------- shared pointer and environment
let pointer: { x: number; y: number; at: number } | null = null;
let pointerTracked = false;
const trackPointer = (): void => {
  if (pointerTracked || typeof window === 'undefined') return;
  pointerTracked = true;
  window.addEventListener('pointermove', event => { pointer = { x: event.clientX, y: event.clientY, at: performance.now() }; }, { passive: true });
};
const canAnimate = (): boolean => typeof globalThis.requestAnimationFrame === 'function';
let seq = 0;

interface Shape { cur: string; amt: number; va: number }
interface Eye extends Shape { cur: EyeShape; open: SVGGElement; hl: SVGCircleElement; hl2: SVGCircleElement; alt: SVGPathElement }
interface Particle { node: SVGElement; x: number; y: number; vx: number; vy: number; g: number; r: number; vr: number; s: number; life: number; max: number; drag?: number }
interface PopFx { node: SVGElement; x: number; y: number; vx: number; vy: number; life: number; max: number; kind: string }

export interface VarinFigureOptions {
  state: BotFigureState;
  /** Head crop for the small sizes (sidebar, title bar); always still. */
  compact: boolean;
  /** Pose only, no loops. */
  still: boolean;
  /** Fill the host's width: the scene widens around her and the ledge runs edge to edge. */
  wide?: boolean;
}

export class VarinFigureRig {
  private readonly host: HTMLElement;
  private readonly compact: boolean;
  private readonly wide: boolean;
  private readonly posed: boolean;
  private view: View;
  private ledge: SVGRectElement | null = null;
  private readonly uid = `vf${++seq}`;
  private svg!: SVGSVGElement;
  private state: BotFigureState;
  private t = 0;
  private stateAt = 0;
  private p: Params = { ...P0 };
  private v: Partial<Params> = {};
  private goal: Params = { ...P0 };
  private sec = { a: 0, va: 0, r: 0, vr: 0 };
  private eyes!: Record<Side, Eye>;
  private mouth: Shape = { cur: 'smile', amt: 1, va: 0 };
  private eyeGoal: Record<Side, EyeShape> = { L: 'open', R: 'open' };
  private mouthGoal: Mouth = 'smile';
  private fxGoal: Fx = {};
  private fxAmt = { alert: 0, zz: 0, dots: 0 };
  private parts: Particle[] = [];
  private pops: PopFx[] = [];
  private timers: { at: number; fn: () => void }[] = [];
  private action: { def: ActionDef; at: number } | null = null;
  private blinkAt = -9;
  private blinkAt2 = -9;
  private nextBlink = 1.5;
  private nextMicro = 6;
  private sheenAt = -9;
  private matrixOn = false;
  private snapping = false;
  private level: MotionLevel = 'full';
  private frame: FrameHandle | null = null;
  private lastTime: number | null = null;
  private onscreen = true;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];
  /** Per-state scratch values for loops. */
  mem: Record<string, number> = {};
  glance = { x: 0, y: 0, until: 0 };
  // Elements written every frame.
  private fig!: SVGGElement;
  private feat!: SVGGElement;
  private ahoge!: SVGGElement;
  private bowTail!: SVGGElement;
  private bowLoop!: SVGGElement;
  private sheenRect!: SVGRectElement;
  private glowStops!: SVGStopElement[];
  private matrix!: SVGFEColorMatrixElement;
  private brows!: SVGGElement[];
  private blushes!: { g: SVGGElement; e: SVGEllipseElement; lines: SVGPathElement; cx: number; cy: number }[];
  private mouths!: Record<Mouth, SVGGElement>;
  private hands!: { g: SVGGElement; sh: SVGEllipseElement }[];
  private fxFront!: SVGGElement;
  private badge!: SVGGElement;
  private badgeRing!: SVGCircleElement;
  private zz!: SVGPathElement[];
  private dots!: { x: number; y: number; n: SVGCircleElement }[];

  constructor(host: HTMLElement, options: VarinFigureOptions) {
    this.host = host;
    this.compact = options.compact;
    this.wide = Boolean(options.wide) && !options.compact;
    this.view = options.compact ? VIEW_HEAD : VIEW_FULL;
    this.posed = options.still || options.compact || !canAnimate();
    this.state = options.state;
    this.build();
    if (this.wide) this.fitWidth();
    this.level = documentMotionLevel();
    if (!this.posed) this.watch();
    this.enterState(options.state, true);
  }

  // ------------------------------------------------------------ public
  setState(state: BotFigureState): void {
    if (this.disposed || state === this.state) return;
    this.enterState(state, false);
  }

  dispose(): void {
    this.disposed = true;
    this.frame?.cancel();
    this.frame = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.svg.remove();
  }

  // ------------------------------------------------------------ used by states and moves
  kick(key: Param, dv: number): void { if (this.animated) this.v[key] = (this.v[key] ?? 0) + dv; }
  flick(dv: number): void { if (this.animated) this.sec.va += dv * 6; }
  later(dt: number, fn: () => void): void { this.timers.push({ at: this.t + dt, fn }); }
  blinkNow(double: boolean): void { this.blinkAt = this.t; this.blinkAt2 = double ? this.t + .26 : -9; }
  sheen(): void { if (this.animated) this.sheenAt = this.t; }
  play(name: Move | 'flick'): void {
    if (!this.animated || this.state === 'offline') return;
    if (name === 'flick') { this.flick(-24); return; }
    const def = ACTIONS[name];
    this.action = { def, at: this.t };
    def.start?.(this);
  }

  bit(side: Side): void {
    if (!this.animated) return;
    const x = (side === 'L' ? this.p.hLx : this.p.hRx) + (Math.random() - .5) * 60;
    const colors = ['#8fb0ea', '#c9d6f5', '#f3c690', '#a9c2f2'];
    const node = el('rect', { x: -9, y: -9, width: 18, height: 18, rx: 3, fill: colors[Math.floor(Math.random() * colors.length)] }, this.fxFront);
    this.parts.push({ node, x, y: 1030, vx: (Math.random() - .5) * 90, vy: -260 - Math.random() * 160, g: 120, r: 45, vr: (Math.random() - .5) * 200, s: .7 + Math.random() * .6, life: 0, max: .95 });
  }

  burst(count: number): void {
    if (!this.animated) return;
    const colors = ['#ffd36e', '#8fb0ea', '#f4a9c0', '#c9d6f5', '#b8c9f5'];
    for (let i = 0; i < count; i += 1) {
      const a = -Math.PI / 2 + (Math.random() - .5) * Math.PI * 1.5, speed = 520 + Math.random() * 520, fill = colors[i % colors.length];
      const node = i % 2 === 0
        ? el('path', { d: 'M0 -20 Q3 -3 20 0 Q3 3 0 20 Q-3 3 -20 0 Q-3 -3 0 -20 Z', fill }, this.fxFront)
        : el('rect', { x: -9, y: -9, width: 18, height: 18, rx: 3, fill }, this.fxFront);
      this.parts.push({ node, x: 628 + (Math.random() - .5) * 120, y: 360, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, g: 1300, r: Math.random() * 90, vr: (Math.random() - .5) * 600, s: .8 + Math.random() * .9, life: 0, max: 1.1 + Math.random() * .5, drag: 1.4 });
    }
  }

  pop(kind: 'heart' | 'question' | 'sparkle'): void {
    if (!this.animated) return;
    let node: SVGElement;
    let at: [number, number, number, number];
    if (kind === 'heart') {
      node = el('path', { d: 'M0 26 C-46 -6 -34 -50 0 -26 C34 -50 46 -6 0 26 Z', fill: '#f49ab4' }, this.fxFront);
      at = [1010, 360, 0, -170];
    } else if (kind === 'question') {
      node = el('g', {}, this.fxFront);
      el('path', { d: 'M-20 -24 C-20 -50 22 -50 22 -22 C22 -4 0 -2 0 16', fill: 'none', style: MARK_STROKE, 'stroke-width': 13, 'stroke-linecap': 'round' }, node);
      el('circle', { cx: 0, cy: 40, r: 8, style: MARK_FILL }, node);
      at = [220, 230, 0, -40];
    } else {
      node = el('path', { d: 'M0 -30 Q4 -4 30 0 Q4 4 0 30 Q-4 4 -30 0 Q-4 -4 0 -30 Z', fill: '#ffd36e' }, this.fxFront);
      at = [850, 600, 0, -30];
    }
    this.pops.push({ node, x: at[0], y: at[1], vx: at[2], vy: at[3], life: 0, max: kind === 'question' ? 1.5 : 1.1, kind });
  }

  // ------------------------------------------------------------ lifecycle
  /** Widen the scene to the host's aspect ratio, keeping her centred and the ledge full width. */
  private fitWidth(): void {
    const resize = (): void => {
      const width = this.host.clientWidth, height = this.host.clientHeight;
      if (!width || !height) return;
      const span = Math.max(VIEW_FULL[2], VIEW_FULL[3] * width / height);
      this.view = [CENTER_X - span / 2, VIEW_FULL[1], span, VIEW_FULL[3]];
      this.svg.setAttribute('viewBox', this.view.join(' '));
      this.ledge?.setAttribute('x', String(this.view[0] - 40));
      this.ledge?.setAttribute('width', String(span + 80));
    };
    resize();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(resize);
    ro.observe(this.host);
    this.cleanups.push(() => ro.disconnect());
  }

  private get animated(): boolean { return !this.posed && !this.snapping && this.level === 'full'; }
  /** 1 when loops may play. */
  private get L(): number { return this.animated && !STATES[this.state].noLoops ? 1 : 0; }

  private enterState(state: BotFigureState, first: boolean): void {
    const fade = !first && !this.posed && this.level === 'reduced';
    this.state = state;
    this.stateAt = this.t;
    this.mem = { nextKey: 0 };
    this.action = null;
    this.host.dataset.state = state;
    if (this.animated) {
      // A figure appears already in its pose; later changes move into the new one.
      if (first) { this.snapping = true; this.settle(STATES[state].stillAt ?? 2.2); this.snapping = false; }
      else STATES[state].enter?.(this);
      this.nextMicro = this.t + 5 + Math.random() * 5;
      this.run();
      return;
    }
    this.settle(STATES[state].stillAt ?? 2.2);
    if (fade) {
      // Reduced motion keeps only the pose change, as a short fade.
      this.svg.style.transition = 'none';
      this.svg.style.opacity = '.35';
      void this.svg.getBoundingClientRect();
      this.svg.style.transition = 'opacity 180ms ease-out';
      this.svg.style.opacity = '1';
    }
  }

  /** Fast-forward the springs to the resting pose. */
  private settle(seconds: number): void {
    this.stateAt = this.t;
    for (let i = 0; i < seconds * 60; i += 1) this.step(1 / 60);
    this.render();
  }

  private watch(): void {
    trackPointer();
    const onVisibility = (): void => this.run();
    document.addEventListener('visibilitychange', onVisibility);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(entries => {
        for (const entry of entries) this.onscreen = entry.isIntersecting;
        this.run();
      }, { rootMargin: '64px 0px' });
      io.observe(this.host);
      this.cleanups.push(() => io.disconnect());
    }
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(() => {
        const level = documentMotionLevel();
        if (level === this.level) return;
        this.level = level;
        if (level === 'full') this.run();
        else { this.clearFx(); this.settle(STATES[this.state].stillAt ?? 2.2); }
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
      this.cleanups.push(() => mo.disconnect());
    }
    const onPoke = (): void => { if (this.state !== 'offline' && this.state !== 'sleeping') this.play('poke'); };
    this.host.addEventListener('pointerdown', onPoke);
    this.cleanups.push(() => this.host.removeEventListener('pointerdown', onPoke));
  }

  private get running(): boolean {
    return this.animated && !this.disposed && this.onscreen && document.visibilityState !== 'hidden';
  }

  private run(): void {
    if (!this.running || this.frame) return;
    this.lastTime = null;
    this.frame = requestFrame(this.tick);
  }

  private tick = (time: number): void => {
    this.frame = null;
    if (!this.running) return;
    const dt = this.lastTime === null ? 1 / 60 : Math.min(.05, (time - this.lastTime) / 1000);
    this.lastTime = time;
    this.step(dt);
    this.stepFx(dt);
    this.render();
    this.frame = requestFrame(this.tick);
  };

  private clearFx(): void {
    for (const q of this.parts) q.node.remove();
    for (const q of this.pops) q.node.remove();
    this.parts = [];
    this.pops = [];
    this.timers = [];
    this.svg.style.removeProperty('opacity');
  }

  // ------------------------------------------------------------ simulation
  private step(dt: number): void {
    this.t += dt;
    const t = this.t, lt = t - this.stateAt, st = STATES[this.state], L = this.L;
    for (const timer of this.timers.splice(0)) { if (timer.at <= t) timer.fn(); else this.timers.push(timer); }
    const following = Boolean(L && st.follow && pointer && performance.now() - pointer.at < 2500);
    if (st.micro && t > this.glance.until && !following) {
      const rest = Math.random() < .45;
      this.glance = { x: rest ? 0 : (Math.random() - .5) * 1.5, y: rest ? 0 : (Math.random() - .6) * .7, until: t + 1.6 + Math.random() * 2.8 };
    }
    if (!st.micro || !L) this.glance = { x: 0, y: 0, until: 0 };
    const q = st.pose(lt, this, L);
    const goal: Params = { ...P0 };
    for (const key of PARAMS) { const value = q[key]; if (value !== undefined) goal[key] = value; }
    let eyeL: EyeRequest = q.eyeL ?? q.eyes ?? st.eyes ?? 'open', eyeR: EyeRequest = q.eyeR ?? q.eyes ?? st.eyes ?? 'open', mouth: Mouth = q.mouth ?? st.mouth ?? 'smile';
    if (following) {
      const [x, y] = this.pointerLook();
      goal.lookX = x; goal.lookY = y * .8 + goal.lookY * .2; goal.featX = (q.featX ?? 0) * .3 + x * 6; goal.frot += x * 1.6;
    }
    if (this.action) {
      const { def, at } = this.action, x = (t - at) / def.dur;
      if (x >= 1) this.action = null;
      else {
        const w = smooth(ramp(x, 0, .12)) * smooth(1 - ramp(x, .85, 1)), o = def.pose(x, t - at);
        for (const key of PARAMS) {
          const set = o.set?.[key], add = o.add?.[key];
          if (set !== undefined) goal[key] = lerp(goal[key], set, w);
          if (add !== undefined) goal[key] += add * w;
        }
        if (w > .35) { if (o.eyes) eyeL = eyeR = o.eyes; if (o.eyeL) eyeL = o.eyeL; if (o.eyeR) eyeR = o.eyeR; if (o.mouth) mouth = o.mouth; }
      }
    }
    const [r, g, b] = hex(GLOW[this.state]);
    goal.gr = r; goal.gg = g; goal.gb = b;
    goal.glow = st.glow * (st.pulse && L ? .78 + .22 * Math.sin(2 * Math.PI * lt / 2.2) : 1);
    this.goal = goal;
    this.eyeGoal = { L: eyeL === 'squeeze' ? 'squeezeL' : eyeL, R: eyeR === 'squeeze' ? 'squeezeR' : eyeR };
    this.mouthGoal = mouth;
    this.fxGoal = { ...st.fx, ...q.fx };
    st.tick?.(lt, this, L);
    if (st.micro && L && !this.action && t > this.nextMicro) {
      this.play(MICRO[Math.floor(Math.random() * MICRO.length)]);
      this.nextMicro = t + 7 + Math.random() * 7;
    }
    if (st.blink && L && t > this.nextBlink) { this.blinkNow(Math.random() < .2); this.nextBlink = t + 2.2 + Math.random() * 3.2; }
    this.integrate(dt);
  }

  private integrate(dt: number): void {
    const p = this.p, goal = this.goal, sub = dt > 1 / 70 ? 2 : 1, h = dt / sub, springy = this.animated, L = this.L;
    for (let s = 0; s < sub; s += 1) {
      for (const key of PARAMS) {
        if (!springy) { p[key] += (goal[key] - p[key]) * clamp(h * 8); this.v[key] = 0; continue; }
        const [k, c] = SPRING[GROUP[key]], v = this.v[key] ?? 0;
        const next = v + (k * (goal[key] - p[key]) - c * v) * h;
        this.v[key] = next; p[key] += next * h;
      }
      this.morph(this.eyes.L, this.eyeGoal.L, h);
      this.morph(this.eyes.R, this.eyeGoal.R, h);
      this.morph(this.mouth, this.mouthGoal, h);
      // Secondary motion: the flyaway lock and the bow trail the body.
      const sec = this.sec, vy = this.v.fy ?? 0, vr = this.v.frot ?? 0;
      const aim = L ? .012 * vy - .9 * vr + 2.2 * Math.sin(this.t * 1.9) : 0;
      sec.va += (140 * (aim - 6 * p.droop - sec.a) - 7 * sec.va) * h; sec.a += sec.va * h;
      const rim = L ? -1.1 * vr + 1.8 * Math.sin(this.t * 1.3 + 1) : 0;
      sec.vr += (90 * (rim - sec.r) - 6 * sec.vr) * h; sec.r += sec.vr * h;
      for (const key of ['alert', 'zz', 'dots'] as const) {
        const want = this.fxGoal[key] ? 1 : 0;
        this.fxAmt[key] += (want - this.fxAmt[key]) * clamp(h * (want ? 6 : 9));
      }
    }
  }

  private morph(m: Shape, want: string, h: number): void {
    if (!this.animated) { m.cur = want; m.amt = 1; return; }
    const target = m.cur === want ? 1 : 0;
    m.va += (900 * (target - m.amt) - 52 * m.va) * h; m.amt += m.va * h;
    if (m.cur !== want && m.amt < .08) { m.cur = want; m.amt = .05; m.va = 0; }
    m.amt = clamp(m.amt, 0, 1.2);
  }

  private pointerLook(): [number, number] {
    if (!pointer || typeof this.host.getBoundingClientRect !== 'function') return [0, 0];
    const r = this.host.getBoundingClientRect(), [x0, y0, span] = this.view, s = r.width / span;
    const dx = pointer.x - (r.left + (628 - x0) * s), dy = pointer.y - (r.top + (690 - y0) * s);
    const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / (r.width * .55 || 1));
    return [dx / d * k, dy / d * k];
  }

  private stepFx(dt: number): void {
    this.parts = this.parts.filter(q => {
      q.life += dt;
      if (q.life >= q.max) { q.node.remove(); return false; }
      q.vy += q.g * dt;
      if (q.drag) { q.vx *= 1 - q.drag * dt; q.vy *= 1 - q.drag * .4 * dt; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.r += q.vr * dt;
      const fade = 1 - ramp(q.life / q.max, .6, 1), grow = Math.min(1, q.life / .12);
      q.node.setAttribute('transform', `translate(${q.x.toFixed(1)} ${q.y.toFixed(1)}) rotate(${q.r.toFixed(0)}) scale(${(q.s * grow).toFixed(3)})`);
      q.node.setAttribute('opacity', fade.toFixed(3));
      return true;
    });
    this.pops = this.pops.filter(q => {
      q.life += dt;
      const x = q.life / q.max;
      if (x >= 1) { q.node.remove(); return false; }
      const pop = x < .25 ? 1 + .35 * Math.sin(x / .25 * Math.PI) * (1 - x / .25) : 1;
      const s = Math.min(1, x / .14) * pop, spin = q.kind === 'question' ? 8 * Math.sin(q.life * 7) : q.kind === 'sparkle' ? q.life * 140 : 0;
      q.node.setAttribute('transform', `translate(${q.x + q.vx * q.life} ${q.y + q.vy * q.life}) rotate(${spin}) scale(${s})`);
      q.node.setAttribute('opacity', (1 - ramp(x, .7, 1)).toFixed(3));
      return true;
    });
  }

  // ------------------------------------------------------------ drawing
  private render(): void {
    const p = this.p, t = this.t, c = this.compact, L = this.L;
    const fy = c ? p.fy * .12 : p.fy, frot = c ? p.frot * .5 : p.frot, fsx = p.fsx * (1 + (1 - p.fsy) * .55);
    this.fig.setAttribute('transform', `translate(${PIVOT[0]} ${PIVOT[1] + fy}) rotate(${frot}) scale(${fsx} ${p.fsy}) translate(${-PIVOT[0]} ${-PIVOT[1]})`);
    this.feat.setAttribute('transform', `translate(${p.featX + p.lookX * 4} ${p.featY + p.lookY * 3})`);
    const blink = Math.max(bump(t - this.blinkAt, 0, .17), bump(t - this.blinkAt2, 0, .17));
    for (const k of ['L', 'R'] as const) {
      const e = this.eyes[k], [cx, cy] = EYE[k], amt = Math.max(.001, e.amt), lx = p.lookX * 13, ly = p.lookY * 9;
      if (e.cur === 'open') {
        const sy = amt * p.eyeY * (1 - .95 * blink);
        e.open.setAttribute('transform', `translate(${cx + lx} ${cy + ly}) scale(${p.eyeS} ${p.eyeS * sy}) translate(${-cx} ${-cy})`);
        e.open.setAttribute('opacity', String(1 - .45 * p.eyeDim));
        const twinkle = 1 + .14 * Math.sin(t * 2.6 + (k === 'L' ? 0 : 1.3)) * L;
        e.hl.setAttribute('transform', `translate(${HL[k][0] + p.lookX * 5} ${HL[k][1] + p.lookY * 4}) scale(${twinkle}) translate(${-HL[k][0]} ${-HL[k][1]})`);
        e.hl.setAttribute('opacity', String(1 - p.eyeDim));
        e.hl2.setAttribute('opacity', String(clamp(p.spark) * (1 - p.eyeDim)));
        e.open.style.display = ''; e.alt.style.display = 'none';
      } else {
        e.open.style.display = 'none'; e.alt.style.display = '';
        e.alt.setAttribute('d', ALT[e.cur](cx));
        e.alt.setAttribute('transform', `translate(${cx + lx * .4} ${cy}) scale(1 ${amt}) translate(${-cx} ${-cy})`);
      }
    }
    const current = this.mouth.cur as Mouth;
    for (const key of Object.keys(this.mouths) as Mouth[]) this.mouths[key].style.display = key === current ? '' : 'none';
    const ma = Math.max(.001, this.mouth.amt), breathe = current === 'sleep' ? 1 + .18 * Math.sin(t * 1.35) * L : 1;
    this.mouths[current].setAttribute('transform', `translate(627 762) scale(${Math.min(1, ma * 1.15) * breathe} ${ma * breathe}) translate(-627 -762)`);
    this.brows.forEach((g, i) => {
      const k = i ? 'R' : 'L', [bx, by] = BROW[k];
      g.setAttribute('transform', `translate(0 ${p[k === 'L' ? 'browL' : 'browR'] + p.lookY * 3}) rotate(${p[k === 'L' ? 'browLr' : 'browRr']} ${bx} ${by})`);
    });
    for (const b of this.blushes) {
      const s = 1 + .12 * clamp(p.blush - 1);
      b.g.setAttribute('transform', `translate(${b.cx} ${b.cy}) scale(${s}) translate(${-b.cx} ${-b.cy})`);
      b.e.setAttribute('opacity', String(clamp(p.blush)));
      b.e.setAttribute('fill', p.blush > 1 ? '#f2b3a9' : '#f3c4ba');
      b.lines.setAttribute('opacity', String(clamp(p.shy)));
    }
    this.ahoge.setAttribute('transform', `rotate(${this.sec.a} ${AHOGE[0]} ${AHOGE[1]})`);
    this.bowTail.setAttribute('transform', `rotate(${this.sec.r} 1030 540)`);
    this.bowLoop.setAttribute('transform', `rotate(${-.7 * this.sec.r + 1.3 * Math.sin(t * 1.7) * L} 1066 528)`);
    const sweep = (t - this.sheenAt) / .95;
    if (sweep >= 0 && sweep < 1) {
      this.sheenRect.setAttribute('opacity', '1');
      this.sheenRect.setAttribute('transform', `rotate(-18 628 600) translate(${lerp(-200, 1500, smooth(sweep))} 0)`);
    } else this.sheenRect.setAttribute('opacity', '0');
    const hand = (h: { g: SVGGElement; sh: SVGEllipseElement }, x: number, y: number, s: number): void => {
      h.g.setAttribute('transform', `translate(${x} ${y}) scale(${s})`);
      h.g.style.display = c ? 'none' : '';
      h.sh.setAttribute('opacity', String(lerp(.12, .22, clamp(1 - (HAND.L[1] - y) / 90))));
    };
    hand(this.hands[0], p.hLx, p.hLy, p.hLs);
    hand(this.hands[1], p.hRx, p.hRy, p.hRs);
    const color = `rgb(${p.gr | 0},${p.gg | 0},${p.gb | 0})`;
    for (const stop of this.glowStops) stop.setAttribute('stop-color', color);
    this.glowStops[0].setAttribute('stop-opacity', String(clamp(p.glow)));
    this.glowStops[1].setAttribute('stop-opacity', String(clamp(p.glow) * .35));
    const grey = clamp(p.grey);
    if (grey > .01) {
      const s = 1 - .88 * grey, light = 1 - .22 * grey, lr = .2126 * (1 - s), lg = .7152 * (1 - s), lb = .0722 * (1 - s);
      const values = [lr + s, lg, lb, 0, 0, lr, lg + s, lb, 0, 0, lr, lg, lb + s, 0, 0, 0, 0, 0, 1, 0];
      this.matrix.setAttribute('values', values.map((v, i) => (i % 5 < 3 && i < 15 ? v * light : v).toFixed(4)).join(' '));
      if (!this.matrixOn) { this.fig.setAttribute('filter', `url(#${this.uid}f)`); this.matrixOn = true; }
    } else if (this.matrixOn) { this.fig.removeAttribute('filter'); this.matrixOn = false; }
    this.renderFx();
  }

  private renderFx(): void {
    const t = this.t, a = this.fxAmt, c = this.compact, L = this.L;
    const bw = a.alert;
    if (bw > .01) {
      const [x, y] = c ? [1020, 300] : [1132, 142];
      const scale = (c ? 1.7 : 1) * (bw < .999 ? 1 + .25 * Math.sin(bw * Math.PI) : 1) * bw;
      this.badge.setAttribute('transform', `translate(${x} ${y}) scale(${scale})`);
      this.badge.setAttribute('opacity', String(clamp(bw * 1.3)));
      const ph = (t % 1.6) / 1.6;
      this.badgeRing.setAttribute('r', String(44 + ph * 36));
      this.badgeRing.setAttribute('opacity', String(L ? .6 * (1 - ph) : 0));
    } else this.badge.setAttribute('opacity', '0');
    this.zz.forEach((z, i) => {
      const ph = L ? ((t * .3) + i / 3) % 1 : [.35, .62, .9][i], [x, y] = c ? [1000, 260] : [1000, 300];
      z.setAttribute('transform', `translate(${x + ph * 120 + i * 8} ${y - ph * 210}) scale(${(c ? 1.6 : 1) * (.65 + ph * .8)})`);
      z.setAttribute('opacity', String(a.zz * Math.sin(Math.PI * ph)));
    });
    this.dots.forEach((d, i) => {
      const pulse = L ? Math.max(0, Math.sin(2 * Math.PI * (t * .9 - i * .2))) : .5, show = clamp(a.dots * 3 - i * .8);
      d.n.setAttribute('opacity', String(show * (.55 + .4 * pulse)));
      d.n.setAttribute('transform', `translate(${d.x} ${d.y}) scale(${(c ? 1.4 : 1) * (1 + .16 * pulse) * (.4 + .6 * show)}) translate(${-d.x} ${-d.y})`);
    });
  }

  // ------------------------------------------------------------ construction
  private build(): void {
    const u = this.uid;
    const svg = el('svg', { viewBox: this.view.join(' '), preserveAspectRatio: 'xMidYMax meet', 'aria-hidden': 'true', focusable: 'false', 'data-agent-avatar': 'bot-figure' });
    this.svg = svg;
    this.host.appendChild(svg);
    const defs = el('defs', {}, svg);
    const glow = el('radialGradient', { id: `${u}g`, cx: .5, cy: .5, r: .5 }, defs);
    this.glowStops = [0, .55, 1].map(offset => el('stop', { offset, 'stop-color': '#3b4c78', 'stop-opacity': 0 }, glow));
    const sheen = el('linearGradient', { id: `${u}s`, x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
    for (const [offset, alpha] of [[0, 0], [.5, .55], [1, 0]]) el('stop', { offset, 'stop-color': '#ffffff', 'stop-opacity': alpha }, sheen);
    const filter = el('filter', { id: `${u}f`, 'color-interpolation-filters': 'sRGB' }, defs);
    this.matrix = el('feColorMatrix', { type: 'matrix', values: '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0' }, filter);
    const clip = (id: string, d: string, rule = 'nonzero'): string => {
      const node = el('clipPath', { id: `${u}${id}` }, defs);
      el('path', { d, 'clip-rule': rule }, node);
      return `url(#${u}${id})`;
    };
    const above = clip('above', `M0 0H1254V${SILL + 6}H0Z`);
    const lower = clip('lower', 'M0 0H1254V1222H0Z');
    // The flyaway lock's own outline: grown for the moving copy, cut a little larger in the static hair.
    const ahogeIn = clip('ai', VARIN_FIGURE_LAYERS.ahogeIn[0][1]);
    const ahogeOut = clip('ao', `M0 0H1254V1254H0Z ${VARIN_FIGURE_LAYERS.ahogeHole[0][1]}`, 'evenodd');
    const paint = (layer: VarinFigureLayer, parent: Element): void => {
      for (const [fill, d] of layer) el('path', { fill, d, 'fill-rule': 'evenodd' }, parent);
    };

    // No backdrop: a state-coloured aura that fades out well inside the box, then everything above the ledge.
    el('circle', { cx: 628, cy: 640, r: 520, fill: `url(#${u}g)` }, svg);
    const aboveLedge = el('g', { 'clip-path': above }, svg);
    if (this.compact) {
      // The head crop fades out below the chin instead of ending in a hard edge.
      const fade = el('linearGradient', { id: `${u}m`, gradientUnits: 'userSpaceOnUse', x1: 0, x2: 0, y1: 850, y2: 980 }, defs);
      el('stop', { offset: 0, 'stop-color': '#ffffff' }, fade);
      el('stop', { offset: 1, 'stop-color': '#000000' }, fade);
      const mask = el('mask', { id: `${u}mk`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 1254, height: 1254 }, defs);
      el('rect', { x: 0, y: 0, width: 1254, height: 1254, fill: `url(#${u}m)` }, mask);
      aboveLedge.setAttribute('mask', `url(#${u}mk)`);
    }
    this.fig = el('g', {}, aboveLedge);

    // Behind the chin: the shoulder area, the inside of the collar and a little neck.
    const under = el('g', {}, this.fig);
    el('path', { fill: '#9599b8', d: 'M260 1300 L262 1100 C290 1000 390 915 470 892 L530 836 L724 836 L784 892 C864 915 964 1000 992 1100 L994 1300 Z' }, under);
    el('path', { fill: '#6c8dd5', d: 'M536 880 C540 862 584 854 626 854 C668 854 712 862 716 880 Z' }, under);
    el('path', { fill: '#f6dcd2', d: 'M594 826 H658 V874 Q626 884 594 874 Z' }, under);
    el('path', { fill: '#efcdc3', d: 'M594 836 Q626 866 658 836 V826 H594 Z' }, under);

    // Clothes: open white coat, ribbed turtleneck, straps, and the two sleeves ending under the hands.
    const body = el('g', {}, this.fig);
    el('path', { fill: '#f4f4f7', d: 'M529 893 C470 900 420 935 390 965 C355 1000 325 1045 306 1100 L296 1300 L956 1300 L946 1100 C927 1045 897 1000 862 965 C832 935 782 900 723 893 Z' }, body);
    el('path', { fill: '#e5e5ec', d: 'M520 897 C500 960 512 1030 522 1300 L537 1300 L537 900 Z M732 897 C752 960 740 1030 730 1300 L715 1300 L715 900 Z' }, body);
    el('path', { fill: '#82a3e6', d: 'M537 900 L715 900 L719 1300 L533 1300 Z' }, body);
    el('path', { fill: '#7495dc', d: 'M537 914 Q626 934 715 914 L715 930 Q626 944 537 930 Z' }, body);
    el('path', { fill: '#82a3e6', d: 'M529 910 L529 884 Q529 864 548 860 Q588 876 626 879 Q664 876 704 860 Q723 864 723 884 L723 910 Q723 918 714 919 Q626 926 538 919 Q529 918 529 910 Z' }, body);
    el('path', { d: 'M588 890 V910 M664 890 V910', fill: 'none', stroke: '#6b8bd5', 'stroke-width': 7, 'stroke-linecap': 'round' }, body);
    el('path', { fill: '#82a3e6', d: 'M306 1104 C322 1068 360 1042 410 1035 C448 1030 480 1032 502 1042 L506 1300 L300 1300 Z M946 1104 C930 1068 892 1042 842 1035 C804 1030 772 1032 750 1042 L746 1300 L952 1300 Z' }, body);
    el('path', { fill: '#6f90d8', d: 'M537 1060 L547 1060 L574 1106 L537 1106 Z M715 1060 L705 1060 L678 1106 L715 1106 Z' }, body);
    el('path', { d: 'M318 1080 C340 1056 372 1042 410 1037 M934 1080 C912 1056 880 1042 842 1037', fill: 'none', stroke: '#9cb6ec', 'stroke-width': 5, 'stroke-linecap': 'round' }, body);
    const straps = el('g', { fill: '#2b2c33' }, body);
    el('path', { d: 'M452 914 Q470 902 492 901 L512 1040 L466 1046 Z' }, straps);
    el('path', { d: 'M761 901 Q783 902 801 914 L787 1046 L742 1040 Z' }, straps);
    const buckles = el('g', { fill: '#5e6372' }, body);
    el('path', { d: 'M455 948 L503 940 L507 976 L459 985 Z' }, buckles);
    el('path', { d: 'M750 940 L798 948 L794 985 L746 976 Z' }, buckles);
    el('path', { d: 'M548 918 Q568 948 601 966 M704 918 Q684 948 651 966', fill: 'none', stroke: '#a08470', 'stroke-width': 4.5, 'stroke-linecap': 'round' }, body);
    el('path', { d: 'M626 961 L654 989 L626 1017 L598 989 Z', fill: 'none', stroke: '#f3c690', 'stroke-width': 9, 'stroke-linejoin': 'round' }, body);
    const motif = el('g', { fill: '#82a3e6', stroke: '#f4f4f7', 'stroke-width': 4 }, body);
    for (const [x, r] of [[400, -40], [852, 40]]) {
      const group = el('g', { transform: `translate(${x} 1000) rotate(${r})` }, motif);
      for (const [rx, ry] of [[-28, -18.5], [0, -18.5], [-28, 0], [0, 0]]) el('rect', { x: rx, y: ry, width: 28, height: 18.5, rx: 2 }, group);
    }

    paint(VARIN_FIGURE_LAYERS.face, el('g', {}, this.fig));
    // Face features slide a little under the bangs when the head "turns".
    this.feat = el('g', {}, this.fig);
    this.blushes = (['L', 'R'] as const).map(k => {
      const a = VARIN_FIGURE_BLUSH[k === 'L' ? 'blushL' : 'blushR'], g = el('g', {}, this.feat);
      const e = el('ellipse', { cx: a.cx, cy: a.cy, rx: a.rx, ry: a.ry, fill: '#f3c4ba' }, g);
      const lines = el('path', { d: [-18, 0, 18].map(dx => `M${a.cx + dx - 6} ${a.cy + 9} l12 -18`).join(' '), stroke: '#e48b86', 'stroke-width': 4.5, 'stroke-linecap': 'round', opacity: 0 }, g);
      return { g, e, lines, cx: a.cx, cy: a.cy };
    });
    const mouthGroup = el('g', {}, this.feat);
    const mouths: Partial<Record<Mouth, SVGGElement>> = {};
    for (const key of Object.keys(MOUTHS) as Mouth[]) {
      const g = el('g', { style: 'display:none' }, mouthGroup);
      for (const [tag, attrs] of MOUTHS[key]) el(tag, attrs, g);
      mouths[key] = g;
    }
    this.mouths = mouths as Record<Mouth, SVGGElement>;
    const eye = (k: Side): Eye => {
      const wrap = el('g', {}, this.feat), open = el('g', {}, wrap);
      paint(VARIN_FIGURE_LAYERS[k === 'L' ? 'eyeL' : 'eyeR'], open);
      return {
        cur: 'open', amt: 1, va: 0, open,
        hl: el('circle', { cx: HL[k][0], cy: HL[k][1], r: 8.5, fill: '#fbfbfd' }, open),
        hl2: el('circle', { cx: HL2[k][0], cy: HL2[k][1], r: 5.5, fill: '#fbfbfd', opacity: 0 }, open),
        alt: el('path', { fill: 'none', stroke: LASH, 'stroke-width': 13, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'display:none' }, wrap),
      };
    };
    this.eyes = { L: eye('L'), R: eye('R') };
    this.brows = (['browL', 'browR'] as const).map(k => { const g = el('g', {}, this.feat); paint(VARIN_FIGURE_LAYERS[k], g); return g; });

    // The hair tie's loop sits behind the lock; its tail and loop tuck under the band (same colour)
    // so they swing without a visible join.
    this.bowLoop = el('g', {}, this.fig);
    paint(VARIN_FIGURE_LAYERS.ribbonLoop, this.bowLoop);
    // Hair: one drawing used twice, so the flyaway lock on the left sways on its own.
    const hair = el('g', { id: `${u}hair` }, defs);
    paint(VARIN_FIGURE_LAYERS.hair, hair);
    hair.firstElementChild?.setAttribute('id', `${u}hairBase`);
    el('use', { href: `#${u}hair`, 'clip-path': ahogeOut }, this.fig);
    this.ahoge = el('g', {}, this.fig);
    el('use', { href: `#${u}hair`, 'clip-path': ahogeIn }, this.ahoge);
    const hairClip = el('clipPath', { id: `${u}hc` }, defs);
    el('use', { href: `#${u}hairBase` }, hairClip);
    this.sheenRect = el('rect', { x: -300, y: 60, width: 260, height: 1200, fill: `url(#${u}s)`, opacity: 0 }, el('g', { 'clip-path': `url(#${u}hc)` }, this.fig));
    this.bowTail = el('g', {}, this.fig);
    paint(VARIN_FIGURE_LAYERS.ribbonTail, this.bowTail);
    paint(VARIN_FIGURE_LAYERS.ribbon, el('g', {}, this.fig));
    // The Varin logo hair clip.
    const clipGroup = el('g', {}, this.fig);
    el('path', { fill: '#2b2c33', d: 'M858 283 L932 285 L940 297 L924 322 L897 323 L862 384 L820 368 Z' }, clipGroup);
    el('path', { fill: '#7f9fe4', d: 'M889 325 L946 323 L966 343 L930 423 L845 423 L872 370 L880 364 L899 378 L912 355 L908 347 L887 331 Z' }, clipGroup);

    // The ledge she leans on, in the theme's surface colour, and the two ball hands resting on it.
    if (!this.compact) this.ledge = el('rect', { x: 30, y: SILL, width: 1194, height: 40, rx: 20, style: 'fill: var(--bot-figure-ledge, #e3e5eb)' }, svg);
    const hands = el('g', { 'clip-path': lower }, svg);
    this.hands = [-1, 1].map(side => {
      const g = el('g', {}, hands);
      const sh = el('ellipse', { cx: 0, cy: 14, rx: 66, ry: 64, style: 'fill: var(--bot-figure-shadow, #141828)', opacity: .22 }, g);
      el('circle', { cx: 0, cy: 0, r: 68, fill: '#efc3b7' }, g);
      el('circle', { cx: -side * 7, cy: -8, r: 61, fill: SKIN }, g);
      return { g, sh };
    });

    // Effects in front: the "needs you" badge, sleep z's, thinking bubbles, particles.
    this.fxFront = el('g', {}, svg);
    this.badge = el('g', { opacity: 0 }, this.fxFront);
    this.badgeRing = el('circle', { r: 44, fill: 'none', stroke: '#f3b562', 'stroke-width': 6 }, this.badge);
    el('circle', { r: 44, fill: '#f3b562' }, this.badge);
    el('rect', { x: -7, y: -26, width: 14, height: 32, rx: 7, fill: '#3a2a12' }, this.badge);
    el('circle', { cx: 0, cy: 19, r: 7.5, fill: '#3a2a12' }, this.badge);
    this.zz = [0, 1, 2].map(() => el('path', { d: 'M-17 -15 H17 L-17 15 H17', fill: 'none', style: MARK_STROKE, 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0 }, this.fxFront));
    this.dots = [[236, 238, 15], [172, 176, 21], [102, 106, 28]].map(([x, y, r]) => ({ x, y, n: el('circle', { cx: x, cy: y, r, style: MARK_FILL, opacity: 0 }, this.fxFront) }));
  }
}
