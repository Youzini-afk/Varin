'use strict';
// The preview's figure engine, shared by index.html and stage.html.
const ART = window.VARIN_ART;
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; };
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const bump = (x, a, b) => (x <= a || x >= b ? 0 : Math.sin(Math.PI * (x - a) / (b - a)));
const ramp = (x, a, b) => clamp((x - a) / (b - a));
const smooth = x => x * x * (3 - 2 * x);
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mulberry = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
let reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- geometry (reference pixel space, 1254 x 1254)
const VIEW = { full:'34 30 1188 1192', head:'330 236 750 750' };
const PIVOT = [628, 1100], SILL = 1100;
const EYE = { L:[489, 706], R:[763, 706] };
const HL = { L:[511, 651], R:[741, 651] }, HL2 = { L:[471, 716], R:[781, 716] };
const BROW = { L:[486, 548], R:[757, 542] };
const HAND = { L:[473, 1097], R:[767, 1097] };
const AHOGE = [240, 466], KNOT = [1074, 532];
const SKIN = '#fae5dd', LASH = '#2f3555';

// ---------------------------------------------------------------- parameters and springs
const P0 = { fy:0, frot:0, fsx:1, fsy:1, featX:0, featY:0, lookX:0, lookY:0, eyeS:1, eyeY:1, eyeDim:0, spark:0,
  browL:0, browR:0, browLr:0, browRr:0, blush:1, shy:0, hLx:HAND.L[0], hLy:HAND.L[1], hRx:HAND.R[0], hRy:HAND.R[1], hLs:1, hRs:1,
  glow:.55, gr:59, gg:76, gb:120, grey:0, droop:0 };
const GROUP = { fy:'body', frot:'body', fsx:'body', fsy:'body', featX:'face', featY:'face', lookX:'look', lookY:'look', eyeS:'face', eyeY:'face', eyeDim:'slow', spark:'slow',
  browL:'face', browR:'face', browLr:'face', browRr:'face', blush:'slow', shy:'slow', hLx:'hand', hLy:'hand', hRx:'hand', hRy:'hand', hLs:'hand', hRs:'hand',
  glow:'slow', gr:'slow', gg:'slow', gb:'slow', grey:'slow', droop:'slow' };
const SPRING = { body:[190, 15], face:[280, 29], look:[420, 38], hand:[170, 16.5], slow:[38, 11.5] };

// ---------------------------------------------------------------- face parts
const ALT = {
  closed:cx => `M${cx - 44} 682 Q${cx} 716 ${cx + 44} 682`,
  happy:cx => `M${cx - 44} 706 Q${cx} 650 ${cx + 44} 706`,
  squeezeL:cx => `M${cx - 30} 662 L${cx + 26} 690 L${cx - 30} 718`,
  squeezeR:cx => `M${cx + 30} 662 L${cx - 26} 690 L${cx + 30} 718`,
};
const LIP = '#e7a19c', MOUTH_IN = '#e2827f', TONGUE = '#f3aaa6';
const MOUTHS = {
  smile:[['path', { d:'M610 755 Q627 768 644 755', fill:'none', stroke:LIP, 'stroke-width':5.5, 'stroke-linecap':'round' }]],
  open:[['path', { d:'M609 753 Q627 757 645 753 Q643 776 627 778 Q611 776 609 753 Z', fill:MOUTH_IN }], ['ellipse', { cx:627, cy:771, rx:8, ry:4.5, fill:TONGUE }]],
  grin:[['path', { d:'M600 750 Q627 757 654 750 Q652 788 627 790 Q602 788 600 750 Z', fill:MOUTH_IN }], ['ellipse', { cx:627, cy:780, rx:13, ry:7, fill:TONGUE }]],
  o:[['ellipse', { cx:627, cy:766, rx:10, ry:12, fill:MOUTH_IN }]],
  sleep:[['ellipse', { cx:627, cy:765, rx:6.5, ry:7.5, fill:'#e79a96' }]],
  yawn:[['ellipse', { cx:627, cy:772, rx:17, ry:24, fill:'#d9777a' }], ['ellipse', { cx:627, cy:786, rx:10, ry:7, fill:'#f0a3a2' }]],
  flat:[['path', { d:'M614 762 L640 762', fill:'none', stroke:LIP, 'stroke-width':5.5, 'stroke-linecap':'round' }]],
  cat:[['path', { d:'M603 755 Q614 769 627 758 Q640 769 651 755', fill:'none', stroke:LIP, 'stroke-width':5.5, 'stroke-linecap':'round', 'stroke-linejoin':'round' }]],
  pout:[['path', { d:'M611 765 Q619 756 627 763 Q635 770 643 761', fill:'none', stroke:LIP, 'stroke-width':5.5, 'stroke-linecap':'round' }]],
};

