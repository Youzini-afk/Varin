/* Varin · 总助手设计稿 · 手机顶部状态胶囊
 * 胶囊是常驻节点：内容更新时测量新尺寸，再从旧尺寸形变过去，不重建、不跳动。
 */
(function () {
  'use strict';
  const VC = window.VC, D = VC.data, S = VC.state, ic = VC.icon, esc = VC.esc, $ = VC.$;
  let el = null, timer = null;
  S.island = 'compact'; S.islandEvent = null;

  // 只呈现能确认的事实：谁、哪项工作、现在怎样
  const EVENTS = {
    result: { who: 'researcher', t1: 'Researcher 送回了结果', t2: '竞品价格调研 · Varin 正在读', act: '查看', go: 'w3' },
    need: { who: 'writer', t1: 'Writer 想问你一件事', t2: '整理汇报材料 · 汇报按什么组织？', act: '去回答', warn: true, go: 'w2' },
    art: { who: 'builder', t1: '发布页面有了新成果', t2: '移动端预览 v4 · Builder', act: '打开', go: 'w1' },
    received: { who: null, t1: 'Varin 已接收你的补充', t2: '', act: null },
  };
  const compact = () => {
    if (S.busy) {
      const t = S.busy === 'reading' ? '读取回报' : S.busy === 'waiting' ? '在等 Reviewer' : S.now === 'woke' ? '读取你的消息' : '思考中';
      return { t1: t, end: S.busy === 'waiting' ? ic('clock', 'sm') : '<span class="spin"></span>', busy: true };
    }
    const n = VC.needs().length;
    if (n) return { t1: `${n} 件事等你`, end: '<span class="dot warn"></span>' };
    return { t1: '发布季准备', end: '<span class="dot live" title="有工作在进行"></span>' };
  };
  const openCard = () => {
    const line = VC.botLine();
    const needs = VC.needs(), running = D.works.filter((w) => w.session === 's1' && w.state.kind === 'run').slice(0, 2);
    const result = D.works.filter((w) => w.session === 's1' && w.state.kind === 'result');
    const rows = [
      ...needs.map((w) => `<div class="is-row" data-act="is-go" data-id="${w.id}">${ic('alert', 'sm')}<span class="trunc"><b>${esc(w.name)}</b> · ${esc(w.state.text)}</span><span class="go">去处理 ›</span></div>`),
      ...result.map((w) => `<div class="is-row" data-act="is-go" data-id="${w.id}"><span class="dot info"></span><span class="trunc"><b>${esc(w.name)}</b> · ${esc(w.state.text)}</span></div>`),
      ...running.map((w) => `<div class="is-row" data-act="is-go" data-id="${w.id}"><span class="spin"></span><span class="trunc"><b>${esc(w.name)}</b> · ${esc(w.state.text)}</span></div>`),
    ];
    return `<span class="is-head" data-head="varin"></span><span class="is-body"><span class="is-t1">Varin · 发布季准备</span><span class="is-t2">${esc(line.text)}</span></span>
      <div class="is-list">${rows.join('')}</div>
      <div class="is-conn" data-act="is-conn"><span class="dot ok"></span><span>家中主机 · 2 台设备可用</span><span>连接 ›</span></div>
      <div class="is-foot"><button class="is-act" data-act="island-panel">打开 Varin</button><button class="is-act ghost" data-act="island-close">收起</button></div>`;
  };
  const content = () => {
    if (S.island === 'open') return { html: openCard(), head: 40 };
    if (S.island === 'event' && S.islandEvent) {
      const e = S.islandEvent;
      return { html: `<span class="is-head"${e.who ? '' : ' data-head="varin"'}>${e.who ? VC.av(e.who, 40) : ''}</span><span class="is-body"><span class="is-t1">${esc(e.t1)}</span>${e.t2 ? `<span class="is-t2">${esc(e.t2)}</span>` : ''}</span>
        <span class="is-end">${e.act ? `<button class="is-act${e.warn ? ' warn' : ''}" data-act="is-go" data-id="${e.go}">${esc(e.act)}</button>` : ic('check', 'sm')}</span>`, head: 40 };
    }
    const c = compact();
    return { html: `<span class="is-head" data-head="varin"></span><span class="is-body"><span class="is-t1">${esc(c.t1)}</span></span><span class="is-end">${c.end}</span>`, head: 24, busy: c.busy };
  };

  // FLIP 形变：记下旧尺寸 → 换内容并测量 → 从旧尺寸过渡到新尺寸
  // 测量时先关掉过渡，否则读到的是过渡起点；横幅和概览占满标题栏中间，平时按内容收紧
  const morph = (apply) => {
    const a = el.isConnected ? el.getBoundingClientRect() : null;
    el.style.transition = 'none';
    apply();
    const full = S.island !== 'compact' && el.parentElement ? `${el.parentElement.clientWidth}px` : 'auto';
    el.style.width = full; el.style.height = S.island === 'open' ? 'auto' : '';
    const b = el.getBoundingClientRect();
    if (a && a.width && document.documentElement.dataset.motion !== 'off') {
      el.style.width = `${a.width}px`; el.style.height = `${a.height}px`;
      void el.offsetWidth;
    }
    el.style.transition = '';
    // 收紧时向上取整再留 1px，避免小数宽度让文字被截成省略号
    el.style.width = `${S.island === 'compact' ? Math.ceil(b.width) + 1 : b.width}px`; el.style.height = `${b.height}px`;
  };
  const key = () => JSON.stringify([S.island, S.islandEvent?.t1, S.busy, S.now, VC.needs().length]);
  let last = null;
  VC.updateIsland = (force) => {
    if (!el || (!force && last === key())) return;
    last = key();
    const c = content();
    morph(() => {
      el.dataset.mode = S.island; el.dataset.busy = String(Boolean(c.busy));
      el.dataset.tone = (S.island === 'compact' && !S.busy && VC.needs().length) || (S.island === 'event' && S.islandEvent?.warn) ? 'warn' : '';
      el.innerHTML = c.html;
      const h = el.querySelector('[data-head="varin"]'); if (h) VC.figHead(h, c.head);
    });
    const scrim = $('#islandScrim');
    if (S.island === 'open' && !scrim) { const s = document.createElement('div'); s.className = 'island-scrim'; s.id = 'islandScrim'; s.dataset.act = 'island-close'; $('#frame').appendChild(s); }
    if (S.island !== 'open' && scrim) scrim.remove();
  };
  VC.mountIsland = (slot) => {
    if (!el) { el = document.createElement('div'); el.className = 'island'; el.setAttribute('role', 'button'); el.tabIndex = 0; el.dataset.act = 'island'; el.setAttribute('aria-label', 'Varin 状态'); }
    slot.appendChild(el);
    VC.updateIsland(true);
  };
  VC.islandEvent = (kind, text) => {
    if (S.size !== 'mobile') return;
    S.islandEvent = { ...EVENTS[kind], ...(text ? { t2: text } : {}) }; S.island = 'event'; VC.updateIsland();
    clearTimeout(timer);
    timer = setTimeout(() => { if (S.island === 'event') { S.island = 'compact'; VC.updateIsland(); } }, 3600);
  };

  VC.on('island', () => { clearTimeout(timer); S.island = S.island === 'open' ? 'compact' : 'open'; VC.updateIsland(); });
  VC.on('island-close', () => { S.island = 'compact'; VC.updateIsland(); });
  VC.on('island-panel', () => { S.island = 'compact'; S.drawer = true; S.active = null; VC.render(); });
  VC.on('is-go', (el2, e) => { e.stopPropagation(); S.island = 'compact'; VC.openView({ kind: 'work', id: el2.dataset.id }); });
  VC.on('is-demo', (b) => VC.islandEvent(b.dataset.v));
})();
