'use strict';
// Design draft: her own round (preparing, thinking, replying, tool props), watching the team, and the
// one-shot beats the stage uses (dispatch, point, take in reports, present, small celebration).
// Extends figure.js; nothing here is wired to the product yet.

const ACCENT = '#8fb0ea', ACCENT_SOFT = '#c9d6f5', INK = '#2b2c33', PAPER = '#fbfbfd', PAPER_EDGE = '#d6d9e4';

// Writing on the sheet: three lines, then a short pause.
const writing = t => {
  const c = t % 6.2, idx = Math.min(2, Math.floor(c / 1.6)), p = c >= 4.8 ? 1 : clamp((c - idx * 1.6) / 1.4);
  return { idx, p, pause:c >= 4.8 };
};

Object.assign(STATES.idle, { label:'空闲' });
Object.assign(STATES, {
  preparing:{ label:'准备', line:'正在准备…', blink:true, glow:.5, glowKey:'listening', fx:{ ellipsis:1 },
    enter:f => f.kick('fy', -300),
    pose:(t, f, L) => ({ fy:-12 - 2 * L * Math.sin(t * 2.2), lookX:.28, lookY:-.4, featX:2, featY:-2, browL:-9, browR:-9, eyeS:1.05, spark:.6,
      hLx:HAND.L[0] + 14, hRx:HAND.R[0] - 14 }) },
  replying:{ ...STATES.working, label:'回复', line:'正在回复你', glowKey:'listening' },
  supervising:{ label:'看着团队', line:'2 位负责人在工作', blink:true, glow:.4, glowKey:'working', follow:false,
    pose:(t, f, L) => {
      const [fx, fyy] = f.focus ? f.targetLook(f.focus) : [.55, .1];
      const sway = L * .1 * Math.sin(t * .7), nod = L * bump((t % 5.4) / 5.4, .78, .9);
      return { lookX:fx * .9 + sway, lookY:fyy * .5 + .12, featX:fx * 5, frot:fx * 2.2, fy:4 + 14 * nod, browL:-3, browR:-3,
        hLx:HAND.L[0] + 14, hRx:HAND.R[0] - 14 };
    } },
  'tool-read':{ label:'查看文件', line:'正在查看 3 个文件', blink:true, glow:.45, glowKey:'thinking', prop:'read', mouth:'flat',
    pose:(t, f, L) => ({ fy:4, lookX:L ? .32 * Math.sin(t * 5.6) : 0, lookY:.5, featY:4, eyeY:.9, browL:-2, browR:-2,
      hLx:520, hLy:1012 + 4 * Math.sin(t * 1.3), hRx:736, hRy:1012 + 4 * Math.sin(t * 1.3 + .4) }) },
  'tool-search':{ label:'检索文件', line:'正在检索文件', blink:true, glow:.45, glowKey:'thinking', prop:'search', mouth:'pout',
    pose:(t, f, L) => {
      const sweep = L ? Math.sin(t * 1.5) : 0, x = 708 + 120 * sweep;
      return { lookX:(x - 80 - 628) / 640, lookY:.55, featX:(x - 708) / 40, featY:3, browL:-6, browR:-2, eyeS:1.03,
        hRx:x, hRy:1060 - 14 * Math.abs(Math.cos(t * 1.5)) * L, hLx:HAND.L[0] - 10 };
    } },
  'tool-web':{ label:'网页', line:'正在查看网页', blink:true, glow:.45, glowKey:'listening', prop:'web', mouth:'smile',
    pose:(t, f, L) => {
      const c = (t % 2.4) / 2.4, swipe = L ? smooth(ramp(c, .1, .45)) * (1 - ramp(c, .6, .75)) : 0;
      return { lookX:.08, lookY:.42, featY:2, eyeS:1.02, hLx:520, hLy:1046, hRx:742, hRy:1030 - 70 * swipe };
    } },
  'tool-edit':{ label:'编辑文件', line:'正在编辑 workbench.md', blink:true, glow:.45, glowKey:'working', prop:'edit', mouth:'flat',
    pose:(t, f, L) => {
      const w = L ? writing(t) : { idx:1, p:.5, pause:false }, jit = L && !w.pause ? 5 * Math.sin(t * 24) : 0;
      return { lookX:(520 + w.p * 200 - 628) / 900, lookY:.78, featY:6, browL:2, browR:2, browLr:3, browRr:-3,
        hRx:575 + w.p * 200 + jit, hRy:1062 + w.idx * 24 + jit * .4 - (w.pause ? 30 : 0), hLx:470, hLy:1090 };
    } },
  'tool-shell':{ label:'运行命令', line:'正在运行命令', blink:true, glow:.45, glowKey:'working', prop:'shell', mouth:'flat',
    pose:(t, f, L) => {
      const c = t % 3.2, tap = L ? 20 * (bump(c, 0, .18) + bump(c, .26, .44)) : 0;
      return { lookX:-.04, lookY:.5, featY:3, eyeY:.92, browL:-2, browR:-2, hLx:430, hLy:HAND.L[1] - tap, hRx:826, hRy:HAND.R[1] };
    } },
  'tool-memory':{ label:'记忆', line:'正在翻记忆', blink:true, glow:.45, glowKey:'thinking', prop:'memory', mouth:'pout',
    pose:(t, f, L) => ({ frot:-2, lookX:.42, lookY:-.55, featX:4, featY:-3, browL:-6, browR:-11, browRr:4,
      hRx:908, hRy:584 + 8 * L * Math.sin(t * 2.4), hLx:HAND.L[0] }) },
  'tool-plan':{ label:'计划', line:'正在更新计划', blink:true, glow:.45, glowKey:'listening', prop:'plan', mouth:'smile',
    pose:(t, f, L) => ({ lookX:.3, lookY:.32, featX:3, browL:-4, browR:-4, hRx:806, hRy:1010 + 4 * L * Math.sin(t * 1.6), hLx:HAND.L[0] + 10 }) },
  'tool-other':{ label:'其他工具', line:'正在使用 mcp · figma', blink:true, glow:.45, glowKey:'working', prop:'other', mouth:'flat',
    pose:(t, f, L) => ({ lookX:.18, lookY:.6, featY:4, browL:-2, browR:-2,
      hRx:792 + 20 * Math.cos(t * 3) * L, hRy:1066 + 20 * Math.sin(t * 3) * L, hLx:HAND.L[0] - 6 }) },
});