// ---------------------------------------------------------------- states (BotFigureState)
// pose(t, f, L): t = seconds in state, L = 1 when loops may play, 0 for still/reduced rendering.
const GLOW = { idle:'#3b4c78', listening:'#4b72b8', thinking:'#6b5bc0', working:'#3b8aa6', waiting:'#e3a04c', result:'#e590b6', sleeping:'#29305a', waking:'#d9b36e', offline:'#1c202b' };
const GLOW_LIGHT = { idle:'#8fb0ea', listening:'#7aa2ff', thinking:'#a08cff', working:'#5cc6d6', waiting:'#f3b562', result:'#f49ab4', sleeping:'#7f8bd6', waking:'#ffd38a', offline:'#8fb0ea' };
const typing = (t, rate, f) => { const burst = (t % 2.3) < 1.7; return burst ? [Math.max(0, Math.sin(t * rate)) ** 2, Math.max(0, Math.sin(t * rate + Math.PI)) ** 2] : [0, 0]; };
const STATES = {
  idle:{ line:'空闲', blink:true, follow:true, micro:true, glow:.5,
    pose:(t, f, L) => ({ fy:-3 * L * Math.sin(t * 1.75), fsy:1 + .006 * L * Math.sin(t * 1.75), lookX:f.glance.x, lookY:f.glance.y, featX:f.glance.x * 5 }) },
  listening:{ line:'在听', blink:true, follow:true, glow:.62,
    enter:f => f.kick('fy', -260),
    pose:(t, f, L) => { const read = L ? -.55 + ((t * .32) % 1) * 1.1 : 0;
      return { fy:-16 - 3 * L * Math.sin(t * 2), fsx:1.03, fsy:1.03, frot:1.3, eyeS:1.07, spark:1, lookX:read, lookY:.35, featX:read * 4, browL:-9, browR:-9, hLx:548, hRx:706, blush:1.1 }; },
    tick:(t, f, L) => { if (L && t > f.mem.nextKey) { const inBurst = (t % 2.6) < 1.8; if (inBurst) f.kick('fy', 70 + f.rand() * 50); f.mem.nextKey = t + .11 + f.rand() * .16; } } },
  thinking:{ line:'正在想…', blink:true, glow:.6, fx:{ dots:1 }, mouth:'pout',
    pose:(t, f, L) => { const drift = .32 * L * Math.sin(t * .85); const tap = L * bump((t % 1.6) / 1.6, .55, .75);
      return { frot:-2.8, fy:-6, lookX:-.72 + drift, lookY:-.9, featX:-7 + drift * 6, featY:-4, browL:-13, browR:2, browLr:-4, browRr:3, hRx:688, hRy:868 - 7 * tap }; } },
  working:{ line:'写作正在编辑 · 12 分钟', blink:true, glow:.55, fx:{ bits:1 }, mouth:'flat',
    pose:(t, f, L) => { const [a, b] = L ? typing(t, 15, f) : [0, 0];
      return { fy:10 + 3 * L * Math.sin(t * 2.2), lookY:.95, lookX:.18 * L * Math.sin(t * .7), eyeY:.82, featY:6, browL:5, browR:5, browLr:6, browRr:-6, hLy:HAND.L[1] - 20 * a, hRy:HAND.R[1] - 20 * b, hLx:HAND.L[0] + 18, hRx:HAND.R[0] - 18 }; },
    tick:(t, f, L) => { if (!L) return; const [a, b] = typing(t, 15, f); for (const [k, v] of [['L', a], ['R', b]]) { const was = f.mem['tap' + k] || 0; if (v > .9 && was <= .9 && f.rand() < .55) f.bit(k); f.mem['tap' + k] = v; } } },
  waiting:{ line:'写作在等你确认', warn:true, blink:true, follow:true, glow:.78, pulse:true, fx:{ alert:1 }, mouth:'open',
    enter:f => { f.kick('fy', -950); f.kick('fsy', 1.4); },
    pose:(t, f, L) => { const c = t % 3.6, wave = L ? ramp(c, 0, .15) * (1 - ramp(c, 1.25, 1.45)) : 0;
      return { fy:-14, frot:2.4, eyeS:1.04, spark:1, browL:-9, browR:-9, blush:1.15, hRx:905 + 30 * wave * Math.sin(c * 15), hRy:850 - 12 * wave * Math.abs(Math.sin(c * 15)) }; } },
  result:{ line:'依赖调查返回了结果', glow:.7, eyes:'happy', mouth:'grin',
    enter:f => { f.kick('fsy', -2.0); f.kick('fy', 380); f.later(.18, () => { f.kick('fy', -1100); f.burst(22); f.sheen(); }); },
    pose:(t, f, L) => { const up = ramp(t, .15, .35), hop = L * Math.abs(Math.sin(t * 4.2)) * ramp(t, .9, 1.1);
      return { fy:-10 - 6 * hop, browL:-8, browR:-8, blush:1.35, hLx:lerp(HAND.L[0], 338, up), hLy:lerp(HAND.L[1], 826, up) + 16 * L * Math.sin(t * 8.4), hRx:lerp(HAND.R[0], 918, up), hRy:lerp(HAND.R[1], 826, up) + 16 * L * Math.sin(t * 8.4 + Math.PI) }; } },
  sleeping:{ line:'休息中 · 叫醒', glow:.42, fx:{ zz:1 }, eyes:'closed', mouth:'sleep', stillAt:3,
    pose:(t, f, L) => ({ fy:150 + 5 * L * Math.sin(t * 1.35), fsy:1 + .012 * L * Math.sin(t * 1.35), frot:-3, featY:4, browL:6, browR:6, blush:.85, hLx:560, hRx:696, hLy:1092, hRy:1092, droop:1 }) },
  waking:{ line:'正在醒来…', glow:.5, stillAt:1.0,
    pose:(t, f, L) => {
      const rise = ramp(t, .3, .9), rub = ramp(t, .95, 1.1) * (1 - ramp(t, 1.85, 2.05)), stretch = ramp(t, 2.0, 2.25) * (1 - ramp(t, 2.6, 2.95));
      const q = { fy:lerp(150, -4, rise), frot:lerp(-3, 0, rise), droop:1 - ramp(t, 2.1, 2.4), featY:4 * (1 - rise), blush:1,
        hLx:lerp(560, 506 + 16 * Math.cos(t * 13), rub), hLy:lerp(1092, 694 + 10 * Math.sin(t * 13), rub), hRx:lerp(696, HAND.R[0], rise), hRy:1094 };
      if (stretch > 0) Object.assign(q, { hLx:lerp(q.hLx, 250, stretch), hLy:lerp(q.hLy, 330, stretch), hRx:lerp(q.hRx, 1005, stretch), hRy:lerp(q.hRy, 330, stretch), fsy:1 + .045 * stretch, fy:q.fy - 16 * stretch });
      q.eyeL = t < .9 ? 'closed' : rub > .3 ? 'closed' : stretch > .3 ? 'squeezeL' : 'open';
      q.eyeR = t < .9 ? 'closed' : stretch > .3 ? 'squeezeR' : 'open';
      q.eyeY = t < 2.6 ? .45 : 1;
      q.mouth = t > 1.05 && t < 1.8 ? 'yawn' : stretch > .3 ? 'o' : t < 1 ? 'sleep' : 'smile';
      q.fx = t > 2.95 && t < 3.1 ? { sparkle:1 } : {};
      return q; },
    tick:(t, f) => { if (!f.mem.wakeBlinked && t > 3.05) { f.mem.wakeBlinked = true; f.blinkNow(true); f.sheen(); } } },
  offline:{ line:'电脑没连上 · 只能查看', glow:0, mouth:'flat', noLoops:true,
    pose:() => ({ fy:330, grey:1, eyeDim:1, browL:4, browR:4, blush:.5, hLy:1330, hRy:1330 }) },
};

