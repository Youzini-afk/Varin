import { requestFrame, requestAfterFrame, type FrameHandle } from '@/lib/motion/frame';
import { documentMotionLevel, type MotionLevel } from '@/lib/motion/preference';
import type { BotFigurePose, BotFigureState, BotToolProp } from './botPresentation';
import { VARIN_FIGURE_BLUSH, VARIN_FIGURE_LAYERS, type VarinFigureLayer } from './varinFigureArt';
import { DEFAULT_FIGURE_ACCENT, type FigureAccent } from './varinFigurePalette';

/**
 * The Bot figure's rig (docs/design/varin-figure.md): Varin leaning on a window sill, drawn from the
 * traced layers and driven by springs. One instance owns one SVG inside the host element. There is no
 * frame: she stands on the page itself, leaning on a light ledge that follows the theme.
 *
 * - Every state has a pose and, at full motion, a loop; one-shot moves (wink, nod, tilt, poke, and the
 *   stage's dispatch, point and reactions) play on top. Eyes and mouth change shape by closing and
 *   reopening, never by cross-fading. Her own round's tool states hold a prop.
 * - The wide figure exposes layers beside and on the ledge for the stage (botStageRenderer).
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
// The drawn mist-blue accent parts: knit, collar, sleeves, sleeve motifs and the clip's light piece.
// They follow the theme's accent; eyes, brows, hair, skin, coat and the black parts never change.
const ACCENT_PARTS = new Set(['#82a3e6', '#7495dc', '#6b8bd5', '#6f90d8', '#9cb6ec', '#6c8dd5', '#7f9fe4']);
const TINTED_GLOW = new Set<BotFigureState>(['idle', 'listening', 'offline']);
// Props, cards and particles drawn in the mist blue follow the accent too.
const ACCENT = '#8fb0ea', ACCENT_SOFT = '#c9d6f5';
const INK = '#2b2c33', PAPER = '#fbfbfd', PAPER_EDGE = '#d6d9e4';
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
// Attribute reads do not measure layout. Avoid invalidating the SVG paint tree for unchanged ink,
// paths and opacity; moving transforms keep their original precision and timing.
const attr = (node: Element, name: string, value: string | number): void => {
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
};
const display = (node: SVGElement, value: string): void => {
  if (node.style.display !== value) node.style.display = value;
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
type FxKey = 'alert' | 'zz' | 'dots' | 'ellipsis';
const FX_KEYS: readonly FxKey[] = ['alert', 'zz', 'dots', 'ellipsis'];
type Fx = Partial<Record<FxKey | 'bits' | 'sparkle', 1>>;
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
  /** What she holds for this state's tool. */
  prop?: BotToolProp;
  enter?(f: VarinFigureRig): void;
  /** `t` seconds in state; `L` is 1 when loops may play and 0 for a still pose. */
  pose(t: number, f: VarinFigureRig, L: number): Pose;
  tick?(t: number, f: VarinFigureRig, L: number): void;
}
// A soft aura behind her, light enough for both themes; most states keep it faint or off.
const GLOW: Record<BotFigureState, string> = {
  idle: '#8fb0ea', listening: '#7aa2ff', thinking: '#a08cff', working: '#5cc6d6', waiting: '#f3b562',
  sleeping: '#7f8bd6', waking: '#ffd38a', offline: '#8fb0ea',
};
// The stage's poses borrow the aura of the state they belong with.
const GLOW_OF: Record<Exclude<BotFigurePose, BotFigureState>, BotFigureState> = {
  preparing: 'listening', replying: 'listening', supervising: 'working',
  'tool-read': 'thinking', 'tool-search': 'thinking', 'tool-web': 'listening', 'tool-edit': 'working',
  'tool-shell': 'working', 'tool-memory': 'thinking', 'tool-plan': 'listening', 'tool-other': 'working',
};
const glowKey = (pose: BotFigurePose): BotFigureState => (pose in GLOW_OF ? GLOW_OF[pose as keyof typeof GLOW_OF] : pose as BotFigureState);
// Writing on the edit sheet: three lines, then a short pause.
const writing = (t: number): { idx: number; p: number; pause: boolean } => {
  const c = t % 6.2, idx = Math.min(2, Math.floor(c / 1.6)), p = c >= 4.8 ? 1 : clamp((c - idx * 1.6) / 1.4);
  return { idx, p, pause: c >= 4.8 };
};
const typing = (t: number, rate: number): [number, number] => ((t % 2.3) < 1.7
  ? [Math.max(0, Math.sin(t * rate)) ** 2, Math.max(0, Math.sin(t * rate + Math.PI)) ** 2]
  : [0, 0]);
// Typing on the ledge, a few bits flying up: delegated work, and her reply to you.
const WORKING: StateDef = { blink: true, glow: .14, fx: { bits: 1 }, mouth: 'flat',
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
  } };
