'use strict';
// Stage design draft: the team on the ledge, flights between her and them, and graded reactions to
// results. Simulated data only. Coordinates are the figure's (reference 1254px space, ledge at y 1100).

const TEAM = window.TEAM_ART;
const LEAD_NAMES = ['调研', '写作', '测试', '设计', '翻译', '审校', '数据', '部署', '检索', '整理', '评估', '规划', '前端', '后端', '文档', '运维', '安全', '运营'];
const SUB_NAMES = ['资料', '对比', '摘要', '核对', '截图', '草稿', '用例', '脚本', '图表', '校对', '清单', '样例'];
const WORD = { preparing:'准备中', thinking:'思考中', replying:'在写', tool:'用工具', waiting:'等待中', needs:'在等你', settling:'收尾中' };
const ACTIVE = ['preparing', 'thinking', 'replying', 'tool'];
// Seat widths per density, member sizes, and the inner edge of each side next to her hair.
const SLOT = { peek:280, sit:160, chip:160 }, SIZE = { peek:236, sit:140, pile:96 }, INNER = { L:30, R:1226 };
const LEDGE = 1100;

const shade = (hexColor, k = .86) => '#' + [1, 3, 5].map(i => Math.round(parseInt(hexColor.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');
const ease = u => (u < .5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);
function avatar(art, parent) {
  const g = el('g', {}, parent);
  if (art.accent) el('path', { d:art.accent.path, fill:art.accent.color }, g);
  el('path', { d:art.body, fill:art.color }, g);
  if (art.eyes) el('path', { d:art.eyes, fill:'#202326' }, g);
  if (art.eyeStroke) el('path', { d:art.eyeStroke, fill:'none', stroke:'#202326', 'stroke-width':4, 'stroke-linecap':'round' }, g);
  return g;
}
const avatarSvg = (art, size) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64">${art.accent ? `<path fill="${art.accent.color}" d="${art.accent.path}"/>` : ''}<path fill="${art.color}" d="${art.body}"/>${art.eyes ? `<path fill="#202326" d="${art.eyes}"/>` : ''}${art.eyeStroke ? `<path fill="none" stroke="#202326" stroke-width="4" stroke-linecap="round" d="${art.eyeStroke}"/>` : ''}</svg>`;

// ---------------------------------------------------------------- graded reactions
const LEVEL = ['只在成员处', '看一眼', '点头', '呈现', '完成'];
const LEVEL_FAIL = { 2:'皱眉', 3:'认真呈现' };
const BASE = { 'sub-dispatch':0, 'sub-report':0, 'lead-report':1, leave:1, gather:2, resolved:2, reply:3, complete:3 };
const EVENT_LABEL = { 'sub-dispatch':'负责人派发子 agent', 'sub-report':'子 agent 回报负责人', 'lead-report':'负责人回报', leave:'负责人离场', gather:'她收下回报', resolved:'你处理掉一件等你的事', reply:'她公开回复你', complete:'请求完成' };
const COST = [0, 0, 1, 2, 3];
// Things said to you never fade below a nod because of the budget; only urgency and typing lower them further.
const FLOOR = { reply:2, complete:2 };

class Reactions {
  constructor(stage) { this.s = stage; this.energy = 4; this.lastGlance = -9; this.recent = []; this.rows = []; this.typing = false; }
  tick(dt) { this.energy = Math.min(4, this.energy + dt / 15); }
  // A member needing you is not graded: she points at it every time, without spending energy.
  urgentEvent(m) {
    this.rows.unshift({ at:this.s.clock, label:`成员需要你 · ${m.name}`, base:null, level:'urgent', why:'紧急，不分级、不花热情值，其他反应暂停到处理掉' });
    this.render();
  }
  event(e) {
    const s = this.s, now = s.t, why = [];
    let level = BASE[e.kind];
    const name = e.member?.name;
    const label = `${EVENT_LABEL[e.kind]}${name ? ` · ${name}` : ''}${e.count > 1 ? ` · ${e.count} 份` : ''}${e.outcome === 'fail' ? ' · 失败' : ''}`;
    if (e.kind === 'complete') {
      if (e.weight === 'large' && e.outcome !== 'fail') { level = 4; why.push('请求大且全部成功 → 升到完成'); }
      else why.push(e.outcome === 'fail' ? '有失败 → 不庆祝' : '请求不大 → 停在呈现');
    }
    if (s.urgent() && e.kind !== 'resolved' && level > 0) { why.push('有事等你或出错 → 只保留 0'); level = 0; }
    if (this.typing && level > 1) { why.push('你正在打字 → 最多看一眼'); level = 1; }
    const prev = this.recent.find(r => r.kind === e.kind && now - r.at < 1.2);
    if (prev && level <= prev.level) {
      prev.count += 1; prev.at = now;
      if (name && !prev.names.includes(name)) prev.names.push(name);
      prev.row.label = `${EVENT_LABEL[e.kind]}${prev.names.length ? ` · ${prev.names.join('、')}` : ''}`;
      prev.row.why = `与上一条合并（1.2 秒内同类），共 ${prev.count} 次`; this.render(); return;
    }
    const floor = FLOOR[e.kind] ?? 0;
    while (level >= 2 && level > floor && COST[level] > this.energy) { why.push(`热情值 ${this.energy.toFixed(1)} 格不够${LEVEL[level]}（要 ${COST[level]} 格）→ 降一级`); level--; }
    if (level === floor && floor >= 2 && COST[level] > this.energy) why.push(`对你说的话最低保留${LEVEL[floor]}`);
    if (level === 1 && now - this.lastGlance < 1.5) { why.push('1.5 秒内刚看过 → 不再看'); level = 0; }
    this.energy = Math.max(0, this.energy - COST[level]);
    if (level === 1) this.lastGlance = now;
    this.perform(level, e);
    const row = { at:s.clock, label, base:BASE[e.kind], level, why:why.join('；'), fail:e.outcome === 'fail' };
    this.rows.unshift(row); this.rows.length = Math.min(this.rows.length, 60);
    this.recent = this.recent.filter(r => now - r.at < 3);
    this.recent.push({ kind:e.kind, at:now, level, count:1, row, names:name ? [name] : [] });
    this.render();
  }
  perform(level, e) {
    const s = this.s, f = s.fig, fail = e.outcome === 'fail';
    if (level === 0) return;
    if (level === 1) {
      const [x, y] = e.member ? s.catchPoint(e.member) : e.kind === 'reply' || e.kind === 'complete' ? [628, 760] : [628, 1070];
      f.lookAt(x, y, .9, .8); return;
    }
    if (level === 2) { f.play(fail ? 'concern' : e.kind === 'gather' ? 'gather' : 'ack'); return; }
    if (level === 3) { f.play(fail ? 'presentSerious' : 'present'); return; }
    f.play('cheerLite');
  }
  render() {
    const log = document.getElementById('log');
    log.innerHTML = this.rows.map(r => {
      if (r.level === 'urgent') return `<div><time>${r.at.toFixed(1)}s</time><span>${r.label}　<span class="lv urgent">指向</span></span><span class="why">${r.why}</span></div>`;
      const name = level => (r.fail && LEVEL_FAIL[level]) || LEVEL[level];
      const down = r.level !== r.base ? `<span class="lv">${r.base} ${name(r.base)}</span> → ` : '';
      return `<div><time>${r.at.toFixed(1)}s</time><span>${r.label}　${down}<span class="lv l${r.level}">${r.level} ${name(r.level)}</span></span>${r.why ? `<span class="why">${r.why}</span>` : ''}</div>`;
    }).join('') || '<div><time></time><span style="color:var(--muted)">还没有事件。播放一个剧本试试。</span></div>';
  }
}

// ---------------------------------------------------------------- stage
class Stage {
  constructor(host) {
    this.host = host;
    this.fig = new Figure(host, { size:216, frameless:true, wide:true, seed:7 });
    this.fig.onFrame = dt => this.frame(dt);
    this.fig.onResize = () => { this.dirty = true; };
    this.teamG = el('g', {}, this.fig.teamBack);
    this.ledgeG = el('g', {}, this.fig.onLedge);
    this.pileG = el('g', {}, this.fig.onLedge);
    this.inboxG = el('g', {}, this.fig.onLedge);
    this.fxG = el('g', {}, this.fig.fxFront);
    this.members = []; this.flights = []; this.inbox = []; this.timers = []; this.queue = [];
    this.t = 0; this.clock = 0; this.speed = 1; this.seq = 0; this.own = 'idle'; this.flash = null; this.uiAt = 0; this.layoutAt = 0;
    this.react = new Reactions(this);
    this.piles = { L:null, R:null };
    this.pileEls = { L:this.makePile(), R:this.makePile() };
    this.card = el('g', { opacity:0 }, this.fig.propFront);
    el('rect', { x:-110, y:-74, width:220, height:148, rx:18, fill:'#ffffff', stroke:'#d6d9e4', 'stroke-width':5 }, this.card);
    el('rect', { x:-80, y:-46, width:110, height:14, rx:7, fill:ACCENT }, this.card);
    [[-14, 160], [12, 130], [38, 150]].forEach(([y, w]) => el('rect', { x:-80, y, width:w, height:12, rx:6, fill:ACCENT_SOFT }, this.card));
    this.react.render();
  }

  // -------------------------------------------------------------- members
  leads() { return this.members.filter(m => m.kind === 'lead'); }
  subsOf(lead) { return this.members.filter(m => m.parent === lead); }
  pickArt() { const used = new Set(this.members.map(m => m.art.id)); return TEAM.find(a => !used.has(a.id)) || TEAM[this.seq % TEAM.length]; }
  addLead(name, { status = 'preparing', instant = false, side, auto = false } = {}) {
    const counts = { L:0, R:0 };
    for (const m of this.leads()) if (!m.leaving) counts[m.side]++;
    const m = { id:++this.seq, kind:'lead', name, art:this.pickArt(), side:side || (counts.R <= counts.L ? 'R' : 'L'), status, order:this.seq,
      arrived:instant, enter:instant ? 1 : 0, leave:0, leaving:false, spot:this.t + 3, auto, nextVary:this.t + 2 + Math.random() * 2,
      x:null, s:SIZE.peek, peek:1, bump:0, mode:'peek' };
    m.g = el('g', {}, this.teamG); m.av = avatar(m.art, m.g); m.sym = el('g', {}, m.g);
    m.hands = [0, 1].map(() => el('circle', { r:30, fill:shade(m.art.color) }, this.ledgeG));
    this.members.push(m); this.setStatus(m, status); this.dirty = true; this.layout();
    return m;
  }
  addSub(lead, { instant = false, status = 'thinking' } = {}) {
    const m = { id:++this.seq, kind:'sub', name:SUB_NAMES[this.seq % SUB_NAMES.length], art:this.pickArt(), parent:lead, status, order:this.seq,
      arrived:instant, enter:instant ? 1 : 0, leave:0, leaving:false, x:null, y:null, s:60 };
    m.g = el('g', {}, this.ledgeG); m.av = avatar(m.art, m.g);
    m.pip = el('circle', { r:22, fill:m.art.color, stroke:shade(m.art.color, .7), 'stroke-width':5 }, this.ledgeG);
    this.members.push(m); return m;
  }
  setStatus(m, status) {
    m.status = status;
    if (m.kind !== 'lead') return;
    m.sym.innerHTML = '';
    const g = m.sym, mark = 'fill:var(--mark,#8a90a0)';
    if (status === 'thinking') [-22, 0, 22].forEach((x, i) => el('circle', { cx:x, cy:-i * 6, r:10, style:mark }, g));
    else if (status === 'replying') { el('rect', { x:-36, y:-16, width:72, height:32, rx:16, style:'fill:var(--bubble,#fff)' }, g); m.caret = el('rect', { x:-24, y:-6, width:10, height:12, rx:3, style:mark }, g); }
    else if (status === 'tool') el('path', { d:'M0 -26 Q4 -4 26 0 Q4 4 0 26 Q-4 4 -26 0 Q-4 -4 0 -26 Z', fill:ACCENT }, g);
    else if (status === 'waiting') el('path', { d:'M-16 -24 H16 L0 0 L16 24 H-16 L0 0 Z', style:mark }, g);
    else if (status === 'preparing') { el('rect', { x:-36, y:-16, width:72, height:32, rx:16, style:'fill:var(--bubble,#fff)' }, g); [-16, 0, 16].forEach(x => el('circle', { cx:x, cy:0, r:6, style:mark }, g)); }
    else if (status === 'needs') { m.ring = el('circle', { r:30, fill:'none', stroke:'#f3b562', 'stroke-width':6 }, g); el('circle', { r:30, fill:'#f3b562' }, g);
      el('rect', { x:-5, y:-18, width:10, height:22, rx:5, fill:'#3a2a12' }, g); el('circle', { cx:0, cy:13, r:5.5, fill:'#3a2a12' }, g); }
    this.dirty = true;
  }
  rank(m) {
    const cls = m.status === 'needs' ? 0 : m.spot > this.t ? 1 : ACTIVE.includes(m.status) ? 2 : 3;
    return cls - (m.mode !== 'pile' ? .5 : 0);
  }
  layout() {
    this.dirty = false;
    const [vx, , vw] = this.fig.viewBox;
    for (const s of ['L', 'R']) {
      const dir = s === 'L' ? -1 : 1, inner = INNER[s], room = Math.abs((s === 'L' ? vx + 50 : vx + vw - 50) - inner);
      const leads = this.leads().filter(m => m.side === s && !m.leaving).sort((a, b) => a.order - b.order);
      const n = leads.length;
      let mode = 'peek', visible = leads;
      if (n * SLOT.peek > room) {
        mode = 'sit';
        if (n * SLOT.sit > room) {
          const k = Math.max(1, Math.floor((room - SLOT.chip) / SLOT.sit));
          const chosen = new Set([...leads].sort((a, b) => this.rank(a) - this.rank(b) || a.order - b.order).slice(0, k));
          visible = leads.filter(m => chosen.has(m));
        }
      }
      visible.forEach((m, i) => { m.mode = mode; m.tx = inner + dir * (i + .5) * SLOT[mode]; m.ts = SIZE[mode]; });
      const pile = leads.filter(m => !visible.includes(m)), px = inner + dir * (visible.length * SLOT[mode] + SLOT.chip / 2);
      pile.forEach((m, i) => { m.mode = 'pile'; m.tx = px + [0, -40, 40][Math.min(i, 2)]; m.ts = SIZE.pile; m.pileIndex = i; });
      this.piles[s] = pile.length ? { x:px, members:pile } : null;
    }
  }
  makePile() {
    const g = el('g', { opacity:0 }, this.pileG), chip = el('g', {}, g);
    el('rect', { x:-70, y:-36, width:140, height:72, rx:36, style:'fill:var(--chip,#fff)', stroke:'#cdd2de', 'stroke-width':3 }, chip);
    const text = el('text', { x:0, y:21, 'text-anchor':'middle', 'font-size':58, 'font-weight':700, style:'fill:var(--chip-text,#333)', 'font-family':'system-ui, sans-serif' }, chip);
    const dot = el('circle', { cx:58, cy:-30, r:16, fill:'#f3b562' }, chip);
    return { g, chip, text, dot };
  }
  bottomOf(m) { return m.mode === 'peek' ? LEDGE + .27 * m.s : LEDGE + 2; }
  catchPoint(m) {
    if (m.kind === 'sub') return [m.x ?? m.parent.x, (m.y ?? LEDGE) - 30];
    if (m.mode === 'pile' && this.piles[m.side]) return [this.piles[m.side].x, LEDGE - 60];
    return [m.x ?? m.tx, this.bottomOf(m) - m.s * .55];
  }
  herHand(side) { const p = this.fig.p; return side === 'L' ? [p.hLx, p.hLy - 80] : [p.hRx, p.hRy - 80]; }

  // -------------------------------------------------------------- per frame
  frame(dt) {
    this.t += dt; this.clock += dt * this.speed;
    for (const q of this.queue.splice(0)) { if (q.at <= this.clock) q.fn(); else this.queue.push(q); }
    for (const q of this.timers.splice(0)) { if (q.at <= this.t) q.fn(); else this.timers.push(q); }
    this.react.tick(dt);
    for (const m of this.leads()) if (m.auto && !m.leaving && ACTIVE.includes(m.status) && this.t > m.nextVary) {
      this.setStatus(m, ACTIVE[1 + Math.floor(Math.random() * 3)]); m.nextVary = this.t + 2 + Math.random() * 3;
    }
    this.resolveBody();
    if (this.dirty || this.t - this.layoutAt > .5) { this.layout(); this.layoutAt = this.t; }
    this.animateMembers(dt);
    this.animateFlights(dt);
    this.animateInbox(dt);
    this.animateCard();
    if (this.t - this.uiAt > .2) { this.uiAt = this.t; this.renderUi(); }
  }
  later(seconds, fn) { this.timers.push({ at:this.t + seconds, fn }); }
  at(seconds, fn) { this.queue.push({ at:this.clock + seconds, fn }); }
  urgent() { return this.leads().some(m => m.status === 'needs' && !m.leaving) || this.own === 'waiting'; }
  resolveBody() {
    const f = this.fig, needs = this.leads().find(m => m.status === 'needs' && !m.leaving), active = this.members.some(m => !m.leaving);
    const want = needs ? 'waiting' : this.own !== 'idle' ? this.own : this.react.typing ? 'listening' : active ? 'supervising' : 'idle';
    if (want !== f.state) f.setState(want);
    const focus = [...this.leads()].filter(m => !m.leaving && m.mode !== 'pile').sort((a, b) => b.spot - a.spot)[0];
    f.focus = focus ? (([x, y]) => ({ x, y }))(this.catchPoint(focus)) : null;
  }
  animateMembers(dt) {
    const k = clamp(dt * 7);
    for (const m of [...this.members]) {
      if (m.leaving) { m.leave = Math.min(1, m.leave + dt * 1.6); if (m.leave >= 1) { this.remove(m); continue; } }
      if (m.arrived) m.enter = Math.min(1, m.enter + dt * 3.2);
      if (m.kind === 'lead') this.drawLead(m, k, dt); else this.drawSub(m, k);
    }
    for (const s of ['L', 'R']) {
      const pile = this.piles[s], P = this.pileEls[s];
      P.g.setAttribute('opacity', pile ? 1 : 0);
      if (!pile) continue;
      P.chip.setAttribute('transform', `translate(${pile.x} ${LEDGE + 8})`);
      P.text.textContent = `+${pile.members.length}`;
      P.dot.setAttribute('opacity', pile.members.some(m => m.status === 'needs') ? 1 : 0);
    }
  }
  drawLead(m, k, dt) {
    if (m.x === null) { m.x = m.tx; m.s = m.ts; }
    m.x += (m.tx - m.x) * k; m.s += (m.ts - m.s) * k;
    m.peek += ((m.mode === 'peek' ? 1 : 0) - m.peek) * k;
    m.bump = Math.max(0, m.bump - dt * 3);
    const subCount = this.subsOf(m).filter(s => !s.leaving).length, cap = this.subCap(m, subCount);
    this.subCount(m, m.mode !== 'pile' && !m.leaving && subCount > cap, m.mode === 'peek', subCount - cap);
    const hidden = m.mode === 'pile' && m.pileIndex > 2;
    const bottom = lerp(LEDGE + 2, LEDGE + .27 * m.s, m.peek) + (1 - ease(m.enter)) * m.s * .95 + ease(m.leave) * m.s - 26 * Math.sin(Math.PI * m.bump);
    const bob = ACTIVE.includes(m.status) && m.mode !== 'pile' ? 5 * Math.sin(this.t * 2.4 + m.id) : 0;
    m.av.setAttribute('transform', `translate(${m.x - m.s / 2} ${bottom - m.s * 60 / 64 + bob}) scale(${m.s / 64})`);
    m.g.setAttribute('opacity', hidden ? 0 : 1);
    const showSym = m.mode !== 'pile' && m.enter > .8 && !m.leaving;
    m.sym.setAttribute('opacity', showSym ? 1 : 0);
    const sx = m.x + m.s * .36, sy = bottom - m.s * .9 + bob, ss = Math.max(.7, m.s / SIZE.peek);
    m.sym.setAttribute('transform', `translate(${sx} ${sy}) scale(${ss})`);
    if (m.status === 'needs' && m.ring) { const ph = (this.t % 1.4) / 1.4; m.ring.setAttribute('r', 30 + ph * 26); m.ring.setAttribute('opacity', .7 * (1 - ph)); }
    if (m.status === 'replying' && m.caret) m.caret.setAttribute('x', -24 + ((this.t * 40) % 40));
    const handOpacity = m.peek * ease(m.enter) * (1 - m.leave) * (hidden ? 0 : 1);
    m.hands.forEach((h, i) => {
      h.setAttribute('cx', m.x + (i ? 1 : -1) * m.s * .42); h.setAttribute('cy', LEDGE - 4 - 10 * Math.sin(Math.PI * m.bump));
      h.setAttribute('r', m.s * .13); h.setAttribute('opacity', handOpacity);
    });
  }
  drawSub(m, k) {
    const lead = m.parent, subs = this.subsOf(lead).filter(s => !s.leaving || s === m), i = subs.indexOf(m);
    const show = lead.mode !== 'pile' && !lead.leaving, peek = lead.mode === 'peek';
    const n = subs.filter(s => !s.leaving).length, cap = this.subCap(lead, n), shown = Math.min(n, cap), over = n > cap;
    // Peek: little heads sitting on the ledge in front of their lead. Sit: overlapping dots on the ledge
    // face, centred under the lead; with a count they shift left so dots + count stay inside one seat.
    const tx = peek ? lead.x + [-.22, .22, 0][Math.min(i, 2)] * lead.s
      : lead.x + (Math.min(i, shown - 1) - (shown - 1) / 2) * 30 - (over ? 24 : 0);
    if (m.x === null) { m.x = tx; m.y = LEDGE; }
    m.x += (tx - m.x) * k;
    const pop = ease(m.enter) * (1 - ease(m.leave)), size = lead.s * .3 * pop;
    m.y = LEDGE + 2;
    m.av.setAttribute('transform', `translate(${m.x - size / 2} ${m.y - size * 60 / 64}) scale(${Math.max(.001, size / 64)})`);
    m.g.setAttribute('opacity', show && peek && i < 3 ? 1 : 0);
    m.pip.setAttribute('cx', m.x); m.pip.setAttribute('cy', LEDGE + 20); m.pip.setAttribute('r', 19 * pop);
    m.pip.setAttribute('opacity', show && !peek && i < cap ? 1 : 0);
    m.pip.setAttribute('stroke', m.status === 'needs' ? '#f3b562' : shade(m.art.color, .7));
  }
  // Peek seats show up to 3 heads. Sit seats are 160 wide: 3 dots, or 2 dots and a count.
  subCap(lead, n) { return lead.mode === 'peek' ? 3 : n > 3 ? 2 : 3; }
  subCount(lead, show, peek, extra) {
    if (!lead.countEl && !show) return;
    if (!lead.countEl) lead.countEl = el('text', { 'text-anchor':'start', 'font-weight':700, style:'fill:var(--chip-text,#333)', 'font-family':'system-ui, sans-serif' }, this.ledgeG);
    lead.countEl.textContent = `+${extra}`;
    lead.countEl.setAttribute('font-size', peek ? 50 : 46);
    lead.countEl.setAttribute('x', peek ? lead.x + .36 * lead.s : lead.x + 14);
    lead.countEl.setAttribute('y', peek ? LEDGE - 6 : LEDGE + 35);
    lead.countEl.setAttribute('opacity', show ? 1 : 0);
  }
  remove(m) {
    m.g.remove(); m.hands?.forEach(h => h.remove()); m.pip?.remove(); m.countEl?.remove();
    this.members = this.members.filter(x => x !== m);
    if (m.parent && m.parent.countEl && this.subsOf(m.parent).length <= 3) m.parent.countEl.setAttribute('opacity', 0);
    this.dirty = true;
  }

  // -------------------------------------------------------------- flights
  fly(kind, from, to, { dur = .8, lift = 220, scale = 1, onArrive, outcome, follow = false } = {}) {
    const node = el('g', {}, this.fxG);
    if (kind === 'card') {
      el('rect', { x:-46, y:-32, width:92, height:64, rx:10, fill:ACCENT }, node);
      el('path', { d:'M-46 0 H46', stroke:'#ffffff', 'stroke-width':5, opacity:.8 }, node);
    } else if (kind === 'plane') {
      el('path', { d:'M-46 18 L50 -4 L-30 -28 L-20 -4 Z', fill:'#ffffff', stroke:ACCENT, 'stroke-width':5, 'stroke-linejoin':'round' }, node);
      el('path', { d:'M-20 -4 L50 -4', stroke:ACCENT, 'stroke-width':4 }, node);
    } else {
      el('rect', { x:-48, y:-32, width:96, height:64, rx:8, fill:'#ffffff', stroke:'#c6ccdb', 'stroke-width':4 }, node);
      el('path', { d:'M-46 -28 L0 6 L46 -28', fill:'none', stroke:'#c6ccdb', 'stroke-width':4, 'stroke-linejoin':'round' }, node);
      if (outcome) el('circle', { cx:40, cy:-26, r:14, fill:outcome === 'fail' ? '#e3a04c' : '#7cc79a' }, node);
    }
    this.flights.push({ node, kind, from, to, t:0, dur, lift, scale, onArrive, follow });
    return node;
  }
  animateFlights(dt) {
    this.flights = this.flights.filter(fl => {
      fl.t += dt;
      const u = Math.min(1, fl.t / fl.dur), e = ease(u), to = typeof fl.to === 'function' ? fl.to() : fl.to;
      const cx = (fl.from[0] + to[0]) / 2, cy = Math.min(fl.from[1], to[1]) - fl.lift;
      const x = (1 - e) ** 2 * fl.from[0] + 2 * (1 - e) * e * cx + e * e * to[0];
      const y = (1 - e) ** 2 * fl.from[1] + 2 * (1 - e) * e * cy + e * e * to[1];
      const spin = fl.kind === 'card' ? 360 * e * (to[0] > fl.from[0] ? 1 : -1) : fl.kind === 'plane' ? (to[0] > fl.from[0] ? 0 : 180) + 10 * Math.sin(u * 9) : 8 * Math.sin(u * 7);
      const s = fl.scale * (u < .15 ? .4 + 4 * u : 1);
      fl.node.setAttribute('transform', `translate(${x} ${y}) rotate(${spin}) scale(${fl.kind === 'plane' && to[0] < fl.from[0] ? s + ' ' + -s : s})`);
      if (fl.follow) this.fig.lookAt(x, y, .25, .9);
      if (u >= 1) { fl.onArrive?.(fl); if (!fl.keep) fl.node.remove(); return false; }
      return true;
    });
  }
  animateInbox(dt) {
    this.inbox.forEach((it, i) => {
      if (it.gather != null) {
        it.gather += dt;
        const u = clamp((it.gather - .35) / .6), x = lerp(it.x, 628, ease(u)), y = lerp(it.y, 1010, ease(u));
        it.node.setAttribute('transform', `translate(${x} ${y}) rotate(${it.r * (1 - u)}) scale(${.9 * (1 - .6 * u)})`);
        it.node.setAttribute('opacity', 1 - ramp(u, .6, 1));
        if (u >= 1) it.done = true;
        return;
      }
      const vi = this.inbox.length - 1 - i, tx = 628 - 30 + Math.min(vi, 2) * 22, ty = 1072 - Math.min(vi, 2) * 12;
      it.x += (tx - it.x) * clamp(dt * 8); it.y += (ty - it.y) * clamp(dt * 8);
      it.node.setAttribute('transform', `translate(${it.x} ${it.y}) rotate(${it.r}) scale(.9)`);
      it.node.setAttribute('opacity', vi > 2 ? 0 : 1);
    });
    for (const it of this.inbox.filter(i => i.done)) it.node.remove();
    this.inbox = this.inbox.filter(i => !i.done);
    if (!this.inboxBadge) {
      this.inboxBadge = el('g', { opacity:0 }, this.inboxG);
      el('circle', { r:32, fill:'#ffffff', stroke:'#c6ccdb', 'stroke-width':4 }, this.inboxBadge);
      this.inboxText = el('text', { y:17, 'text-anchor':'middle', 'font-size':46, 'font-weight':700, fill:'#3a3f4a', 'font-family':'system-ui, sans-serif' }, this.inboxBadge);
    }
    const waiting = this.inbox.filter(i => i.gather == null).length;
    this.inboxBadge.setAttribute('opacity', waiting > 3 ? 1 : 0);
    this.inboxBadge.setAttribute('transform', 'translate(700 1030)');
    this.inboxText.textContent = String(waiting);
  }
  animateCard() {
    const a = this.fig.action, def = a?.def, on = def === ACTIONS.present || def === ACTIONS.presentSerious;
    const x = on ? (this.fig.t - a.at) / def.dur : 1, op = on ? ramp(x, .12, .25) * (1 - ramp(x, .85, .97)) : 0;
    this.card.setAttribute('opacity', op);
    const p = this.fig.p;
    this.card.setAttribute('transform', `translate(${(p.hLx + p.hRx) / 2} ${(p.hLy + p.hRy) / 2 - 92}) rotate(-2)`);
  }

  // -------------------------------------------------------------- team events
  say(text, seconds = 2.6) { this.flash = { text, until:this.t + seconds }; }
  dispatch(name = this.freeName(), opts = {}) {
    const m = this.addLead(name, { status:'preparing', ...opts });
    this.fig.play(m.side === 'L' ? 'throwL' : 'throwR');
    this.say(`交给了 ${name}`);
    this.later(.42, () => this.fly('card', this.herHand(m.side), () => this.catchPoint(m), { dur:.75, lift:260, follow:true,
      onArrive:() => { m.arrived = true; m.spot = this.t + 3; this.dirty = true; } }));
    return m;
  }
  continueWith(m = this.someLead()) {
    if (!m) return;
    m.spot = this.t + 3; this.dirty = true; this.say(`又交给 ${m.name} 一件事`);
    this.fig.play(m.side === 'L' ? 'throwL' : 'throwR');
    this.later(.42, () => this.fly('plane', this.herHand(m.side), () => this.catchPoint(m), { dur:.7, lift:160, follow:true, onArrive:() => { m.bump = 1; this.setStatus(m, 'thinking'); } }));
  }
  subDispatch(lead = this.someLead(), opts = {}) {
    if (!lead) return;
    const sub = this.addSub(lead, opts);
    this.fly('card', this.catchPoint(lead), () => [sub.x ?? lead.x, LEDGE - 40], { dur:.55, lift:90, scale:.45, onArrive:() => { sub.arrived = true; } });
    this.react.event({ kind:'sub-dispatch', member:lead });
    return sub;
  }
  subReport(lead = this.leads().find(l => !l.leaving && this.subsOf(l).some(s => !s.leaving))) {
    const sub = lead && this.subsOf(lead).find(s => !s.leaving && s.arrived);
    if (!sub) return;
    sub.status = 'settling';
    this.fly('envelope', [sub.x, LEDGE - 40], () => this.catchPoint(lead), { dur:.55, lift:90, scale:.42, outcome:'ok', onArrive:() => { lead.bump = 1; } });
    this.later(.45, () => { sub.leaving = true; });
    this.react.event({ kind:'sub-report', member:lead });
  }
  report(m = this.someLead(), outcome = 'ok') {
    if (!m) return;
    m.spot = this.t + 3; this.dirty = true; this.setStatus(m, 'settling');
    this.say(outcome === 'fail' ? `${m.name} 送回了报告：没完成` : `${m.name} 送回了报告`);
    const from = this.catchPoint(m);
    this.fly('envelope', from, [628, 1066], { dur:.8, lift:240, outcome, onArrive:fl => {
      fl.keep = true; this.inboxG.appendChild(fl.node);
      this.inbox.push({ node:fl.node, outcome, x:628, y:1066, r:-8 + Math.random() * 16 });
      this.react.event({ kind:'lead-report', member:m, outcome });
    } });
  }
  gather() {
    const items = this.inbox.filter(i => i.gather == null);
    if (!items.length) return;
    for (const it of items) it.gather = 0;
    this.say(`收下了 ${items.length} 份报告`);
    this.react.event({ kind:'gather', count:items.length, outcome:items.some(i => i.outcome === 'fail') ? 'fail' : 'ok' });
  }
  needs(m = this.someLead()) {
    if (!m) return;
    this.setStatus(m, 'needs'); m.spot = this.t + 6; this.layout();
    this.react.urgentEvent(m);
    this.later(.05, () => { this.fig.play(m.side === 'L' ? 'pointL' : 'pointR'); });
  }
  resolve() {
    const m = this.leads().find(l => l.status === 'needs');
    if (!m) return;
    this.setStatus(m, 'thinking'); this.say(`${m.name} 继续工作了`);
    this.react.event({ kind:'resolved', member:m });
  }
  leave(m = this.leads().filter(l => !l.leaving).sort((a, b) => (a.status === 'settling' ? -1 : 0) - (b.status === 'settling' ? -1 : 0))[0]) {
    if (!m) return;
    m.bump = 1;
    this.later(.25, () => { m.leaving = true; for (const s of this.subsOf(m)) s.leaving = true; this.dirty = true; });
    this.react.event({ kind:'leave', member:m });
  }
  someLead() {
    const live = this.leads().filter(m => !m.leaving && m.arrived && m.status !== 'needs');
    return live.find(m => m.mode !== 'pile') || live[0];
  }
  freeName() { const used = new Set(this.leads().map(m => m.name)); return LEAD_NAMES.find(n => !used.has(n)) || `成员 ${this.seq}`; }
  reset() {
    for (const m of [...this.members]) this.remove(m);
    for (const fl of this.flights) fl.node.remove();
    for (const it of this.inbox) it.node.remove();
    this.flights = []; this.inbox = []; this.queue = []; this.timers = []; this.own = 'idle'; this.flash = null; this.clock = 0;
    this.react.rows = []; this.react.energy = 4; this.react.recent = []; this.react.render();
    this.fig.action = null; this.dirty = true;
    syncOwnButtons();
  }

  // -------------------------------------------------------------- panel text
  stateLine() {
    const needs = this.leads().find(m => m.status === 'needs' && !m.leaving);
    if (needs) return { text:`${needs.name} 在等你确认`, warn:true };
    if (this.flash && this.t < this.flash.until) return { text:this.flash.text };
    if (this.own !== 'idle') return { text:STATES[this.own].line };
    const leads = this.leads().filter(m => !m.leaving), subs = this.members.filter(m => m.kind === 'sub' && !m.leaving);
    if (leads.length) return { text:`${leads.length} 位负责人${subs.length ? `、${subs.length} 位成员` : ''}在工作` };
    return { text:this.react.typing ? '在听' : '空闲' };
  }
  renderUi() {
    const line = this.stateLine(), el2 = document.getElementById('stateLine');
    el2.classList.toggle('warn', !!line.warn); el2.querySelector('span').textContent = line.text;
    const list = document.getElementById('workList'), leads = this.leads().filter(m => !m.leaving);
    list.innerHTML = `<h3>进行中${leads.length ? ` · ${leads.length} 位负责人` : ''}</h3>` + (leads.length ? leads.map(m => {
      const subs = this.subsOf(m).filter(s => !s.leaving).length;
      return `<div class="row${m.status === 'needs' ? ' needs' : ''}">${avatarSvg(m.art, 18)}<span>${m.name}</span><span class="sub">${WORD[m.status] || ''}${subs ? ` · ${subs} 位成员` : ''}</span><span class="where">${m.mode === 'pile' ? '在成员堆里' : m.mode === 'sit' ? '并坐' : '探头'}</span></div>`;
    }).join('') : '<div class="row sub">没有进行中的工作</div>');
    document.getElementById('meter').innerHTML = [0, 1, 2, 3].map(i => `<b class="${this.react.energy >= i + 1 ? 'f' : ''}"></b>`).join('');
  }
}

// ---------------------------------------------------------------- scripts
const SCRIPTS = {
  request(s) {
    const T = [];
    const at = (t, fn) => T.push([t, fn]);
    let A, B, a1, a2, b1;
    at(0, () => { s.own = 'preparing'; s.say('收到你的消息'); s.fig.play('ack'); });
    at(1.4, () => { s.own = 'thinking'; });
    at(4.2, () => { s.own = 'tool-web'; });
    at(6.6, () => { s.own = 'tool-search'; });
    at(8.6, () => { s.own = 'tool-read'; });
    // Dispatching is itself her tool call: the reading prop goes away before she hands the card over.
    at(10.2, () => { s.own = 'idle'; });
    at(10.5, () => { A = s.dispatch('调研', { side:'R' }); });
    at(12.0, () => { B = s.dispatch('写作', { side:'L' }); });
    at(13.2, () => { s.setStatus(A, 'thinking'); });
    at(14.4, () => { a1 = s.subDispatch(A); s.setStatus(A, 'tool'); });
    at(15.2, () => { a2 = s.subDispatch(A); s.setStatus(B, 'thinking'); });
    at(16.4, () => { b1 = s.subDispatch(B); });
    at(17.6, () => { s.setStatus(B, 'replying'); s.setStatus(A, 'waiting'); });
    at(19.6, () => s.subReport(A));
    at(21.0, () => s.subReport(A));
    at(21.6, () => s.setStatus(A, 'replying'));
    at(23.4, () => s.report(A));
    at(25.0, () => s.subReport(B));
    at(26.6, () => s.report(B));
    at(28.0, () => { s.own = 'thinking'; s.gather(); });
    at(30.2, () => { s.own = 'replying'; });
    at(31.0, () => s.leave(A));
    at(31.6, () => s.leave(B));
    at(34.6, () => { s.own = 'idle'; s.say('回复了你'); s.react.event({ kind:'complete', weight:'large', outcome:'ok' }); });
    return T;
  },
  storm(s) {
    const T = [], at = (t, fn) => T.push([t, fn]);
    at(0, () => { for (const n of ['调研', '写作', '测试', '设计', '数据']) s.addLead(n, { instant:true, status:'thinking', auto:true }); s.say('5 位负责人在工作'); });
    const times = [2, 3.4, 4.1, 6, 8.5, 9.2, 11, 13.5, 17, 19.5, 22, 26];
    times.forEach((t, i) => at(t, () => { const live = s.leads().filter(m => !m.leaving); const m = live[i % live.length]; s.report(m, i === 6 ? 'fail' : 'ok'); s.later(1.2, () => s.setStatus(m, 'thinking')); }));
    [5.2, 12, 20.5, 28].forEach(t => at(t, () => { s.own = 'thinking'; s.gather(); s.later(1.6, () => { s.own = 'idle'; }); }));
    [14.5, 29.5].forEach(t => at(t, () => s.react.event({ kind:'reply', outcome:'ok' })));
    return T;
  },
  needs(s) {
    const T = [], at = (t, fn) => T.push([t, fn]);
    let A;
    at(0, () => { A = s.addLead('部署', { instant:true, status:'tool', side:'R' }); s.addLead('测试', { instant:true, status:'thinking', side:'L' }); s.addLead('文档', { instant:true, status:'replying', auto:true }); });
    at(1.6, () => s.needs(A));
    at(6.5, () => s.resolve());
    at(9, () => s.report(A));
    at(10.5, () => { s.own = 'thinking'; s.gather(); });
    at(12.5, () => { s.own = 'idle'; });
    return T;
  },
};

// ---------------------------------------------------------------- page
const stage = new Stage(document.getElementById('figHost'));
const OWN = ['idle', 'preparing', 'thinking', 'replying', 'tool-read', 'tool-search', 'tool-web', 'tool-edit', 'tool-shell', 'tool-memory', 'tool-plan', 'tool-other'];
const ownBox = document.getElementById('own');
function syncOwnButtons() { for (const b of ownBox.children) b.classList.toggle('on', b.dataset.own === stage.own); }
for (const k of OWN) {
  const b = document.createElement('button'); b.dataset.own = k; b.textContent = STATES[k].label || k;
  b.onclick = () => { stage.own = k; syncOwnButtons(); }; ownBox.appendChild(b);
}
setInterval(syncOwnButtons, 300);
document.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => {
  stage.reset();
  const name = b.dataset.run;
  if (name === 'reset') return;
  for (const [t, fn] of SCRIPTS[name](stage)) stage.at(t, fn);
}));
const TEAM_ACTIONS = {
  dispatch:() => stage.dispatch(), continue:() => stage.continueWith(), subDispatch:() => stage.subDispatch(), subReport:() => stage.subReport(),
  report:() => stage.report(), reportFail:() => stage.report(undefined, 'fail'), gather:() => stage.gather(), needs:() => stage.needs(), resolve:() => stage.resolve(), leave:() => stage.leave(),
};
document.querySelectorAll('[data-team]').forEach(b => b.addEventListener('click', () => TEAM_ACTIONS[b.dataset.team]()));
document.querySelectorAll('[data-crowd]').forEach(b => b.addEventListener('click', () => {
  stage.reset();
  const n = +b.dataset.crowd;
  for (let i = 0; i < n; i++) {
    const m = stage.addLead(LEAD_NAMES[i], { instant:true, status:ACTIVE[1 + (i % 3)], auto:true });
    const subs = n >= 16 ? 2 + (i * 5) % 7 : n >= 4 ? i % 3 : (i === 0 ? 2 : 1);
    for (let k = 0; k < subs; k++) stage.addSub(m, { instant:true });
  }
  if (n >= 8) stage.setStatus(stage.leads()[n - 2], 'waiting');
}));
const RESULTS = {
  reply:() => stage.react.event({ kind:'reply', outcome:'ok' }),
  completeSmall:() => stage.react.event({ kind:'complete', weight:'small', outcome:'ok' }),
  completeLarge:() => stage.react.event({ kind:'complete', weight:'large', outcome:'ok' }),
};
document.querySelectorAll('[data-result]').forEach(b => b.addEventListener('click', () => RESULTS[b.dataset.result]()));
document.getElementById('typing').onchange = e => { stage.react.typing = e.target.checked; };
document.getElementById('speed').onchange = e => { stage.speed = +e.target.value; };
const panel = document.getElementById('panel'), widthOut = document.getElementById('widthOut');
document.getElementById('width').oninput = e => { panel.style.width = `${e.target.value}px`; widthOut.textContent = e.target.value; };
document.getElementById('zoomBox').onchange = e => document.body.classList.toggle('zoomed', e.target.checked);
document.getElementById('dark').onchange = e => document.body.classList.toggle('dark', e.target.checked);
const params = new URLSearchParams(location.search);
if (params.get('width')) { panel.style.width = `${params.get('width')}px`; widthOut.textContent = params.get('width'); }
if (params.has('dark')) document.body.classList.add('dark');
if (params.has('zoom')) document.body.classList.add('zoomed');
if (params.get('crowd')) document.querySelector(`[data-crowd="${params.get('crowd')}"]`)?.click();
if (params.get('run')) document.querySelector(`[data-run="${params.get('run')}"]`)?.click();
if (params.get('own')) { stage.own = params.get('own'); syncOwnButtons(); }
requestAnimationFrame(t => { last = t; requestAnimationFrame(frame); });