// ---------------------------------------------------------------- one-shot actions
const ACTIONS = {
  wave:{ label:'挥手', dur:1.9, pose:(x, t) => ({ set:{ hRx:915 + 30 * Math.sin(t * 15) * ramp(t, .25, .4), hRy:836, blush:1.2, browL:-6, browR:-6, frot:2 }, mouth:'open' }) },
  nod:{ label:'点头', dur:1.05, pose:(x) => ({ add:{ fy:24 * (bump(x, .05, .45) + bump(x, .5, .9)), featY:8 * (bump(x, .05, .45) + bump(x, .5, .9)) }, eyes:'happy', mouth:'smile' }) },
  shake:{ label:'摇头', dur:1.15, pose:(x) => ({ add:{ frot:3.4 * Math.sin(x * Math.PI * 6) * (1 - x), featX:-9 * Math.sin(x * Math.PI * 6) * (1 - x) }, set:{ browL:4, browR:4, browLr:5, browRr:-5 }, eyes:'squeeze', mouth:'pout' }) },
  tilt:{ label:'疑惑', dur:1.7, start:f => f.pop('question'), pose:() => ({ set:{ frot:6, featX:9, lookX:.55, lookY:-.35, browL:-13, browR:4, browLr:-5, browRr:4 }, mouth:'pout' }) },
  wink:{ label:'眨眼', dur:1.0, start:f => f.later(.12, () => f.pop('sparkle')), pose:() => ({ set:{ blush:1.25, frot:-1.5 }, eyeR:'happy', mouth:'cat' }) },
  poke:{ label:'戳一下', dur:1.3, start:f => { f.kick('fsy', -2.4); f.kick('fy', 520); f.flick(-26); f.pop('heart'); },
    pose:() => ({ set:{ blush:1.7, shy:1, browL:-6, browR:-6 }, eyes:'squeeze', mouth:'cat' }) },
  hide:{ label:'躲起来', dur:3.5, start:f => { f.later(2.3, () => { f.kick('fy', -1300); f.flick(-20); f.sheen(); }); },
    pose:(x, t) => {
      const down = t < 1.45 ? 470 : t < 2.3 ? 335 : -8;
      const look = t > 1.6 && t < 2.3 ? (t < 1.95 ? -.85 : .85) : 0;
      return { set:{ fy:down, lookX:look, featX:look * 6, lookY:t > 1.45 && t < 2.3 ? -.2 : 0, hLy:HAND.L[1] + (t < 2.3 ? 6 : 0), hRy:HAND.R[1] + (t < 2.3 ? 6 : 0) }, eyes:t > 2.45 ? 'happy' : 'open', mouth:t > 2.45 ? 'grin' : 'o' };
    } },
  cheer:{ label:'欢呼', dur:1.9, start:f => { f.kick('fy', -900); f.later(.1, () => f.burst(16)); f.later(.75, () => f.kick('fy', -700)); },
    pose:(x, t) => { const s = Math.sin(t * 9); return { set:{ hLx:330, hLy:800 + 34 * s, hRx:925, hRy:800 - 34 * s, blush:1.3, browL:-9, browR:-9 }, eyes:'happy', mouth:'grin' }; } },
  shy:{ label:'害羞', dur:2.1, pose:(x, t) => ({ set:{ hLx:436, hLy:792, hRx:818, hRy:792, hLs:.92, hRs:.92, blush:1.75, shy:1, fy:26, browL:-4, browR:-4, browLr:-6, browRr:6 }, add:{ frot:1.8 * Math.sin(t * 6) }, eyes:'happy', mouth:'cat' }) },
  surprise:{ label:'吃惊', dur:1.35, start:f => { f.kick('fy', -1250); f.flick(-34); f.pop('exclaim'); },
    pose:() => ({ set:{ eyeS:1.14, lookY:-.15, browL:-20, browR:-20, fy:-12 }, mouth:'o' }) },
  yawn:{ label:'打哈欠', dur:2.3, start:f => f.later(2.05, () => f.blinkNow(true)),
    pose:(x, t) => { const cover = ramp(t, .25, .5) * (1 - ramp(t, 1.55, 1.85)); return { set:{ hLx:lerp(HAND.L[0], 590, cover), hLy:lerp(HAND.L[1], 808, cover), fsy:1 + .03 * bump(t, .2, 1.6), fy:-8 * bump(t, .2, 1.6), browL:-6, browR:-6 }, eyes:t > .25 && t < 1.7 ? 'squeeze' : 'open', mouth:t > .2 && t < 1.65 ? 'yawn' : 'smile' }; } },
};
const MICRO = ['wink', 'nod', 'tilt', 'flick', 'tap'];
// Stage states, one-shot beats and props live in figure-stage-poses.js.

// ---------------------------------------------------------------- figure
let seq = 0;
class Figure {
  constructor(host, opts = {}) {
    this.host = host; this.still = !!opts.still; this.compact = !!opts.compact; this.size = opts.size || 520; this.view = opts.view || VIEW.full;
    this.frameless = !!opts.frameless; this.wide = !!opts.wide; this.viewBox = this.view.split(' ').map(Number);
    this.lookTarget = null; this.focus = null; this.prop = null; this.propAt = 0; this.propEls = {};
    this.uid = 'vf' + (++seq); this.rand = mulberry(opts.seed ?? 11 * seq); this.t = 0;
    this.p = { ...P0 }; this.v = {}; this.goal = { ...P0 };
    this.sec = { a:0, va:0, r:0, vr:0 };
    this.eyes = { L:{ cur:'open', amt:1, va:0 }, R:{ cur:'open', amt:1, va:0 } }; this.mouthS = { cur:'smile', amt:1, va:0 };
    this.fxAmt = { alert:0, zz:0, dots:0, ellipsis:0 }; this.parts = []; this.timers = []; this.pops = [];
    this.glance = { x:0, y:0, until:0 }; this.blinkAt = -9; this.nextBlink = 1.5; this.nextMicro = 6; this.action = null; this.sheenAt = -9; this.lastPointer = -9;
    this.build();
    this.setState(opts.state || 'idle');
    if (!opts.manual) Figure.live.add(this);
    this.visible = true;
  }
  get L() { return this.still || reduced || STATES[this.state].noLoops ? 0 : 1; }