const side = (s, v) => (s === 'L' ? -v : v);
Object.assign(ACTIONS, {
  // Dispatch: the hand on the target's side lifts a card and flicks it out (the stage flies the card).
  throwL:{ keep:true, label:'派发 ←', dur:1, pose:(x, t) => throwPose('L', t) },
  throwR:{ keep:true, label:'派发 →', dur:1, pose:(x, t) => throwPose('R', t) },
  pointL:{ keep:true, label:'指向 ←', dur:1.9, pose:(x, t) => pointPose('L', t) },
  pointR:{ keep:true, label:'指向 →', dur:1.9, pose:(x, t) => pointPose('R', t) },
  // Takes in the reports on the ledge: both hands sweep them in, a look, a small nod.
  gather:{ keep:true, label:'收下回报', dur:1.5, pose:(x, t) => {
    const a = smooth(ramp(t, 0, .35)) * (1 - smooth(ramp(t, 1.05, 1.45)));
    return { set:{ hLx:lerp(HAND.L[0], 588, a), hRx:lerp(HAND.R[0], 668, a), hLy:1084, hRy:1084, lookY:.82, lookX:0, featY:6, browL:-2, browR:-2 },
      add:{ fy:14 * a + 16 * bump(t, .85, 1.2) }, mouth:'smile' };
  } },
  ack:{ keep:true, label:'点头（收到）', dur:.95, pose:x => ({ add:{ fy:18 * bump(x, .08, .6), featY:6 * bump(x, .08, .6) }, set:{ blush:1.15 }, mouth:'smile' }) },
  present:{ keep:true, label:'呈现', dur:1.9, start:f => f.later(.3, () => f.blinkNow(false)), pose:(x, t) => {
    const up = smooth(ramp(t, 0, .3));
    return { set:{ hLx:lerp(HAND.L[0], 560, up), hLy:lerp(HAND.L[1], 968, up), hRx:lerp(HAND.R[0], 696, up), hRy:lerp(HAND.R[1], 968, up),
      lookX:0, lookY:.04, fy:-10, blush:1.2, browL:-6, browR:-6 }, eyes:t > .4 && t < 1 ? 'happy' : 'open', mouth:'smile' };
  } },
  presentSerious:{ keep:true, label:'呈现（有问题）', dur:1.9, pose:(x, t) => {
    const up = smooth(ramp(t, 0, .3));
    return { set:{ hLx:lerp(HAND.L[0], 560, up), hLy:lerp(HAND.L[1], 968, up), hRx:lerp(HAND.R[0], 696, up), hRy:lerp(HAND.R[1], 968, up),
      lookX:0, lookY:.04, browL:4, browR:4, browLr:5, browRr:-5 }, mouth:'flat' };
  } },
  concern:{ keep:true, label:'在意', dur:1.4, pose:(x, t) => ({ set:{ browL:6, browR:6, browLr:8, browRr:-8, lookY:.3 },
    add:{ frot:2 * Math.sin(t * 9) * (1 - ramp(t, .3, 1.1)) }, mouth:'flat' }) },
  cheerLite:{ keep:true, label:'完成（收敛）', dur:1.7, start:f => { f.kick('fy', -420); f.later(.12, () => f.burst(8)); f.sheen(); },
    pose:() => ({ set:{ hLx:392, hLy:936, hRx:864, hRy:936, blush:1.3, browL:-8, browR:-8 }, eyes:'happy', mouth:'grin' }) },
});
function throwPose(s, t) {
  const up = bump(t, 0, .62), fling = ramp(t, .42, .6) * (1 - ramp(t, .7, 1)), h = s === 'L' ? HAND.L : HAND.R;
  const k = s === 'L' ? 'hL' : 'hR';
  return { set:{ [k + 'x']:h[0] + side(s, 120 * up + 160 * fling), [k + 'y']:h[1] - 240 * up - 50 * fling,
    frot:side(s, 2.2), lookX:side(s, .75), featX:side(s, 5), browL:-7, browR:-7 }, mouth:'open' };
}
function pointPose(s, t) {
  const up = smooth(ramp(t, 0, .3)) * (1 - smooth(ramp(t, 1.45, 1.85))), toYou = t > 1.05;
  const h = s === 'L' ? HAND.L : HAND.R, k = s === 'L' ? 'hL' : 'hR';
  return { set:{ [k + 'x']:h[0] + side(s, 200 * up), [k + 'y']:h[1] - 200 * up,
    lookX:toYou ? 0 : side(s, .85), lookY:toYou ? -.02 : .1, frot:toYou ? 0 : side(s, 2.4), featX:toYou ? 0 : side(s, 6), browL:-9, browR:-9 },
    mouth:'open' };
}

