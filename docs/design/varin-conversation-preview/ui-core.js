/* Varin · 总助手设计稿 · 核心：图标、头像、形象、状态与渲染调度 */
(function () {
  'use strict';
  const VC = window.VC = window.VC || {};

  // ---------------------------------------------------------------- 工具
  VC.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  VC.$ = (s, r = document) => r.querySelector(s);
  VC.$$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ---------------------------------------------------------------- 图标（线性，与工作台同一套笔画）
  const ICONS = {
    side: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9 4.5v15"/>',
    panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M15 4.5v15"/>',
    chev: '<path d="M7 10l5 5 5-5"/>', right: '<path d="M10 7l5 5-5 5"/>', back: '<path d="M14 7l-5 5 5 5"/>',
    down: '<path d="M12 6v12M6.5 12.5L12 18l5.5-5.5"/>', up: '<path d="M12 18V6M6.5 11.5L12 6l5.5 5.5"/>',
    stack: '<path d="M12 4l8 4.5-8 4.5-8-4.5z"/><path d="M4 13l8 4.5 8-4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', x: '<path d="M7 7l10 10M17 7L7 17"/>',
    at: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2.5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    new: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M12 8.5v7M8.5 12h7"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6"/>',
    dots: '<circle cx="6" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18" cy="12" r="1.1"/>',
    out: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v3.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 17.5v-10A1.5 1.5 0 0 1 6.5 6H10"/>',
    check: '<path d="M5.5 12.5l4.2 4.2 8.8-9.4"/>',
    alert: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5M12 15.8v.2"/>',
    shield: '<path d="M12 3.5l7 3v5.2c0 4.2-3 7.4-7 8.8-4-1.4-7-4.6-7-8.8V6.5z"/>',
    bot: '<rect x="4" y="5" width="16" height="14" rx="5"/><rect x="7" y="8" width="10" height="7" rx="3"/>',
    workbench: '<rect x="4" y="4.5" width="16" height="15" rx="3"/><path d="M4 9h16M9.5 9v10.5"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5A2 2 0 0 0 13.5 4.5h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    retry: '<path d="M5 12a7 7 0 1 0 2-4.9"/><path d="M5 4.5V8h3.5"/>',
    branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 8v8M17 10c0 4-5 3.5-9.5 6.5"/>',
    edit: '<path d="M5 19l1-4 9.5-9.5a2 2 0 0 1 2.8 2.8L8.8 17.8z"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l.8 11a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7"/>',
    pin: '<path d="M9 4h6l-1 5 3 3H7l3-3z"/><path d="M12 15v5"/>',
    cal: '<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M9 3.5v4M15 3.5v4"/>',
    list: '<path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01"/>',
    history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.7h3.7"/><path d="M12 8v4.2l2.8 1.8"/>',
    memory: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5A1.5 1.5 0 0 1 3.5 15.5V7A1.5 1.5 0 0 1 5 5.5z"/><path d="M10 8.5h4v5l-2-1.4-2 1.4z"/>',
    computer: '<rect x="3.5" y="4.5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16v4"/>',
    server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
    file: '<path d="M7.5 3.5h6L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M13.5 3.5V8H18"/>',
    doc: '<path d="M7.5 3.5h6L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M9 12.5h6M9 16h4"/>',
    sheet: '<rect x="4" y="4.5" width="16" height="15" rx="2.5"/><path d="M4 9.5h16M4 14.5h16M10 4.5v15"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4.5-4.5 3 3 2-2L19 17"/>',
    diff: '<circle cx="7" cy="16" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 4v10M17 10v10"/>',
    link: '<path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/>',
    upload: '<path d="M12 15V4.5M7.5 9L12 4.5 16.5 9"/><path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/>',
    download: '<path d="M12 4.5V15M7.5 10.5L12 15l4.5-4.5"/><path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/>',
    phone: '<rect x="7" y="3.5" width="10" height="17" rx="2.5"/><path d="M11 17.5h2"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 18.5h18"/>',
    expand: '<path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5l-6 6M4.5 19.5l6-6"/>',
    collapse: '<path d="M19.5 4.5L14 10M14 5.5V10h4.5M4.5 19.5L10 14M10 18.5V14H5.5"/>',
    hand: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a5.5 5.5 0 0 1-4.3-2.1L4.5 15a1.5 1.5 0 0 1 2.3-1.9L8 14.5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
    reply: '<path d="M9 7L4.5 11.5 9 16"/><path d="M4.5 11.5H14a5.5 5.5 0 0 1 5.5 5.5v1"/>',
    key: '<circle cx="8" cy="15" r="3.5"/><path d="M10.5 12.5L19 4M16 7l2 2M14 9l1.5 1.5"/>',
    terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 10l3 2.5-3 2.5M12.5 15.5h4"/>',
    globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.6 2.5 13.4 0 16M12 4c-2.5 2.6-2.5 13.4 0 16"/>',
    qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2M18 14h2M14 18h2v2M18 18v2h2"/>',
    plug: '<path d="M9 4v4M15 4v4M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v4"/>',
    brain: '<path d="M9 5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.5A3 3 0 0 0 8 18.5a2.5 2.5 0 0 0 4 .5V6a2.5 2.5 0 0 0-3-1z"/><path d="M15 5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.5 3 3 0 0 1-3.5 5 2.5 2.5 0 0 1-4 .5"/>',
    pause: '<path d="M9.5 7v10M14.5 7v10"/>',
    sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6"/>',
    move: '<path d="M4.5 12h12M12.5 7.5L17 12l-4.5 4.5"/><path d="M20 5v14"/>',
    wifi: '<path d="M4 9.5a12 12 0 0 1 16 0M7 13a7.5 7.5 0 0 1 10 0M10 16.5a3 3 0 0 1 4 0"/><path d="M12 19.5h.01"/>',
  };
  VC.icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  // ---------------------------------------------------------------- 产品头像（agent-avatar-art.ts 的原图形）
  const ART = {
    'slant-mint': { body: 'M11 19Q12 13 20 13L44 10Q50 9 53 16L61 43Q64 52 54 54L18 58Q10 59 8 51L5 29Q4 22 11 19Z', color: '#96C4B4', eyes: 'M19 31L24 30Q27 30 27 32Q27 34 25 34L20 35Q17 35 17 33Q17 31 19 31ZM40 28L45 27Q48 27 48 29Q48 31 46 31L41 32Q38 32 38 30Q38 28 40 28Z' },
    'pebble-blue': { body: 'M7 28Q15 11 30 11L37 11Q49 12 56 27Q62 39 59 48Q57 55 47 56Q30 60 14 56Q5 54 4 44Q3 36 7 28Z', color: '#85B3D2', eyes: 'M18 31H24Q26 31 26 33Q26 35 24 35H18Q16 35 16 33Q16 31 18 31ZM40 31H46Q48 31 48 33Q48 35 46 35H40Q38 35 38 33Q38 31 40 31Z' },
    'notch-ochre': { body: 'M5 31Q9 13 28 12Q34 12 38 17Q41 21 48 21Q59 22 61 34L62 43Q63 54 50 55L18 55Q4 55 3 44Q2 37 5 31Z', color: '#E9C16E', eyes: 'M20 30H23Q26 30 26 33V34Q26 37 23 37H20Q18 37 18 34V33Q18 30 20 30ZM40 33H46Q48 33 48 35Q48 37 46 37H40Q38 37 38 35Q38 33 40 33Z' },
    'slope-lilac': { body: 'M13 18Q15 14 21 13L43 8Q47 7 50 10L57 17Q59 19 59 24L61 47Q62 54 54 55L13 60Q6 61 7 53L10 26Q11 21 13 18Z', color: '#C7B5EF', eyes: 'M19 31L24 30Q27 30 27 32Q27 34 25 34L20 35Q17 35 17 33Q17 31 19 31ZM40 28L45 27Q48 27 48 29Q48 31 46 31L41 32Q38 32 38 30Q38 28 40 28Z' },
    'dome-ivory': { body: 'M5 43C6 23 18 12 32 12C49 12 59 26 60 45Q61 51 54 52Q32 55 10 52Q3 52 5 43Z', color: '#E9DED0', eyes: 'M21 29H24Q26 29 26 32V34Q26 36 23 36H21Q19 36 19 33V32Q19 29 21 29ZM41 29H44Q46 29 46 32V34Q46 36 43 36H41Q39 36 39 33V32Q39 29 41 29Z' },
    'taper-sage': { body: 'M15 13Q19 8 25 9L45 12Q51 13 53 20L61 48Q63 55 55 55L10 53Q3 53 5 46L11 23Q12 17 15 13Z', color: '#A8BD96', eyes: 'M20 29L25 30Q27 30 27 32Q27 34 25 34L20 33Q18 33 18 31Q18 29 20 29Z', eyeStroke: 'M40 33Q44 27 48 33' },
  };
  VC.av = (id, size = 20, lead = false) => {
    const a = VC.data.agents[id]; if (!a) return '';
    const art = ART[a.art];
    const eyes = `<path d="${art.eyes}" fill="#1b1a18"/>${art.eyeStroke ? `<path d="${art.eyeStroke}" fill="none" stroke="#1b1a18" stroke-width="4" stroke-linecap="round"/>` : ''}`;
    return `<span class="av${lead ? ' lead' : ''}" style="width:${size}px;height:${size}px" title="${VC.esc(a.name)}"><svg viewBox="0 0 64 64" aria-hidden="true"><path d="${art.body}" fill="${art.color}"/>${eyes}</svg></span>`;
  };
  VC.avs = (ids, size = 18, lead) => `<span class="av-stack">${ids.map((id) => VC.av(id, size, id === lead)).join('')}</span>`;

  // ---------------------------------------------------------------- Varin 形象：复用 ../varin-figure-preview/figure.js
  const HEAD = '330 236 750 750';
  VC.figHead = (host, size) => {
    if (typeof Figure !== 'function' || !host) return;
    try { const f = new Figure(host, { size, view: HEAD, compact: true, still: true, manual: true, seed: 5 }); f.render?.(); } catch (e) { /* 形象缺失时保留空位 */ }
  };

  // ---------------------------------------------------------------- 状态
  VC.state = {
    scene: 'chat', theme: 'light', size: 'desktop', motion: 'on',
    sidebar: false, drawer: false, tab: 'overview', scope: 'session',
    views: [], active: null, expanded: false,
    actOpen: {}, answer: null, answered: false,
    busy: null, now: null, pending: [], extra: [], sendMenu: false, laterHint: false,
    computer: 'watch', fileLoc: 'ws', fileSel: 'hero.css', xfer: true,
    svcPop: false, settings: null, sendPref: { varin: 'steer', agent: 'queue' },
    wizard: null, flash: null,
  };

  // ---------------------------------------------------------------- 动作注册与分发
  VC.act = {};
  VC.on = (name, fn) => { VC.act[name] = fn; };
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = VC.act[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  // ---------------------------------------------------------------- 渲染调度：各区域独立刷新，Bot 形象常驻不重建
  VC.parts = {};
  VC.render = (...which) => {
    const all = !which.length;
    const s = VC.state, frame = VC.$('#frame');
    frame.dataset.size = s.size;
    frame.dataset.sidebar = s.sidebar ? 'open' : 'closed';
    frame.dataset.region = s.views.length && s.active ? 'view' : 'panel';
    frame.dataset.expanded = String(Boolean(s.expanded && s.active));
    frame.dataset.drawer = s.drawer ? 'open' : 'closed';
    frame.dataset.panel = s.panelHidden ? 'hidden' : 'shown';
    document.documentElement.dataset.theme = s.theme;
    document.documentElement.dataset.motion = s.motion;
    for (const k of ['title', 'side', 'chat', 'panel', 'views', 'over', 'lab']) if (all || which.includes(k)) VC.parts[k]?.();
  };
})();