  build() {
    const u = this.uid, svg = el('svg', this.wide
      ? { viewBox:this.view, width:'100%', height:this.size, preserveAspectRatio:'xMidYMax meet', style:'display:block;overflow:visible' }
      : { viewBox:this.view, width:this.size, height:this.size, style:'display:block' });
    this.svg = svg; this.host.appendChild(svg);
    const defs = el('defs', {}, svg);
    const glow = el('radialGradient', { id:`${u}g`, cx:.5, cy:.5, r:.5 }, defs);
    this.glowStops = [el('stop', { offset:0, 'stop-color':'#3b4c78', 'stop-opacity':.6 }, glow), el('stop', { offset:.55, 'stop-color':'#3b4c78', 'stop-opacity':.2 }, glow), el('stop', { offset:1, 'stop-color':'#3b4c78', 'stop-opacity':0 }, glow)];
    const sheen = el('linearGradient', { id:`${u}s`, x1:0, x2:1, y1:0, y2:0 }, defs);
    [[0, 0], [.5, .55], [1, 0]].forEach(([o, a]) => el('stop', { offset:o, 'stop-color':'#ffffff', 'stop-opacity':a }, sheen));
    const filter = el('filter', { id:`${u}f`, 'color-interpolation-filters':'sRGB' }, defs);
    this.matrix = el('feColorMatrix', { type:'matrix', values:'1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0' }, filter);
    const clip = (id, d, rule) => { const c = el('clipPath', { id:`${u}${id}` }, defs); el('path', { d, 'clip-rule':rule || 'nonzero' }, c); return `url(#${u}${id})`; };
    const above = clip('above', `M0 0H1254V${SILL + 6}H0Z`);
    const lower = clip('lower', 'M0 0H1254V1222H0Z');
    // The flyaway lock's own outline: grown for the moving copy, shrunk for the hole in the static hair.
    const ahogeIn = clip('ai', ART.layers.ahogeIn[0][1]);
    const ahogeOut = clip('ao', 'M0 0H1254V1254H0Z ' + ART.layers.ahogeHole[0][1], 'evenodd');
    const paint = (name, parent) => { for (const [fill, d] of ART.layers[name] || []) el('path', { fill, d, 'fill-rule':'evenodd' }, parent); };

    if (!this.frameless) el('rect', { x:0, y:0, width:1254, height:1254, fill:'#1c202b' }, svg);
    this.glowEl = el('circle', { cx:628, cy:600, r:660, fill:`url(#${u}g)` }, svg);
    this.fxBack = el('g', {}, svg);
    const outer = el('g', { 'clip-path':above }, svg);
    this.fig = el('g', {}, outer);
    // Stage layers: team members peeking over the ledge beside her (clipped like her), then items on the ledge.
    this.teamBack = el('g', { 'clip-path':clip('teamAbove', `M-4000 -800H5254V${SILL + 6}H-4000Z`) }, svg);

    // Behind the chin: a fill for the shoulder area, the inside of the collar and a little neck.
    const under = el('g', {}, this.fig);
    el('path', { fill:'#9599b8', d:'M260 1300 L262 1100 C290 1000 390 915 470 892 L530 836 L724 836 L784 892 C864 915 964 1000 992 1100 L994 1300 Z' }, under);
    el('path', { fill:'#6c8dd5', d:'M536 880 C540 862 584 854 626 854 C668 854 712 862 716 880 Z' }, under);
    el('path', { fill:'#f6dcd2', d:'M594 826 H658 V874 Q626 884 594 874 Z' }, under);
    el('path', { fill:'#efcdc3', d:'M594 836 Q626 866 658 836 V826 H594 Z' }, under);

    // Clothes, drawn as clean shapes: open white coat, ribbed turtleneck, straps, sleeves resting on the sill.
    const body = el('g', {}, this.fig);
    el('path', { fill:'#f4f4f7', d:'M529 893 C470 900 420 935 390 965 C355 1000 325 1045 306 1100 L296 1300 L956 1300 L946 1100 C927 1045 897 1000 862 965 C832 935 782 900 723 893 Z' }, body);
    el('path', { fill:'#e5e5ec', d:'M520 897 C500 960 512 1030 522 1300 L537 1300 L537 900 Z M732 897 C752 960 740 1030 730 1300 L715 1300 L715 900 Z' }, body);
    el('path', { fill:'#82a3e6', d:'M537 900 L715 900 L719 1300 L533 1300 Z' }, body);
    el('path', { fill:'#7495dc', d:'M537 914 Q626 934 715 914 L715 930 Q626 944 537 930 Z' }, body);
    el('path', { fill:'#82a3e6', d:'M529 910 L529 884 Q529 864 548 860 Q588 876 626 879 Q664 876 704 860 Q723 864 723 884 L723 910 Q723 918 714 919 Q626 926 538 919 Q529 918 529 910 Z' }, body);
    el('path', { d:'M588 890 V910 M664 890 V910', fill:'none', stroke:'#6b8bd5', 'stroke-width':7, 'stroke-linecap':'round' }, body);
    el('path', { fill:'#82a3e6', d:'M306 1104 C322 1068 360 1042 410 1035 C448 1030 480 1032 502 1042 L506 1300 L300 1300 Z M946 1104 C930 1068 892 1042 842 1035 C804 1030 772 1032 750 1042 L746 1300 L952 1300 Z' }, body);
    el('path', { fill:'#6f90d8', d:'M537 1060 L547 1060 L574 1106 L537 1106 Z M715 1060 L705 1060 L678 1106 L715 1106 Z' }, body);
    el('path', { d:'M318 1080 C340 1056 372 1042 410 1037 M934 1080 C912 1056 880 1042 842 1037', fill:'none', stroke:'#9cb6ec', 'stroke-width':5, 'stroke-linecap':'round' }, body);
    const straps = el('g', { fill:'#2b2c33' }, body);
    el('path', { d:'M452 914 Q470 902 492 901 L512 1040 L466 1046 Z' }, straps); el('path', { d:'M761 901 Q783 902 801 914 L787 1046 L742 1040 Z' }, straps);
    const buckles = el('g', { fill:'#5e6372' }, body);
    el('path', { d:'M455 948 L503 940 L507 976 L459 985 Z' }, buckles); el('path', { d:'M750 940 L798 948 L794 985 L746 976 Z' }, buckles);
    el('path', { d:'M548 918 Q568 948 601 966 M704 918 Q684 948 651 966', fill:'none', stroke:'#a08470', 'stroke-width':4.5, 'stroke-linecap':'round' }, body);
    el('path', { d:'M626 961 L654 989 L626 1017 L598 989 Z', fill:'none', stroke:'#f3c690', 'stroke-width':9, 'stroke-linejoin':'round' }, body);
    const motif = el('g', { fill:'#82a3e6', stroke:'#f4f4f7', 'stroke-width':4 }, body);
    for (const [x, r] of [[400, -40], [852, 40]]) { const m = el('g', { transform:`translate(${x} 1000) rotate(${r})` }, motif); for (const [a, b] of [[-28, -18.5], [0, -18.5], [-28, 0], [0, 0]]) el('rect', { x:a, y:b, width:28, height:18.5, rx:2 }, m); }

    paint('face', el('g', {}, this.fig));
    // Face features slide a little under the bangs when the head "turns".
    this.feat = el('g', {}, this.fig);
    this.blushes = ['L', 'R'].map(k => {
      const a = ART.anchors['blush' + k], g = el('g', {}, this.feat);
      const e = el('ellipse', { cx:a.cx, cy:a.cy, rx:a.rx, ry:a.ry, fill:'#f3c4ba' }, g);
      const lines = el('path', { d:[-18, 0, 18].map(dx => `M${a.cx + dx - 6} ${a.cy + 9} l12 -18`).join(' '), stroke:'#e48b86', 'stroke-width':4.5, 'stroke-linecap':'round', opacity:0 }, g);
      return { g, e, lines, a };
    });
    this.mouthG = el('g', {}, this.feat);
    this.mouths = {};
    for (const [k, parts] of Object.entries(MOUTHS)) { const g = el('g', { style:'display:none' }, this.mouthG); for (const [tag, attrs] of parts) el(tag, attrs, g); this.mouths[k] = g; }
    for (const k of ['L', 'R']) {
      const e = this.eyes[k], wrap = el('g', {}, this.feat);
      e.open = el('g', {}, wrap); paint('eye' + k, e.open);
      e.hl = el('circle', { cx:HL[k][0], cy:HL[k][1], r:8.5, fill:'#fbfbfd' }, e.open);
      e.hl2 = el('circle', { cx:HL2[k][0], cy:HL2[k][1], r:5.5, fill:'#fbfbfd', opacity:0 }, e.open);
      e.alt = el('path', { fill:'none', stroke:LASH, 'stroke-width':13, 'stroke-linecap':'round', 'stroke-linejoin':'round', style:'display:none' }, wrap);
    }
    this.brows = ['L', 'R'].map(k => { const g = el('g', {}, this.feat); paint('brow' + k, g); return g; });

    // Hair tie, copied from the original. Its loop sits behind the lock; tail and loop tuck under
    // the band (same colour), so they can swing without a visible join.
    this.bowLoop = el('g', {}, this.fig); paint('ribbonLoop', this.bowLoop);
    // Hair: one traced drawing, used twice so the flyaway lock can sway on its own.
    const hair = el('g', { id:`${u}hair` }, defs); paint('hair', hair);
    hair.firstChild.setAttribute('id', `${u}hairBase`);
    el('use', { href:`#${u}hair`, 'clip-path':ahogeOut }, this.fig);
    this.ahoge = el('g', {}, this.fig); el('use', { href:`#${u}hair`, 'clip-path':ahogeIn }, this.ahoge);
    const hc = el('clipPath', { id:`${u}hc` }, defs); el('use', { href:`#${u}hairBase` }, hc);
    this.sheenRect = el('rect', { x:-300, y:60, width:260, height:1200, fill:`url(#${u}s)`, opacity:0 }, el('g', { 'clip-path':`url(#${u}hc)` }, this.fig));
    this.bowTail = el('g', {}, this.fig); paint('ribbonTail', this.bowTail);
    paint('ribbon', el('g', {}, this.fig));
    const clipG = el('g', {}, this.fig);
    el('path', { fill:'#2b2c33', d:'M858 283 L932 285 L940 297 L924 322 L897 323 L862 384 L820 368 Z' }, clipG);
    el('path', { fill:'#7f9fe4', d:'M889 325 L946 323 L966 343 L930 423 L845 423 L872 370 L880 364 L899 378 L912 355 L908 347 L887 331 Z' }, clipG);

    // Window sill and the two ball hands resting on it.
    if (this.frameless) this.ledge = el('rect', { x:30, y:SILL, width:1194, height:40, rx:20, style:'fill:var(--ledge,#e3e5eb)' }, svg);
    else { el('rect', { x:0, y:SILL, width:1254, height:154, fill:'#282c37' }, svg); el('rect', { x:0, y:SILL, width:1254, height:24, fill:'#373c49' }, svg); }
    this.onLedge = el('g', {}, svg);
    this.propBack = el('g', {}, svg);
    const hands = el('g', { 'clip-path':lower }, svg);
    this.hands = [-1, 1].map(side => {
      const g = el('g', {}, hands), sh = el('ellipse', { cx:0, cy:14, rx:66, ry:64, fill:'#0d0f17', opacity:.45 }, g);
      el('circle', { cx:0, cy:0, r:68, fill:'#efc3b7' }, g);
      el('circle', { cx:-side * 7, cy:-8, r:61, fill:SKIN }, g);
      return { g, sh };
    });
    this.propFront = el('g', {}, svg);
    this.fxFront = el('g', {}, svg);
    this.buildProps();

    // Persistent effects.
    this.badge = el('g', { opacity:0 }, this.fxFront);
    this.badgeRing = el('circle', { r:44, fill:'none', stroke:'#f3b562', 'stroke-width':6 }, this.badge);
    el('circle', { r:44, fill:'#f3b562' }, this.badge);
    el('rect', { x:-7, y:-26, width:14, height:32, rx:7, fill:'#3a2a12' }, this.badge); el('circle', { cx:0, cy:19, r:7.5, fill:'#3a2a12' }, this.badge);
    this.zz = [0, 1, 2].map(() => el('path', { d:'M-17 -15 H17 L-17 15 H17', fill:'none', stroke:'#c9cde0', 'stroke-width':7, 'stroke-linecap':'round', 'stroke-linejoin':'round', opacity:0 }, this.fxFront));
    this.dots = [[236, 238, 15], [172, 176, 21], [102, 106, 28]].map(([x, y, r]) => ({ x, y, n:el('circle', { cx:x, cy:y, r, fill:'#e3e4f0', opacity:0 }, this.fxFront) }));
    this.ellipsis = el('g', { opacity:0 }, this.fxFront);
    el('rect', { x:-62, y:-30, width:124, height:60, rx:30, style:this.frameless ? 'fill:var(--bubble,#ffffff)' : 'fill:#e3e4f0' }, this.ellipsis);
    this.ellipsisDots = [-30, 0, 30].map(x => el('circle', { cx:x, cy:0, r:10, style:'fill:var(--mark,#7c8296)' }, this.ellipsis));
    if (this.frameless) {
      for (const z of this.zz) { z.removeAttribute('stroke'); z.setAttribute('style', 'stroke:var(--mark,#9aa0ad)'); }
      for (const d of this.dots) { d.n.removeAttribute('fill'); d.n.setAttribute('style', 'fill:var(--mark,#9aa0ad)'); }
    }
    this.matrixOn = false;
    if (this.wide) this.fitWide();
  }
  fitWide() {
    const resize = () => {
      const w = this.host.clientWidth, h = this.size; if (!w) return;
      const span = Math.max(1192, 1192 * w / h);
      this.viewBox = [628 - span / 2, -24, span, 1192];
      this.svg.setAttribute('viewBox', this.viewBox.join(' '));
      if (this.ledge) { this.ledge.setAttribute('x', this.viewBox[0] - 40); this.ledge.setAttribute('width', span + 80); }
      this.onResize?.();
    };
    resize(); new ResizeObserver(resize).observe(this.host);
  }
  /** Eye direction toward a point in figure units, as lookX / lookY. */
  targetLook(pt) { return [clamp((pt.x - 628) / 640, -1, 1), clamp((pt.y - 690) / 520, -1, 1)]; }
  lookAt(x, y, seconds = 1, turn = 1.4) { this.lookTarget = { x, y, until:this.t + seconds, turn }; }