// ---------------------------------------------------------------- props
Figure.prototype.buildProps = function buildProps() {
  const back = this.propBack, front = this.propFront, P = this.propEls = {};
  const grp = parent => el('g', { opacity:0 }, parent);
  // Reading: a sheet held in both hands, a highlight moving down line by line.
  P.read = grp(back);
  P.readSheet = el('g', {}, P.read);
  el('rect', { x:-150, y:-112, width:300, height:206, rx:16, fill:PAPER, stroke:PAPER_EDGE, 'stroke-width':4 }, P.readSheet);
  P.readHi = el('rect', { x:-128, y:-80, width:256, height:24, rx:9, fill:ACCENT, opacity:.25 }, P.readSheet);
  [[-70, 230], [-44, 200], [-18, 236], [8, 170], [34, 226], [60, 140]].forEach(([y, w]) => el('rect', { x:-118, y, width:w, height:11, rx:5.5, fill:ACCENT_SOFT }, P.readSheet));
  // Searching: a magnifier swept along the ledge, a ring when something is found.
  P.search = grp(front);
  P.searchHandle = el('line', { stroke:INK, 'stroke-width':24, 'stroke-linecap':'round' }, P.search);
  P.searchLens = el('circle', { r:64, fill:ACCENT, 'fill-opacity':.2, stroke:INK, 'stroke-width':15 }, P.search);
  P.searchGlint = el('path', { d:'M-34 -20 A40 40 0 0 1 -12 -40', fill:'none', stroke:'#ffffff', 'stroke-width':9, 'stroke-linecap':'round' }, P.search);
  P.searchPing = el('circle', { r:64, fill:'none', stroke:ACCENT, 'stroke-width':6 }, P.search);
  // Web: a small browser window in front of her, the page scrolling.
  P.web = grp(back);
  const win = el('g', { transform:'translate(628 968)' }, P.web);
  const clipId = `${this.uid}webclip`, cp = el('clipPath', { id:clipId }, this.svg.querySelector('defs'));
  el('rect', { x:-176, y:-72, width:352, height:174, rx:4 }, cp);
  el('rect', { x:-182, y:-118, width:364, height:226, rx:24, fill:'#ffffff', stroke:PAPER_EDGE, 'stroke-width':4 }, win);
  el('path', { d:'M-182 -78 V-94 Q-182 -118 -158 -118 H158 Q182 -118 182 -94 V-78 Z', fill:'#eef1f8' }, win);
  ['#f2a3a3', '#f3c690', '#9fd3a8'].forEach((c, i) => el('circle', { cx:-152 + i * 22, cy:-98, r:7, fill:c }, win));
  el('rect', { x:-80, y:-107, width:220, height:18, rx:9, fill:'#dfe4f0' }, win);
  P.webPage = el('g', {}, el('g', { 'clip-path':`url(#${clipId})` }, win));
  for (let k = 0; k < 3; k++) {
    const y = k * 210;
    el('rect', { x:-156, y:-60 + y, width:130, height:84, rx:10, fill:ACCENT_SOFT }, P.webPage);
    [[-60, 150], [-34, 120], [-8, 140]].forEach(([dy, w]) => el('rect', { x:-12, y:dy + y, width:w, height:12, rx:6, fill:'#d9dfee' }, P.webPage));
    [[44, 300], [70, 250], [96, 280], [122, 200]].forEach(([dy, w]) => el('rect', { x:-156, y:dy + y, width:w, height:12, rx:6, fill:'#e3e7f2' }, P.webPage));
  }
  // Editing: a sheet standing on the ledge, lines written one by one; a pen in her hand.
  P.edit = grp(back);
  el('rect', { x:500, y:996, width:270, height:110, rx:12, fill:PAPER, stroke:PAPER_EDGE, 'stroke-width':4, transform:'rotate(-2 635 1050)' }, P.edit);
  P.editLines = [0, 1, 2].map(i => el('rect', { x:520, y:1016 + i * 24, width:0, height:10, rx:5, fill:ACCENT, opacity:.7, transform:'rotate(-2 635 1050)' }, P.edit));
  P.pen = grp(front);
  P.penBody = el('line', { stroke:INK, 'stroke-width':15, 'stroke-linecap':'round' }, P.pen);
  P.penTip = el('circle', { r:8, fill:ACCENT }, P.pen);
  // Shell: a small terminal standing on the ledge, output scrolling after the keys.
  P.shell = grp(back);
  el('rect', { x:516, y:924, width:224, height:182, rx:20, fill:'#23262e' }, P.shell);
  ['#f2a3a3', '#f3c690', '#9fd3a8'].forEach((c, i) => el('circle', { cx:540 + i * 18, cy:946, r:6, fill:c }, P.shell));
  const tclip = `${this.uid}termclip`, tc = el('clipPath', { id:tclip }, this.svg.querySelector('defs'));
  el('rect', { x:526, y:962, width:204, height:134 }, tc);
  P.shellOut = el('g', {}, el('g', { 'clip-path':`url(#${tclip})` }, P.shell));
  P.shellRows = Array.from({ length:12 }, (_, i) => {
    const row = el('g', {}, P.shellOut);
    el('rect', { x:536, y:0, width:12, height:10, rx:3, fill:i % 4 === 0 ? '#7ee0a8' : '#59606e' }, row);
    el('rect', { x:556, y:0, width:60 + ((i * 47) % 110), height:10, rx:5, fill:i % 4 === 0 ? '#e7eaf2' : '#9aa6bd' }, row);
    return row;
  });
  P.shellCursor = el('rect', { x:536, width:14, height:16, fill:'#7ee0a8' }, P.shell);
  // Memory: a note flies into her temple.
  P.memory = grp(front);
  P.note = el('g', {}, P.memory);
  el('path', { d:'M-38 -38 H30 L38 -30 V38 H-38 Z', fill:'#f3dc8a' }, P.note);
  el('path', { d:'M30 -38 V-30 H38 Z', fill:'#d9bd62' }, P.note);
  el('rect', { x:-24, y:-14, width:44, height:8, rx:4, fill:'#c9a94e' }, P.note);
  el('rect', { x:-24, y:4, width:30, height:8, rx:4, fill:'#c9a94e' }, P.note);
  P.memRing = el('circle', { cx:868, cy:560, r:30, fill:'none', stroke:ACCENT, 'stroke-width':6 }, P.memory);
  // Plan: a small checklist card, items ticked in turn.
  P.plan = grp(front);
  P.planCard = el('g', {}, P.plan);
  el('rect', { x:-78, y:-196, width:156, height:190, rx:16, fill:PAPER, stroke:PAPER_EDGE, 'stroke-width':4 }, P.planCard);
  P.planTicks = [0, 1, 2].map(i => {
    el('rect', { x:-56, y:-170 + i * 54, width:26, height:26, rx:7, fill:'none', stroke:ACCENT, 'stroke-width':5 }, P.planCard);
    el('rect', { x:-18, y:-163 + i * 54, width:70 - i * 12, height:11, rx:5.5, fill:ACCENT_SOFT }, P.planCard);
    return el('path', { d:`M-51 ${-158 + i * 54} l7 8 l13 -15`, fill:'none', stroke:ACCENT, 'stroke-width':6, 'stroke-linecap':'round', 'stroke-linejoin':'round' }, P.planCard);
  });
  // Other tools: a small gear on the ledge that she turns.
  P.other = grp(back);
  P.gear = el('g', {}, P.other);
  const teeth = Array.from({ length:8 }, (_, i) => { const a = i * Math.PI / 4; return `M${Math.cos(a) * 40} ${Math.sin(a) * 40} L${Math.cos(a) * 58} ${Math.sin(a) * 58}`; }).join(' ');
  // White with an outline like the other props, so it doesn't sink into the knit, which shares the accent.
  el('path', { d:teeth, stroke:'#c6ccdb', 'stroke-width':32, 'stroke-linecap':'round' }, P.gear);
  el('circle', { r:49, fill:'#c6ccdb' }, P.gear);
  el('path', { d:teeth, stroke:'#ffffff', 'stroke-width':22, 'stroke-linecap':'round' }, P.gear);
  el('circle', { r:44, fill:'#ffffff' }, P.gear);
  el('circle', { r:18, fill:ACCENT }, P.gear);
  this.propAmt = { read:0, search:0, web:0, edit:0, shell:0, memory:0, plan:0, other:0 };
  this.propClock = this.t;
};

