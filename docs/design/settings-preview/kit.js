/* Varin · 设置设计稿 · 渲染工具
 * 页面用这些函数声明结构，返回 HTML 字符串；交互由 app.js 统一委托处理。
 * 状态都在 S 里，只服务于本原型。
 */
window.S = {
  v: {}, page: 'general', sel: {}, tab: {}, unit: {}, theme: 'light', size: 'desktop', host: 'local', stage: 'page', mstage: {},
};
window.K = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ic = (n, c = '') => `<svg class="ic ${c}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
  const opts = {};
  const get = (k, d) => (k in S.v ? S.v[k] : d);
  const set = (k, v) => { S.v[k] = v; };
  const attrs = o => Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const norm = o => (typeof o === 'string' ? { v: o, l: o } : o);

  /* ── 控件 ── */
  const sw = (k, d = false, o = {}) => `<button class="sw" role="switch" aria-checked="${get(k, d)}" data-sw="${k}"${o.re ? ' data-re' : ''}${o.unit ? ` data-unit="${o.unit}"` : ''}${o.off ? ' disabled' : ''} aria-label="${esc(o.label || k)}"></button>`;
  const dd = (k, list, d, o = {}) => {
    opts[k] = list.map(norm);
    const cur = get(k, d ?? opts[k].find(x => !x.grp)?.v);
    opts[k]._cur = cur;
    const item = opts[k].find(x => x.v === cur) || { l: cur };
    const lead = item.logo ? logo(item.logo) : item.icon ? ic(item.icon, 'sm') : '';
    const description = attrs({
      'aria-label': o.label && `${o.label} · ${item.l}`,
      'data-tip': o.label,
      title: item.meta && `${item.l} · ${item.meta}`,
    });
    return `<button class="dd ${o.w || 'w'} ${o.plain ? 'plain' : ''}" data-dd="${k}"${o.re ? ' data-re' : ''}${o.unit ? ` data-unit="${o.unit}"` : ''} aria-haspopup="listbox"${description}>${lead}<span class="lbl">${esc(o.show ? o.show(item) : item.short || item.l)}</span>${item.meta ? `<span class="via">${esc(item.meta)}</span>` : ''}${ic('updown', 'xs chev')}</button>`;
  };
  const seg = (k, list, d, o = {}) => {
    const cur = get(k, d ?? norm(list[0]).v);
    return `<div class="seg" role="group"${o.label ? ` aria-label="${esc(o.label)}"` : ''}>${list.map(norm).map(x => `<button data-seg="${k}" data-v="${esc(x.v)}" aria-pressed="${x.v === cur}"${o.re ? ' data-re' : ''}>${x.icon ? ic(x.icon, 'sm') : ''}${esc(x.l)}</button>`).join('')}<span class="thumb"></span></div>`;
  };
  const num = (k, d, o = {}) => `<span class="numf"><input class="field ws num" inputmode="decimal" data-in="${k}" value="${esc(get(k, d))}"${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o.unit2 ? ` data-unit="${o.unit2}"` : ''}>${o.unit ? `<span class="unit">${esc(o.unit)}</span>` : ''}</span>`;
  const txt = (k, d = '', o = {}) => `<input class="field ${o.w || ''} ${o.mono ? 'mono' : ''}" data-in="${k}" value="${esc(get(k, d))}"${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o.unit ? ` data-unit="${o.unit}"` : ''}${o.type ? ` type="${o.type}"` : ''} aria-label="${esc(o.label || k)}">`;
  const area = (k, d = '', o = {}) => `<textarea class="area ${o.mono ? 'mono' : ''}" data-in="${k}" rows="${o.rows || 5}"${o.ph ? ` placeholder="${esc(o.ph)}"` : ''}${o.unit ? ` data-unit="${o.unit}"` : ''}>${esc(get(k, d))}</textarea>`;
  const tags = (k, d = [], o = {}) => `<div class="tags" data-tags="${k}">${get(k, d).map((t, i) => `<span class="tag">${esc(t)}<button data-act="tag-rm" data-k="${k}" data-i="${i}" aria-label="移除">${ic('x', 'xs')}</button></span>`).join('')}<input data-tagin="${k}" placeholder="${esc(o.ph || '输入后按 Enter')}"></div>`;
  const btn = (l, o = {}) => `<button class="btn ${o.k || ''} ${o.sm ? 'sm' : ''} ${!l ? 'icon' : ''}"${attrs({ 'data-act': o.act, 'data-go': o.go, 'data-v': o.v, 'data-sel': o.sel, 'data-tip': o.tip, disabled: o.off, 'aria-label': !l ? o.tip : null })}>${o.icon ? ic(o.icon, 'sm') : ''}${esc(l || '')}</button>`;
  const logoSrc = n => (n.includes('/') ? n : `../../../packages/ui/src/assets/provider-logos/${n}.svg`);
  const logo = (n, c = '') => n.startsWith('#') ? `<span class="logo ${c}">${ic(n.slice(1), 'sm')}</span>`
    : n.startsWith('@') ? `<span class="logo ${c}">${MARK}</span>`
      : c.includes('lg') ? `<span class="logo ${c}"><img class="${n.includes('harness') ? 'keep' : ''}" src="${logoSrc(n)}" alt=""></span>`
        : `<img class="logo ${c} ${n.includes('harness') ? 'keep' : ''}" src="${logoSrc(n)}" alt="">`;
  const chip = (l, k = '', icon) => `<span class="chip ${k}">${icon ? ic(icon, 'xs') : ''}${esc(l)}</span>`;
  const info = t => `<span class="info" data-tip="${esc(t)}" tabindex="0">${ic('info', 'xs')}</span>`;
  const kbd = s => s.split('+').map(x => `<span class="kbd">${esc(x)}</span>`).join('');

  /* ── 结构 ── */
  const scopeText = {
    device: () => ['monitor', '此设备', '只影响你正在用的这台设备上的界面。'],
    host: () => S.host === 'local'
      ? ['server', 'Varin 服务 · studio-pc', '保存在当前 Varin 服务上，所有连接这台服务的设备都使用这份设置。']
      : ['server', 'Varin 服务 · home-server', '保存在远程 Varin 服务 home-server 上，所有连接它的设备都使用这份设置。'],
    hostProject: () => { const [i, l, d] = scopeText.host(); return [i, l, d + '项目可以单独覆盖。']; },
    project: () => ['folder', '项目 · opencr', '只作用于这个项目里的对话。'],
    mixed: () => ['layers', '此设备与 Varin 服务', '分区会分别标出各自保存在哪里。'],
  };
  const scope = kind => { if (!kind) return ''; const [i, l, d] = scopeText[kind](); return `<span class="scope" data-tip="${esc(d)}">${ic(i, 'xs')}<span>${esc(l)}</span></span>`; };
  const header = (p, o = {}) => `<header class="ph"><div class="grow"><h1>${esc(p.title)}</h1>${p.desc ? `<p>${p.desc}</p>` : ''}${scope(p.scope)}</div><div class="acts"><span class="saved" id="saved">${ic('check', 'xs')}已保存</span>${o.acts || ''}</div></header>`;
  const sec = (title, body, o = {}) => `<section class="sec"${o.id ? ` id="${o.id}"` : ''}>${title || o.acts ? `<div class="sh"><div class="grow">${title ? `<h2>${esc(title)}</h2>` : ''}${o.desc ? `<p>${o.desc}</p>` : ''}</div>${o.acts ? `<div class="acts">${o.acts}</div>` : ''}</div>` : ''}${o.raw ? body : `<div class="panel">${body}</div>`}${o.after || ''}</section>`;
  const row = (label, ctl = '', o = {}) => `<div class="row ${o.stack ? 'stack' : ''} ${o.sub ? 'sub' : ''} ${o.dim ? 'dim' : ''}" data-item="${esc(o.item || label)}">${o.lead ? `<span class="lead">${ic(o.lead, 'sm')}</span>` : ''}<div class="rl"><div class="t">${esc(label)}${o.info ? info(o.info) : ''}${o.tag || ''}</div>${o.desc ? `<div class="d">${o.desc}</div>` : ''}</div><div class="rc">${ctl}</div></div>`;
  const link = (label, go, o = {}) => `<div class="row link" data-go="${go}"${o.sel ? ` data-sel="${o.sel}"` : ''} data-item="${esc(label)}" role="link" tabindex="0">${o.lead ? `<span class="lead">${ic(o.lead, 'sm')}</span>` : ''}<div class="rl"><div class="t">${esc(label)}</div>${o.desc ? `<div class="d">${o.desc}</div>` : ''}</div><div class="rc">${o.end ? `<span class="muted" style="font-size:12.5px">${o.end}</span>` : ''}${ic('chev', 'sm')}</div></div>`;
  const disc = (label, body, o = {}) => `<details class="disc"${o.open ? ' open' : ''}><summary>${ic('chev', 'sm chev')}${esc(label)}${o.sum ? `<span class="sum">${esc(o.sum)}</span>` : ''}</summary><div class="body2">${body}</div></details>`;
  const note = (t, o = {}) => `<div class="note ${o.k || ''} ${o.inpanel ? 'inpanel' : ''}">${ic(o.icon || (o.k === 'warn' ? 'alert' : 'info'), 'sm')}<div>${t}</div></div>`;
  const empty = (icon, title, desc, action = '') => `<div class="empty"><span class="ei">${ic(icon, 'lg')}</span><b>${esc(title)}</b>${desc ? `<p>${desc}</p>` : ''}${action}</div>`;
  const cards = (k, list, d, o = {}) => { const cur = get(k, d); return `<div class="cards" style="--n:${o.n || list.length}" role="radiogroup">${list.map(x => `<button class="ocard" role="radio" aria-checked="${x.v === cur}" data-card="${k}" data-v="${esc(x.v)}"${o.re ? ' data-re' : ''}>${x.art ? `<div class="art">${x.art}</div>` : ''}<div class="oh">${x.icon ? ic(x.icon, 'sm') : ''}${esc(x.l)}<span class="radio"></span></div>${x.d ? `<div class="od">${x.d}</div>` : ''}</button>`).join('')}</div>`; };
  const tabs = (key, list, d) => { const cur = S.tab[key] ?? d ?? list[0].v; return [`<nav class="tabs" role="tablist">${list.map(x => `<button role="tab" data-tab="${key}" data-v="${x.v}" aria-selected="${x.v === cur}">${esc(x.l)}${x.n != null ? `<span class="count">${x.n}</span>` : ''}</button>`).join('')}</nav>`, cur]; };
  const unitOpts = {};
  const unitMsg = (u, o) => { const st = S.unit[u]; return st === 'busy' ? `<span class="spin"></span>${esc(o.busy || '正在保存…')}` : st === 'ok' ? `${ic('check', 'sm')}${esc(o.ok || '已保存')}` : st === 'err' ? `${ic('alert', 'sm')}${esc(o.err || '保存失败')}` : esc(o.msg || '有未保存的修改'); };
  const unitBtns = (u, o) => { const st = S.unit[u]; return st === 'dirty' || st === 'err' ? `${btn(o.cancel || '放弃', { k: 'ghost', sm: true, act: 'unit-cancel', v: u })}${btn(o.save || '保存', { k: 'primary', sm: true, act: o.verify ? 'unit-verify' : 'unit-save', v: u })}` : ''; };
  /* 正文编辑的悬浮保存条 */
  const dock = (u, o = {}) => { unitOpts[u] = { ...o, dock: true }; const st = S.unit[u]; return `<div class="dock ${st ? 'on' : ''}" data-dock="${u}"><div class="in">${unitMsg(u, o)}${unitBtns(u, o)}</div></div>`; };
  const unitbar = (u, o = {}) => { unitOpts[u] = o; const st = S.unit[u]; const cls = st === 'ok' ? 'ok' : st === 'err' ? 'err' : ''; const msg = st === 'busy' ? `<span class="spin"></span>${esc(o.busy || '正在验证…')}` : st === 'ok' ? `${ic('check', 'sm')}${esc(o.ok || '已保存')}` : st === 'err' ? `${ic('alert', 'sm')}${esc(o.err || '连接失败')}` : esc(o.msg || '有未保存的修改'); return `<div class="unitbar ${st ? 'on' : ''}" data-unitbar="${u}"><div><div class="in ${cls}"><span class="grow">${msg}</span>${st === 'dirty' || st === 'err' ? `${btn('放弃', { k: 'ghost', sm: true, act: 'unit-cancel', v: u })}${btn(o.save || '保存', { k: 'primary', sm: true, act: o.verify ? 'unit-verify' : 'unit-save', v: u })}` : ''}</div></div></div>`; };

  /* 模型选择：按服务分组，带品牌标识 */
  const modelDD = (k, d, o = {}) => {
    const options = o.none ? [{ v: '', l: o.none }] : [];
    for (const service of DATA.services) {
      const models = service.models.filter(model => !o.cap || model.caps.includes(o.cap));
      if (!models.length) continue;
      options.push({ grp: service.name }, ...models.map(model => ({
        v: DATA.modelRef(service.id, model.id), l: model.id, logo: service.logo,
        meta: DATA.isSharedModel(model.id) ? service.name : '',
      })));
    }
    return dd(k, options, DATA.model(d)?.ref ?? d, { w: o.w || 'wl', re: o.re });
  };
  const thinkDD = (k, d = '默认') => dd(k, ['默认', '关闭', '低', '中', '高', '最高'], d, { w: 'ws', label: '思考等级' });
  /* 功能页和模型分工共用选项与保存键。 */
  const roleRef = (role, none, o = {}) => {
    const entry = DATA.roles[role];
    return modelDD('role.' + role, entry.def, { cap: entry.cap, none, w: o.w });
  };

  /* 对象目录骨架 */
  const cat = o => {
    const ms = S.mstage[o.key] || 'list';
    return `<div class="cat" data-mstage="${ms}"><aside class="cat-list"><div class="cat-head"><div class="tt"><h1>${esc(o.title)}</h1>${o.headActs || ''}</div>${o.desc ? `<p>${o.desc}</p>` : ''}${scope(o.scope)}</div>${o.filter ? `<div class="cat-filter">${ic('search', 'sm')}<input placeholder="${esc(o.filter)}" data-filter="${o.key}" value="${esc(S.v['filter.' + o.key] || '')}"></div>` : ''}<div class="cat-items">${o.items}</div>${o.foot ? `<div class="cat-foot">${o.foot}</div>` : ''}</aside><section class="cat-detail"><div class="scroll"><div class="page">${o.detail}</div></div>${o.dock || ''}</section></div>`;
  };
  const ci = (key, id, inner, o = {}) => `<button class="ci ${o.pinned ? 'pinned' : ''}" data-sel="${key}" data-v="${esc(id)}" aria-current="${(S.sel[key] ?? o.first) === id}">${inner}</button>`;
  const sel = (key, d) => S.sel[key] ?? d;

  return { esc, ic, get, set, opts, unitOpts, dock, sw, dd, seg, num, txt, area, tags, btn, logo, chip, info, kbd, scope, header, sec, row, link, disc, note, empty, cards, tabs, unitbar, modelDD, thinkDD, roleRef, cat, ci, sel };
})();

/* 页面注册表 */
window.P = {};
window.ACTS = {};
window.page = (slug, def) => { P[slug] = { slug, ...def }; };