  // ------------------------------------------------------------ control
  setState(name) {
    if (!STATES[name]) return;
    this.state = name; this.stateAt = this.t; this.mem = { nextKey:0 };
    const prop = STATES[name].prop || null; if (prop !== this.prop) { this.prop = prop; this.propAt = this.t; }
    if (this.action && !this.action.def.keep) this.action = null;
    const st = STATES[name];
    if (st.enter && !this.still && !reduced) st.enter(this);
    this.nextMicro = this.t + 5 + this.rand() * 5;
    if (this.still) this.settle(st.stillAt ?? 2.2);
  }
  play(name) {
    if (this.still || this.state === 'offline') return;
    if (name === 'flick') { this.flick(-24); return; }
    if (name === 'tap') { this.action = { def:{ dur:.9, pose:(x, t) => ({ set:{ hLy:HAND.L[1] - 22 * bump(t, 0, .2) - 22 * bump(t, .4, .6), hRy:HAND.R[1] - 22 * bump(t, .2, .4) - 22 * bump(t, .6, .8) } }) }, at:this.t }; return; }
    const def = ACTIONS[name]; if (!def) return;
    this.action = { def, at:this.t, name };
    if (!reduced) def.start?.(this);
  }
  kick(key, dv) { if (this.still || reduced) return; this.v[key] = (this.v[key] || 0) + dv; }
  flick(dv) { if (!this.still && !reduced) this.sec.va += dv * 6; }
  later(dt, fn) { this.timers.push({ at:this.t + dt, fn }); }
  blinkNow(double) { this.blinkAt = this.t; this.blinkAt2 = double ? this.t + .26 : -9; }
  sheen() { if (!this.still && !reduced) this.sheenAt = this.t; }
  settle(seconds) {
    // Fast-forward the springs to the resting pose; used for still sizes and screenshots.
    this.stateAt = this.t;
    for (let i = 0; i < seconds * 60; i++) this.step(1 / 60, true);
    this.render();
  }