const STATES: Record<BotFigurePose, StateDef> = {
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
  working: WORKING,
  replying: WORKING,
  // Her round is getting ready: leaning in, a small ellipsis bubble by her ear.
  preparing: { blink: true, glow: .18, fx: { ellipsis: 1 },
    enter: f => f.kick('fy', -300),
    pose: (t, _f, L) => ({ fy: -12 - 2 * L * Math.sin(t * 2.2), lookX: .28, lookY: -.4, featX: 2, featY: -2, browL: -9, browR: -9, eyeS: 1.05, spark: .6, hLx: HAND.L[0] + 14, hRx: HAND.R[0] - 14 }) },
  // Watching the team on the ledge: her eyes rest on the member that last had something happen.
  supervising: { blink: true, glow: .14,
    pose: (t, f, L) => {
      const [lx, ly] = f.focus ? f.targetLook(f.focus) : [.55, .1];
      const sway = L * .1 * Math.sin(t * .7), nod = L * bump((t % 5.4) / 5.4, .78, .9);
      return { lookX: lx * .9 + sway, lookY: ly * .5 + .12, featX: lx * 5, frot: lx * 2.2, fy: 4 + 14 * nod, browL: -3, browR: -3, hLx: HAND.L[0] + 14, hRx: HAND.R[0] - 14 };
    } },
  // A sheet held in both hands, read line by line.
  'tool-read': { blink: true, glow: .16, prop: 'read', mouth: 'flat',
    pose: (t, _f, L) => ({ fy: 4, lookX: .32 * L * Math.sin(t * 5.6), lookY: .5, featY: 4, eyeY: .9, browL: -2, browR: -2,
      hLx: 520, hLy: 1012 + 4 * L * Math.sin(t * 1.3), hRx: 736, hRy: 1012 + 4 * L * Math.sin(t * 1.3 + .4) }) },
  // A magnifier swept along the ledge.
  'tool-search': { blink: true, glow: .16, prop: 'search', mouth: 'pout',
    pose: (t, _f, L) => {
      const x = 708 + 120 * L * Math.sin(t * 1.5);
      return { lookX: (x - 80 - 628) / 640, lookY: .55, featX: (x - 708) / 40, featY: 3, browL: -6, browR: -2, eyeS: 1.03,
        hRx: x, hRy: 1060 - 14 * Math.abs(Math.cos(t * 1.5)) * L, hLx: HAND.L[0] - 10 };
    } },
  // A small browser window, the page scrolled with a swipe now and then.
  'tool-web': { blink: true, glow: .16, prop: 'web', mouth: 'smile',
    pose: (t, _f, L) => {
      const c = (t % 2.4) / 2.4, swipe = L ? smooth(ramp(c, .1, .45)) * (1 - ramp(c, .6, .75)) : 0;
      return { lookX: .08, lookY: .42, featY: 2, eyeS: 1.02, hLx: 520, hLy: 1046, hRx: 742, hRy: 1030 - 70 * swipe };
    } },
  // A sheet on the ledge, written line by line with a pen.
  'tool-edit': { blink: true, glow: .16, prop: 'edit', mouth: 'flat',
    pose: (t, _f, L) => {
      const w = L ? writing(t) : { idx: 1, p: .5, pause: false }, jit = L && !w.pause ? 5 * Math.sin(t * 24) : 0;
      return { lookX: (520 + w.p * 200 - 628) / 900, lookY: .78, featY: 6, browL: 2, browR: 2, browLr: 3, browRr: -3,
        hRx: 575 + w.p * 200 + jit, hRy: 1062 + w.idx * 24 + jit * .4 - (w.pause ? 30 : 0), hLx: 470, hLy: 1090 };
    } },
  // A small terminal on the ledge, a couple of keys and the output scrolling.
  'tool-shell': { blink: true, glow: .16, prop: 'shell', mouth: 'flat',
    pose: (t, _f, L) => {
      const c = t % 3.2, tap = L ? 20 * (bump(c, 0, .18) + bump(c, .26, .44)) : 0;
      return { lookX: -.04, lookY: .5, featY: 3, eyeY: .92, browL: -2, browR: -2, hLx: 430, hLy: HAND.L[1] - tap, hRx: 826, hRy: HAND.R[1] };
    } },
  // A hand at her temple; a note flies in and turns into a small glow.
  'tool-memory': { blink: true, glow: .16, prop: 'memory', mouth: 'pout',
    pose: (t, _f, L) => ({ frot: -2, lookX: .42, lookY: -.55, featX: 4, featY: -3, browL: -6, browR: -11, browRr: 4,
      hRx: 908, hRy: 584 + 8 * L * Math.sin(t * 2.4), hLx: HAND.L[0] }) },
  // A checklist card, items ticked in turn.
  'tool-plan': { blink: true, glow: .16, prop: 'plan', mouth: 'smile',
    pose: (t, _f, L) => ({ lookX: .3, lookY: .32, featX: 3, browL: -4, browR: -4, hRx: 806, hRy: 1010 + 4 * L * Math.sin(t * 1.6), hLx: HAND.L[0] + 10 }) },
  // Any other tool: a small gear on the ledge that she turns.
  'tool-other': { blink: true, glow: .16, prop: 'other', mouth: 'flat',
    pose: (t, _f, L) => ({ lookX: .18, lookY: .6, featY: 4, browL: -2, browR: -2,
      hRx: 792 + 20 * Math.cos(t * 3) * L, hRy: 1066 + 20 * Math.sin(t * 3) * L, hLx: HAND.L[0] - 6 }) },
  // Hops in, warm glow breathing, a badge, and a wave every few seconds.
  waiting: { blink: true, follow: true, glow: .42, pulse: true, fx: { alert: 1 }, mouth: 'open',
    enter: f => { f.kick('fy', -950); f.kick('fsy', 1.4); },
    pose: (t, _f, L) => {
      const c = t % 3.6, wave = L ? ramp(c, 0, .15) * (1 - ramp(c, 1.25, 1.45)) : 0;
      return { fy: -14, frot: 2.4, eyeS: 1.04, spark: 1, browL: -9, browR: -9, blush: 1.15, hRx: 905 + 30 * wave * Math.sin(c * 15), hRy: 850 - 12 * wave * Math.abs(Math.sin(c * 15)) };
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
interface ActionDef {
  dur: number;
  /** Plays on through a change of an awake state: a reaction belongs to the moment, not to the pose. */
  keep?: boolean;
  start?(f: VarinFigureRig): void;
  pose(x: number, t: number): ActionPose;
}
type Move = 'wink' | 'nod' | 'tilt' | 'tap' | 'poke';
/** The stage's beats: handing work out, pointing at what needs you, and the graded reactions. */
export type StageMove = 'throwL' | 'throwR' | 'pointL' | 'pointR' | 'gather' | 'ack' | 'present' | 'presentSerious' | 'concern' | 'cheerLite';
const toward = (side: Side, value: number): number => (side === 'L' ? -value : value);
const handAt = (side: Side, x: number, y: number): Partial<Params> => (side === 'L' ? { hLx: x, hLy: y } : { hRx: x, hRy: y });
// Dispatch: the hand on the member's side lifts a card and flicks it out (the stage flies the card).
const throwPose = (side: Side, t: number): ActionPose => {
  const up = bump(t, 0, .62), fling = ramp(t, .42, .6) * (1 - ramp(t, .7, 1)), [hx, hy] = HAND[side];
  return { set: { ...handAt(side, hx + toward(side, 120 * up + 160 * fling), hy - 240 * up - 50 * fling),
    frot: toward(side, 2.2), lookX: toward(side, .75), featX: toward(side, 5), browL: -7, browR: -7 }, mouth: 'open' };
};
// Points at the member that needs you, then looks back at you.
const pointPose = (side: Side, t: number): ActionPose => {
  const up = smooth(ramp(t, 0, .3)) * (1 - smooth(ramp(t, 1.45, 1.85))), toYou = t > 1.05, [hx, hy] = HAND[side];
  return { set: { ...handAt(side, hx + toward(side, 200 * up), hy - 200 * up),
    lookX: toYou ? 0 : toward(side, .85), lookY: toYou ? -.02 : .1, frot: toYou ? 0 : toward(side, 2.4), featX: toYou ? 0 : toward(side, 6), browL: -9, browR: -9 }, mouth: 'open' };
};
const holdUp = (t: number): Partial<Params> => {
  const up = smooth(ramp(t, 0, .3));
  return { hLx: lerp(HAND.L[0], 560, up), hLy: lerp(HAND.L[1], 968, up), hRx: lerp(HAND.R[0], 696, up), hRy: lerp(HAND.R[1], 968, up), lookX: 0, lookY: .04 };
};
const STAGE_ACTIONS: Record<StageMove, ActionDef> = {
  throwL: { keep: true, dur: 1, pose: (_x, t) => throwPose('L', t) },
  throwR: { keep: true, dur: 1, pose: (_x, t) => throwPose('R', t) },
  pointL: { keep: true, dur: 1.9, pose: (_x, t) => pointPose('L', t) },
  pointR: { keep: true, dur: 1.9, pose: (_x, t) => pointPose('R', t) },
  // Takes in the reports on the ledge: both hands sweep them in, a look down, a small nod.
  gather: { keep: true, dur: 1.5, pose: (_x, t) => {
    const a = smooth(ramp(t, 0, .35)) * (1 - smooth(ramp(t, 1.05, 1.45)));
    return { set: { hLx: lerp(HAND.L[0], 588, a), hRx: lerp(HAND.R[0], 668, a), hLy: 1084, hRy: 1084, lookY: .82, lookX: 0, featY: 6, browL: -2, browR: -2 },
      add: { fy: 14 * a + 16 * bump(t, .85, 1.2) }, mouth: 'smile' };
  } },
  ack: { keep: true, dur: .95, pose: x => ({ add: { fy: 18 * bump(x, .08, .6), featY: 6 * bump(x, .08, .6) }, set: { blush: 1.15 }, mouth: 'smile' }) },
  // Turns to you and holds up a card (the stage draws the card between her hands).
  present: { keep: true, dur: 1.9, start: f => f.later(.3, () => f.blinkNow(false)),
    pose: (_x, t) => ({ set: { ...holdUp(t), fy: -10, blush: 1.2, browL: -6, browR: -6 }, eyes: t > .4 && t < 1 ? 'happy' : 'open', mouth: 'smile' }) },
  presentSerious: { keep: true, dur: 1.9,
    pose: (_x, t) => ({ set: { ...holdUp(t), browL: 4, browR: 4, browLr: 5, browRr: -5 }, mouth: 'flat' }) },
  concern: { keep: true, dur: 1.4, pose: (_x, t) => ({ set: { browL: 6, browR: 6, browLr: 8, browRr: -8, lookY: .3 },
    add: { frot: 2 * Math.sin(t * 9) * (1 - ramp(t, .3, 1.1)) }, mouth: 'flat' }) },
  // The only cheer left: hands up once, happy eyes and a few sparkles.
  cheerLite: { keep: true, dur: 1.7, start: f => { f.kick('fy', -420); f.later(.12, () => f.burst(8)); f.sheen(); },
    pose: () => ({ set: { hLx: 392, hLy: 936, hRx: 864, hRy: 936, blush: 1.3, browL: -8, browR: -8 }, eyes: 'happy', mouth: 'grin' }) },
};
const ACTIONS: Record<Move, ActionDef> = {
  wink: { dur: 1, start: f => f.later(.12, () => f.pop('sparkle')), pose: () => ({ set: { blush: 1.25, frot: -1.5 }, eyeR: 'happy', mouth: 'cat' }) },
  nod: { dur: 1.05, pose: x => ({ add: { fy: 24 * (bump(x, .05, .45) + bump(x, .5, .9)), featY: 8 * (bump(x, .05, .45) + bump(x, .5, .9)) }, eyes: 'happy', mouth: 'smile' }) },
  tilt: { dur: 1.7, start: f => f.pop('question'), pose: () => ({ set: { frot: 6, featX: 9, lookX: .55, lookY: -.35, browL: -13, browR: 4, browLr: -5, browRr: 4 }, mouth: 'pout' }) },
  tap: { dur: .9, pose: (_x, t) => ({ set: { hLy: HAND.L[1] - 22 * bump(t, 0, .2) - 22 * bump(t, .4, .6), hRy: HAND.R[1] - 22 * bump(t, .2, .4) - 22 * bump(t, .6, .8) } }) },
  poke: { dur: 1.3, start: f => { f.kick('fsy', -2.4); f.kick('fy', 520); f.flick(-26); f.pop('heart'); },
    pose: () => ({ set: { blush: 1.7, shy: 1, browL: -6, browR: -6 }, eyes: 'squeeze', mouth: 'cat' }) },
};
const MICRO: readonly (Move | 'flick')[] = ['wink', 'nod', 'tilt', 'flick', 'tap'];
const AWAKE = (state: BotFigurePose): boolean => state !== 'offline' && state !== 'sleeping' && state !== 'waking';

// ---------------------------------------------------------------- shared pointer and environment
let pointer: { x: number; y: number; at: number } | null = null;
const pointerSubscribers = new Set<() => void>();
const onPointerMove = (event: PointerEvent): void => {
  pointer = { x: event.clientX, y: event.clientY, at: performance.now() };
  for (const notify of pointerSubscribers) notify();
};
const trackPointer = (notify: () => void): (() => void) => {
  const owner = window;
  if (!pointerSubscribers.size) owner.addEventListener('pointermove', onPointerMove, { passive: true });
  pointerSubscribers.add(notify);
  return () => {
    pointerSubscribers.delete(notify);
    if (!pointerSubscribers.size) { owner.removeEventListener('pointermove', onPointerMove); pointer = null; }
  };
};
const canAnimate = (): boolean => typeof globalThis.requestAnimationFrame === 'function';
let seq = 0;

interface Shape { cur: string; amt: number; va: number }
interface Eye extends Shape { cur: EyeShape; open: SVGGElement; hl: SVGCircleElement; hl2: SVGCircleElement; alt: SVGPathElement }
interface Particle { node: SVGElement; x: number; y: number; vx: number; vy: number; g: number; r: number; vr: number; s: number; life: number; max: number; drag?: number }
interface PopFx { node: SVGElement; x: number; y: number; vx: number; vy: number; life: number; max: number; kind: string }

/** Layers the stage draws into, in paint order around her and the ledge. */
export interface VarinFigureStageLayers {
  /** Beside her above the ledge, clipped at the ledge like her. */
  team: SVGGElement;
  /** On the ledge, in front of it and behind her hands. */
  ledge: SVGGElement;
  /** In front of her hands. */
  front: SVGGElement;
  /** Flying things, over everything. */
  fx: SVGGElement;
}
type PropParts = {
  read: SVGGElement; readSheet: SVGGElement; readHi: SVGRectElement;
  search: SVGGElement; searchHandle: SVGLineElement; searchLens: SVGCircleElement; searchGlint: SVGPathElement; searchPing: SVGCircleElement;
  web: SVGGElement; webPage: SVGGElement;
  edit: SVGGElement; editLines: SVGRectElement[]; pen: SVGGElement; penBody: SVGLineElement; penTip: SVGCircleElement;
  shell: SVGGElement; shellRows: SVGGElement[]; shellCursor: SVGRectElement;
  memory: SVGGElement; note: SVGGElement; memRing: SVGCircleElement;
  plan: SVGGElement; planCard: SVGGElement; planTicks: SVGPathElement[];
  other: SVGGElement; gear: SVGGElement;
};
const PROPS: readonly BotToolProp[] = ['read', 'search', 'web', 'edit', 'shell', 'memory', 'plan', 'other'];

export interface VarinFigureOptions {
  state: BotFigurePose;
  /** Head crop for the small sizes (sidebar, title bar); always still. */
  compact: boolean;
  /** Pose only, no loops. */
  still: boolean;
  /** Fill the host's width: the scene widens around her and the ledge runs edge to edge. */
  wide?: boolean;
  /** Theme colours for the accent parts (varinFigurePalette). */
  accent?: FigureAccent;
}

export class VarinFigureRig {
  private readonly host: HTMLElement;
  private readonly compact: boolean;
  private readonly wide: boolean;
  private readonly posed: boolean;
  private view: View;
  private ledge: SVGRectElement | null = null;
  private accent: FigureAccent = DEFAULT_FIGURE_ACCENT;
  private readonly accented: { node: Element; attr: 'fill' | 'stroke'; source: string }[] = [];
  private readonly uid = `vf${++seq}`;
  private svg!: SVGSVGElement;
  private state: BotFigurePose;
  private poseState: BotFigurePose | null = null;
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
  private fxAmt: Record<FxKey, number> = { alert: 0, zz: 0, dots: 0, ellipsis: 0 };
  private prop: BotToolProp | null = null;
  private propAt = 0;
  private propAmt: Record<BotToolProp, number> = { read: 0, search: 0, web: 0, edit: 0, shell: 0, memory: 0, plan: 0, other: 0 };
  private propParts: PropParts | null = null;
  private lookTarget: { x: number; y: number; until: number; turn: number } | null = null;
  private parts: Particle[] = [];
  private pops: PopFx[] = [];
  private timers: { at: number; fn: () => void }[] = [];
  private action: { def: ActionDef; at: number; name: string } | null = null;
  private blinkAt = -9;
  private blinkAt2 = -9;
  private nextBlink = 1.5;
  private nextMicro = 6;
  private sheenAt = -9;
  private matrixOn = false;
  private snapping = false;
  private level: MotionLevel = 'full';
  private frame: FrameHandle | null = null;
  private geometryFrame: FrameHandle | null = null;
  private pointerBounds: DOMRect | null = null;
  private lastTime: number | null = null;
  private onscreen = true;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];
  /** Per-state scratch values for loops. */
  mem: Record<string, number> = {};
  glance = { x: 0, y: 0, until: 0 };
  /** Where `supervising` rests her eyes, in figure units (the stage sets it). */
  focus: { x: number; y: number } | null = null;
  /** Called after each animated frame with its duration in seconds. */
  onFrame: ((dt: number) => void) | null = null;
  /** Called when the wide scene's viewBox changes. */
  onResize: (() => void) | null = null;
  private stageGroups: VarinFigureStageLayers | null = null;
  private ellipsis!: SVGGElement;
  private ellipsisDots!: SVGCircleElement[];
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
    if (options.accent) this.setAccent(options.accent);
    if (this.wide) this.fitWidth();
    this.level = documentMotionLevel();
    if (!this.posed) this.watch();
    this.enterState(options.state, true);
  }

  // ------------------------------------------------------------ public
  setState(state: BotFigurePose): void {
    if (this.disposed || state === this.state) return;
    this.enterState(state, false);
  }

  /** The scene's current viewBox in figure units; the wide scene follows the host's width. */
  get viewBox(): View { return this.view; }
  /** Whether frames are being drawn now: animated, on screen and the page visible. */
  get live(): boolean { return this.running; }
  /** Whether motion plays at all (full motion, not a still figure). */
  get moving(): boolean { return this.animated; }
  get current(): BotFigurePose { return this.state; }
  /** The one-shot move playing now and how far through it is (0..1). */
  get move(): { name: string; progress: number } | null {
    return this.action ? { name: this.action.name, progress: clamp((this.t - this.action.at) / this.action.def.dur) } : null;
  }
  /** Layers for the stage; only the wide figure has a stage. */
  get stageLayers(): VarinFigureStageLayers | null { return this.stageGroups; }
  /** A hand's position, where a dispatched card leaves from. */
  handPoint(side: Side): [number, number] { return side === 'L' ? [this.p.hLx, this.p.hLy] : [this.p.hRx, this.p.hRy]; }
  /** Eye direction toward a point in figure units, as lookX / lookY. */
  targetLook(point: { x: number; y: number }): [number, number] {
    return [clamp((point.x - CENTER_X) / 640, -1, 1), clamp((point.y - 690) / 520, -1, 1)];
  }
  /** A glance at a point for a moment, turning the head by `turn` degrees at most. */
  lookAt(x: number, y: number, seconds = 1, turn = 1.4): void {
    if (this.animated) this.lookTarget = { x, y, until: this.t + seconds, turn };
  }
  /** The theme's version of a mist-blue ink. */
  tint(source: string): string { return this.accent.tint(source); }
  /** Keep a stage node's mist-blue ink in step with the theme. */
  paintAccent(node: Element, name: 'fill' | 'stroke', source: string): void {
    this.accented.push({ node, attr: name, source });
    attr(node, name, this.accent.tint(source));
  }
  /** Resume frames after the stage starts something while a settled figure had stopped. */
  wake(): void { if (!this.disposed) this.run(); }

  /** Recolour the accent parts for the current theme; poses and motion carry on. */
  setAccent(accent: FigureAccent): void {
    if (this.disposed || accent.key === this.accent.key) return;
    this.accent = accent;
    // Stage nodes come and go; forget the ones that have left the drawing.
    const inside = (node: Node | null): boolean => { while (node && node !== this.svg) node = node.parentNode; return node === this.svg; };
    for (let i = this.accented.length - 1; i >= 0; i -= 1) if (!inside(this.accented[i]!.node)) this.accented.splice(i, 1);
    for (const part of this.accented) attr(part.node, part.attr, accent.tint(part.source));
    // Static figures have no subsequent simulation frame to update their aura.
    if (!this.animated) {
      const [r, g, b] = this.glowColor();
      this.p.gr = this.goal.gr = r; this.p.gg = this.goal.gg = g; this.p.gb = this.goal.gb = b;
      this.v.gr = this.v.gg = this.v.gb = 0;
    }
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.frame?.cancel();
    this.frame = null;
    this.geometryFrame?.cancel();
    this.geometryFrame = null;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.svg.remove();
  }

  // ------------------------------------------------------------ used by states and moves
  kick(key: Param, dv: number): void { if (this.animated) this.v[key] = (this.v[key] ?? 0) + dv; }
  flick(dv: number): void { if (this.animated) this.sec.va += dv * 6; }
  later(dt: number, fn: () => void): void { this.timers.push({ at: this.t + dt, fn }); }
  blinkNow(double: boolean): void { this.blinkAt = this.t; this.blinkAt2 = double ? this.t + .26 : -9; }
  sheen(): void { if (this.animated) this.sheenAt = this.t; }
  play(name: Move | StageMove | 'flick'): void {
    if (!this.animated || !AWAKE(this.state)) return;
    if (name === 'flick') { this.flick(-24); return; }
    const def = name in STAGE_ACTIONS ? STAGE_ACTIONS[name as StageMove] : ACTIONS[name as Move];
    this.action = { def, at: this.t, name };
    def.start?.(this);
    this.run();
  }

  bit(side: Side): void {
    if (!this.animated) return;
    const x = (side === 'L' ? this.p.hLx : this.p.hRx) + (Math.random() - .5) * 60;
    const colors = [this.accent.tint('#8fb0ea'), this.accent.tint('#c9d6f5'), '#f3c690', this.accent.tint('#a9c2f2')];
    const node = el('rect', { x: -9, y: -9, width: 18, height: 18, rx: 3, fill: colors[Math.floor(Math.random() * colors.length)] }, this.fxFront);
    this.parts.push({ node, x, y: 1030, vx: (Math.random() - .5) * 90, vy: -260 - Math.random() * 160, g: 120, r: 45, vr: (Math.random() - .5) * 200, s: .7 + Math.random() * .6, life: 0, max: .95 });
  }

  burst(count: number): void {
    if (!this.animated) return;
    const colors = ['#ffd36e', this.accent.tint('#8fb0ea'), '#f4a9c0', this.accent.tint('#c9d6f5'), this.accent.tint('#b8c9f5')];
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
      this.measurePointer();
      this.onResize?.();
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

  private enterState(state: BotFigurePose, first: boolean): void {
    const fade = !first && !this.posed && this.level === 'reduced';
    this.state = state;
    this.stateAt = this.t;
    this.mem = { nextKey: 0 };
    const prop = STATES[state].prop ?? null;
    if (prop !== this.prop) { this.prop = prop; this.propAt = this.t; }
    // A reaction belongs to its moment and plays on while she stays awake; anything else ends here.
    const kept = this.action?.def.keep && AWAKE(state) ? this.action : null;
    this.action = kept;
    // Delayed gestures belong to the state that scheduled them, never to its successor.
    if (!kept) this.timers = [];
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
    this.cleanups.push(trackPointer(this.measurePointer));
    window.addEventListener('scroll', this.measurePointer, { capture: true, passive: true });
    window.addEventListener('resize', this.measurePointer, { passive: true });
    this.cleanups.push(() => {
      window.removeEventListener('scroll', this.measurePointer, true);
      window.removeEventListener('resize', this.measurePointer);
    });
    if (!this.wide && typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(this.measurePointer);
      ro.observe(this.host);
      this.cleanups.push(() => ro.disconnect());
    }
    const onVisibility = (): void => this.run();
    document.addEventListener('visibilitychange', onVisibility);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(entries => {
        for (const entry of entries) this.onscreen = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
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
        else { this.clearFx(); this.settle(STATES[this.state].stillAt ?? 2.2); this.run(); }
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
    if (!this.running) {
      this.frame?.cancel(); this.frame = null; this.lastTime = null;
      this.geometryFrame?.cancel(); this.geometryFrame = null; this.pointerBounds = null;
      return;
    }
    this.measurePointer();
    if (this.frame || STATES[this.state].noLoops && this.atRest()) return;
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
    this.onFrame?.(dt);
    if (!STATES[this.state].noLoops || !this.atRest()) this.frame = requestFrame(this.tick);
  };

  /** Stop a non-looping pose only once its transition and already emitted effects have settled.
   * 0.001 in the 1254-unit drawing is far below a rendered pixel, including angular transforms. */
  private atRest(): boolean {
    const near = (a: number, b = 0): boolean => Math.abs(a - b) < .001;
    return this.poseState === this.state && !this.action && !this.timers.length && !this.parts.length && !this.pops.length
      && PARAMS.every(key => near(this.p[key], this.goal[key]) && near(this.v[key] ?? 0))
      && near(this.sec.a, -6 * this.p.droop) && near(this.sec.va) && near(this.sec.r) && near(this.sec.vr)
      && [this.eyes.L, this.eyes.R, this.mouth].every(shape => near(shape.amt, 1) && near(shape.va))
      && this.eyes.L.cur === this.eyeGoal.L && this.eyes.R.cur === this.eyeGoal.R && this.mouth.cur === this.mouthGoal
      && FX_KEYS.every(key => near(this.fxAmt[key], this.fxGoal[key] ? 1 : 0))
      && PROPS.every(key => near(this.propAmt[key], this.prop === key ? 1 : 0));
  }

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
    // A glance the stage asked for (a report landing, a card flying) wins over the pose's own gaze.
    if (this.lookTarget && t < this.lookTarget.until && L) {
      const [x, y] = this.targetLook(this.lookTarget);
      goal.lookX = x; goal.lookY = y; goal.featX = x * 6; goal.frot += x * this.lookTarget.turn;
    } else this.lookTarget = null;
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
    const [r, g, b] = this.glowColor();
    goal.gr = r; goal.gg = g; goal.gb = b;
    goal.glow = st.glow * (st.pulse && L ? .78 + .22 * Math.sin(2 * Math.PI * lt / 2.2) : 1);
    this.goal = goal;
    this.poseState = this.state;
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
      for (const key of FX_KEYS) {
        const want = this.fxGoal[key] ? 1 : 0;
        this.fxAmt[key] += (want - this.fxAmt[key]) * clamp(h * (want ? 6 : 9));
      }
      for (const key of PROPS) {
        const want = this.prop === key ? 1 : 0;
        this.propAmt[key] += (want - this.propAmt[key]) * clamp(h * (want ? 7 : 10));
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

  private glowColor(): [number, number, number] {
    const key = glowKey(this.state);
    return hex(TINTED_GLOW.has(key) ? this.accent.tint(GLOW[key]) : GLOW[key]);
  }

  // Read geometry once after this frame's layout writers, and reuse it during spring integration.
  // Pointer, scroll and resize invalidate it; animation frames themselves do not force reflow.
  private measurePointer = (): void => {
    if (this.geometryFrame || !this.running || !STATES[this.state].follow || !pointer) return;
    this.geometryFrame = requestAfterFrame(() => {
      this.geometryFrame = null;
      if (this.running) this.pointerBounds = this.host.getBoundingClientRect();
    });
  };

  private pointerLook(): [number, number] {
    if (!pointer || !this.pointerBounds) return [0, 0];
    const r = this.pointerBounds, [x0, y0, span] = this.view, s = r.width / span;
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
      attr(q.node, 'transform', `translate(${q.x.toFixed(1)} ${q.y.toFixed(1)}) rotate(${q.r.toFixed(0)}) scale(${(q.s * grow).toFixed(3)})`);
      attr(q.node, 'opacity', fade.toFixed(3));
      return true;
    });
    this.pops = this.pops.filter(q => {
      q.life += dt;
      const x = q.life / q.max;
      if (x >= 1) { q.node.remove(); return false; }
      const pop = x < .25 ? 1 + .35 * Math.sin(x / .25 * Math.PI) * (1 - x / .25) : 1;
      const s = Math.min(1, x / .14) * pop, spin = q.kind === 'question' ? 8 * Math.sin(q.life * 7) : q.kind === 'sparkle' ? q.life * 140 : 0;
      attr(q.node, 'transform', `translate(${q.x + q.vx * q.life} ${q.y + q.vy * q.life}) rotate(${spin}) scale(${s})`);
      attr(q.node, 'opacity', (1 - ramp(x, .7, 1)).toFixed(3));
      return true;
    });
  }

  // ------------------------------------------------------------ drawing
  private render(): void {
    const p = this.p, t = this.t, c = this.compact, L = this.L;
    const fy = c ? p.fy * .12 : p.fy, frot = c ? p.frot * .5 : p.frot, fsx = p.fsx * (1 + (1 - p.fsy) * .55);
    attr(this.fig, 'transform', `translate(${PIVOT[0]} ${PIVOT[1] + fy}) rotate(${frot}) scale(${fsx} ${p.fsy}) translate(${-PIVOT[0]} ${-PIVOT[1]})`);
    attr(this.feat, 'transform', `translate(${p.featX + p.lookX * 4} ${p.featY + p.lookY * 3})`);
    const blink = Math.max(bump(t - this.blinkAt, 0, .17), bump(t - this.blinkAt2, 0, .17));
    for (const k of ['L', 'R'] as const) {
      const e = this.eyes[k], [cx, cy] = EYE[k], amt = Math.max(.001, e.amt), lx = p.lookX * 13, ly = p.lookY * 9;
      if (e.cur === 'open') {
        const sy = amt * p.eyeY * (1 - .95 * blink);
        attr(e.open, 'transform', `translate(${cx + lx} ${cy + ly}) scale(${p.eyeS} ${p.eyeS * sy}) translate(${-cx} ${-cy})`);
        attr(e.open, 'opacity', String(1 - .45 * p.eyeDim));
        const twinkle = 1 + .14 * Math.sin(t * 2.6 + (k === 'L' ? 0 : 1.3)) * L;
        attr(e.hl, 'transform', `translate(${HL[k][0] + p.lookX * 5} ${HL[k][1] + p.lookY * 4}) scale(${twinkle}) translate(${-HL[k][0]} ${-HL[k][1]})`);
        attr(e.hl, 'opacity', String(1 - p.eyeDim));
        attr(e.hl2, 'opacity', String(clamp(p.spark) * (1 - p.eyeDim)));
        display(e.open, ''); display(e.alt, 'none');
      } else {
        display(e.open, 'none'); display(e.alt, '');
        attr(e.alt, 'd', ALT[e.cur](cx));
        attr(e.alt, 'transform', `translate(${cx + lx * .4} ${cy}) scale(1 ${amt}) translate(${-cx} ${-cy})`);
      }
    }
    const current = this.mouth.cur as Mouth;
    for (const key of Object.keys(this.mouths) as Mouth[]) display(this.mouths[key], key === current ? '' : 'none');
    const ma = Math.max(.001, this.mouth.amt), breathe = current === 'sleep' ? 1 + .18 * Math.sin(t * 1.35) * L : 1;
    this.mouths[current].setAttribute('transform', `translate(627 762) scale(${Math.min(1, ma * 1.15) * breathe} ${ma * breathe}) translate(-627 -762)`);
    this.brows.forEach((g, i) => {
      const k = i ? 'R' : 'L', [bx, by] = BROW[k];
      attr(g, 'transform', `translate(0 ${p[k === 'L' ? 'browL' : 'browR'] + p.lookY * 3}) rotate(${p[k === 'L' ? 'browLr' : 'browRr']} ${bx} ${by})`);
    });
    for (const b of this.blushes) {
      const s = 1 + .12 * clamp(p.blush - 1);
      attr(b.g, 'transform', `translate(${b.cx} ${b.cy}) scale(${s}) translate(${-b.cx} ${-b.cy})`);
      attr(b.e, 'opacity', String(clamp(p.blush)));
      attr(b.e, 'fill', p.blush > 1 ? '#f2b3a9' : '#f3c4ba');
      attr(b.lines, 'opacity', String(clamp(p.shy)));
    }
    attr(this.ahoge, 'transform', `rotate(${this.sec.a} ${AHOGE[0]} ${AHOGE[1]})`);
    attr(this.bowTail, 'transform', `rotate(${this.sec.r} 1030 540)`);
    attr(this.bowLoop, 'transform', `rotate(${-.7 * this.sec.r + 1.3 * Math.sin(t * 1.7) * L} 1066 528)`);
    const sweep = (t - this.sheenAt) / .95;
    if (sweep >= 0 && sweep < 1) {
      attr(this.sheenRect, 'opacity', '1');
      attr(this.sheenRect, 'transform', `rotate(-18 628 600) translate(${lerp(-200, 1500, smooth(sweep))} 0)`);
    } else attr(this.sheenRect, 'opacity', '0');
    const hand = (h: { g: SVGGElement; sh: SVGEllipseElement }, x: number, y: number, s: number): void => {
      attr(h.g, 'transform', `translate(${x} ${y}) scale(${s})`);
      display(h.g, c ? 'none' : '');
      attr(h.sh, 'opacity', String(lerp(.12, .22, clamp(1 - (HAND.L[1] - y) / 90))));
    };
    hand(this.hands[0], p.hLx, p.hLy, p.hLs);
    hand(this.hands[1], p.hRx, p.hRy, p.hRs);
    const color = `rgb(${p.gr | 0},${p.gg | 0},${p.gb | 0})`;
    for (const stop of this.glowStops) attr(stop, 'stop-color', color);
    attr(this.glowStops[0], 'stop-opacity', String(clamp(p.glow)));
    attr(this.glowStops[1], 'stop-opacity', String(clamp(p.glow) * .35));
    const grey = clamp(p.grey);
    if (grey > .01) {
      const s = 1 - .88 * grey, light = 1 - .22 * grey, lr = .2126 * (1 - s), lg = .7152 * (1 - s), lb = .0722 * (1 - s);
      const values = [lr + s, lg, lb, 0, 0, lr, lg + s, lb, 0, 0, lr, lg, lb + s, 0, 0, 0, 0, 0, 1, 0];
      attr(this.matrix, 'values', values.map((v, i) => (i % 5 < 3 && i < 15 ? v * light : v).toFixed(4)).join(' '));
      if (!this.matrixOn) { attr(this.fig, 'filter', `url(#${this.uid}f)`); this.matrixOn = true; }
    } else if (this.matrixOn) { this.fig.removeAttribute('filter'); this.matrixOn = false; }
    this.renderProps();
    this.renderFx();
  }

  /** Her tool props follow her hands; each fades in and out on its own. */
  private renderProps(): void {
    const P = this.propParts;
    if (!P) return;
    const p = this.p, L = this.L, a = this.propAmt, lt = this.t - this.propAt;
    if (!this.animated) for (const key of PROPS) a[key] = this.prop === key ? 1 : 0;
    const show = (node: SVGElement, value: number): void => { attr(node, 'opacity', value.toFixed(3)); display(node, value < .01 ? 'none' : ''); };
    show(P.read, a.read);
    if (a.read > .01) {
      const flip = (lt % 4.6) / 4.6, sx = L && flip > .9 ? Math.abs(Math.cos((flip - .9) / .1 * Math.PI)) : 1;
      attr(P.readSheet, 'transform', `translate(${(p.hLx + p.hRx) / 2} ${(p.hLy + p.hRy) / 2 - 64}) rotate(-3) scale(${Math.max(.08, sx)} ${a.read})`);
      attr(P.readHi, 'y', -80 + (L ? (lt * .55) % 1 : .4) * 150);
    }
    show(P.search, a.search);
    if (a.search > .01) {
      const lx = p.hRx - 82, ly = p.hRy - 92, ping = L ? (lt % 2.3) / 2.3 : 1;
      attr(P.searchHandle, 'x1', p.hRx - 26); attr(P.searchHandle, 'y1', p.hRy - 30);
      attr(P.searchHandle, 'x2', lx + 40); attr(P.searchHandle, 'y2', ly + 44);
      attr(P.searchLens, 'cx', lx); attr(P.searchLens, 'cy', ly);
      attr(P.searchGlint, 'transform', `translate(${lx} ${ly})`);
      attr(P.searchPing, 'cx', lx); attr(P.searchPing, 'cy', ly);
      attr(P.searchPing, 'r', 64 + ping * 60); attr(P.searchPing, 'opacity', ping < 1 ? .6 * (1 - ping) : 0);
    }
    show(P.web, a.web);
    if (a.web > .01) {
      attr(P.web, 'transform', `translate(0 ${(1 - a.web) * 40})`);
      const c = (lt % 2.4) / 2.4, scroll = Math.floor(lt / 2.4) * 70 + 70 * smooth(ramp(c, .15, .5));
      attr(P.webPage, 'transform', `translate(0 ${-(L ? scroll % 210 : 30)})`);
    }
    show(P.edit, a.edit); show(P.pen, a.edit);
    if (a.edit > .01) {
      const w = L ? writing(lt) : { idx: 1, p: .5 }, tx = p.hRx - 55, ty = p.hRy - 42;
      P.editLines.forEach((line, i) => attr(line, 'width', (i < w.idx ? 1 : i === w.idx ? w.p : 0) * (200 - i * 30)));
      attr(P.penBody, 'x1', tx); attr(P.penBody, 'y1', ty); attr(P.penBody, 'x2', tx + 56); attr(P.penBody, 'y2', ty - 118);
      attr(P.penTip, 'cx', tx); attr(P.penTip, 'cy', ty);
    }
    show(P.shell, a.shell);
    if (a.shell > .01) {
      const c = lt % 3.2, rows = L ? Math.floor(lt / 3.2) * 4 + Math.min(4, Math.max(0, Math.floor((c - .5) / .35) + 1)) : 5;
      P.shellRows.forEach((row, i) => {
        const k = i - Math.max(0, rows - 7);
        attr(row, 'transform', `translate(0 ${970 + k * 18})`);
        attr(row, 'opacity', i < rows && k >= 0 ? 1 : 0);
      });
      attr(P.shellCursor, 'y', 968 + Math.min(rows, 7) * 18);
      attr(P.shellCursor, 'opacity', !L || Math.sin(this.t * 8) > 0 ? 1 : .2);
    }
    show(P.memory, a.memory);
    if (a.memory > .01) {
      const c = L ? (lt % 2.6) / 2.6 : .5, u = smooth(ramp(c, 0, .7));
      const x = (1 - u) ** 2 * 1270 + 2 * (1 - u) * u * 1120 + u * u * 872, y = (1 - u) ** 2 * 250 + 2 * (1 - u) * u * 300 + u * u * 556;
      attr(P.note, 'transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(-20 + 30 * u).toFixed(1)}) scale(${(1 - .65 * u).toFixed(3)})`);
      attr(P.note, 'opacity', c < .75 ? 1 : 1 - ramp(c, .75, .9));
      const ring = ramp(c, .7, 1);
      attr(P.memRing, 'r', 30 + ring * 50); attr(P.memRing, 'opacity', ring > 0 ? .7 * (1 - ring) : 0);
    }
    show(P.plan, a.plan);
    if (a.plan > .01) {
      attr(P.planCard, 'transform', `translate(${p.hRx - 6} ${p.hRy - 8}) rotate(6)`);
      const done = L ? Math.floor(lt / 1.4) % 4 : 2;
      P.planTicks.forEach((tick, i) => {
        attr(tick, 'opacity', i < done ? 1 : 0);
        attr(tick, 'stroke-dashoffset', i === done - 1 && L ? 40 * (1 - smooth(clamp((lt % 1.4) / .4))) : 0);
      });
    }
    show(P.other, a.other);
    if (a.other > .01) attr(P.gear, 'transform', `translate(640 1022) rotate(${L ? (lt * 60) % 360 : 20}) scale(1.25)`);
  }

  private renderFx(): void {
    const t = this.t, a = this.fxAmt, c = this.compact, L = this.L;
    const bw = a.alert;
    if (bw > .01) {
      const [x, y] = c ? [985, 330] : [1132, 142];
      const scale = (c ? 1.7 : 1) * (bw < .999 ? 1 + .25 * Math.sin(bw * Math.PI) : 1) * bw;
      attr(this.badge, 'transform', `translate(${x} ${y}) scale(${scale})`);
      attr(this.badge, 'opacity', String(clamp(bw * 1.3)));
      const ph = (t % 1.6) / 1.6;
      attr(this.badgeRing, 'r', String(44 + ph * 36));
      attr(this.badgeRing, 'opacity', String(L ? .6 * (1 - ph) : 0));
    } else attr(this.badge, 'opacity', '0');
    this.zz.forEach((z, i) => {
      const ph = L ? ((t * .3) + i / 3) % 1 : [.35, .62, .9][i], [x, y] = c ? [850, 500] : [1000, 300];
      attr(z, 'transform', `translate(${x + ph * 120 + i * 8} ${y - ph * 210}) scale(${(c ? 1.6 : 1) * (.65 + ph * .8)})`);
      attr(z, 'opacity', String(a.zz * Math.sin(Math.PI * ph)));
    });
    this.dots.forEach((d, i) => {
      const pulse = L ? Math.max(0, Math.sin(2 * Math.PI * (t * .9 - i * .2))) : .5, show = clamp(a.dots * 3 - i * .8);
      attr(d.n, 'opacity', String(show * (.55 + .4 * pulse)));
      attr(d.n, 'transform', `translate(${d.x} ${d.y}) scale(${(c ? 1.4 : 1) * (1 + .16 * pulse) * (.4 + .6 * show)}) translate(${-d.x} ${-d.y})`);
    });
    const ea = a.ellipsis;
    attr(this.ellipsis, 'opacity', ea.toFixed(3));
    display(this.ellipsis, ea < .01 ? 'none' : '');
    if (ea >= .01) {
      const [x, y] = c ? [960, 330] : [1070, 330];
      attr(this.ellipsis, 'transform', `translate(${x} ${y}) scale(${((c ? 1.5 : 1) * (.6 + .4 * ea)).toFixed(3)})`);
      this.ellipsisDots.forEach((dot, i) => attr(dot, 'cy', L ? (-10 * Math.max(0, Math.sin(t * 5 - i * .8))).toFixed(1) : 0));
    }
  }

  // ------------------------------------------------------------ construction
  private collectAccent(root: Element): void {
    for (const node of [root, ...root.querySelectorAll('*')]) {
      for (const attr of ['fill', 'stroke'] as const) {
        const source = node.getAttribute(attr)?.toLowerCase();
        if (source && ACCENT_PARTS.has(source)) this.accented.push({ node, attr, source });
      }
    }
  }

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

    for (const group of [under, body]) this.collectAccent(group);
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
    this.collectAccent(clipGroup);

    // The stage's members sit beside her above the ledge, cut by it as she is; the clip spans any width.
    const stage = this.wide ? { team: el('g', { class: 'bot-figure-team', 'clip-path': clip('team', `M-4000 -800H5254V${SILL + 6}H-4000Z`) }, svg) } : null;
    // The ledge she leans on, in the theme's surface colour, and the two ball hands resting on it.
    if (!this.compact) this.ledge = el('rect', { x: 30, y: SILL, width: 1194, height: 40, rx: 20, style: 'fill: var(--bot-figure-ledge, #e3e5eb)' }, svg);
    const onLedge = stage ? el('g', { class: 'bot-figure-team' }, svg) : null;
    const propBack = this.compact ? null : el('g', {}, svg);
    const hands = el('g', { 'clip-path': lower }, svg);
    this.hands = [-1, 1].map(side => {
      const g = el('g', {}, hands);
      const sh = el('ellipse', { cx: 0, cy: 14, rx: 66, ry: 64, style: 'fill: var(--bot-figure-shadow, #141828)', opacity: .22 }, g);
      el('circle', { cx: 0, cy: 0, r: 68, fill: '#efc3b7' }, g);
      el('circle', { cx: -side * 7, cy: -8, r: 61, fill: SKIN }, g);
      return { g, sh };
    });

    const propFront = this.compact ? null : el('g', {}, svg);
    // The stage's cards and its flights; her own effects stay the last layer.
    const stageFront = stage ? el('g', { class: 'bot-figure-team' }, svg) : null;
    const stageFx = stage ? el('g', { class: 'bot-figure-team' }, svg) : null;
    // Effects in front: the "needs you" badge, sleep z's, thinking bubbles, particles.
    this.fxFront = el('g', {}, svg);
    this.badge = el('g', { opacity: 0 }, this.fxFront);
    this.badgeRing = el('circle', { r: 44, fill: 'none', stroke: '#f3b562', 'stroke-width': 6 }, this.badge);
    el('circle', { r: 44, fill: '#f3b562' }, this.badge);
    el('rect', { x: -7, y: -26, width: 14, height: 32, rx: 7, fill: '#3a2a12' }, this.badge);
    el('circle', { cx: 0, cy: 19, r: 7.5, fill: '#3a2a12' }, this.badge);
    this.zz = [0, 1, 2].map(() => el('path', { d: 'M-17 -15 H17 L-17 15 H17', fill: 'none', style: MARK_STROKE, 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0 }, this.fxFront));
    const dots = this.compact ? [[460, 440, 15], [420, 385, 21], [385, 312, 28]] : [[236, 238, 15], [172, 176, 21], [102, 106, 28]];
    this.dots = dots.map(([x, y, r]) => ({ x, y, n: el('circle', { cx: x, cy: y, r, style: MARK_FILL, opacity: 0 }, this.fxFront) }));
    // Getting ready: a small speech bubble with three dots by her ear.
    this.ellipsis = el('g', { opacity: 0, style: 'display:none' }, this.fxFront);
    el('rect', { x: -62, y: -30, width: 124, height: 60, rx: 30, style: 'fill: var(--bot-figure-bubble, #ffffff)' }, this.ellipsis);
    this.ellipsisDots = [-30, 0, 30].map(x => el('circle', { cx: x, cy: 0, r: 10, style: MARK_FILL }, this.ellipsis));
    if (propBack && propFront) this.buildProps(defs, propBack, propFront);
    if (stage && onLedge && stageFront && stageFx) this.stageGroups = { team: stage.team, ledge: onLedge, front: stageFront, fx: stageFx };
  }

  private buildProps(defs: SVGDefsElement, back: SVGGElement, front: SVGGElement): void {
    const u = this.uid, group = (parent: SVGGElement) => el('g', { opacity: 0, style: 'display:none' }, parent);
    const accent = <T extends Element>(node: T, name: 'fill' | 'stroke' = 'fill', source = ACCENT): T => { this.accented.push({ node, attr: name, source }); return node; };
    // Reading: a sheet held in both hands, a highlight moving down line by line.
    const read = group(back), readSheet = el('g', {}, read);
    el('rect', { x: -150, y: -112, width: 300, height: 206, rx: 16, fill: PAPER, stroke: PAPER_EDGE, 'stroke-width': 4 }, readSheet);
    const readHi = accent(el('rect', { x: -128, y: -80, width: 256, height: 24, rx: 9, fill: ACCENT, opacity: .25 }, readSheet));
    for (const [y, width] of [[-70, 230], [-44, 200], [-18, 236], [8, 170], [34, 226], [60, 140]]) accent(el('rect', { x: -118, y, width, height: 11, rx: 5.5, fill: ACCENT_SOFT }, readSheet), 'fill', ACCENT_SOFT);
    // Searching: a magnifier swept along the ledge, a ring each time it finds something.
    const search = group(front);
    const searchHandle = el('line', { stroke: INK, 'stroke-width': 24, 'stroke-linecap': 'round' }, search);
    const searchLens = accent(el('circle', { r: 64, fill: ACCENT, 'fill-opacity': .2, stroke: INK, 'stroke-width': 15 }, search));
    const searchGlint = el('path', { d: 'M-34 -20 A40 40 0 0 1 -12 -40', fill: 'none', stroke: '#ffffff', 'stroke-width': 9, 'stroke-linecap': 'round' }, search);
    const searchPing = accent(el('circle', { r: 64, fill: 'none', stroke: ACCENT, 'stroke-width': 6 }, search), 'stroke');
    // Web: a small browser window in front of her, the page scrolling.
    const web = group(back), win = el('g', { transform: 'translate(628 968)' }, web);
    el('rect', { x: -176, y: -72, width: 352, height: 174, rx: 4 }, el('clipPath', { id: `${u}web` }, defs));
    el('rect', { x: -182, y: -118, width: 364, height: 226, rx: 24, fill: '#ffffff', stroke: PAPER_EDGE, 'stroke-width': 4 }, win);
    el('path', { d: 'M-182 -78 V-94 Q-182 -118 -158 -118 H158 Q182 -118 182 -94 V-78 Z', fill: '#eef1f8' }, win);
    ['#f2a3a3', '#f3c690', '#9fd3a8'].forEach((fill, i) => el('circle', { cx: -152 + i * 22, cy: -98, r: 7, fill }, win));
    el('rect', { x: -80, y: -107, width: 220, height: 18, rx: 9, fill: '#dfe4f0' }, win);
    const webPage = el('g', {}, el('g', { 'clip-path': `url(#${u}web)` }, win));
    for (let k = 0; k < 3; k += 1) {
      const y = k * 210;
      accent(el('rect', { x: -156, y: -60 + y, width: 130, height: 84, rx: 10, fill: ACCENT_SOFT }, webPage), 'fill', ACCENT_SOFT);
      for (const [dy, width] of [[-60, 150], [-34, 120], [-8, 140]]) el('rect', { x: -12, y: dy + y, width, height: 12, rx: 6, fill: '#d9dfee' }, webPage);
      for (const [dy, width] of [[44, 300], [70, 250], [96, 280], [122, 200]]) el('rect', { x: -156, y: dy + y, width, height: 12, rx: 6, fill: '#e3e7f2' }, webPage);
    }
    // Editing: a sheet standing on the ledge, lines written one by one with a pen in her hand.
    const edit = group(back);
    el('rect', { x: 500, y: 996, width: 270, height: 110, rx: 12, fill: PAPER, stroke: PAPER_EDGE, 'stroke-width': 4, transform: 'rotate(-2 635 1050)' }, edit);
    const editLines = [0, 1, 2].map(i => accent(el('rect', { x: 520, y: 1016 + i * 24, width: 0, height: 10, rx: 5, fill: ACCENT, opacity: .7, transform: 'rotate(-2 635 1050)' }, edit)));
    const pen = group(front);
    const penBody = el('line', { stroke: INK, 'stroke-width': 15, 'stroke-linecap': 'round' }, pen);
    const penTip = accent(el('circle', { r: 8, fill: ACCENT }, pen));
    // Shell: a small terminal standing on the ledge, output scrolling after the keys.
    const shell = group(back);
    el('rect', { x: 516, y: 924, width: 224, height: 182, rx: 20, fill: '#23262e' }, shell);
    ['#f2a3a3', '#f3c690', '#9fd3a8'].forEach((fill, i) => el('circle', { cx: 540 + i * 18, cy: 946, r: 6, fill }, shell));
    el('rect', { x: 526, y: 962, width: 204, height: 134 }, el('clipPath', { id: `${u}term` }, defs));
    const shellOut = el('g', {}, el('g', { 'clip-path': `url(#${u}term)` }, shell));
    const shellRows = Array.from({ length: 12 }, (_, i) => {
      const row = el('g', {}, shellOut);
      el('rect', { x: 536, y: 0, width: 12, height: 10, rx: 3, fill: i % 4 === 0 ? '#7ee0a8' : '#59606e' }, row);
      el('rect', { x: 556, y: 0, width: 60 + ((i * 47) % 110), height: 10, rx: 5, fill: i % 4 === 0 ? '#e7eaf2' : '#9aa6bd' }, row);
      return row;
    });
    const shellCursor = el('rect', { x: 536, width: 14, height: 16, fill: '#7ee0a8' }, shell);
    // Memory: a note flies into her temple and turns into a small ring.
    const memory = group(front), note = el('g', {}, memory);
    el('path', { d: 'M-38 -38 H30 L38 -30 V38 H-38 Z', fill: '#f3dc8a' }, note);
    el('path', { d: 'M30 -38 V-30 H38 Z', fill: '#d9bd62' }, note);
    el('rect', { x: -24, y: -14, width: 44, height: 8, rx: 4, fill: '#c9a94e' }, note);
    el('rect', { x: -24, y: 4, width: 30, height: 8, rx: 4, fill: '#c9a94e' }, note);
    const memRing = accent(el('circle', { cx: 868, cy: 560, r: 30, fill: 'none', stroke: ACCENT, 'stroke-width': 6, opacity: 0 }, memory), 'stroke');
    // Plan: a small checklist card, items ticked in turn.
    const plan = group(front), planCard = el('g', {}, plan);
    el('rect', { x: -78, y: -196, width: 156, height: 190, rx: 16, fill: PAPER, stroke: PAPER_EDGE, 'stroke-width': 4 }, planCard);
    const planTicks = [0, 1, 2].map(i => {
      accent(el('rect', { x: -56, y: -170 + i * 54, width: 26, height: 26, rx: 7, fill: 'none', stroke: ACCENT, 'stroke-width': 5 }, planCard), 'stroke');
      accent(el('rect', { x: -18, y: -163 + i * 54, width: 70 - i * 12, height: 11, rx: 5.5, fill: ACCENT_SOFT }, planCard), 'fill', ACCENT_SOFT);
      return accent(el('path', { d: `M-51 ${-158 + i * 54} l7 8 l13 -15`, fill: 'none', stroke: ACCENT, 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': 40, opacity: 0 }, planCard), 'stroke');
    });
    // Other tools: a small gear on the ledge that she turns; white with an outline so it stands off the knit.
    const other = group(back), gear = el('g', {}, other);
    const teeth = Array.from({ length: 8 }, (_, i) => { const a = i * Math.PI / 4; return `M${(Math.cos(a) * 40).toFixed(1)} ${(Math.sin(a) * 40).toFixed(1)} L${(Math.cos(a) * 58).toFixed(1)} ${(Math.sin(a) * 58).toFixed(1)}`; }).join(' ');
    el('path', { d: teeth, stroke: '#c6ccdb', 'stroke-width': 32, 'stroke-linecap': 'round' }, gear);
    el('circle', { r: 49, fill: '#c6ccdb' }, gear);
    el('path', { d: teeth, stroke: '#ffffff', 'stroke-width': 22, 'stroke-linecap': 'round' }, gear);
    el('circle', { r: 44, fill: '#ffffff' }, gear);
    accent(el('circle', { r: 18, fill: ACCENT }, gear));
    this.propParts = { read, readSheet, readHi, search, searchHandle, searchLens, searchGlint, searchPing, web, webPage, edit, editLines, pen, penBody, penTip,
      shell, shellRows, shellCursor, memory, note, memRing, plan, planCard, planTicks, other, gear };
  }
}