Figure.prototype.stepProps = function stepProps(h) {
  for (const k in this.propAmt) { const want = this.prop === k ? 1 : 0; this.propAmt[k] += (want - this.propAmt[k]) * clamp(h * (want ? 7 : 10)); }
};

Figure.prototype.renderProps = function renderProps() {
  const P = this.propEls, p = this.p, t = this.t, L = this.L;
  if (this.still) for (const k in this.propAmt) this.propAmt[k] = this.prop === k ? 1 : 0;
  const a = this.propAmt, show = (node, v) => { node.setAttribute('opacity', v.toFixed(3)); node.style.display = v < .01 ? 'none' : ''; };
  const lt = t - this.propAt;
  show(P.read, a.read);
  if (a.read > .01) {
    const flip = (lt % 4.6) / 4.6, sx = L && flip > .9 ? Math.abs(Math.cos((flip - .9) / .1 * Math.PI)) : 1;
    const cx = (p.hLx + p.hRx) / 2, cy = (p.hLy + p.hRy) / 2 - 64;
    P.readSheet.setAttribute('transform', `translate(${cx} ${cy}) rotate(-3) scale(${Math.max(.08, sx)} ${a.read})`);
    P.readHi.setAttribute('y', -80 + (L ? (lt * .55) % 1 : .4) * 150);
  }
  show(P.search, a.search);
  if (a.search > .01) {
    const lx = p.hRx - 82, ly = p.hRy - 92;
    P.searchHandle.setAttribute('x1', p.hRx - 26); P.searchHandle.setAttribute('y1', p.hRy - 30);
    P.searchHandle.setAttribute('x2', lx + 40); P.searchHandle.setAttribute('y2', ly + 44);
    P.searchLens.setAttribute('cx', lx); P.searchLens.setAttribute('cy', ly);
    P.searchGlint.setAttribute('transform', `translate(${lx} ${ly})`);
    const ping = L ? (lt % 2.3) / 2.3 : 1;
    P.searchPing.setAttribute('cx', lx); P.searchPing.setAttribute('cy', ly);
    P.searchPing.setAttribute('r', 64 + ping * 60); P.searchPing.setAttribute('opacity', ping < 1 ? .6 * (1 - ping) : 0);
  }
  show(P.web, a.web);
  if (a.web > .01) {
    P.web.setAttribute('transform', `translate(0 ${(1 - a.web) * 40})`);
    const c = (lt % 2.4) / 2.4, scroll = Math.floor(lt / 2.4) * 70 + 70 * smooth(ramp(c, .15, .5));
    P.webPage.setAttribute('transform', `translate(0 ${-(L ? scroll % 210 : 30)})`);
  }
  show(P.edit, a.edit); show(P.pen, a.edit);
  if (a.edit > .01) {
    const w = L ? writing(lt) : { idx:1, p:.5 };
    P.editLines.forEach((line, i) => line.setAttribute('width', (i < w.idx ? 1 : i === w.idx ? w.p : 0) * (200 - i * 30)));
    const tx = p.hRx - 55, ty = p.hRy - 42;
    P.penBody.setAttribute('x1', tx); P.penBody.setAttribute('y1', ty); P.penBody.setAttribute('x2', tx + 56); P.penBody.setAttribute('y2', ty - 118);
    P.penTip.setAttribute('cx', tx); P.penTip.setAttribute('cy', ty);
  }
  show(P.shell, a.shell);
  if (a.shell > .01) {
    const c = lt % 3.2, rows = L ? Math.floor(lt / 3.2) * 4 + Math.min(4, Math.max(0, Math.floor((c - .5) / .35) + 1)) : 5;
    P.shellRows.forEach((row, i) => { const k = i - Math.max(0, rows - 7); row.setAttribute('transform', `translate(0 ${970 + k * 18})`); row.setAttribute('opacity', i < rows && k >= 0 ? 1 : 0); });
    P.shellCursor.setAttribute('y', 968 + Math.min(rows, 7) * 18); P.shellCursor.setAttribute('opacity', Math.sin(t * 8) > 0 ? 1 : .2);
  }
  show(P.memory, a.memory);
  if (a.memory > .01) {
    const c = L ? (lt % 2.6) / 2.6 : .5, u = smooth(ramp(c, 0, .7)), ax = 1270, ay = 250, bx = 872, by = 556;
    const x = (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * 1120 + u * u * bx, y = (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * 300 + u * u * by;
    P.note.setAttribute('transform', `translate(${x} ${y}) rotate(${-20 + 30 * u}) scale(${1 - .65 * u})`);
    P.note.setAttribute('opacity', c < .75 ? 1 : 1 - ramp(c, .75, .9));
    const ring = ramp(c, .7, 1);
    P.memRing.setAttribute('r', 30 + ring * 50); P.memRing.setAttribute('opacity', ring > 0 ? .7 * (1 - ring) : 0);
  }
  show(P.plan, a.plan);
  if (a.plan > .01) {
    P.planCard.setAttribute('transform', `translate(${p.hRx - 6} ${p.hRy - 8}) rotate(6)`);
    const done = L ? Math.floor(lt / 1.4) % 4 : 2;
    P.planTicks.forEach((tick, i) => { const v = i < done ? 1 : 0; tick.setAttribute('opacity', v); tick.setAttribute('stroke-dasharray', '40'); tick.setAttribute('stroke-dashoffset', i === done - 1 ? 40 * (1 - smooth(clamp((lt % 1.4) / .4))) : 0); });
  }
  show(P.other, a.other);
  if (a.other > .01) P.gear.setAttribute('transform', `translate(640 1022) rotate(${(L ? lt * 60 : 20)}) scale(1.25)`);
};