  // ------------------------------------------------------------ simulation
  step(dt, quiet) {
    this.t += dt; const t = this.t, lt = t - this.stateAt, st = STATES[this.state], L = this.L;
    for (const tm of this.timers.splice(0)) { if (tm.at <= t) tm.fn(); else this.timers.push(tm); }
    // Glances and pointer follow.
    const following = Figure.follow && st.follow && Figure.pointer && t - this.lastPointer < 2.5 && !this.still && !this.compact;
    if (st.micro && t > this.glance.until && !following) {
      const quiet2 = this.rand() < .45;
      this.glance = { x:quiet2 ? 0 : (this.rand() - .5) * 1.5, y:quiet2 ? 0 : (this.rand() - .6) * .7, until:t + 1.6 + this.rand() * 2.8 };
    }
    if (!st.micro) this.glance = { x:0, y:0, until:0 };
    const q = st.pose(lt, this, L) || {};
    const goal = { ...P0 };
    let eyeL = q.eyeL || q.eyes || st.eyes || 'open', eyeR = q.eyeR || q.eyes || st.eyes || 'open', mouth = q.mouth || st.mouth || 'smile';
    let fx = { ...(st.fx || {}), ...(q.fx || {}) };
    for (const k in q) if (k in goal) goal[k] = q[k];
    if (following) {
      const p = this.pointerLook();
      goal.lookX = p[0]; goal.lookY = p[1] * .8 + goal.lookY * .2; goal.featX = (q.featX || 0) * .3 + p[0] * 6; goal.frot += p[0] * 1.6;
    }
    if (this.lookTarget && t < this.lookTarget.until && !this.still) {
      const [lx, ly] = this.targetLook(this.lookTarget);
      goal.lookX = lx; goal.lookY = ly; goal.featX = lx * 6; goal.frot += lx * this.lookTarget.turn;
    }
    // One-shot action on top of the state pose.
    if (this.action) {
      const a = this.action, x = (t - a.at) / a.def.dur;
      if (x >= 1) this.action = null;
      else {
        const w = smooth(ramp(x, 0, .12)) * smooth(1 - ramp(x, .85, 1)), o = a.def.pose(x, t - a.at, this) || {};
        for (const k in o.set || {}) goal[k] = lerp(goal[k], o.set[k], w);
        for (const k in o.add || {}) goal[k] += o.add[k] * w;
        if (w > .35) { if (o.eyes) eyeL = eyeR = o.eyes; if (o.eyeL) eyeL = o.eyeL; if (o.eyeR) eyeR = o.eyeR; if (o.mouth) mouth = o.mouth; }
      }
    }
    if (eyeL === 'squeeze') eyeL = 'squeezeL'; if (eyeR === 'squeeze') eyeR = 'squeezeR';
    // Glow colour per state.
    const [r, g, b] = hex((this.frameless ? GLOW_LIGHT : GLOW)[st.glowKey || this.state] || '#8fb0ea'); goal.gr = r; goal.gg = g; goal.gb = b;
    goal.glow = (this.frameless ? (st.glowLite ?? st.glow * .35) : st.glow) * (st.pulse && L ? .78 + .22 * Math.sin(2 * Math.PI * lt / 2.2) : 1);
    this.goal = goal; this.eyeGoal = { L:eyeL, R:eyeR }; this.mouthGoal = mouth; this.fxGoal = fx;
    st.tick?.(lt, this, L);
    // Micro moves while idle.
    if (st.micro && L && !this.action && t > this.nextMicro) { this.play(MICRO[Math.floor(this.rand() * MICRO.length)]); this.nextMicro = t + 7 + this.rand() * 7; }
    if (st.blink && L && t > this.nextBlink) { this.blinkNow(this.rand() < .2); this.nextBlink = t + 2.2 + this.rand() * 3.2; }
    this.integrate(dt);
    if (!quiet) this.render();
  }
  integrate(dt) {
    const p = this.p, goal = this.goal, sub = dt > 1 / 70 ? 2 : 1, h = dt / sub;
    const prevFrot = p.frot;
    for (let s = 0; s < sub; s++) {
      for (const key in GROUP) {
        const [k, c] = SPRING[GROUP[key]];
        if (reduced || this.still) { p[key] += (goal[key] - p[key]) * clamp(h * 8); this.v[key] = 0; continue; }
        const v = this.v[key] || 0; this.v[key] = v + (k * (goal[key] - p[key]) - c * v) * h; p[key] += this.v[key] * h;
      }
      // Eye and mouth shapes: close, swap, reopen.
      for (const k of ['L', 'R']) this.morph(this.eyes[k], this.eyeGoal[k], h);
      this.morph(this.mouthS, this.mouthGoal, h);
      // Secondary motion: the flyaway lock and the ribbon trail the body.
      const sec = this.sec, vy = this.v.fy || 0, vr = this.v.frot || 0, L = this.L;
      const aim = L ? .012 * vy - .9 * vr + 2.2 * Math.sin(this.t * 1.9) : 0;
      sec.va += (140 * (aim - 6 * p.droop - sec.a) - 7 * sec.va) * h; sec.a += sec.va * h;
      const rim = L ? -1.1 * vr + 1.8 * Math.sin(this.t * 1.3 + 1) : 0;
      sec.vr += (90 * (rim - sec.r) - 6 * sec.vr) * h; sec.r += sec.vr * h;
      for (const k in this.fxAmt) { const want = this.fxGoal[k] ? 1 : 0; this.fxAmt[k] += (want - this.fxAmt[k]) * clamp(h * (want ? 6 : 9)); }
      this.stepProps?.(h);
    }
  }
  morph(m, want, h) {
    if (this.still || reduced) { m.cur = want; m.amt = 1; return; }
    const target = m.cur === want ? 1 : 0;
    m.va += (900 * (target - m.amt) - 52 * m.va) * h; m.amt += m.va * h;
    if (m.cur !== want && m.amt < .08) { m.cur = want; m.amt = .05; m.va = 0; }
    m.amt = clamp(m.amt, 0, 1.2);
  }
  pointerLook() {
    const r = this.host.getBoundingClientRect(), [vx, vy, vw] = this.viewBox, s = r.width / vw;
    const cx = r.left + (628 - vx) * s, cy = r.top + (690 - vy) * s;
    const dx = Figure.pointer.x - cx, dy = Figure.pointer.y - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / (r.width * .55));
    return [dx / d * k, dy / d * k];
  }

  // ------------------------------------------------------------ effects
  bit(side) {
    if (this.still || reduced) return;
    const x = (side === 'L' ? this.p.hLx : this.p.hRx) + (this.rand() - .5) * 60, colors = ['#8fb0ea', '#f4f4f7', '#f3c690', '#a9c2f2'];
    const n = el('rect', { x:-9, y:-9, width:18, height:18, rx:3, fill:colors[Math.floor(this.rand() * 4)] }, this.fxFront);
    this.parts.push({ n, x, y:1030, vx:(this.rand() - .5) * 90, vy:-260 - this.rand() * 160, g:120, r:45, vr:(this.rand() - .5) * 200, s:.7 + this.rand() * .6, life:0, max:.95 });
  }
  burst(count) {
    if (this.still || reduced) return;
    const colors = ['#ffd36e', '#8fb0ea', '#f4a9c0', '#ffffff', '#b8c9f5'];
    for (let i = 0; i < count; i++) {
      const star = i % 2 === 0, a = -Math.PI / 2 + (this.rand() - .5) * Math.PI * 1.5, v = 520 + this.rand() * 520;
      const n = star ? el('path', { d:'M0 -20 Q3 -3 20 0 Q3 3 0 20 Q-3 3 -20 0 Q-3 -3 0 -20 Z', fill:colors[i % colors.length] }, this.fxFront)
        : el('rect', { x:-9, y:-9, width:18, height:18, rx:3, fill:colors[i % colors.length] }, this.fxFront);
      this.parts.push({ n, x:628 + (this.rand() - .5) * 120, y:360, vx:Math.cos(a) * v, vy:Math.sin(a) * v, g:1300, r:this.rand() * 90, vr:(this.rand() - .5) * 600, s:.8 + this.rand() * .9, life:0, max:1.1 + this.rand() * .5, drag:1.4 });
    }
  }
  pop(kind) {
    if (this.still || reduced) return;
    const make = {
      heart:() => [el('path', { d:'M0 26 C-46 -6 -34 -50 0 -26 C34 -50 46 -6 0 26 Z', fill:'#f49ab4' }, this.fxFront), 1010, 360, 0, -170],
      question:() => { const g = el('g', {}, this.fxFront); el('path', { d:'M-20 -24 C-20 -50 22 -50 22 -22 C22 -4 0 -2 0 16', fill:'none', stroke:'#e3e4f0', 'stroke-width':13, 'stroke-linecap':'round' }, g); el('circle', { cx:0, cy:40, r:8, fill:'#e3e4f0' }, g); return [g, 220, 230, 0, -40]; },
      sparkle:() => [el('path', { d:'M0 -30 Q4 -4 30 0 Q4 4 0 30 Q-4 4 -30 0 Q-4 -4 0 -30 Z', fill:'#ffd36e' }, this.fxFront), 850, 600, 0, -30],
      exclaim:() => { const g = el('g', {}, this.fxFront); el('rect', { x:-9, y:-46, width:18, height:56, rx:9, fill:'#f3b562' }, g); el('circle', { cx:0, cy:30, r:10, fill:'#f3b562' }, g); return [g, 1110, 250, 0, -60]; },
    }[kind];
    const [n, x, y, vx, vy] = make();
    this.pops.push({ n, x, y, vx, vy, life:0, max:kind === 'question' ? 1.5 : 1.1, kind });
  }

  // ------------------------------------------------------------ drawing
  render() {
    const p = this.p, t = this.t, c = this.compact;
    const fy = c ? p.fy * .12 : p.fy, frot = c ? p.frot * .5 : p.frot;
    const fsx = p.fsx * (1 + (1 - p.fsy) * .55);
    this.fig.setAttribute('transform', `translate(${PIVOT[0]} ${PIVOT[1] + fy}) rotate(${frot}) scale(${fsx} ${p.fsy}) translate(${-PIVOT[0]} ${-PIVOT[1]})`);
    this.feat.setAttribute('transform', `translate(${p.featX + p.lookX * 4} ${p.featY + p.lookY * 3})`);
    // Eyes.
    const blink = Math.max(bump(t - this.blinkAt, 0, .17), bump(t - (this.blinkAt2 ?? -9), 0, .17));
    for (const k of ['L', 'R']) {
      const e = this.eyes[k], [cx, cy] = EYE[k], amt = Math.max(.001, e.amt), lx = p.lookX * 13, ly = p.lookY * 9;
      if (e.cur === 'open') {
        const sy = amt * p.eyeY * (1 - .95 * blink);
        e.open.setAttribute('transform', `translate(${cx + lx} ${cy + ly}) scale(${p.eyeS} ${p.eyeS * sy}) translate(${-cx} ${-cy})`);
        e.open.setAttribute('opacity', 1 - .45 * p.eyeDim);
        const tw = 1 + .14 * Math.sin(t * 2.6 + (k === 'L' ? 0 : 1.3)) * this.L;
        e.hl.setAttribute('transform', `translate(${HL[k][0] + p.lookX * 5} ${HL[k][1] + p.lookY * 4}) scale(${tw}) translate(${-HL[k][0]} ${-HL[k][1]})`);
        e.hl.setAttribute('opacity', 1 - p.eyeDim);
        e.hl2.setAttribute('opacity', clamp(p.spark) * (1 - p.eyeDim));
        e.open.style.display = ''; e.alt.style.display = 'none';
      } else {
        e.open.style.display = 'none'; e.alt.style.display = '';
        e.alt.setAttribute('d', ALT[e.cur](cx));
        e.alt.setAttribute('transform', `translate(${cx + lx * .4} ${cy}) scale(1 ${amt}) translate(${-cx} ${-cy})`);
      }
    }
    // Mouth.
    for (const k in this.mouths) this.mouths[k].style.display = k === this.mouthS.cur ? '' : 'none';
    const ma = Math.max(.001, this.mouthS.amt), breathe = this.mouthS.cur === 'sleep' ? 1 + .18 * Math.sin(t * 1.35) * this.L : 1;
    this.mouths[this.mouthS.cur].setAttribute('transform', `translate(627 762) scale(${Math.min(1, ma * 1.15) * breathe} ${ma * breathe}) translate(-627 -762)`);
    // Brows, blush.
    this.brows.forEach((g, i) => { const k = i ? 'R' : 'L', [bx, by] = BROW[k];
      g.setAttribute('transform', `translate(0 ${p['brow' + k] + p.lookY * 3}) rotate(${p['brow' + k + 'r']} ${bx} ${by})`); });
    for (const b of this.blushes) {
      const s = 1 + .12 * clamp(p.blush - 1, 0, 1);
      b.g.setAttribute('transform', `translate(${b.a.cx} ${b.a.cy}) scale(${s}) translate(${-b.a.cx} ${-b.a.cy})`);
      b.e.setAttribute('opacity', clamp(p.blush)); b.e.setAttribute('fill', p.blush > 1 ? '#f2b3a9' : '#f3c4ba');
      b.lines.setAttribute('opacity', clamp(p.shy));
    }
    // Hair accents.
    this.ahoge.setAttribute('transform', `rotate(${this.sec.a} ${AHOGE[0]} ${AHOGE[1]})`);
    this.bowTail.setAttribute('transform', `rotate(${this.sec.r} 1030 540)`);
    this.bowLoop.setAttribute('transform', `rotate(${-.7 * this.sec.r + 1.3 * Math.sin(this.t * 1.7) * this.L} 1066 528)`);
    const sx = (t - this.sheenAt) / .95;
    if (sx >= 0 && sx < 1) { this.sheenRect.setAttribute('opacity', 1); this.sheenRect.setAttribute('transform', `rotate(-18 628 600) translate(${lerp(-200, 1500, smooth(sx))} 0)`); }
    else this.sheenRect.setAttribute('opacity', 0);
    // Hands.
    const hand = (h, x, y, s) => {
      h.g.setAttribute('transform', `translate(${x} ${y}) scale(${s})`);
      h.g.style.display = c ? 'none' : '';
      h.sh.setAttribute('opacity', lerp(.28, .45, clamp(1 - (HAND.L[1] - y) / 90)) * (this.frameless ? .45 : 1));
    };
    hand(this.hands[0], p.hLx, p.hLy, p.hLs); hand(this.hands[1], p.hRx, p.hRy, p.hRs);
    // Glow and grey.
    const col = `rgb(${p.gr | 0},${p.gg | 0},${p.gb | 0})`;
    this.glowStops[0].setAttribute('stop-color', col); this.glowStops[1].setAttribute('stop-color', col); this.glowStops[2].setAttribute('stop-color', col);
    this.glowStops[0].setAttribute('stop-opacity', clamp(p.glow)); this.glowStops[1].setAttribute('stop-opacity', clamp(p.glow) * .35);
    const g = clamp(p.grey);
    if (g > .01) {
      const s = 1 - .88 * g, b = 1 - .22 * g, lr = .2126 * (1 - s), lg = .7152 * (1 - s), lb = .0722 * (1 - s);
      this.matrix.setAttribute('values', [lr + s, lg, lb, 0, 0, lr, lg + s, lb, 0, 0, lr, lg, lb + s, 0, 0, 0, 0, 0, 1, 0].map((v, i) => (i % 5 < 3 ? v * b : v).toFixed(4)).join(' '));
      if (!this.matrixOn) { this.fig.setAttribute('filter', `url(#${this.uid}f)`); this.matrixOn = true; }
    } else if (this.matrixOn) { this.fig.removeAttribute('filter'); this.matrixOn = false; }
    this.renderProps();
    this.renderFx();
  }
  renderFx() {
    const t = this.t, a = this.fxAmt, c = this.compact;
    // Waiting badge.
    const bw = a.alert;
    if (bw > .01) {
      const pos = c ? [1020, 300] : [1132, 142], sc = (c ? 1.7 : 1) * (bw < .999 ? 1 + .25 * Math.sin(bw * Math.PI) : 1) * bw;
      this.badge.setAttribute('transform', `translate(${pos[0]} ${pos[1]}) scale(${sc})`); this.badge.setAttribute('opacity', clamp(bw * 1.3));
      const ph = (t % 1.6) / 1.6; this.badgeRing.setAttribute('r', 44 + ph * 36); this.badgeRing.setAttribute('opacity', this.L ? .6 * (1 - ph) : 0);
    } else this.badge.setAttribute('opacity', 0);
    const ea = a.ellipsis;
    this.ellipsis.setAttribute('opacity', ea);
    this.ellipsis.setAttribute('transform', `translate(1070 330) scale(${.6 + .4 * ea})`);
    this.ellipsisDots.forEach((d, i) => d.setAttribute('cy', this.L ? -10 * Math.max(0, Math.sin(t * 5 - i * .8)) : 0));
    // Sleep z's.
    this.zz.forEach((z, i) => {
      const ph = this.L ? ((t * .3) + i / 3) % 1 : [.35, .62, .9][i], base = c ? [1000, 260] : [1000, 300];
      z.setAttribute('transform', `translate(${base[0] + ph * 120 + i * 8} ${base[1] - ph * 210}) scale(${(c ? 1.6 : 1) * (.65 + ph * .8)})`);
      z.setAttribute('opacity', a.zz * Math.sin(Math.PI * ph));
    });
    // Thinking bubbles.
    this.dots.forEach((d, i) => {
      const pulse = this.L ? Math.max(0, Math.sin(2 * Math.PI * (t * .9 - i * .2))) : .5;
      const show = clamp(a.dots * 3 - i * .8);
      d.n.setAttribute('opacity', show * (.55 + .4 * pulse));
      d.n.setAttribute('transform', `translate(${d.x} ${d.y}) scale(${(c ? 1.4 : 1) * (1 + .16 * pulse) * (.4 + .6 * show)}) translate(${-d.x} ${-d.y})`);
    });
  }
  fxStep(dt) {
    this.parts = this.parts.filter(q => {
      q.life += dt; if (q.life >= q.max) { q.n.remove(); return false; }
      q.vy += q.g * dt; if (q.drag) { q.vx *= 1 - q.drag * dt; q.vy *= 1 - q.drag * .4 * dt; }
      q.x += q.vx * dt; q.y += q.vy * dt; q.r += q.vr * dt;
      const fade = 1 - ramp(q.life / q.max, .6, 1), grow = Math.min(1, q.life / .12);
      q.n.setAttribute('transform', `translate(${q.x.toFixed(1)} ${q.y.toFixed(1)}) rotate(${q.r.toFixed(0)}) scale(${(q.s * grow).toFixed(3)})`);
      q.n.setAttribute('opacity', fade); return true;
    });
    this.pops = this.pops.filter(q => {
      q.life += dt; const x = q.life / q.max; if (x >= 1) { q.n.remove(); return false; }
      const pop = x < .25 ? 1 + .35 * Math.sin(x / .25 * Math.PI) * (1 - x / .25) + (x / .25 - 1) * 0 : 1;
      const s = Math.min(1, x / .14) * pop, wob = q.kind === 'question' ? 8 * Math.sin(q.life * 7) : q.kind === 'sparkle' ? q.life * 140 : 0;
      q.n.setAttribute('transform', `translate(${q.x + q.vx * q.life} ${q.y + q.vy * q.life}) rotate(${wob}) scale(${s})`);
      q.n.setAttribute('opacity', 1 - ramp(x, .7, 1)); return true;
    });
    this.onFrame?.(dt);
  }
}
Figure.live = new Set(); Figure.follow = true; Figure.pointer = null;
const io = new IntersectionObserver(es => { for (const e of es) for (const f of Figure.live) if (f.host === e.target) f.visible = e.isIntersecting; }, { rootMargin:'100px' });
let last = performance.now();
const frame = now => {
  const dt = Math.min(.05, (now - last) / 1000); last = now;
  if (!document.hidden) for (const f of Figure.live) if (f.visible && !f.still) { f.step(dt); f.fxStep(dt); }
  requestAnimationFrame(frame);
};
addEventListener('pointermove', e => { Figure.pointer = { x:e.clientX, y:e.clientY }; for (const f of Figure.live) f.lastPointer = f.t; });

