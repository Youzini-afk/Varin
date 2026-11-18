/* Varin · 设置设计稿 · 外壳、路由、搜索与交互委托 */
(() => {
  const { ic, esc } = K;
  const win = document.getElementById('win');
  const lab = document.getElementById('lab');
  window.ACTS = window.ACTS || {};
  const host = () => S.host === 'local' ? { name: 'studio-pc', sub: '本机 · 已连接', dot: 'ok' } : { name: 'home-server', sub: '远程 · 192.168.1.20', dot: 'ok' };
  const meta = slug => P[slug] || { title: slug, icon: 'info' };

  /* ── 外壳 ── */
  function shell() {
    win.innerHTML = `
      <header class="titlebar">
        <button class="back" data-act="close" data-tip="返回之前的会话（Esc）">${ic('back', 'sm')}返回</button>
        <button class="back navback" data-act="mnav" aria-label="返回设置">${ic('back', 'sm')}设置</button>
        <span class="crumb"><span class="crumb-root">设置</span><span class="crumb-root faint">/</span><b id="crumb"></b></span>
        <span class="sp"></span>
        <button class="hostpill" data-go="devices" data-tip="设置保存在这台 Varin 服务上">${'<span class="dot ok"></span>'}<span id="hostname"></span></button>
        <span class="wc"><span>—</span><span>▢</span><span>✕</span></span>
      </header>
      <div class="body">
        <nav class="nav" aria-label="设置分区">
          <div class="search">${ic('search', 'sm')}<input id="q" placeholder="搜索设置" autocomplete="off" aria-label="搜索设置"><span class="kbd">Ctrl K</span></div>
          <div class="list" id="navlist"></div>
          <div class="foot"><button data-go="devices" id="foothostbtn">${'<span class="dot ok"></span>'}<span class="grow"><span id="foothost"></span><small id="footsub"></small></span>${ic('chev', 'sm faint')}</button></div>
        </nav>
        <main class="canvas" id="canvas"></main>
      </div>`;
  }

  function renderNav() {
    const q = document.getElementById('q').value.trim();
    const el = document.getElementById('navlist');
    if (q) { el.className = 'results'; el.innerHTML = searchHTML(q); return; }
    el.className = 'list';
    el.innerHTML = DATA.nav.map(g => `<div class="gt">${esc(g.g)}</div>` + g.items.filter(s => P[s] && !(P[s].desktopOnly && S.size === 'phone')).map(s => {
      const p = meta(s); const badge = p.badge ? p.badge() : '';
      return `<button class="it" data-go="${s}" aria-current="${S.page === s ? 'page' : 'false'}">${ic(p.icon)}<span class="trunc">${esc(p.title)}</span>${badge}</button>`;
    }).join('')).join('');
    const h = host();
    document.querySelectorAll('.hostpill, #foothostbtn').forEach(b => { b.dataset.sel = h.name; });
    document.getElementById('hostname').textContent = h.name;
    document.getElementById('foothost').textContent = h.name;
    document.getElementById('footsub').textContent = h.sub;
    document.getElementById('crumb').textContent = meta(S.page).title;
  }

  /* ── 画布 ── */
  let lastScroll = 0;
  function renderPage(o = {}) {
    const canvas = document.getElementById('canvas');
    const scroller = canvas.querySelector('.cat-detail .scroll') || canvas.querySelector('.scroll');
    const keep = !o.enter && scroller ? scroller.scrollTop : 0;
    const focus = document.activeElement; const fk = focus && (focus.dataset?.in || focus.dataset?.filter || focus.dataset?.tagin); const fattr = focus?.dataset?.in ? 'in' : focus?.dataset?.filter ? 'filter' : 'tagin'; const caret = focus?.selectionStart;
    const p = meta(S.page);
    let html = p.render ? p.render() : '';
    const isCat = html.startsWith('<div class="cat"');
    if (!isCat) html = `<div class="scroll"><div class="page ${p.wide ? 'wide' : ''}">${html}</div></div>`;
    const inDetail = isCat && S.mstage[S.page] === 'detail';
    const mh = `<div class="mhead"><button class="btn ghost icon" ${inDetail ? `data-act="mback" data-v="${S.page}" aria-label="返回${esc(p.title)}"` : 'data-act="mnav" aria-label="返回设置"'}>${ic('back')}</button><span class="mt">${esc(p.title)}</span></div>`;
    canvas.innerHTML = mh + html + (p.dock ? p.dock() : '');
    if (o.enter) { canvas.classList.remove('enter'); void canvas.offsetWidth; canvas.classList.add('enter'); }
    else canvas.classList.remove('enter');
    if (o.detail) { const d = canvas.querySelector('.cat-detail .page'); if (d) d.classList.add('enter'); }
    const sc = canvas.querySelector('.cat-detail .scroll') || canvas.querySelector('.scroll');
    if (sc && keep && !o.detail) sc.scrollTop = keep;
    if (fk) { const n = canvas.querySelector(`[data-${fattr}="${fk}"]`); if (n) { n.focus(); try { n.setSelectionRange(caret, caret); } catch { /* 非文本输入 */ } } }
    layoutSegs(canvas);
    p.after && p.after(canvas);
  }
  const render = (o = {}) => { renderNav(); renderPage(o); };
  function showSettingsNav(focusSearch = false) {
    S.stage = 'nav';
    win.dataset.stage = 'nav';
    const search = document.getElementById('q');
    if (focusSearch) search.focus();
    else document.querySelector('#navlist [aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }
  /* 实时示例：只重画示例区，不打断左侧表单的滚动和焦点 */
  function refreshLive(resetOpen) {
    const p = meta(S.page); const el = document.getElementById('live');
    if (!p.preview || !el) return;
    if (resetOpen) Object.keys(S.v).filter(k => k.startsWith('pv.open.')).forEach(k => delete S.v[k]);
    el.innerHTML = p.preview(); layoutSegs(el);
  }
  window.App = { render, go, toast, flashSaved, flashItem, refreshLive };

  function go(slug, o = {}) {
    if (!P[slug]) { toast('这个页面在原型里没有展开'); return; }
    S.page = slug; S.stage = 'page'; win.dataset.stage = 'page';
    document.getElementById('q').value = '';
    render({ enter: true });
    if (o.flash) setTimeout(() => flashItem(o.flash), 60);
  }
  function flashItem(label) {
    const n = [...document.querySelectorAll('#canvas [data-item]')].find(x => x.dataset.item === label);
    if (!n) return; n.scrollIntoView({ block: 'center', behavior: 'smooth' }); n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash');
  }

  /* 分段控件的滑块 */
  function layoutSegs(root) {
    root.querySelectorAll('.seg').forEach(s => { const b = s.querySelector('[aria-pressed="true"]'); const t = s.querySelector('.thumb'); if (!b || !t) { if (t) t.style.width = '0'; return; } t.style.left = b.offsetLeft + 'px'; t.style.width = b.offsetWidth + 'px'; });
  }

  /* ── 反馈 ── */
  let savedTimer;
  function flashSaved() { const s = document.getElementById('saved'); if (!s) return; s.classList.add('on'); clearTimeout(savedTimer); savedTimer = setTimeout(() => s.classList.remove('on'), 1600); }
  let toastTimer;
  function toast(msg) { const c = document.getElementById('canvas'); c.querySelector('.toast')?.remove(); c.insertAdjacentHTML('beforeend', `<div class="toast">${esc(msg)}</div>`); clearTimeout(toastTimer); toastTimer = setTimeout(() => c.querySelector('.toast')?.remove(), 2400); }
  function setUnit(u, st) {
    S.unit[u] = st;
    const o = K.unitOpts[u] || {};
    document.querySelectorAll(`[data-unitbar="${u}"]`).forEach(n => { n.outerHTML = K.unitbar(u, o); });
    document.querySelectorAll(`[data-dock="${u}"]`).forEach(n => { n.outerHTML = K.dock(u, o); });
  }

  /* ── 下拉菜单 ── */
  let pop = null;
  function closePop() { pop?.remove(); pop = null; }
  function openPop(btn) {
    closePop();
    const k = btn.dataset.dd; const list = K.opts[k] || []; const cur = K.get(k, list._cur ?? list.find(x => !x.grp)?.v);
    pop = document.createElement('div'); pop.className = 'pop'; pop.setAttribute('role', 'listbox');
    pop.innerHTML = list.map(x => x.grp ? `<div class="grp">${esc(x.grp)}</div>` : x.sep ? '<div class="sep"></div>' : `<button class="opt" role="option" data-v="${esc(x.v)}" aria-selected="${x.v === cur}">${x.logo ? K.logo(x.logo) : x.icon ? ic(x.icon, 'sm') : ''}<span class="grow">${esc(x.l)}${x.d && !x.logo ? `<small>${esc(x.d)}</small>` : ''}</span>${x.meta ? `<small class="via">${esc(x.meta)}</small>` : ''}${ic('check', 'sm chk')}</button>`).join('');
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const above = r.top - 12, below = innerHeight - r.bottom - 12;
    pop.style.minWidth = Math.min(r.width, innerWidth - 16) + 'px';
    const openAbove = pop.offsetHeight > below && above > below;
    pop.style.maxHeight = Math.min(pop.offsetHeight, openAbove ? above : below) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = (openAbove ? r.top - pop.offsetHeight - 4 : r.bottom + 4) + 'px';
    pop.onclick = e => { const o = e.target.closest('.opt'); if (!o) return; K.set(k, o.dataset.v); closePop(); afterChange(btn, true); };
    pop.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  function afterChange(el, forceRe) {
    if (el.closest && el.closest('#live')) { refreshLive(); return; }
    if (el.dataset.unit) { setUnit(el.dataset.unit, 'dirty'); if (forceRe || el.hasAttribute('data-re')) renderPage(); return; }
    if (forceRe || el.hasAttribute('data-re')) renderPage(); else refreshLive(true);
    flashSaved();
  }

  /* ── 搜索：从各页实际渲染出的条目建立索引 ── */
  let index = null;
  function buildIndex() {
    index = [];
    const saved = { sel: { ...S.sel }, tab: { ...S.tab } };
    const tmp = document.createElement('div');
    DATA.nav.flatMap(g => g.items).filter(s => P[s]).forEach(s => {
      const p = P[s];
      index.push({ page: s, label: p.title, desc: p.desc ? p.desc.replace(/<[^>]+>/g, '') : '', kw: (p.keywords || ''), isPage: true });
      try { tmp.innerHTML = p.render(); } catch { return; }
      tmp.querySelectorAll('[data-item]').forEach(n => {
        index.push({ page: s, label: n.dataset.item, desc: n.querySelector('.d')?.textContent || '', sec: n.closest('.sec')?.querySelector('h2')?.textContent || '' });
      });
    });
    S.sel = saved.sel; S.tab = saved.tab;
  }
  let kb = 0;
  function searchHTML(q) {
    if (!index) buildIndex();
    const ql = q.toLowerCase();
    const hits = index.filter(x => (x.label + ' ' + x.desc + ' ' + (x.kw || '') + ' ' + (x.sec || '')).toLowerCase().includes(ql)).slice(0, 40);
    if (!hits.length) return `<div class="none">没有找到「${esc(q)}」。可以换个说法，例如功能名称或你想做的事。</div>`;
    const mark = s => esc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), m => `<mark>${m}</mark>`);
    const groups = {}; hits.forEach(h => { (groups[h.page] = groups[h.page] || []).push(h); });
    let i = 0; kb = Math.min(kb, hits.length - 1);
    return Object.entries(groups).map(([pg, hs]) => `<div class="rg">${esc(meta(pg).title)}</div>` + hs.map(h => `<button class="r ${i++ === kb ? 'kb' : ''}" data-go="${pg}" data-flash="${h.isPage ? '' : esc(h.label)}"><b>${mark(h.label)}</b>${(() => { const t = h.isPage ? h.desc : [h.sec, h.desc].filter(Boolean).join(' · '); return t ? `<small>${mark(t)}</small>` : ''; })()}</button>`).join('')).join('');
  }

  /* ── 委托：点击 ── */
  document.addEventListener('click', e => {
    if (pop && !e.target.closest('.pop')) { if (!e.target.closest('[data-dd]')) { closePop(); } }
    const t = e.target;
    const dd = t.closest('[data-dd]'); if (dd) { if (pop && pop.dataset.k === dd.dataset.dd) { closePop(); return; } openPop(dd); pop.dataset.k = dd.dataset.dd; return; }
    const swb = t.closest('[data-sw]'); if (swb) { const v = swb.getAttribute('aria-checked') !== 'true'; K.set(swb.dataset.sw, v); swb.setAttribute('aria-checked', v); afterChange(swb); return; }
    const sg = t.closest('[data-seg]'); if (sg) { K.set(sg.dataset.seg, sg.dataset.v); sg.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === sg)); layoutSegs(sg.parentElement.parentElement); afterChange(sg); return; }
    const cd = t.closest('[data-card]'); if (cd) { K.set(cd.dataset.card, cd.dataset.v); cd.parentElement.querySelectorAll('.ocard').forEach(b => b.setAttribute('aria-checked', b === cd)); afterChange(cd); return; }
    const tb = t.closest('[data-tab]'); if (tb) { S.tab[tb.dataset.tab] = tb.dataset.v; renderPage({ detail: true }); return; }
    const act = t.closest('[data-act]');
    const gol = t.closest('[data-go]');
    if (act && !(gol && act.contains(gol) && act !== gol) ) {
      const a = act.dataset.act;
      if (ACTS[a]) { ACTS[a](act, e); return; }
      if (a === 'close') { toast('回到之前的会话；未保存的单元会先询问'); return; }
      if (a === 'mnav') { showSettingsNav(); return; }
      if (a === 'mback') { S.mstage[act.dataset.v] = 'list'; renderPage(); return; }
      if (a === 'unit-cancel') { setUnit(act.dataset.v, null); renderPage(); return; }
      if (a === 'unit-save' || a === 'unit-verify') { const u = act.dataset.v; setUnit(u, 'busy'); setTimeout(() => { setUnit(u, 'ok'); setTimeout(() => setUnit(u, null), 1800); }, a === 'unit-verify' ? 1100 : 450); return; }
      if (a === 'tag-rm') { const arr = [...K.get(act.dataset.k, [])]; arr.splice(+act.dataset.i, 1); K.set(act.dataset.k, arr); renderPage(); flashSaved(); return; }
      if (a === 'toast') { toast(act.dataset.v); return; }
      if (a === 'theme') { setTheme(act.dataset.v); return; }
      if (a === 'size') { setSize(act.dataset.v); return; }
      if (a === 'host') { S.host = act.dataset.v; index = null; render(); drawLab(); return; }
      if (a === 'motion') { document.documentElement.dataset.motion = act.dataset.v; drawLab(); return; }
    }
    const sl = t.closest('[data-sel]');
    if (sl && !gol) { S.sel[sl.dataset.sel] = sl.dataset.v; S.mstage[sl.dataset.sel] = 'detail'; renderPage({ detail: true }); return; }
    if (gol) { if (gol.dataset.sel) { S.sel[gol.dataset.go] = gol.dataset.sel; S.mstage[gol.dataset.go] = 'detail'; } go(gol.dataset.go, { flash: gol.dataset.flash || '' }); return; }
  });

  /* ── 委托：输入 ── */
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.id === 'q') { kb = 0; renderNav(); return; }
    if (t.dataset.in && t.closest('#live')) { K.set(t.dataset.in, t.value); return; }
    if (t.type === 'range') { const f = t.dataset.fmt; const v = +t.value; const rv = t.parentElement.querySelector('.rv'); if (rv) rv.textContent = f === '%' ? Math.round(v * 100) + '%' : f === 'x' ? v.toFixed(1) + '×' : v + f; }
    if (t.dataset.in) { K.set(t.dataset.in, t.value); if (!t.dataset.unit) refreshLive(true); if (t.dataset.unit) { if (S.unit[t.dataset.unit] !== 'dirty') setUnit(t.dataset.unit, 'dirty'); } else { clearTimeout(t._s); t._s = setTimeout(flashSaved, 500); } return; }
    if (t.dataset.filter) { S.v['filter.' + t.dataset.filter] = t.value; renderPage(); }
  });
  document.addEventListener('keydown', e => {
    const t = e.target;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); showSettingsNav(true); return; }
    if (t.id === 'q') {
      const rs = [...document.querySelectorAll('#navlist .r')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); kb = Math.max(0, Math.min(rs.length - 1, kb + (e.key === 'ArrowDown' ? 1 : -1))); rs.forEach((r, i) => r.classList.toggle('kb', i === kb)); rs[kb]?.scrollIntoView({ block: 'nearest' }); return; }
      if (e.key === 'Enter') { rs[kb]?.click(); t.blur(); return; }
      if (e.key === 'Escape') { t.value = ''; renderNav(); t.blur(); return; }
    }
    if (t.dataset.tagin && e.key === 'Enter' && t.value.trim()) { const k = t.dataset.tagin; K.set(k, [...K.get(k, []), t.value.trim()]); t.value = ''; renderPage(); flashSaved(); return; }
    if (e.key === 'Escape') { if (pop) { closePop(); return; } toast('Esc：回到之前的会话'); }
    if ((e.key === 'Enter' || e.key === ' ') && t.matches('.row.link, [role="radio"][data-act]')) { e.preventDefault(); t.click(); }
  });

  /* 提示 */
  let tipEl = null;
  document.addEventListener('mouseover', e => { const n = e.target.closest('[data-tip]'); if (!n || tipEl?._n === n) return; tipEl?.remove(); tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.textContent = n.dataset.tip; tipEl._n = n; document.body.appendChild(tipEl); const r = n.getBoundingClientRect(); const w = tipEl.offsetWidth; tipEl.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px'; tipEl.style.top = (r.bottom + 6 + tipEl.offsetHeight > innerHeight ? r.top - tipEl.offsetHeight - 6 : r.bottom + 6) + 'px'; });
  document.addEventListener('mouseout', e => { if (tipEl && !e.relatedTarget?.closest?.('[data-tip]')) { tipEl.remove(); tipEl = null; } });
  document.addEventListener('scroll', e => { if (!pop?.contains(e.target)) closePop(); tipEl?.remove(); tipEl = null; }, true);
  addEventListener('resize', () => layoutSegs(document));

  /* ── 原型实验室 ── */
  function setTheme(t) { S.theme = t; document.documentElement.dataset.theme = t; drawLab(); }
  function setSize(s) { S.size = s; win.dataset.size = s; S.stage = s === 'phone' ? 'nav' : 'page'; win.dataset.stage = S.stage; index = null; render(); drawLab(); }
  function drawLab() {
    const b = (act, v, l, on) => `<button data-act="${act}" data-v="${v}" aria-pressed="${on}">${l}</button>`;
    lab.innerHTML = `<b>原型实验室</b>
      <span class="lg">${b('theme', 'light', '浅色', S.theme === 'light')}${b('theme', 'dark', '深色', S.theme === 'dark')}</span>
      <span class="lg">${b('size', 'desktop', '桌面', S.size === 'desktop')}${b('size', 'narrow', '窄窗口', S.size === 'narrow')}${b('size', 'phone', '手机', S.size === 'phone')}</span>
      <span class="lg">${b('host', 'local', '本机服务', S.host === 'local')}${b('host', 'remote', '远程服务', S.host === 'remote')}</span>
      <span class="lg">${b('motion', 'on', '动效', document.documentElement.dataset.motion !== 'off')}${b('motion', 'off', '关闭动效', document.documentElement.dataset.motion === 'off')}</span>`;
  }

  shell();
  win.dataset.stage = S.stage;
  const start = location.hash.slice(1);
  if (start && P[start]) S.page = start;
  render({ enter: true }); drawLab();
  addEventListener('hashchange', () => { const s = location.hash.slice(1); if (P[s] && s !== S.page) go(s); });
})();
