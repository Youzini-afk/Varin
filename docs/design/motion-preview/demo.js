/* Varin 动效与交互原型 v2 · 编排
 * 外观与结构沿用 packages/ui 的真实组件（对话优先过程行、思考阅读窗口、派发成员行、任务回复气泡、
 * 轮末用量、右侧导轨与面板、设置窗口、工作台切换）；运动层按 docs/design/motion-and-interaction.md。
 */
(function () {
  'use strict';
  const M = window.VarinMotion;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const h = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const full = () => M.level === 'full' && !M.legacy;
  const root = document.documentElement;

  // ---------------- 图标（与产品的细线图标同一语气） ----------------
  const P = {
    'layout-left': '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="M9.5 3.5v17"/>',
    'layout-right': '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="M14.5 3.5v17"/>',
    workbench: '<rect x="3.5" y="3.5" width="7" height="9" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.6"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.6"/><rect x="3.5" y="15.5" width="7" height="5" rx="1.6"/>',
    general: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
    research: '<path d="M9 3h6M10 3v6.5L4.6 18.8A1.5 1.5 0 0 0 5.9 21h12.2a1.5 1.5 0 0 0 1.3-2.2L14 9.5V3"/><path d="M7.2 15h9.6"/>',
    code: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><path d="m10 9.5-2.6 2.5 2.6 2.5M14 9.5l2.6 2.5-2.6 2.5"/>',
    bot: '<path d="M12 8V4.5H8.5"/><rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
    'chev-down': '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    'chev-right': '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
    folder: '<path d="M20 19a2 2 0 0 0 2-2V8.5a2 2 0 0 0-2-2h-7.6a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 8.2 3.5H4a2 2 0 0 0-2 2V17a2 2 0 0 0 2 2Z"/>',
    'git-branch': '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="8" r="2.4"/><path d="M6 8.4v7.2M18 10.4c0 4.2-6.2 3.4-10.4 6"/>',
    stack: '<path d="m12 3 9 4.6-9 4.6-9-4.6z"/><path d="m3 12.2 9 4.6 9-4.6"/><path d="m3 16.6 9 4.6 9-4.6"/>',
    new: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M18.4 2.8a2 2 0 0 1 2.8 2.8L12 14.8l-3.6.9.9-3.6z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
    chat: '<path d="M20.5 14.5a2 2 0 0 1-2 2H8l-4.5 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z"/>',
    chats: '<path d="M14 9.5a2 2 0 0 1-2 2H6.5l-3 3v-10a2 2 0 0 1 2-2H12a2 2 0 0 1 2 2Z"/><path d="M17.5 9h1a2 2 0 0 1 2 2v10l-3-3H12a2 2 0 0 1-2-2v-1"/>',
    donut: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v5M12 12m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>',
    'file-code': '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8Z"/><path d="M14 2.5V8h5.5"/><path d="m10 12.5-2 2 2 2M14 12.5l2 2-2 2"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    keyboard: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M6.5 9.5h.01M10 9.5h.01M14 9.5h.01M17.5 9.5h.01M6.5 13h.01M17.5 13h.01M10 13h4M7.5 15.8h9"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    shield: '<path d="M12 21.5s7.5-3.4 7.5-9.6V5.6L12 2.8 4.5 5.6v6.3c0 6.2 7.5 9.6 7.5 9.6Z"/>',
    brain: '<path d="M9.5 3.5A2.5 2.5 0 0 0 7 6v.2A3 3 0 0 0 4.6 9.3a3 3 0 0 0 .6 1.8 3 3 0 0 0-1 2.4 3 3 0 0 0 2 2.8v.7a3 3 0 0 0 3 3h.3A2.5 2.5 0 0 0 12 17.5V6a2.5 2.5 0 0 0-2.5-2.5Z"/><path d="M14.5 3.5A2.5 2.5 0 0 1 17 6v.2a3 3 0 0 1 2.4 3.1 3 3 0 0 1-.6 1.8 3 3 0 0 1 1 2.4 3 3 0 0 1-2 2.8v.7a3 3 0 0 1-3 3h-.3A2.5 2.5 0 0 1 12 17.5"/>',
    'arrow-up': '<path d="m6 11 6-6 6 6"/><path d="M12 19V5"/>',
    'arrow-down': '<path d="M12 5v14"/><path d="m18 13-6 6-6-6"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    check: '<path d="M20 6.5 9.5 17 4 11.5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    copy: '<rect x="8.5" y="8.5" width="12.5" height="12.5" rx="2.2"/><path d="M15.5 8.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h3.5"/>',
    redo: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
    thumb: '<path d="M7 10v11"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/>',
    file: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8Z"/><path d="M14 2.5V8h5.5M9 13h6M9 17h6"/>',
    pencil: '<path d="M21 6.8a1 1 0 0 0-3.8-3.8L3.8 16.2a2 2 0 0 0-.5.8L2 21.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5Z"/><path d="m15 5 4 4"/>',
    more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
    external: '<path d="M14.5 3.5h6v6M10 14 20.5 3.5M18 13.5v5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
    bell: '<path d="M6 8.5a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    pin: '<path d="M12 17v5M9 10.8V4h6v6.8l2.5 3.2H6.5Z"/>',
    archive: '<rect x="2.5" y="3.5" width="19" height="5" rx="1.5"/><path d="M4.5 8.5v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-10M10 12.5h4"/>',
    trash: '<path d="M3.5 6h17M8.5 6V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V6M18.5 6l-.8 13a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 6"/>',
    palette: '<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 1 0 0 20 1.7 1.7 0 0 0 1.7-1.7c0-.4-.2-.8-.4-1.1a1.6 1.6 0 0 1 1.3-2.7h2A5.5 5.5 0 0 0 22 11 10 10 0 0 0 12 2Z"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v4a6 6 0 0 1-12 0V8Z"/>',
    book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    play: '<path d="m7 4 12 8-12 8Z"/>',
    scale: '<path d="M12 3v18M5 21h14M6 7h12M6 7l-3 7a3 3 0 0 0 6 0ZM18 7l-3 7a3 3 0 0 0 6 0Z"/>',
    map: '<path d="M9 4 3 6.5v14L9 18l6 2.5 6-2.5V4l-6 2.5Z"/><path d="M9 4v14M15 6.5v14"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bug: '<rect x="7.5" y="7" width="9" height="13" rx="4.5"/><path d="M12 20v-9M3 13h4.5M16.5 13H21M4 7.5l3.5 2M20 7.5l-3.5 2M4 19l3.5-2M20 19l-3.5-2M9.5 7a2.5 2.5 0 0 1 5 0"/>',
    eye: '<path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z"/><circle cx="12" cy="12" r="3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  };
  const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
  const VARIN = '<svg viewBox="-64 -64 128 128" aria-hidden="true"><path d="M-35 -19 L-11 -43 L44 -43 L57 -30 L2 -30 L-21 -7 L-21 26 L-35 12 Z"/><path d="M35 19 L11 43 L-44 43 L-57 30 L-2 30 L21 7 L21 -26 L35 -12 Z" opacity=".6"/></svg>';
  function hydrateIcons(scope = document) {
    $$('i[data-ic]', scope).forEach((i) => {
      const t = document.createElement('template');
      t.innerHTML = icon(i.dataset.ic, i.className);
      i.replaceWith(t.content.firstChild);
    });
  }

  // Agent 头像：取自 components/ui/agent-avatar-art.ts，保持原造型
  const AVATARS = {
    'pebble-blue': { body: 'M7 28Q15 11 30 11L37 11Q49 12 56 27Q62 39 59 48Q57 55 47 56Q30 60 14 56Q5 54 4 44Q3 36 7 28Z', color: '#85B3D2', eyes: 'M18 31H24Q26 31 26 33Q26 35 24 35H18Q16 35 16 33Q16 31 18 31ZM40 31H46Q48 31 48 33Q48 35 46 35H40Q38 35 38 33Q38 31 40 31Z' },
    'slant-mint': { body: 'M11 19Q12 13 20 13L44 10Q50 9 53 16L61 43Q64 52 54 54L18 58Q10 59 8 51L5 29Q4 22 11 19Z', color: '#96C4B4', eyes: 'M19 31L24 30Q27 30 27 32Q27 34 25 34L20 35Q17 35 17 33Q17 31 19 31ZM40 28L45 27Q48 27 48 29Q48 31 46 31L41 32Q38 32 38 30Q38 28 40 28Z' },
    'notch-ochre': { body: 'M5 31Q9 13 28 12Q34 12 38 17Q41 21 48 21Q59 22 61 34L62 43Q63 54 50 55L18 55Q4 55 3 44Q2 37 5 31Z', color: '#E9C16E', eyes: 'M20 30H23Q26 30 26 33V34Q26 37 23 37H20Q18 37 18 34V33Q18 30 20 30ZM40 33H46Q48 33 48 35Q48 37 46 37H40Q38 37 38 35Q38 33 40 33Z' },
  };
  const avatar = (id, size = 23) => {
    const a = AVATARS[id];
    return `<svg class="avatar" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true"><path fill="${a.color}" d="${a.body}"/><path fill="#202326" d="${a.eyes}"/></svg>`;
  };

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // 进场 / 退场：现状模式下直接出现、直接消失
  function enter(el, kf, opts) {
    if (M.legacy || !el) return null;
    return M.animate(el, kf || [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], opts || { spring: 'glide' });
  }
  function exit(el, kf, opts) {
    if (M.legacy || !el) return Promise.resolve();
    return M.done(M.animate(el, kf || [{ opacity: 1 }, { opacity: 0, transform: 'translateY(4px)' }], Object.assign({ duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' }, opts)));
  }
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

  // ---------------- 分段控件（实验室） ----------------
  function Seg(el, onChange) {
    const knob = $('.seg-knob', el);
    const buttons = $$('button', el);
    let value = (buttons.find((b) => b.getAttribute('aria-checked') === 'true') || buttons[0]).dataset.value;
    const x = new M.Spring(0, { token: 'glide', restDelta: 0.2, onUpdate: (v) => (knob.style.transform = `translateX(${v}px)`) });
    const w = new M.Spring(0, { token: 'glide', restDelta: 0.2, onUpdate: (v) => (knob.style.width = `${v}px`) });
    function place(instant) {
      const b = buttons.find((n) => n.dataset.value === value);
      if (!b || !b.offsetWidth) return;
      x.to(b.offsetLeft, { instant: instant || M.legacy });
      w.to(b.offsetWidth, { instant: instant || M.legacy });
    }
    function set(v, { silent = false, instant = false, from } = {}) {
      if (v === value && !instant) return;
      value = v;
      buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === v)));
      place(instant);
      if (!silent && onChange) onChange(v, from);
    }
    buttons.forEach((b) => b.addEventListener('click', (e) => set(b.dataset.value, { from: e })));
    requestAnimationFrame(() => place(true));
    return { set, place, get value() { return value; } };
  }

  // ---------------- 数据 ----------------
  const DEMO_PROMPT = '把登录模块重构一下，跑完测试再告诉我结果。';
  const groups = [
    { id: 'varin', name: 'Varin', icon: 'folder', items: [
      { id: 'retrieval', title: '检索隔离与工具可靠性', seed: [['user', '子 Agent 的检索为什么会报 child_tool_original_owner_unavailable？'], ['summary', '读取文件 6 次 · 检索了 2 次'], ['agent', '根因在 Wait 之后的重新绑定：父 Run 借用了另一个 Run 的同模型凭证，那个凭证里没有冻结的子检索模型，于是子工具找不到原始所有者。\n修复放在 `thread-adapter.ts` 的 `retainFrozenChildModels`：重新绑定时保留子 Run 冻结的模型集合，而不是按模型名去借。']] },
      { id: 'kernel', title: 'Rust 内核构建排查', unread: true, seed: [['user', 'cargo build 在 Windows 上提示找不到 link.exe。'], ['agent', '需要在 VS x64 开发者环境里构建。用 `builds\\varin-cargo.cmd` 包一层就行，它会先调用 `vcvars64.bat` 再执行 cargo。\n另外别和另一个构建同时写 `kernel/target`，锁竞争会让两边都变慢。']] },
      { id: 'settings', title: '设置页信息架构', seed: [['user', '设置页切换分类的时候太硬了。'], ['agent', '现在是直接替换内容。左侧导航可以用滑动选中胶囊，右侧内容 110ms 退场、160ms 交叉淡入，标题跟随方向换字。']] },
    ] },
    { id: 'web', name: 'Varin-web', icon: 'folder', items: [
      { id: 'home', title: '官网首页文案', seed: [['user', '首页第一屏的标题再短一点。'], ['agent', '可以压到一句：「让 Agent 在你的工作区里，把事做完。」副标题留给能力说明。']] },
      { id: 'installer', title: '安装器完成页', seed: [['user', '安装完成页的按钮顺序要调整吗？'], ['agent', '主操作「打开 Varin」放右侧，「查看更新说明」作为文字链接，避免两个实心按钮并列。']] },
    ] },
    { id: 'chat', name: '普通对话', icon: 'chat', items: [
      { id: 'theme', title: '主题与配色校准', seed: [['user', '暗色模式的边框是不是太亮了？'], ['agent', '暗色边框是 `#ffffff12`，在 `#161616` 上属于刻意的低对比。选中态再叠一层 `#ffffff12` 就够区分。']] },
    ] },
  ];
  const threads = [];
  groups.forEach((g) => g.items.forEach((t) => {
    Object.assign(t, { group: g, sends: 0, scrollTop: 0, run: null, empty: !t.seed, kind: t.kind || 'seed' });
    threads.push(t);
  }));
  const draft = { id: 'draft', title: '新会话', kind: 'draft', sends: 0, empty: true, run: null, scrollTop: 0 };

  // ---------------- DOM ----------------
  hydrateIcons();
  const frame = $('#frame');
  const canvas = $('#canvas');
  const scroller = $('#scroller');
  const input = $('#input');
  const sendBtn = $('#sendBtn');
  const composer = $('#composer');
  const dock = $('#dock');
  const sessions = $('#sessions');
  const selPill = $('#selPill');
  const hoverPill = $('#hoverPill');
  let current = null;

  // ---------------- 侧栏：按项目分组；选中胶囊 + 磁吸悬停 ----------------
  const selY = new M.Spring(0, { token: 'glide', restDelta: 0.2, onUpdate: (y) => (selPill.style.transform = `translateY(${y}px)`) });
  const hovY = new M.Spring(0, { token: 'snap', restDelta: 0.2, onUpdate: (y) => hoverPill.style.setProperty('--y', `${y}px`) });
  const hovX = new M.Spring(0, { token: 'snap', restDelta: 0.05, onUpdate: (x) => hoverPill.style.setProperty('--x', `${x}px`) });
  let hovered = null;
  const rowTop = (el) => el.getBoundingClientRect().top - sessions.getBoundingClientRect().top + sessions.scrollTop;

  function sessionRow(t) {
    const b = h('button', 'session', `<span class="s-icon">${icon('chat')}</span><span class="s-title swap"><span class="swap-cur">${esc(t.title)}</span></span><span class="s-more" role="button" tabindex="-1" aria-label="会话操作">${icon('more')}</span>`);
    b.type = 'button';
    b.dataset.id = t.id;
    b.setAttribute('aria-selected', 'false');
    b.addEventListener('click', (e) => {
      if (e.target.closest('.s-more')) return openSessionMenu(t, e.target.closest('.s-more'));
      selectThread(t);
    });
    t.item = b;
    return b;
  }
  groups.forEach((g) => {
    const wrap = h('div', 'group');
    wrap.dataset.group = g.id;
    const head = h('button', 'group-head', `${icon(g.icon)}<span>${esc(g.name)}</span>${icon('chev-down', 'g-chev')}`);
    head.type = 'button';
    head.addEventListener('click', () => toggleGroup(g, wrap));
    const items = h('div', 'group-items');
    g.items.forEach((t) => items.append(sessionRow(t)));
    wrap.append(head, items);
    g.el = wrap;
    g.itemsEl = items;
    sessions.append(wrap);
  });
  threads.forEach(setSessionIcon);

  // 收起项目：下方分组用 FLIP 上移，不做逐帧高度动画
  function toggleGroup(g, wrap) {
    const after = [...sessions.querySelectorAll('.group')].filter((n) => n.compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_PRECEDING);
    const collapse = wrap.dataset.collapsed !== 'true';
    if (!collapse) {
      M.flip(after, () => (wrap.dataset.collapsed = 'false'));
      $$('.session', g.itemsEl).forEach((r, i) => enter(r, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: Math.min(i, 5) * 20 }));
    } else M.flip(after, () => (wrap.dataset.collapsed = 'true'));
    requestAnimationFrame(() => placeSelection());
  }

  function placeSelection(instant) {
    const t = current && current.item && current.item.isConnected && current.item.offsetParent ? current : null;
    if (!t) {
      if (selPill.style.opacity !== '0') exit(selPill, [{ opacity: 1 }, { opacity: 0, transform: `translateY(${selY.x}px) scale(.98)` }]).then(() => (selPill.style.opacity = '0'));
      if (M.legacy) selPill.style.opacity = '0';
      return;
    }
    selPill.style.height = `${t.item.offsetHeight}px`;
    const y = rowTop(t.item);
    if (selPill.style.opacity === '0') {
      // 胶囊首次出现：就地淡入，不从旧位置滑过来
      selPill.getAnimations().forEach((a) => a.cancel());
      selPill.style.opacity = '';
      selY.jump(y);
      enter(selPill, [{ opacity: 0, transform: `translateY(${y}px) scale(.97)` }, { opacity: 1, transform: `translateY(${y}px)` }], { spring: 'glide' });
    } else selY.to(y, { instant: instant || M.legacy });
  }
  selPill.style.opacity = '0';
  sessions.addEventListener('pointermove', (e) => {
    const it = e.target.closest('.session');
    if (!it || M.legacy) return;
    const fresh = !hoverPill.classList.contains('on');
    if (it !== hovered) {
      hovered = it;
      hoverPill.style.height = `${it.offsetHeight}px`;
      hovY.to(rowTop(it), { instant: fresh });
    }
    const r = it.getBoundingClientRect();
    hovX.to(((e.clientX - r.left) / r.width - 0.5) * 5, { instant: fresh });
    hoverPill.classList.add('on');
  });
  sessions.addEventListener('pointerleave', () => {
    hoverPill.classList.remove('on');
    hovered = null;
    hovX.to(0);
  });
  sessions.addEventListener('scroll', () => {
    hoverPill.classList.remove('on');
    hovered = null;
  }, { passive: true });

  // 会话状态：运行中圆点 / 未读铃铛 / 默认对话图标，原位换出
  function setSessionIcon(t) {
    if (!t.item) return;
    const slot = $('.s-icon', t.item);
    const kind = t.run && t !== current ? 'run' : t.unread && t !== current ? 'unread' : 'chat';
    if (slot.dataset.kind === kind) return;
    slot.dataset.kind = kind;
    slot.innerHTML = kind === 'run' ? '<span class="run-dot"></span>' : kind === 'unread' ? `<span class="unread">${icon('bell')}</span>` : icon('chat');
    enter(slot.firstElementChild, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
  }

  // ---------------- 新会话：居中输入框与起始建议 ----------------
  const STARTERS = [['book', '了解这个项目'], ['play', '接续项目进展'], ['scale', '比较可选方案'], ['map', '规划新功能'], ['target', '创建持续任务'], ['clock', '安排计划任务'], ['bug', '排查问题'], ['eye', '审查当前改动']];
  const starters = $('#starters');
  STARTERS.forEach(([ic, label]) => {
    const b = h('button', 'starter', `${icon(ic)}<span>${label}</span>`);
    b.type = 'button';
    b.addEventListener('click', () => {
      setInput(label === '排查问题' ? DEMO_PROMPT : `${label}：`, true);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    starters.append(b);
  });
  const draftSlot = $('#draftSlot');
  const draftEl = $('#draft');

  // 输入框只有一个：草稿时停在标题下方，发送后以 travel 弹簧下沉停靠（FLIP，布局只提交一次）
  function placeDock(mode, animate) {
    const first = dock.getBoundingClientRect();
    if (mode === 'draft') {
      root.style.setProperty('--composer-h', `${composer.offsetHeight}px`);
      dock.style.top = `${draftSlot.offsetTop + draftEl.offsetTop}px`;
      dock.style.bottom = 'auto';
      dock.style.paddingBottom = '0';
    } else {
      dock.style.top = '';
      dock.style.bottom = '';
      dock.style.paddingBottom = '';
    }
    if (!animate || M.legacy) return;
    const last = dock.getBoundingClientRect();
    const dy = first.top - last.top;
    if (Math.abs(dy) > 1) M.animate(dock, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { spring: 'travel' });
  }
  function showDraft(show, animate) {
    canvas.dataset.empty = String(show);
    if (show) {
      placeDock('draft', animate);
      if (animate) {
        const parts = [$('#draftTitle'), ...$$('.starter', starters)];
        parts.forEach((p, i) => enter(p, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 60 + Math.min(i, 6) * 22 }));
      }
    } else {
      placeDock('docked', animate);
    }
  }
  new ResizeObserver(() => {
    root.style.setProperty('--dock-h', `${dock.offsetHeight}px`);
    if (canvas.dataset.empty === 'true') placeDock('draft', false);
  }).observe(dock);
  new ResizeObserver(() => { if (canvas.dataset.empty === 'true') placeDock('draft', false); }).observe(canvas);

  // ---------------- 输入框 ----------------
  function fitInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(220, input.scrollHeight)}px`;
  }
  // 发送 / 清空时高度用 glide 过渡；打字时即时增长
  function setInput(text, animated = true) {
    const h0 = composer.offsetHeight;
    input.value = text;
    fitInput();
    const h1 = composer.offsetHeight;
    if (animated && Math.abs(h1 - h0) > 1 && !M.legacy) M.animate(composer, [{ height: `${h0}px` }, { height: `${h1}px` }], { spring: 'glide' });
    syncComposer();
  }
  function syncComposer() {
    const running = !!(current && current.run);
    sendBtn.dataset.state = running ? 'running' : input.value.trim() ? 'ready' : 'idle';
    sendBtn.dataset.tip = running ? '停止' : '发送';
    sendBtn.setAttribute('aria-label', sendBtn.dataset.tip);
    input.placeholder = current && current.kind !== 'draft' && !current.empty ? '继续这项工作…' : '描述你想做的事…';
  }
  input.addEventListener('input', () => { fitInput(); syncComposer(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onSend();
    }
  });
  sendBtn.addEventListener('click', onSend);

  // ---------------- 时间线 ----------------
  function userTurn(text) {
    const turn = h('div', 'turn-user');
    const b = h('div', 'user-bubble');
    b.textContent = text;
    turn.append(b);
    return turn;
  }
  function ensureTimeline(t) {
    if (t.timeline) return t.timeline;
    const tl = h('div', 'timeline');
    t.timeline = tl;
    let agent = null;
    (t.seed || []).forEach(([role, text]) => {
      if (role === 'user') {
        tl.append(userTurn(text));
        agent = null;
        return;
      }
      if (!agent) {
        agent = h('div', 'turn-agent');
        tl.append(agent);
      }
      if (role === 'summary') agent.append(staticActivity(text));
      else {
        const p = h('div', 'prose');
        renderStatic(p, parseMd(text));
        agent.append(p);
        agent.append(turnFooter(['复制', '重试'], { input: 14200, output: 980, speed: 41 }, true));
      }
    });
    return tl;
  }

  function parseMd(md) {
    const out = [];
    const src = md.trim().split('\n');
    for (let i = 0; i < src.length; i++) {
      const fence = src[i].match(/^```(\w*)/);
      if (!fence) { if (src[i].trim()) out.push(parseLine(src[i])); continue; }
      const body = [];
      for (i++; i < src.length && !src[i].startsWith('```'); i++) body.push(src[i]);
      const text = body.join('\n');
      out.push({ tag: 'code', lang: fence[1] || 'text', segs: [{ k: 't', s: text }], len: text.length });
    }
    return out;
  }
  const LANG = { ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', sh: 'Shell', text: '文本' };
  function codeFrame(lang) {
    const pre = h('pre', 'cb');
    pre.innerHTML = `<div class="cb-head"><span>${esc(LANG[lang] || lang)}</span><button type="button" aria-label="复制代码">${icon('copy')}复制</button></div><code class="cb-body"></code>`;
    return pre;
  }
  function parseLine(line) {
    {
      let tag = 'p';
      let body = line;
      if (line.startsWith('### ')) { tag = 'h3'; body = line.slice(4); } else if (line.startsWith('- ')) { tag = 'li'; body = line.slice(2); }
      const segs = [];
      const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
      let last = 0;
      let m;
      while ((m = re.exec(body))) {
        if (m.index > last) segs.push({ k: 't', s: body.slice(last, m.index) });
        segs.push(m[1] != null ? { k: 'code', s: m[1] } : { k: 'b', s: m[2] });
        last = re.lastIndex;
      }
      if (last < body.length) segs.push({ k: 't', s: body.slice(last) });
      return { tag, segs, len: segs.reduce((n, x) => n + x.s.length, 0) };
    }
  }
  function renderStatic(rootEl, blocks) {
    let list = null;
    blocks.forEach((b) => {
      let el;
      if (b.tag === 'code') {
        list = null;
        const pre = codeFrame(b.lang);
        $('.cb-body', pre).innerHTML = b.segs[0].s.split('\n').map((l) => `<span class="cb-line">${highlightTS(l, false)}</span>`).join('');
        rootEl.append(pre);
        return;
      }
      if (b.tag === 'li') {
        if (!list) { list = h('ul'); rootEl.append(list); }
        el = h('li');
        list.append(el);
      } else {
        list = null;
        el = h(b.tag);
        rootEl.append(el);
      }
      b.segs.forEach((s) => {
        if (s.k === 't') el.append(s.s);
        else { const c = h(s.k === 'code' ? 'code' : 'strong'); c.textContent = s.s; el.append(c); }
      });
    });
  }

  // ---------------- 切换会话：方向感知 ----------------
  const order = () => [draft, ...threads.filter((t) => t.item && t.item.isConnected)];
  function selectThread(t, { instant = false } = {}) {
    if (t === current) return;
    const prev = current;
    const list = order();
    const dir = prev ? Math.sign(list.indexOf(t) - list.indexOf(prev)) || 1 : 1;
    if (prev && prev.timeline && prev.timeline.isConnected) prev.scrollTop = scroller.scrollTop;
    current = t;
    t.unread = false;
    threads.forEach(setSessionIcon);
    $$('.session').forEach((b) => b.setAttribute('aria-selected', String(b === t.item)));
    placeSelection(instant);
    M.swapText($('#threadTitle'), t.title, { dir });
    swapTimeline(prev, t, dir, instant);
    follow.mode = 'follow';
    setJumpPill(false);
    syncComposer();
    if (t.kind === 'draft') setCtxUsage(0);
    else setCtxUsage(t.ctx || (t.seed ? 0.22 : 0));
  }

  function swapTimeline(prev, t, dir, instant) {
    const old = prev && prev.timeline;
    const wasEmpty = canvas.dataset.empty === 'true';
    if (old && old.isConnected && !instant && !M.legacy && M.level !== 'off') {
      const overlay = h('div', 'timeline-exit');
      const inner = h('div');
      inner.style.width = `${scroller.clientWidth}px`;
      inner.style.transform = `translateY(${-scroller.scrollTop}px)`;
      inner.append(old);
      overlay.append(inner);
      scroller.after(overlay);
      exit(overlay, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-10 * dir}px)` }]).then(() => {
        if (overlay.contains(old)) old.remove();
        overlay.remove();
      });
    } else if (old) old.remove();
    if (t.kind === 'draft') {
      scroller.replaceChildren();
      showDraft(true, !instant && !wasEmpty);
      return;
    }
    const next = ensureTimeline(t);
    scroller.replaceChildren(next);
    showDraft(false, !instant && wasEmpty);
    scroller.scrollTop = t.scrollTop || scroller.scrollHeight;
    follow.programmatic = scroller.scrollTop;
    if (!instant) {
      const kids = [...next.children].slice(-6);
      kids.forEach((k, i) => enter(k, [{ opacity: 0, transform: `translateY(${14 * dir}px)` }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 30 + i * 22 }));
    }
  }

  // ---------------- 滚动：锚定 + 舒适线弹簧跟随 ----------------
  const follow = { mode: 'follow', programmatic: -1, lastSH: 0 };
  const scrollSpring = new M.Spring(0, { omega: 14, restDelta: 0.5, restSpeed: 4, onUpdate: (v) => { scroller.scrollTop = v; follow.programmatic = scroller.scrollTop; } });
  const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const contentTop = (el) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  function scrollTo(target, token) {
    scrollSpring.sync(scroller.scrollTop);
    scrollSpring.configure(token ? { token } : { omega: 14 });
    scrollSpring.to(Math.max(0, Math.min(maxScroll(), target)));
  }
  function liveEnd(t) {
    const live = t.timeline && t.timeline.querySelector('.turn-agent.live');
    if (!live) return 0;
    let last = live.lastElementChild;
    while (last && last.classList.contains('m-ghost')) last = last.previousElementSibling;
    return last ? contentTop(last) + last.offsetHeight : contentTop(live);
  }
  function followTick() {
    const t = current;
    if (!t || !t.run) return;
    if (follow.mode !== 'follow') return updateJumpPill();
    if (M.legacy) {
      if (scroller.scrollHeight !== follow.lastSH) {
        follow.lastSH = scroller.scrollHeight;
        requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; follow.programmatic = scroller.scrollTop; });
      }
      return;
    }
    const desired = Math.min(maxScroll(), liveEnd(t) + 56 - scroller.clientHeight);
    if (desired > scrollSpring.target + 1) {
      if (!scrollSpring.active) scrollSpring.sync(scroller.scrollTop);
      scrollSpring.configure({ omega: 14 });
      scrollSpring.to(desired);
    }
  }
  function release() {
    if (follow.mode === 'free') return;
    follow.mode = 'free';
    scrollSpring.stop();
  }
  scroller.addEventListener('wheel', (e) => e.deltaY < 0 && release(), { passive: true });
  scroller.addEventListener('touchstart', release, { passive: true });
  scroller.addEventListener('scroll', () => {
    if (Math.abs(scroller.scrollTop - follow.programmatic) > 2) {
      const dist = maxScroll() - scroller.scrollTop;
      if (dist <= 24) follow.mode = 'follow';
      else if (!scrollSpring.active) release();
    }
    updateJumpPill();
  });
  const jumpPill = $('#jumpPill');
  let jumpShown = false;
  function updateJumpPill() {
    setJumpPill(follow.mode === 'free' && maxScroll() - scroller.scrollTop > 120);
  }
  function setJumpPill(show) {
    if (show === jumpShown) return;
    jumpShown = show;
    if (show) {
      jumpPill.hidden = false;
      enter(jumpPill, [{ opacity: 0, transform: 'translateY(8px) scale(.96)' }, { opacity: 1, transform: 'none' }], { spring: 'snap' });
    } else {
      exit(jumpPill, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(4px) scale(.98)' }]).then(() => { if (!jumpShown) jumpPill.hidden = true; });
      if (M.legacy) jumpPill.hidden = true;
    }
  }
  jumpPill.addEventListener('click', () => {
    follow.mode = 'follow';
    setJumpPill(false);
    if (M.legacy) scroller.scrollTop = scroller.scrollHeight;
    else scrollTo(current.run ? liveEnd(current) + 56 - scroller.clientHeight : maxScroll(), 'travel');
  });

  // ---------------- 发送：共享元素飞入 ----------------
  function onSend() {
    const t = current;
    if (t.run) { t.run.cancel(); return; }
    const text = input.value.trim();
    if (!text) return;
    send(t, text);
  }
  function textOrigin() {
    const r = input.getBoundingClientRect();
    const cs = getComputedStyle(input);
    return { x: r.left + parseFloat(cs.paddingLeft), y: r.top + parseFloat(cs.paddingTop) - input.scrollTop };
  }
  function flyBubble(src, bubble) {
    const ghost = h('div', 'flight');
    ghost.textContent = bubble.textContent;
    const r = bubble.getBoundingClientRect();
    ghost.style.width = `${r.width}px`;
    bubble.style.visibility = 'hidden';
    document.body.append(ghost);
    const from = { x: src.x - 16, y: src.y - 12 };
    ghost.style.transform = `translate3d(${from.x}px, ${from.y}px, 0)`;
    const D = M.dur.travel * M.ts;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const off = M.onFrame(() => {
        const p = Math.min(1, (performance.now() - t0) / D);
        const tr = bubble.getBoundingClientRect();
        // x 用 glide、y 用 travel：横向先到位，纵向带惯性，轨迹是一道很浅的弧
        const x = from.x + (tr.left - from.x) * M.curve.glide(p);
        const y = from.y + (tr.top - from.y) * M.curve.travel(p);
        ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        ghost.style.setProperty('--fill', Math.min(1, p * 2.4).toFixed(3));
        if (p >= 1 || !bubble.isConnected) {
          off();
          bubble.style.visibility = '';
          ghost.remove();
          resolve();
        }
      });
    });
  }
  // 新回合锚定到视口顶部：给进行中的回合预留最小高度，回复向下生长
  function reserveAnchor(t, turn, live) {
    $$('.turn-agent.live', t.timeline).forEach((n) => { if (n !== live) { n.classList.remove('live'); n.style.minHeight = ''; } });
    if (M.legacy) return null;
    const anchor = turn.previousElementSibling ? contentTop(turn) - 18 : 0;
    const extra = scroller.clientHeight - (scroller.scrollHeight - anchor);
    if (extra > 0) live.style.minHeight = `${extra}px`;
    return Math.max(0, anchor);
  }

  async function send(t, text) {
    const src = textOrigin();
    // 首次发送：在侧栏项目顶部长出新会话，胶囊滑过去
    if (t.kind === 'draft') t = materializeDraft(text);
    const tl = ensureTimeline(t);
    if (!tl.isConnected) scroller.replaceChildren(tl);
    const wasEmpty = t.empty;
    t.empty = false;
    const turn = userTurn(text);
    const bubble = $('.user-bubble', turn);
    tl.append(turn);
    const live = h('div', 'turn-agent live');
    tl.append(live);
    if (wasEmpty) {
      exit($('#draftTitle'), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-10px)' }]);
      $$('.starter', starters).forEach((s, i) => exit(s, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }], { delay: Math.min(i, 6) * 12 }));
      showDraft(false, true);
      $('#draftTitle').getAnimations().forEach((a) => setTimeout(() => a.cancel(), 400 * M.ts));
      $$('.starter', starters).forEach((s) => s.getAnimations().forEach((a) => setTimeout(() => a.cancel(), 500 * M.ts)));
    }
    const anchor = reserveAnchor(t, turn, live);
    setInput('', true);
    follow.mode = 'follow';
    setJumpPill(false);
    let landed = Promise.resolve();
    if (M.legacy) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
    else {
      scrollTo(anchor, 'travel');
      if (M.level === 'full') landed = flyBubble(src, bubble);
      else enter(bubble, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: M.ease.out });
    }
    const run = M.createRun();
    t.run = run;
    run.thread = t;
    run.started = performance.now();
    syncComposer();
    setSessionIcon(t);
    const offFollow = M.onFrame(followTick);
    const script = t.kind === 'demo' && t.sends === 0 ? demoScript : genericScript;
    t.sends++;
    try {
      await landed;
      const usage = await script(t, live, run);
      turnFooter(['复制', '重试', '有帮助'], usage, false, live);
    } catch (err) {
      if (!(err instanceof M.Cancelled)) throw err;
      markStopped(live);
      const note = h('div', 'stopped-note', '已停止');
      live.append(note);
      enter(note);
    } finally {
      offFollow();
      if (t.run === run) t.run = null;
      if (t !== current && !run.cancelled) t.unread = true;
      setSessionIcon(t);
      if (t === current) { syncComposer(); requestAnimationFrame(updateJumpPill); }
    }
  }

  function materializeDraft(text) {
    const t = { id: `t${Date.now()}`, title: text.length > 14 ? `${text.slice(0, 14)}…` : text, kind: text === DEMO_PROMPT ? 'demo' : 'new', group: groups[0], sends: 0, scrollTop: 0, run: null, empty: true };
    if (t.kind === 'demo') t.title = '重构登录模块';
    threads.unshift(t);
    const g = groups[0];
    if (g.el.dataset.collapsed === 'true') g.el.dataset.collapsed = 'false';
    const rows = $$('.session, .group-head', sessions);
    M.flip(rows, () => g.itemsEl.prepend(sessionRow(t)));
    enter(t.item, [{ opacity: 0, transform: 'translateX(-6px) scale(.97)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
    current = t;
    $$('.session').forEach((b) => b.setAttribute('aria-selected', String(b === t.item)));
    requestAnimationFrame(() => placeSelection());
    M.swapText($('#threadTitle'), t.title);
    return t;
  }

  function markStopped(live) {
    $$('.tool[data-state="running"]', live).forEach((r) => setToolState(r, 'stopped'));
    // 停止后未应用的修改只是预览：没有应用结果
    $$('.fc', live).forEach((c) => c._fc && c._fc.phase !== 'applied' && c._fc.setPhase('preview'));
    $$('.caret', live).forEach((c) => exit(c, [{ opacity: 1 }, { opacity: 0 }]).then(() => c.remove()));
    $$('.activity', live).forEach((a) => a._act && a._act.settle(true));
    $$('.member[data-state="running"], .member[data-state="starting"]', live).forEach((m) => m._set && m._set('cancelled'));
  }

  // ---------------- 流式正文：墨迹前沿 + 节奏化配速 ----------------
  function makeWriter(rootEl, blocks) {
    const ink = !M.legacy && M.level !== 'off';
    let bi = 0, si = 0, ci = 0, blockEl = null, segEl = null, listEl = null;
    const caret = h('span', 'caret');
    caret.setAttribute('aria-hidden', 'true');
    const pending = [];
    const put = (node) => blockEl.insertBefore(node, caret.parentNode === blockEl ? caret : null);
    let lineEl = null;
    function openBlock(b) {
      if (b.tag === 'code') {
        // 围栏一到就出现代码框与语言标签；行随到随长，写完的行再着色
        listEl = null;
        const pre = codeFrame(b.lang);
        rootEl.append(pre);
        enter(pre, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
        blockEl = $('.cb-body', pre);
        blockEl._code = true;
        newLine();
        return;
      }
      if (b.tag === 'li') {
        if (!listEl) { listEl = h('ul'); rootEl.append(listEl); }
        blockEl = h('li');
        listEl.append(blockEl);
      } else { listEl = null; blockEl = h(b.tag); rootEl.append(blockEl); }
      blockEl.append(caret);
    }
    function newLine() {
      lineEl = h('span', 'cb-line');
      lineEl._text = '';
      blockEl.append(lineEl);
      lineEl.append(caret);
    }
    function finishLine() {
      const l = lineEl;
      const text = l._text;
      setTimeout(() => { if (l.isConnected) l.innerHTML = highlightTS(text, bloomOn()); }, (M.legacy ? 0 : 90) * M.ts);
    }
    function openSeg(seg) {
      if (seg.k === 't') segEl = blockEl;
      else { segEl = h(seg.k === 'code' ? 'code' : 'strong'); put(segEl); }
    }
    function write(str) {
      if (blockEl._code) {
        str.split('\n').forEach((part, idx) => {
          if (idx > 0) { const prev = lineEl; newLine(); finishLineOf(prev); }
          if (!part) return;
          const node = ink ? h('span', 'ink') : document.createTextNode(part);
          if (ink) node.textContent = part;
          lineEl.insertBefore(node, caret);
          lineEl._text += part;
        });
        return;
      }
      let node;
      if (ink) { node = h('span', 'ink'); node.textContent = str; pending.push({ node, at: performance.now() }); } else node = document.createTextNode(str);
      if (segEl === blockEl) put(node); else segEl.append(node);
    }
    function finishLineOf(l) {
      const keep = lineEl;
      lineEl = l;
      finishLine();
      lineEl = keep;
    }
    function mergeOld(force) {
      const now = performance.now();
      while (pending.length && (force || now - pending[0].at > 420 * M.ts)) {
        const { node } = pending.shift();
        if (node.isConnected) node.replaceWith(node.textContent);
      }
    }
    return {
      total: blocks.reduce((n, b) => n + b.len, 0),
      emit(n) {
        while (n > 0 && bi < blocks.length) {
          const b = blocks[bi];
          if (!blockEl) { openBlock(b); si = 0; ci = 0; segEl = null; }
          const seg = b.segs[si];
          if (!segEl) openSeg(seg);
          const take = Math.min(n, seg.s.length - ci);
          write(seg.s.slice(ci, ci + take));
          ci += take;
          n -= take;
          if (ci >= seg.s.length) {
            si++; ci = 0; segEl = null;
            if (si >= b.segs.length) {
              // 代码块写完：光标移出代码框，最后一行着色
              if (blockEl && blockEl._code && lineEl) { blockEl.parentNode.after(caret); finishLineOf(lineEl); }
              bi++;
              if (bi < blocks.length) blockEl = null;
            }
          }
        }
        mergeOld(false);
      },
      waiting(on) { caret.classList.toggle('waiting', on); },
      end() {
        const c = caret;
        exit(c, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.5)' }]).then(() => c.remove());
        if (M.legacy) c.remove();
        setTimeout(() => { mergeOld(true); rootEl.normalize(); }, 520 * M.ts);
      },
    };
  }

  // 配速：rate = max(26 字/秒, 积压 / 0.24s)；网络结束后 0.16s 内匀速排空
  async function stream(parent, run, md, seed, { onStart } = {}) {
    const el = h('div', 'prose');
    parent.append(el);
    const writer = makeWriter(el, parseMd(md));
    const total = writer.total;
    const net = { received: 0, done: false };
    (async () => {
      const rnd = rng(seed);
      try {
        await M.sleep(140 + rnd() * 120, run);
        while (net.received < total) {
          await M.sleep(rnd() < 0.06 ? 420 : 28 + rnd() * 90, run);
          net.received = Math.min(total, net.received + 3 + Math.floor(rnd() * 11));
        }
        net.done = true;
      } catch (e) { /* 停止时网络模拟一并结束 */ }
    })();
    let started = false;
    const start = () => { if (!started) { started = true; if (onStart) onStart(); } };
    if (M.legacy) {
      let shown = 0;
      while (shown < total) {
        await M.sleep(64, run);
        const backlog = net.received - shown;
        if (backlog > 0) start();
        if (net.done) { writer.emit(backlog); shown += backlog; break; }
        if (backlog <= 0) continue;
        const n = Math.min(backlog, Math.max(5, Math.min(64, Math.ceil(backlog / 3))));
        writer.emit(n);
        shown += n;
      }
      writer.end();
      return el;
    }
    await new Promise((resolve, reject) => {
      let shownF = 0, shown = 0, drainRate = 0, lastEmit = performance.now();
      const off = M.onFrame((dt) => {
        if (run.cancelled) { off(); writer.end(); reject(new M.Cancelled()); return; }
        const backlog = net.received - shownF;
        let rate = Math.max(26, backlog / 0.24);
        if (net.done) { if (!drainRate) drainRate = Math.max(26, backlog / 0.16); rate = Math.max(rate, drainRate); }
        shownF = Math.min(net.received, shownF + rate * dt);
        const n = Math.floor(shownF) - shown;
        if (n > 0) { start(); writer.emit(n); shown += n; lastEmit = performance.now(); writer.waiting(false); }
        else if (performance.now() - lastEmit > 280 * M.ts) writer.waiting(true);
        if (net.done && shown >= total) { off(); writer.end(); resolve(); }
      });
    });
    return el;
  }

  // ---------------- 单行思考预览：新行出现时整行上滑（弹簧），不逐 token 重放 ----------------
  function Preview(host) {
    const inner = h('span');
    host.append(inner);
    let target = 0;
    const y = new M.Spring(0, { token: 'glide', restDelta: 0.2, onUpdate: (v) => (inner.style.transform = `translateY(${-v}px)`) });
    return {
      set(text) {
        inner.textContent = text.replace(/\s+/g, ' ');
        const next = Math.max(0, inner.offsetHeight - host.clientHeight);
        if (next !== target) {
          target = next;
          if (next - y.x > host.clientHeight * 1.5) y.jump(next - host.clientHeight);
          y.to(next, { instant: M.legacy });
        }
      },
    };
  }

  // ---------------- 对话优先过程行 ----------------
  // 两段发言之间的普通动作和公开思考共用一条可展开行：进行中显示当前动作，下一段发言到达后留下回执摘要。
  function Activity(parent) {
    const el = h('div', 'activity');
    el.dataset.open = 'false';
    el.innerHTML = `<button class="activity-head" type="button" aria-expanded="false">${icon('chev-right', 'act-chev')}<span class="act-label"><span class="act-text swap"><span class="swap-cur"></span></span><span class="thinking-preview" hidden></span></span><span class="act-flags"></span></button><div class="activity-peek" hidden></div><div class="activity-body"></div>`;
    parent.append(el);
    enter(el, [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
    const head = $('.activity-head', el);
    const label = $('.act-text', el);
    const pv = $('.thinking-preview', el);
    const preview = Preview(pv);
    const body = $('.activity-body', el);
    const peek = $('.activity-peek', el);
    const counts = new Map();
    let failures = 0;
    head.addEventListener('click', () => {
      const open = el.dataset.open !== 'true';
      M.resize(el, () => { el.dataset.open = String(open); head.setAttribute('aria-expanded', String(open)); }, { crossfade: false });
      if (open) [...body.children].slice(0, 6).forEach((c, i) => enter(c, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: i * 20 }));
    });

    // ---- 就地预览托盘 ----
    // 一批：从托盘里出现第一张卡片开始，到全部写完并安静 LINGER 毫秒为止。
    // 同时写入的卡片一起收回；收回之后再开始的修改进入新的一批。
    // 用户正在看（指针在托盘内、展开了卡片、暂停了内部跟随）时推迟收回，离开后重新计时。
    const LINGER = 700;
    let inflight = 0, timer = 0, settled = false;
    const pinned = () => peek.matches(':hover') || !!peek.querySelector('.fc[data-expanded="true"], .fc[data-paused="true"]');
    function schedule() {
      clearTimeout(timer);
      if (inflight > 0 || !peek.children.length) return;
      // 停留是阅读时间而不是动画：降低动效时同样保留
      timer = setTimeout(() => (pinned() ? 0 : retract()), LINGER * M.ts);
    }
    peek.addEventListener('pointerleave', () => { if (!inflight) schedule(); });
    peek.addEventListener('fc-unpin', () => { if (!inflight) schedule(); });
    function retract() {
      clearTimeout(timer);
      if (!peek.children.length || inflight > 0) return;
      // 保留进行中回合的高度：下方内容平滑上移，滚动位置不被浏览器夹回
      const turn = el.closest('.turn-agent.live');
      if (turn && !M.legacy) turn.style.minHeight = `${Math.max(parseFloat(turn.style.minHeight) || 0, turn.offsetHeight)}px`;
      const tops = $$('.fc-view', peek).map((v) => v.scrollTop);
      M.resize(el, () => { body.append(...peek.children); peek.hidden = true; });
      // 快照是克隆出来的，内部滚动位置要手动对齐，否则淡出时代码会跳回顶部
      const ghost = el.nextElementSibling;
      if (ghost && ghost.classList.contains('m-ghost')) $$('.fc-view', ghost).forEach((v, i) => (v.scrollTop = tops[i] || 0));
    }
    // 标签栈：显示最近开始、仍在进行的动作；同时有多项时右侧注明「另有 N 项进行中」
    const entries = new Map();
    function renderLabel() {
      const live = [...entries.values()].filter((e) => e.busy);
      const top = live.at(-1) || [...entries.values()].at(-1);
      if (top) api.live(top.text, { busy: !!live.length });
      const flags = $('.act-flags', el);
      const more = live.length - 1;
      const text = more > 0 ? `另有 ${more} 项进行中` : '';
      if ((flags.dataset.more || '') !== text) {
        flags.dataset.more = text;
        flags.innerHTML = text ? `<span class="swap"><span class="swap-cur">${text}</span></span>` : '';
        if (text) enter(flags.firstChild, [{ opacity: 0, transform: 'translateX(-4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
      }
    }
    const api = {
      el, body,
      // 正在写的文件就地预览：过程行仍是折叠的，当前批次的修改卡片显示在行下方
      host() {
        // 现状没有托盘：对话优先下修改卡片直接进入折叠的过程行
        if (M.legacy || root.dataset.reading === 'chrono' || el.dataset.open === 'true') return body;
        clearTimeout(timer);
        peek.hidden = false;
        return peek;
      },
      trayStart() { inflight++; clearTimeout(timer); },
      trayDone() { inflight = Math.max(0, inflight - 1); if (!inflight) schedule(); },
      // 更新不改变顺序：后开始的动作始终在前台，先开始的完成时不抢标签
      status(id, text, busy = true) { const e = entries.get(id); if (e) Object.assign(e, { text, busy }); else entries.set(id, { text, busy }); renderLabel(); },
      live(text, { thinking = false, busy = true } = {}) {
        label.classList.toggle('live', busy);
        M.swapText(label, text);
        if (thinking && pv.hidden) { pv.hidden = false; enter(pv, [{ opacity: 0 }, { opacity: 0.75 }], { duration: 200, easing: M.ease.out }); }
        if (!thinking && !pv.hidden) { exit(pv, [{ opacity: 0.75 }, { opacity: 0 }]).then(() => (pv.hidden = true)); if (M.legacy) pv.hidden = true; }
      },
      think(text) { preview.set(text); },
      count(key) { counts.set(key, (counts.get(key) || 0) + 1); },
      fail() { failures++; },
      settle(stopped) {
        settled = true;
        label.classList.remove('live');
        // 段落结束：已写完的批次立即收回（用户正在看的托盘等离开后再收）
        if (peek.children.length && !inflight) { if (pinned()) schedule(); else retract(); }
        if (!pv.hidden) { exit(pv, [{ opacity: 0.75 }, { opacity: 0 }]).then(() => (pv.hidden = true)); if (M.legacy) pv.hidden = true; }
        const words = { reads: (n) => `读取文件 ${n} 次`, searches: (n) => `检索了 ${n} 次`, changes: (n) => `应用了 ${n} 次修改`, commands: (n) => `运行了 ${n} 条命令` };
        const summary = [...counts].map(([k, n]) => words[k](n)).join(' · ') || '思考过程';
        M.swapText(label, summary);
        const flags = $('.act-flags', el);
        flags.innerHTML = '';
        flags.dataset.more = '';
        if (stopped && !flags.textContent) { flags.innerHTML = '<span>1 项已取消</span>'; enter(flags.firstChild); }
        if (failures) { flags.innerHTML = `<span class="fail">${failures} 项失败</span>`; enter(flags.firstChild); }
      },
    };
    el._act = api;
    return api;
  }

  function staticActivity(summary) {
    const el = h('div', 'activity');
    el.dataset.open = 'false';
    el.innerHTML = `<button class="activity-head" type="button" aria-expanded="false">${icon('chev-right', 'act-chev')}<span class="act-label"><span class="act-text swap"><span class="swap-cur">${esc(summary)}</span></span></span></button><div class="activity-body"><div class="tool" data-open="false"><button class="tool-head" type="button">${icon('search')}<span class="tool-copy"><span class="tool-label">检索代码</span><span class="tool-subject">child retrieval owner</span></span><span class="tool-receipt">4 处命中</span>${icon('chev-right', 't-chev')}</button></div><div class="tool" data-open="false"><button class="tool-head" type="button">${icon('file')}<span class="tool-copy"><span class="tool-label">读取</span><span class="tool-subject mono">thread-adapter.ts</span></span><span class="tool-receipt">L210–388</span>${icon('chev-right', 't-chev')}</button></div></div>`;
    const head = $('.activity-head', el);
    head.addEventListener('click', () => {
      const open = el.dataset.open !== 'true';
      M.resize(el, () => { el.dataset.open = String(open); head.setAttribute('aria-expanded', String(open)); }, { crossfade: false });
    });
    return el;
  }

  // ---------------- 思考块（过程行展开后可见；按时间模式下直接出现） ----------------
  function Thinking(parent) {
    const el = h('div', 'thinking');
    el.dataset.open = 'false';
    el.innerHTML = `<button class="thinking-head" type="button" aria-expanded="false">${icon('brain')}<span class="thinking-label">思考过程</span><span class="thinking-preview"></span>${icon('chev-right', 't-chev')}</button><div class="thinking-window"><div class="thinking-scroll"><div class="thinking-body"></div></div></div>`;
    parent.append(el);
    const head = $('.thinking-head', el);
    const body = $('.thinking-body', el);
    const scroll = $('.thinking-scroll', el);
    const preview = Preview($('.thinking-preview', el));
    head.addEventListener('click', () => {
      const open = el.dataset.open !== 'true';
      M.resize(el, () => { el.dataset.open = String(open); head.setAttribute('aria-expanded', String(open)); }, { crossfade: false });
      if (open) scroll.scrollTop = scroll.scrollHeight;
    });
    return {
      el,
      append(text, all) {
        const s = h('span', M.legacy || M.level === 'off' ? '' : 'ink');
        s.textContent = text;
        body.append(s);
        preview.set(all);
        if (el.dataset.open === 'true') scroll.scrollTop = scroll.scrollHeight;
      },
    };
  }

  // ---------------- 工具行：动作 + 对象 + 回执；普通成功不加完成徽标 ----------------
  function Tool(parent, step) {
    const el = h('div', 'tool');
    el.dataset.open = 'false';
    el.dataset.state = 'running';
    el.innerHTML = `<button class="tool-head" type="button" aria-expanded="false">${icon(step.icon)}<span class="tool-copy"><span class="tool-label">${esc(step.verb)}</span><span class="tool-subject${step.mono ? ' mono' : ''}">${esc(step.subject)}</span></span><span class="tool-receipt"></span><span class="tool-status"><span class="spin"></span><span class="swap st"><span class="swap-cur">进行中</span></span></span>${icon('chev-right', 't-chev')}</button><div class="tool-detail">${step.detail || ''}</div>`;
    parent.append(el);
    enter(el, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
    const head = $('.tool-head', el);
    head.addEventListener('click', () => {
      const open = el.dataset.open !== 'true';
      M.resize(el, () => { el.dataset.open = String(open); head.setAttribute('aria-expanded', String(open)); }, { crossfade: false });
    });
    return el;
  }
  function setToolState(el, state, receipt) {
    el.dataset.state = state;
    const status = $('.tool-status', el);
    if (state === 'done') {
      exit(status, [{ opacity: 1 }, { opacity: 0, transform: 'translateX(4px)' }]).then(() => status.remove());
      if (M.legacy) status.remove();
      const r = $('.tool-receipt', el);
      if (receipt && receipt.diff) {
        r.innerHTML = '<span class="add">+<b>0</b></span><span class="del">−<b>0</b></span>';
        const [a, d] = $$('b', r);
        M.countTo(a, receipt.diff[0], { duration: 520 });
        M.countTo(d, receipt.diff[1], { duration: 520 });
      } else r.textContent = receipt || '';
      enter(r, [{ opacity: 0, transform: 'translateX(-4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 60 });
    } else if (state === 'stopped') {
      const sp = $('.spin', status);
      if (sp) sp.remove();
      M.swapText($('.st', status), '已取消');
    } else if (state === 'error') {
      status.classList.add('err');
      const sp = $('.spin', status);
      if (sp) sp.remove();
      M.swapText($('.st', status), '失败');
    }
  }

  // ---------------- 参数流配速：与正文同一套节拍，代码基础速度更高 ----------------
  async function pace(run, total, onProgress, { seed = 1, base = 140, tau = 0.22 } = {}) {
    const net = { received: 0, done: false };
    (async () => {
      const rnd = rng(seed);
      try {
        await M.sleep(80 + rnd() * 80, run);
        while (net.received < total) {
          await M.sleep(rnd() < 0.05 ? 360 : 22 + rnd() * 56, run);
          net.received = Math.min(total, net.received + 6 + Math.floor(rnd() * 13));
        }
        net.done = true;
      } catch (e) { /* 停止时一并结束 */ }
    })();
    if (M.legacy) {
      // 现状：参数增量原样落下，没有配速
      let shown = -1;
      while (!(net.done && shown >= total)) {
        await M.sleep(32, run);
        if (net.received !== shown) { shown = net.received; onProgress(shown); }
      }
      return;
    }
    await new Promise((resolve, reject) => {
      let shownF = 0, shown = 0, drain = 0;
      const off = M.onFrame((dt) => {
        if (run.cancelled) { off(); reject(new M.Cancelled()); return; }
        const backlog = net.received - shownF;
        let rate = Math.max(base, backlog / tau);
        if (net.done) { if (!drain) drain = Math.max(base, backlog / 0.12); rate = Math.max(rate, drain); }
        shownF = Math.min(net.received, shownF + rate * dt);
        const n = Math.floor(shownF);
        if (n !== shown) { shown = n; onProgress(n); }
        if (net.done && shown >= total) { off(); resolve(); }
      });
    });
  }

  // ---------------- 语法着色：一行写完后才着色（模拟 worker 延迟），颜色从正文色晕开 ----------------
  const TS_RE = /(\/\/.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?)|\b(import|from|export|function|const|let|var|return|if|else|try|catch|await|async|new|type|interface|throw|of|for|while|undefined|null|true|false)\b|\b([A-Z][A-Za-z0-9_]*)\b|\b([a-zA-Z_$][\w$]*)(?=\s*\()|\b(\d+(?:\.\d+)?)\b/g;
  function highlightTS(text, bloom) {
    let out = '', last = 0, m;
    TS_RE.lastIndex = 0;
    while ((m = TS_RE.exec(text))) {
      if (m.index > last) out += esc(text.slice(last, m.index));
      const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : m[4] ? 't' : m[5] ? 'f' : 'n';
      out += `<span class="${bloom ? 'tk ' : ''}tk-${cls}">${esc(m[0])}</span>`;
      last = TS_RE.lastIndex;
    }
    return out + esc(text.slice(last));
  }
  const bloomOn = () => !M.legacy && M.level === 'full';

  // ---------------- 行级 LCS 差异（与 diffLines 一致：同一变更区内先删后增） ----------------
  function lineDiff(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0, rem = [], add = [];
    const flush = () => { ops.push(...rem, ...add); rem = []; add = []; };
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { flush(); ops.push({ k: 'context', oi: i, ni: j }); i++; j++; }
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { add.push({ k: 'add', ni: j }); j++; }
      else { rem.push({ k: 'remove', oi: i }); i++; }
    }
    flush();
    return ops;
  }
  const linesOf = (text) => { if (!text) return []; const l = text.split('\n'); if (l.at(-1) === '') l.pop(); return l; };

  // file_edit 的投影：newText 未到时 oldText 是拟删除；到达后已决定的部分按差异显示，
  // 游标之后尚未决定的旧行保持删除色但变淡，整段写完再一次性落定为最终差异。
  function projectEdit(ei, oldText, oldDone, newText, newDone, smart = !M.legacy) {
    const oldLines = oldDone ? linesOf(oldText) : oldText.split('\n');
    if (!oldDone && oldLines.at(-1) === '') oldLines.pop();
    const ok = (i) => `e${ei}o${i}`, nk = (i) => `e${ei}n${i}`;
    if (newText == null) return oldLines.map((t, i) => ({ key: ok(i), k: 'remove', t, pending: !oldDone && i === oldLines.length - 1 }));
    const nl = newText.split('\n');
    let partial = null;
    if (!newDone) partial = nl.pop(); else if (nl.at(-1) === '') nl.pop();
    const ops = lineDiff(oldLines, nl);
    const row = (o) => (o.k === 'add' ? { key: nk(o.ni), k: 'add', t: nl[o.ni] } : { key: ok(o.oi), k: o.k, t: oldLines[o.oi] });
    if (newDone) return ops.map(row);
    // 现状：未完成的新行直接参与差异，旧行一律显示为删除
    if (!smart) return lineDiff(oldLines, partial ? [...nl, partial] : nl).map((o) => (o.k === 'add' ? { key: nk(o.ni), k: 'add', t: o.ni < nl.length ? nl[o.ni] : partial, pending: o.ni >= nl.length } : { key: ok(o.oi), k: o.k, t: oldLines[o.oi] }));
    let lastCtx = -1;
    ops.forEach((o, idx) => { if (o.k === 'context') lastCtx = idx; });
    const tail = ops.slice(lastCtx + 1);
    const rows = [...ops.slice(0, lastCtx + 1).map(row), ...tail.filter((o) => o.k === 'add').map(row)];
    const removes = tail.filter((o) => o.k === 'remove');
    // 正在写的行若与游标后的旧行同前缀：在旧行上「复写」，不先闪成新增
    const over = partial != null && partial !== '' && removes.find((o) => oldLines[o.oi].startsWith(partial));
    if (over) rows.push({ key: ok(over.oi), k: 'context', t: oldLines[over.oi], pending: true, typed: partial.length });
    else if (partial) rows.push({ key: nk(nl.length), k: 'add', t: partial, pending: true });
    removes.filter((o) => o !== over).forEach((o) => rows.push({ ...row(o), ahead: true }));
    return rows;
  }
  // apply_patch 的投影：文件头整行到达前不打开文件，避免截断路径
  function projectPatch(text, done) {
    const lines = text.split('\n');
    const rows = [];
    let path = '';
    lines.forEach((line, idx) => {
      const complete = idx < lines.length - 1 || done;
      const head = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
      if (head) { if (complete) path = head[2]; return; }
      if (!path || line.startsWith('*** ') || (!complete && !line)) return;
      if (line.startsWith('@@')) rows.push({ key: `p${idx}`, k: 'hunk', t: line, pending: !complete });
      else if (/^[+ -]/.test(line)) rows.push({ key: `p${idx}`, k: line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context', t: line.slice(1), pending: !complete });
    });
    return { path, rows };
  }

  // ---------------- 文件修改预览：ChatFileChangePreview 的卡片 + 流式适配 ----------------
  const FC_PHASE = { generating: '正在生成修改', applying: '正在应用修改', applied: '已应用', draft: '已应用到未保存的草稿', preview: '修改预览 · 尚无应用结果', failed: '未应用 · 查看详情' };
  const ROW_H = 22;
  function FileChange(parent, { onOpen } = {}) {
    const el = h('section', 'fc');
    el.dataset.phase = 'generating';
    el.dataset.expanded = 'false';
    el.innerHTML = `<header class="fc-head"><span class="fc-icon"><span class="spin"></span></span><button class="fc-name swap" type="button" disabled><span class="swap-cur shimmer">文件路径待接收</span></button><span class="fc-counts" hidden><span class="add">+<b class="swap"><span class="swap-cur">0</span></b></span><span class="del">−<b class="swap"><span class="swap-cur">0</span></b></span></span><button class="fc-toggle" type="button" aria-expanded="false" aria-label="展开修改" data-tip="展开修改">${icon('chev-down')}</button></header><div class="fc-view" role="region" tabindex="0" aria-label="修改预览"><div class="fc-inner"><div class="fc-rows"></div><div class="fc-ghosts"></div></div></div><p class="fc-empty">正在接收文件内容…</p><footer class="fc-foot"><span class="fc-phase swap" role="status"><span class="swap-cur">正在生成修改</span></span><span class="fc-tools"><button type="button" class="fc-latest" hidden>${icon('arrow-down')}回到最新</button><button type="button" class="fc-prev" hidden aria-label="上一处修改" data-tip="上一处修改">${icon('arrow-up')}</button><button type="button" class="fc-next" hidden aria-label="下一处修改" data-tip="下一处修改">${icon('arrow-down')}</button><button type="button" class="fc-raw-btn">工具详情</button></span></footer><pre class="fc-raw" hidden></pre>`;
    parent.append(el);
    enter(el, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
    const view = $('.fc-view', el), rowsEl = $('.fc-rows', el), ghosts = $('.fc-ghosts', el);
    const nameBtn = $('.fc-name', el), counts = $('.fc-counts', el), [addN, delN] = $$('.fc-counts b', el);
    const phaseEl = $('.fc-phase', el), iconSlot = $('.fc-icon', el), toggle = $('.fc-toggle', el);
    const latestBtn = $('.fc-latest', el), prevBtn = $('.fc-prev', el), nextBtn = $('.fc-next', el), rawBtn = $('.fc-raw-btn', el), raw = $('.fc-raw', el);
    const rowMap = new Map();
    let path = '', phase = 'generating', expanded = false, following = true, prog = -1, nAdd = 0, nDel = 0;
    // 外层高度只在前 8 行内生长；之后只滚动内部，时间线保持稳定
    const viewH = new M.Spring(0, { token: 'glide', restDelta: 0.3, onUpdate: (v) => (view.style.height = `${v}px`) });
    const scrollS = new M.Spring(0, { omega: 16, restDelta: 0.3, restSpeed: 4, onUpdate: (v) => { view.scrollTop = v; prog = view.scrollTop; } });
    const gut = (k) => (k === 'add' ? '+' : k === 'remove' ? '−' : ' ');

    function scheduleHL(row) {
      if (row._hlTimer) return;
      row._hlTimer = setTimeout(() => {
        row._hlTimer = 0;
        if (!row.isConnected || row.classList.contains('pending') || row.dataset.k === 'hunk') return;
        row.lastElementChild.innerHTML = highlightTS(row._text, bloomOn());
        row._hl = true;
      }, (M.legacy ? 0 : 90) * M.ts);
    }
    function updateRow(row, r, isNew) {
      if (row.dataset.k !== r.k) { row.dataset.k = r.k; row.firstElementChild.textContent = gut(r.k); }
      row.classList.toggle('ahead', !!r.ahead);
      row.classList.toggle('pending', !!r.pending);
      const code = row.lastElementChild;
      if (r.typed != null) {
        // 复写旧行：已写部分是正文色，光标后的旧内容保持淡色
        code.innerHTML = `${esc(r.t.slice(0, r.typed))}<span class="fc-caret"></span><span class="fc-rest">${esc(r.t.slice(r.typed))}</span>`;
        row._text = undefined;
        row._hl = false;
        return isNew && enter(row, [{ opacity: 0, transform: 'scaleY(0)' }, { opacity: 1, transform: 'scaleY(1)' }], { spring: 'snap' });
      }
      if (r.t !== row._text) {
        if (!row._hl && row._text && r.t.startsWith(row._text)) {
          const s = h('span', bloomOn() ? 'ink' : '');
          s.textContent = r.t.slice(row._text.length);
          code.append(s);
        } else { code.textContent = r.t; row._hl = false; }
        row._text = r.t;
      }
      let caret = $('.fc-caret', code);
      if (r.pending) { if (!caret) caret = h('span', 'fc-caret'); code.append(caret); } else if (caret) caret.remove();
      if (!r.pending && !row._hl) scheduleHL(row);
      // 插入的行从顶边展开，与下方行的滑动同一条 snap 曲线：边缘始终贴合，不会叠在一起
      if (isNew) enter(row, [{ opacity: 0, transform: 'scaleY(0)' }, { opacity: 1, transform: 'scaleY(1)' }], { spring: 'snap' });
    }
    function ghostOut(row) {
      const g = row.cloneNode(true);
      Object.assign(g.style, { position: 'absolute', left: '0', right: '0', top: `${row.offsetTop}px` });
      row.remove();
      if (M.legacy) return;
      ghosts.append(g);
      // 移除的行向顶边收起，下方行同步上移填位
      M.done(M.animate(g, [{ opacity: 1, transform: 'scaleY(1)' }, { opacity: 0, transform: 'scaleY(0)' }], { spring: 'snap', fill: 'forwards' })).then(() => g.remove());
    }
    // 行按来源身份复用：拟删除变为上下文时只换底色，插入新行时其余行用 FLIP 让位
    // 最长递增子序列：顺序没变的行才滑动，换了顺序的行原地淡入，避免行与行交叉穿过
    function stableKeys(prevOrder, nextKeys) {
      const pos = new Map(prevOrder.map((k, i) => [k, i]));
      const seq = nextKeys.filter((k) => pos.has(k));
      const vals = seq.map((k) => pos.get(k));
      const tails = [], prev = new Array(vals.length).fill(-1), idx = [];
      vals.forEach((v, i) => {
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[tails[mid]] < v) lo = mid + 1; else hi = mid; }
        if (lo > 0) prev[i] = tails[lo - 1];
        tails[lo] = i;
        idx[lo] = i;
      });
      const keep = new Set();
      for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(seq[i]);
      return keep;
    }
    function reconcile(rows) {
      const before = new Map();
      rowMap.forEach((r, key) => before.set(key, r.offsetTop));
      const prevOrder = [...rowsEl.children].map((r) => r._key);
      const stable = stableKeys(prevOrder, rows.map((r) => r.key));
      const keep = new Set(rows.map((r) => r.key));
      [...rowMap].forEach(([key, r]) => { if (!keep.has(key)) { ghostOut(r); rowMap.delete(key); } });
      let prev = null;
      rows.forEach((r) => {
        let row = rowMap.get(r.key);
        const isNew = !row;
        if (isNew) {
          row = h('div', 'fc-row', `<span class="fc-g">${gut(r.k)}</span><span class="fc-code"></span>`);
          row.dataset.k = r.k;
          row._text = '';
          row._key = r.key;
          rowMap.set(r.key, row);
        }
        const next = prev ? prev.nextSibling : rowsEl.firstChild;
        if (row !== next) rowsEl.insertBefore(row, next);
        updateRow(row, r, isNew);
        prev = row;
      });
      if (M.legacy) return;
      rowMap.forEach((row, key) => {
        if (!before.has(key)) return;
        if (!stable.has(key)) {
          if (before.get(key) !== row.offsetTop) M.animate(row, [{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: 130, easing: M.ease.out });
          return;
        }
        const d = before.get(key) - row.offsetTop;
        if (Math.abs(d) > 0.5) M.animate(row, [{ transform: `translateY(${d}px)` }, { transform: 'translateY(0)' }], { spring: 'snap', composite: 'add' });
      });
    }
    function layout() {
      const natural = rowsEl.offsetHeight;
      const target = Math.min(natural, (expanded ? 24 : 8) * ROW_H);
      if (M.legacy) {
        view.style.transition = 'height calc(280ms * var(--ts)) cubic-bezier(.22,1,.36,1)';
        view.style.height = `${target}px`;
        if (following) requestAnimationFrame(() => { view.scrollTop = view.scrollHeight; prog = view.scrollTop; });
        return;
      }
      view.style.transition = '';
      viewH.to(target);
      if (following) {
        if (!scrollS.active) scrollS.sync(view.scrollTop);
        scrollS.configure({ omega: 16 });
        scrollS.to(Math.max(0, natural - target));
      }
    }
    function setCount(b, n) { if (b.textContent !== String(n)) M.swapText(b, String(n)); }
    function pause() {
      if (!following) return;
      following = false;
      el.dataset.paused = 'true';
      scrollS.stop();
      if (rowMap.size && view.scrollHeight > view.clientHeight + 2) { latestBtn.hidden = false; enter(latestBtn, [{ opacity: 0, transform: 'translateX(4px)' }, { opacity: 1, transform: 'none' }], { spring: 'snap' }); }
    }
    function resume() {
      following = true;
      el.dataset.paused = 'false';
      el.dispatchEvent(new Event('fc-unpin', { bubbles: true }));
      if (!latestBtn.hidden) exit(latestBtn, [{ opacity: 1 }, { opacity: 0 }]).then(() => { if (following) latestBtn.hidden = true; });
      if (M.legacy) latestBtn.hidden = true;
    }
    view.addEventListener('wheel', (e) => e.deltaY < 0 && pause(), { passive: true });
    view.addEventListener('pointerdown', pause);
    view.addEventListener('keydown', (e) => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) pause(); });
    view.addEventListener('scroll', () => {
      if (Math.abs(view.scrollTop - prog) <= 2) return;
      if (view.scrollHeight - view.clientHeight - view.scrollTop <= 2) resume();
    }, { passive: true });
    latestBtn.addEventListener('click', () => { resume(); layout(); });
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      el.dataset.expanded = String(expanded);
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.dataset.tip = toggle.ariaLabel = expanded ? '收起预览' : '展开修改';
      [prevBtn, nextBtn].forEach((b, i) => {
        if (expanded && nAdd + nDel) { b.hidden = false; enter(b, [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { spring: 'snap', delay: i * 20 }); }
        else b.hidden = true;
      });
      layout();
      if (!expanded) el.dispatchEvent(new Event('fc-unpin', { bubbles: true }));
    });
    // 上一处 / 下一处：内部滚动用 travel 弹簧滑到变更起点，并短暂提亮落点
    function navigate(dir) {
      const rows = [...rowsEl.children];
      const changed = (r) => r && (r.dataset.k === 'add' || r.dataset.k === 'remove');
      const starts = rows.filter((r, i) => changed(r) && !changed(rows[i - 1]));
      const top = view.scrollTop + 2;
      const target = dir > 0 ? starts.find((r) => r.offsetTop > top) : [...starts].reverse().find((r) => r.offsetTop < top - 4);
      if (!target) return;
      pause();
      scrollS.sync(view.scrollTop);
      scrollS.configure({ token: 'travel' });
      scrollS.to(Math.max(0, Math.min(view.scrollHeight - view.clientHeight, target.offsetTop - ROW_H)), { instant: M.legacy });
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
      setTimeout(() => target.classList.remove('flash'), 950 * M.ts);
    }
    prevBtn.addEventListener('click', () => navigate(-1));
    nextBtn.addEventListener('click', () => navigate(1));
    rawBtn.addEventListener('click', () => M.resize(el, () => { raw.hidden = !raw.hidden; }, { crossfade: false }));
    nameBtn.addEventListener('click', () => onOpen && onOpen(path));

    function setPhase(p) {
      if (p === phase) return;
      phase = p;
      el.dataset.phase = p;
      M.swapText(phaseEl, FC_PHASE[p]);
      if (p === 'applied' || p === 'preview' || p === 'failed' || p === 'draft') {
        iconSlot.innerHTML = icon(p === 'failed' ? 'close' : 'file-code');
        enter(iconSlot.firstElementChild, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
        nameBtn.disabled = !path || p === 'failed';
      }
    }
    const api = {
      el,
      get phase() { return phase; },
      counts: () => ({ add: nAdd, del: nDel }),
      setPhase,
      setRaw(text) { raw.textContent = text; },
      // 整文件写入没有修改前的内容，不显示 +/− 计数，底部注明「写入内容预览」
      markWrite() {
        el.dataset.write = 'true';
        const hint = h('span', 'fc-hint', '写入内容预览');
        hint.title = '这是整文件写入内容，尚未与原文件比较。';
        phaseEl.after(hint);
      },
      update({ path: p, rows }) {
        if (p && p !== path) {
          path = p;
          M.swapText(nameBtn, p.split('/').at(-1));
          nameBtn.title = p;
          view.setAttribute('aria-label', `${p} 的修改`);
        }
        reconcile(rows);
        nAdd = rows.filter((r) => r.k === 'add').length;
        nDel = rows.filter((r) => r.k === 'remove').length;
        if (rows.length && counts.hidden && el.dataset.write !== 'true') { counts.hidden = false; enter(counts, [{ opacity: 0, transform: 'translateX(-4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' }); }
        setCount(addN, nAdd);
        setCount(delN, nDel);
        const empty = $('.fc-empty', el);
        if (rows.length && empty) { if (M.legacy) empty.remove(); else exit(empty, [{ opacity: 1 }, { opacity: 0 }], { duration: 90 }).then(() => empty.remove()); }
        layout();
      },
    };
    el._fc = api;
    return api;
  }

  // 一次文件修改：参数流 → 正在应用 → 已应用。过程行标签与卡片同步。
  let fileSeq = 0;
  async function fileStep(act, run, spec) {
    const id = `f${++fileSeq}`;
    const editSegs = spec.kind === 'edit' ? spec.edits.flatMap((e, ei) => [{ f: 'old', ei, t: e.old }, { f: 'new', ei, t: e.new }]) : [];
    const pathSeg = { f: 'path', t: spec.path };
    const segs = spec.kind === 'edit' ? (spec.pathLast ? [...editSegs, pathSeg] : [pathSeg, ...editSegs])
      : spec.kind === 'write' ? [pathSeg, { f: 'content', t: spec.content }] : [{ f: 'patch', t: spec.patch }];
    const total = segs.reduce((n, s) => n + s.t.length, 0);
    let card = null;
    const host = () => (act.host ? act.host() : act.body || act);
    const ensure = () => {
      if (card) return card;
      card = FileChange(host(), { onOpen: () => openSurface('editor') });
      if (spec.kind === 'write') card.markWrite();
      return card;
    };
    let last = '';
    const label = (s, busy = true) => {
      if (s === last) return;
      last = s;
      if (act.status) act.status(id, s, busy); else act.live(s, { busy });
    };
    if (act.trayStart) act.trayStart();
    label(spec.kind === 'write' ? '准备写入文件' : '准备修改文件');
    if (spec.kind === 'edit') ensure();
    const project = (n) => {
      if (spec.kind === 'patch') return projectPatch(spec.patch.slice(0, n), n >= total);
      if (spec.kind === 'write') {
        const p = n >= pathSeg.t.length;
        const text = spec.content.slice(0, Math.max(0, n - pathSeg.t.length));
        const lines = text.split('\n');
        const done = n >= total;
        if (done && lines.at(-1) === '') lines.pop();
        return { path: p ? spec.path : '', rows: text ? lines.map((t, i) => ({ key: `w${i}`, k: 'add', t, pending: !done && i === lines.length - 1 })) : [] };
      }
      let rest = n;
      const st = segs.map((s) => { const take = Math.min(rest, s.t.length); rest -= take; return { ...s, text: s.t.slice(0, take), done: take === s.t.length, started: take > 0 }; });
      const find = (f, ei) => st.find((s) => s.f === f && (ei === undefined || s.ei === ei));
      const rows = [];
      spec.edits.forEach((e, ei) => {
        const o = find('old', ei), nw = find('new', ei);
        if (!o.started) return;
        if (ei > 0 && rows.length) rows.push({ key: `h${ei}`, k: 'hunk', t: '…' });
        rows.push(...projectEdit(ei, o.text, o.done, o.done && nw.started ? nw.text : null, nw.done));
      });
      // 路径只有完整到达后才成为可打开的文件身份
      return { path: find('path').done ? spec.path : '', rows };
    };
    const verb = spec.kind === 'write' ? '写入文件' : '修改文件';
    try {
      await pace(run, total, (n) => {
        const p = project(n);
        if (p.path) label(`准备${verb} · ${p.path}`);
        if (p.path || spec.kind === 'edit') ensure().update(p);
      }, { seed: spec.seed });
      if (spec.onStreamed) spec.onStreamed();
      card.setRaw(spec.kind === 'edit' ? `file_edit\n{ "path": "${spec.path}", "edits": [${spec.edits.length} 处替换] }` : spec.kind === 'write' ? `file_write\n{ "path": "${spec.path}", "content": "…" }` : `apply_patch\n*** Update File: ${spec.path}`);
      label(`正在${verb} · ${spec.path}`);
      card.setPhase('applying');
      await M.sleep(spec.applyMs || 420, run);
      card.setPhase('applied');
      const c = card.counts();
      if (act.count) act.count('changes');
      label(`${verb}完成 · ${spec.path}`, false);
      gitAdd(spec.path, c.add, c.del);
      bumpCtx(run.thread, 0.03);
      return card;
    } finally {
      if (act.trayDone) act.trayDone();
    }
  }

  // ---------------- 派发：成员行 ----------------
  const STATE_TEXT = { starting: '启动中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消' };
  function Dispatch(parent) {
    const el = h('div', 'dispatch');
    el.innerHTML = '<div class="dispatch-label"><span class="swap dl"><span class="swap-cur">已分派 1 个任务</span></span></div>';
    parent.append(el);
    enter(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: M.ease.out });
    let n = 0;
    return {
      el,
      add({ name, task, avatarId }) {
        n++;
        if (n > 1) M.swapText($('.dl', el), `已分派 ${n} 个任务`);
        const m = h('div', 'member');
        m.dataset.open = 'false';
        m.dataset.state = 'starting';
        m.innerHTML = `<button class="member-line" type="button" aria-expanded="false">${avatar(avatarId)}<span class="member-name">${esc(name)}</span><span class="member-task">${esc(task)}</span><span class="member-state"><span class="spin"></span><span class="swap ms"><span class="swap-cur">启动中</span></span></span>${icon('chev-right', 't-chev')}</button><div class="member-detail"><p style="margin:0">${esc(task)}</p><div class="inline-actions"><button type="button">查看会话 ${icon('external')}</button><button type="button">停止任务</button></div></div>`;
        el.append(m);
        enter(m, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
        const av = $('.avatar', m);
        enter(av, [{ transform: 'scale(.4) rotate(-12deg)' }, { transform: 'none' }], { spring: 'settle', delay: 40 });
        const line = $('.member-line', m);
        line.addEventListener('click', () => {
          const open = m.dataset.open !== 'true';
          M.resize(m, () => { m.dataset.open = String(open); line.setAttribute('aria-expanded', String(open)); }, { crossfade: false });
        });
        m._set = (state) => {
          m.dataset.state = state;
          const st = $('.member-state', m);
          const sp = $('.spin', st);
          if (state !== 'starting' && state !== 'running' && sp) exit(sp, [{ opacity: 1 }, { opacity: 0, transform: 'scale(.6)' }]).then(() => sp.remove());
          M.swapText($('.ms', m), STATE_TEXT[state]);
          setMemberState(name, STATE_TEXT[state]);
        };
        return m;
      },
    };
  }

  // ---------------- 任务回复：两行预览折叠 ----------------
  function AgentMessage(parent, { from, to, avatarId, kind = '任务回复', status = '已完成', preview, body, file, outgoing = false }) {
    const el = h('article', 'agent-msg');
    el.dataset.open = 'false';
    el.innerHTML = `${avatar(avatarId, 26)}<div class="agent-msg-col"><div class="agent-msg-route"><b>${esc(from)}</b>${icon('arrow-right')}<span>${esc(to)}</span></div><div class="agent-msg-bubble"><button class="agent-msg-toggle" type="button" aria-expanded="false"><span class="agent-msg-heading"><span>${esc(kind)}</span><span>${esc(status)}</span>${icon('chev-down')}</span><span class="agent-msg-preview">${esc(preview)}</span></button><div class="agent-msg-content">${body}${file ? `<div class="agent-msg-file"><span class="ft">TS</span>${esc(file)}</div>` : ''}</div></div></div>`;
    el.dataset.outgoing = String(outgoing);
    parent.append(el);
    enter(el, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
    const toggle = $('.agent-msg-toggle', el);
    toggle.addEventListener('click', () => {
      const open = el.dataset.open !== 'true';
      // 预览与正文一起过渡：旧外观交叉淡出，高度只提交一次
      M.resize(el, () => { el.dataset.open = String(open); toggle.setAttribute('aria-expanded', String(open)); });
    });
    return el;
  }

  // ---------------- 轮末：左操作，右用量 ----------------
  function turnFooter(actions, usage, isStatic, parent) {
    const el = h('div', 'turn-footer');
    const icons = { 复制: 'copy', 重试: 'redo', 有帮助: 'thumb' };
    el.innerHTML = `<div class="turn-actions">${actions.map((a) => `<button type="button" data-tip="${a}" aria-label="${a}">${icon(icons[a])}</button>`).join('')}</div><div class="turn-usage"><span>输入 <b data-n="${usage.input}">${fmtK(usage.input)}</b></span><span>输出 <b data-n="${usage.output}">${fmtK(usage.output)}</b></span><span><b data-n="${usage.speed}">${usage.speed}</b> tok/s</span></div>`;
    $$('b', el).forEach((b) => (b.style.fontWeight = '400'));
    if (isStatic) return el;
    parent.append(el);
    [...$('.turn-actions', el).children].forEach((c, i) => enter(c, [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: i * 24 }));
    enter($('.turn-usage', el), [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 80, easing: M.ease.out });
    $$('b', el).forEach((b, i) => M.countTo(b, +b.dataset.n, { duration: 640, format: i === 2 ? (n) => String(Math.round(n)) : fmtK }));
    return el;
  }

  // ---------------- 剧本 ----------------
  const fileRow = (path, range) => `<button type="button" class="file-link"><span class="ft">TS</span><span>${esc(path)}</span><span class="line-no">${esc(range)}</span></button>`;
  const SEARCH_DETAIL = `${fileRow('src/auth/login.ts', 'L42')}<pre class="snippet">  const token = <span class="hit">localStorage.getItem("login")</span>;</pre>${fileRow('src/auth/LoginForm.tsx', 'L118')}<pre class="snippet">  <span class="hit">onLogin</span>(form.values);</pre>`;
  const READ_DETAIL = (path, range) => `${fileRow(path, range)}`;
  const EDIT_LOGIN = [
    {
      old: 'export function useLoginFlow() {\n  const token = localStorage.getItem("login");\n  if (!token) redirectToLegacy();\n  const [state, setState] = useState<LoginState>({ kind: "idle" });\n',
      new: 'export function useLoginFlow() {\n  const [state, setState] = useState<LoginState>({ kind: "idle" });\n',
    },
    {
      old: '    try {\n      const res = await api.login(form);\n      localStorage.setItem("login", res.token);\n      setState({ kind: "done", session: res });\n    } catch (error) {\n      setState({ kind: "failed", message: String(error) });\n',
      new: '    try {\n      const session = await refreshOnce(() => api.login(form));\n      setState({ kind: "done", session });\n    } catch (error) {\n      setState({ kind: "failed", message: mapAuthError(error) });\n',
    },
  ];
  const PATCH_SESSION = '*** Begin Patch\n*** Update File: src/auth/session.ts\n@@ export function readSession\n export function readSession(): Session | undefined {\n-  return JSON.parse(localStorage.getItem("login") ?? "null");\n+  return store.read();\n }\n+\n+let inflight: Promise<Session> | undefined;\n+export function refreshOnce(run: () => Promise<Session>) {\n+  inflight ??= run().finally(() => (inflight = undefined));\n+  return inflight;\n+}\n*** End Patch\n';
  const WRITE_TEST = 'import { describe, expect, it } from "bun:test";\nimport { refreshOnce } from "../src/auth/session";\n\ndescribe("refreshOnce", () => {\n  it("shares one inflight request", async () => {\n    let calls = 0;\n    const run = () => Promise.resolve(++calls);\n    await Promise.all([refreshOnce(run), refreshOnce(run)]);\n    expect(calls).toBe(1);\n  });\n});\n';
  const EDIT_FORM = [{
    old: '  <Button type="submit">登录</Button>\n',
    new: '  <Button type="submit" disabled={state.kind === "submitting"}>\n    {state.kind === "submitting" ? "正在登录…" : "登录"}\n  </Button>\n',
  }];
  const DEMO_ANSWER = `### 重构完成，测试全部通过
登录模块拆成了三层：\`LoginForm\` 只管表单状态，\`useLoginFlow\` 负责提交、重试和错误映射，\`session.ts\` 统一读取和刷新令牌。原来散在组件里的 4 处 \`localStorage\` 访问都收进了 \`session.ts\`。
- 提交前先做本地校验，服务端错误码映射成可读提示
- 令牌刷新改成单飞，并发请求不会重复刷新
- 移除了没人调用的 \`legacyRedirect\` 分支
调用方现在统一这样拿会话：
\`\`\`ts
const session = await refreshOnce(() => api.login(form));
if (!session) return redirectToLogin();
\`\`\`
验证测试跑了 \`bun test auth\`：24 项全部通过；调用方检查确认 3 处调用都已迁移。需要的话，我可以接着给 \`useLoginFlow\` 补一条端到端用例。`;

  async function toolStep(act, run, step) {
    act.live(step.live);
    const el = Tool(act.body || act, step);
    const t0 = performance.now();
    await M.sleep(step.ms, run);
    // 标签至少停留 260ms，快速完成的读取也能被看清
    const shown = (performance.now() - t0) / M.ts;
    if (shown < 260 && !M.legacy) await M.sleep(260 - shown, run);
    setToolState(el, 'done', step.receipt);
    if (act.count) act.count(step.count);
    act.live(step.finished, { busy: false });
    if (step.onDone) step.onDone();
    bumpCtx(run.thread, 0.035);
    return el;
  }
  const quiet = { live() {}, count() {} };

  async function demoScript(t, live, run) {
    await stream(live, run, '好的，我先看看登录模块现在的结构，再决定怎么拆。', 3);
    const a1 = Activity(live);
    const th = Thinking(a1.body);
    a1.live('正在思考…', { thinking: true });
    const thought = '要重构登录模块并跑测试。先搜 login 找入口，再读 login.ts 和 session.ts，确认令牌读写散在哪里。改完交给两个子 Agent：一个跑 bun test auth，一个检查调用方，主流程不用干等。';
    for (let i = 0; i < thought.length; i += 3) {
      const acc = thought.slice(0, i + 3);
      th.append(thought.slice(i, i + 3), acc);
      a1.think(acc);
      await M.sleep(40, run);
    }
    bumpCtx(t, 0.04);
    await M.sleep(220, run);
    await toolStep(a1, run, { icon: 'search', verb: '搜索', subject: 'login', ms: 620, receipt: '9 处命中', count: 'searches', live: '正在搜索文件 · login', finished: '搜索文件完成 · login', detail: SEARCH_DETAIL });
    await toolStep(a1, run, { icon: 'file', verb: '读取', subject: 'src/auth/login.ts', mono: true, ms: 520, receipt: 'L1–182', count: 'reads', live: '正在读取文件 · src/auth/login.ts', finished: '读取文件完成 · src/auth/login.ts', detail: READ_DETAIL('src/auth/login.ts', 'L1–182') });
    await toolStep(a1, run, { icon: 'file', verb: '读取', subject: 'src/auth/session.ts', mono: true, ms: 180, receipt: 'L1–64', count: 'reads', live: '正在读取文件 · src/auth/session.ts', finished: '读取文件完成 · src/auth/session.ts', detail: READ_DETAIL('src/auth/session.ts', 'L1–64') });
    // 下一段发言到达：过程行原位换成回执摘要
    await stream(live, run, '令牌的读写散在组件里 4 处。我把它们收进 `session.ts`，再派两个 Agent 分别跑测试、检查调用方。', 5, { onStart: () => a1.settle() });
    const a2 = Activity(live);
    // 第一批：单个文件。file_edit 的 edits 先到、path 后到，写完停留片刻后收回过程行
    await fileStep(a2, run, { kind: 'edit', path: 'src/auth/login.ts', pathLast: true, seed: 21, edits: EDIT_LOGIN });
    await M.sleep(1300, run);
    // 第二批：两个文件重叠。session.ts 还在应用时测试文件已开始写入，二者都完成后一起收回
    let streamed;
    const patchStreamed = new Promise((r) => (streamed = r));
    const pB = fileStep(a2, run, { kind: 'patch', path: 'src/auth/session.ts', seed: 23, patch: PATCH_SESSION, applyMs: 1100, onStreamed: streamed });
    await patchStreamed;
    await M.sleep(120, run);
    const pC = fileStep(a2, run, { kind: 'write', path: 'tests/auth.refresh.test.ts', seed: 27, content: WRITE_TEST, applyMs: 380 });
    await Promise.all([pB, pC]);
    await M.sleep(1100, run);
    a2.settle();
    // 派发与成员消息独立成行，不进入折叠
    const d = Dispatch(live);
    const m1 = d.add({ name: '验证测试', task: '运行 bun test auth，汇报失败用例', avatarId: 'pebble-blue' });
    addMember('验证测试', 'pebble-blue');
    addFeed({ from: '主 Agent', to: '验证测试', avatarId: 'notch-ochre', kind: '派发任务', status: '已送达', preview: '运行 bun test auth，汇报失败用例。只读，不改文件。', body: '<p>运行 bun test auth，汇报失败用例。只读，不改文件。</p>' });
    await M.sleep(280, run);
    const m2 = d.add({ name: '调用方检查', task: '检查令牌刷新的所有调用方', avatarId: 'slant-mint' });
    addMember('调用方检查', 'slant-mint');
    addFeed({ from: '主 Agent', to: '调用方检查', avatarId: 'notch-ochre', kind: '派发任务', status: '已送达', preview: '检查 refreshOnce 之外是否还有直接刷新令牌的调用方。', body: '<p>检查 refreshOnce 之外是否还有直接刷新令牌的调用方。</p>' });
    await M.sleep(420, run);
    m1._set('running');
    await M.sleep(180, run);
    m2._set('running');
    await M.sleep(1500, run);
    m2._set('completed');
    const r2 = { from: '调用方检查', to: '主 Agent', avatarId: 'slant-mint', preview: '找到 3 处调用：LoginForm、SessionGuard 和 api/client。三处都已改走 refreshOnce，没有遗漏的直接刷新。', body: '<p>找到 3 处调用：<code class="code-inline">LoginForm</code>、<code class="code-inline">SessionGuard</code> 和 <code class="code-inline">api/client</code>。</p><p>三处都已改走 refreshOnce，没有遗漏的直接刷新。</p>', file: 'src/api/client.ts' };
    AgentMessage(live, r2);
    addFeed(r2);
    bumpCtx(t, 0.05);
    await M.sleep(900, run);
    m1._set('completed');
    const r1 = { from: '验证测试', to: '主 Agent', avatarId: 'pebble-blue', preview: '24 项测试全部通过；新增的 6 项覆盖刷新竞态与错误映射，没有回归。', body: '<p>24 项测试全部通过；新增的 6 项覆盖刷新竞态与错误映射，没有回归。</p><p><code class="code-inline">bun test auth</code> · 2.1 秒 · 退出码 0</p>', file: 'tests/auth.test.ts' };
    AgentMessage(live, r1);
    addFeed(r1);
    terminalLog.push('$ bun test auth', '✓ session › refreshOnce shares inflight request', '✓ login › maps server error codes', '✓ login › keeps form values after failure', '24 pass · 0 fail · 2.1s');
    bumpCtx(t, 0.05);
    await M.sleep(320, run);
    await stream(live, run, DEMO_ANSWER, 7);
    setMemberState('主 Agent', '空闲');
    return { input: 18240, output: 1630, speed: 42 };
  }

  const GENERIC = [
    { lead: '我先确认一下现状。', tool: { icon: 'file', verb: '读取', subject: 'src/auth/session.ts', mono: true, ms: 480, receipt: 'L1–64', live: '', finished: '', detail: READ_DETAIL('src/auth/session.ts', 'L1–64') },
      answer: '`session.ts` 里的刷新已经是单飞的，这一步不用再改。\n如果想让错误提示更具体，可以在 `useLoginFlow` 里集中映射服务端错误码，组件只拿可读文案。要我直接动手吗？' },
    { lead: '这个改动不大，我只动提交按钮的状态。', file: { kind: 'edit', path: 'src/auth/LoginForm.tsx', seed: 31, edits: EDIT_FORM },
      answer: '- 提交中禁用按钮并显示进度\n- 失败后保留输入，焦点回到出错的字段\n改完我会再跑一遍 `bun test auth`，确认没有回归。' },
  ];
  // 单个活动直接渲染原工具行或修改卡片，不再套一层摘要
  async function genericScript(t, live, run) {
    const pick = GENERIC[t.sends % GENERIC.length];
    await stream(live, run, pick.lead, 13 + t.sends);
    const host = { body: live, live() {}, count() {} };
    if (pick.file) await fileStep(host, run, pick.file);
    else await toolStep(host, run, pick.tool);
    await stream(live, run, pick.answer, 17 + t.sends);
    return { input: 9600 + t.sends * 800, output: 420, speed: 39 };
  }

  // ---------------- 上下文环 ----------------
  const ctxArc = $('#ctxArc');
  const ctxRing = $('#ctxRing');
  let ctxShown = 0;
  function setCtxUsage(v) {
    const from = ctxShown;
    ctxShown = v;
    ctxRing.dataset.empty = String(v <= 0);
    ctxRing.dataset.tip = `上下文 · ${Math.round(v * 100)}%`;
    const pct = $('#ctxPct');
    if (!full()) { ctxArc.style.strokeDasharray = `${v * 100} 100`; pct.textContent = `${Math.round(v * 100)}%`; return; }
    const t0 = performance.now();
    const D = 520 * M.ts;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / D);
      const x = from + (v - from) * M.curve.glide(p);
      ctxArc.style.strokeDasharray = `${(x * 100).toFixed(2)} 100`;
      pct.textContent = `${Math.round(x * 100)}%`;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  function bumpCtx(t, d) {
    t.ctx = Math.min(0.92, (t.ctx || 0.06) + d);
    if (t === current) setCtxUsage(t.ctx);
  }

  // ---------------- 协作 / Git / 终端 状态 ----------------
  const members = [{ name: '主 Agent', avatarId: null, state: '运行中' }];
  const feedItems = [];
  const gitFiles = [];
  const terminalLog = [];
  function addMember(name, avatarId) {
    members.push({ name, avatarId, state: '启动中' });
    renderSurface('threads', true);
    if (!panelOpen || activeSurface !== 'threads') railMark('threads');
  }
  function setMemberState(name, state) {
    const m = members.find((x) => x.name === name);
    if (!m) return;
    m.state = state;
    const row = $(`.member-row[data-name="${name}"] .state`);
    if (row) M.swapText(row, state);
  }
  function addFeed(msg) {
    feedItems.push(msg);
    const feed = $('.surface[data-surface="threads"] .feed');
    if (feed) {
      AgentMessage(feed, Object.assign({}, msg, { outgoing: msg.from === '主 Agent' }));
      const s = feed.closest('.surface');
      s.scrollTo({ top: s.scrollHeight, behavior: full() ? 'smooth' : 'auto' });
    }
  }
  function gitAdd(path, add, del) {
    gitFiles.push({ path, add, del });
    railBadge('git', gitFiles.length);
    renderSurface('git', true);
  }

  // ---------------- 右侧导轨与面板 ----------------
  const RAIL = [
    { id: 'threads', icon: 'chats', label: '协作', desc: '成员交流、文件交接与 Agent 对话' },
    { id: 'context', icon: 'donut', label: '上下文', desc: '会话上下文与 token 用量' },
    { id: 'recovery', icon: 'history', label: '恢复', desc: '工作区检查点与对话联合恢复' },
    { id: 'git', icon: 'git-branch', label: 'Git', desc: '提交、分支和拉取请求' },
    { id: 'editor', icon: 'file-code', label: '文件', desc: '编辑项目文件' },
    { id: 'terminal', icon: 'terminal', label: '终端', desc: '内置终端' },
  ];
  const rail = $('#rail');
  const railInd = $('#railInd');
  const ctxPanel = $('#ctxPanel');
  const panelTabs = $('#panelTabs');
  const panelBody = $('#panelBody');
  const tabInk = $('#tabInk');
  let panelOpen = false;
  let activeSurface = null;
  const openTabs = [];
  RAIL.forEach((r) => {
    const b = h('button', '', icon(r.icon));
    b.type = 'button';
    b.dataset.surface = r.id;
    b.dataset.tip = r.label;
    b.dataset.tipSide = 'left';
    b.setAttribute('aria-label', r.label);
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => (panelOpen && activeSurface === r.id ? setPanel(false) : openSurface(r.id)));
    rail.append(b);
  });
  const railY = new M.Spring(0, { token: 'glide', restDelta: 0.2, onUpdate: (y) => (railInd.style.transform = `translateY(${y}px)`) });
  function placeRail(instant) {
    const b = panelOpen && $(`button[data-surface="${activeSurface}"]`, rail);
    $$('button', rail).forEach((n) => n.setAttribute('aria-pressed', String(n === b)));
    if (!b) { railInd.classList.remove('on'); return; }
    const y = b.offsetTop + 8;
    if (!railInd.classList.contains('on')) railY.jump(y); else railY.to(y, { instant: instant || M.legacy });
    railInd.classList.add('on');
  }
  function railBadge(id, n) {
    const b = $(`button[data-surface="${id}"]`, rail);
    let badge = $('.rail-badge', b);
    if (!n) { if (badge) badge.remove(); return; }
    if (!badge) { badge = h('span', 'rail-badge'); b.append(badge); }
    badge.textContent = String(n);
    enter(badge, [{ transform: 'scale(.4)' }, { transform: 'scale(1)' }], { spring: 'settle' });
    b.dataset.tip = `${n} 个更改的文件`;
  }
  function railMark(id) {
    const b = $(`button[data-surface="${id}"]`, rail);
    if ($('.rail-dot', b)) return;
    const d = h('span', 'rail-dot');
    b.append(d);
    enter(d, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { spring: 'settle' });
  }

  // 面板宽度由弹簧驱动（可打断）；打开时主列先锁定到最终宽度，文字只重排一次
  const PANEL_W = 400;
  let colLocked = [];
  const panelW = new M.Spring(0, {
    token: 'glide', restDelta: 0.5, restSpeed: 6,
    onUpdate: (w) => {
      ctxPanel.style.width = `${w}px`;
      ctxPanel.style.marginLeft = `${Math.min(6, w * 0.05)}px`;
      if (!panelW.active) {
        colLocked.forEach((e) => (e.style.width = ''));
        colLocked = [];
        if (w < 1) ctxPanel.hidden = true;
      }
    },
  });
  panelW.jump(0);
  function setPanel(open) {
    panelOpen = open;
    $('#panelToggle').setAttribute('aria-pressed', String(open));
    if (open) {
      ctxPanel.hidden = false;
      const finalCanvas = canvas.offsetWidth + panelW.x + Math.min(6, panelW.x * 0.05) - (PANEL_W + 6);
      const col = Math.min(960, finalCanvas);
      colLocked = [current && current.timeline, $('.dock-col')].filter(Boolean);
      colLocked.forEach((e) => (e.style.width = `${col}px`));
      enter(ctxPanel.firstElementChild, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 60, easing: M.ease.out });
    }
    panelW.to(open ? PANEL_W : 0, { instant: M.legacy });
    placeRail();
  }
  $('#panelToggle').addEventListener('click', () => (panelOpen ? setPanel(false) : openSurface(activeSurface || 'threads')));
  $('#panelClose').addEventListener('click', () => setPanel(false));

  const tabX = new M.Spring(0, { token: 'glide', restDelta: 0.2, onUpdate: (v) => (tabInk.style.transform = `translateX(${v}px)`) });
  const tabWd = new M.Spring(0, { token: 'glide', restDelta: 0.2, onUpdate: (v) => (tabInk.style.width = `${v}px`) });
  function renderTabs() {
    $$('.panel-tab', panelTabs).forEach((n) => { if (!openTabs.includes(n.dataset.surface)) n.remove(); });
    openTabs.forEach((id) => {
      if ($(`.panel-tab[data-surface="${id}"]`, panelTabs)) return;
      const r = RAIL.find((x) => x.id === id);
      const b = h('button', 'panel-tab', `${icon(r.icon)}<span>${r.label}</span>`);
      b.type = 'button';
      b.dataset.surface = id;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => openSurface(id));
      panelTabs.append(b);
      enter(b, [{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
    });
    $$('.panel-tab', panelTabs).forEach((n) => n.setAttribute('aria-selected', String(n.dataset.surface === activeSurface)));
    requestAnimationFrame(() => {
      const a = $(`.panel-tab[data-surface="${activeSurface}"]`, panelTabs);
      if (!a) return;
      const fresh = !tabInk.classList.contains('on');
      tabX.to(a.offsetLeft, { instant: fresh || M.legacy });
      tabWd.to(a.offsetWidth, { instant: fresh || M.legacy });
      tabInk.classList.add('on');
    });
  }
  function openSurface(id) {
    const prev = activeSurface;
    if (!openTabs.includes(id)) openTabs.push(id);
    activeSurface = id;
    const dot = $(`button[data-surface="${id}"] .rail-dot`, rail);
    if (dot) exit(dot, [{ transform: 'scale(1)' }, { transform: 'scale(0)' }]).then(() => dot.remove());
    renderTabs();
    const wasOpen = panelOpen;
    if (!panelOpen) setPanel(true); else placeRail();
    if (prev !== id || !wasOpen) showSurface(id, wasOpen && prev && prev !== id);
  }
  function showSurface(id, crossfade) {
    const old = $('.surface', panelBody);
    const el = buildSurface(id);
    if (old && crossfade) {
      old.classList.add('leaving');
      exit(old, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }]).then(() => old.remove());
      if (M.legacy) old.remove();
    } else if (old) old.remove();
    panelBody.append(el);
    [...el.children].slice(0, 6).forEach((c, i) => enter(c, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: (crossfade ? 50 : 90) + i * 22 }));
  }
  function memberRowsHtml() {
    return members.map((m) => `<div class="member-row" data-name="${esc(m.name)}">${m.avatarId ? avatar(m.avatarId) : `<span class="vlogo">${VARIN}</span>`}<span>${esc(m.name)}</span><span class="state swap"><span class="swap-cur">${esc(m.state)}</span></span></div>`).join('');
  }
  function buildSurface(id) {
    const s = h('div', 'surface');
    s.dataset.surface = id;
    if (id === 'threads') {
      s.innerHTML = `<h4>成员 · <span class="swap mc"><span class="swap-cur">${members.length}</span></span></h4><div class="members-list">${memberRowsHtml()}</div><h4 style="margin-top:18px">消息</h4><div class="feed"></div>`;
      const feed = $('.feed', s);
      if (!feedItems.length) feed.innerHTML = '<p class="muted" style="margin:0">派发任务后，成员之间的交流会出现在这里。</p>';
      feedItems.forEach((m) => AgentMessage(feed, Object.assign({}, m, { outgoing: m.from === '主 Agent' })));
    } else if (id === 'git') {
      s.innerHTML = `<h4>更改 · ${gitFiles.length}</h4><div class="git-list">${gitFiles.map((f) => `<div class="git-file"><span class="ft">TS</span><span class="path">${esc(f.path)}</span><span class="stat"><span style="color:var(--add)">+${f.add}</span> <span style="color:var(--del)">−${f.del}</span></span></div>`).join('') || '<p class="muted" style="margin:0">工作区没有未提交的更改。</p>'}</div><div class="git-commit"><textarea aria-label="提交信息" placeholder="提交信息">refactor(auth): 收拢令牌读写到 session.ts</textarea><div><button class="btn-solid" type="button">提交</button></div></div>`;
    } else if (id === 'context') {
      const used = Math.round(((current && current.ctx) || 0) * 100);
      s.innerHTML = `<h4>上下文用量</h4><div style="font-size:22px;font-weight:600;font-variant-numeric:tabular-nums">${used}%</div><div class="muted">约 ${Math.round(used * 2)}k / 200k tokens</div><div class="ctx-bar"><i style="width:${used * 0.12}%;background:var(--faint)"></i><i style="width:${used * 0.5}%;background:var(--muted)"></i><i style="width:${used * 0.38}%;background:var(--fg);opacity:.7"></i></div><div class="ctx-legend"><span><b style="background:var(--faint)"></b>系统与工具声明<em>${Math.round(used * 0.12)}%</em></span><span><b style="background:var(--muted)"></b>工具结果<em>${Math.round(used * 0.5)}%</em></span><span><b style="background:var(--fg);opacity:.7"></b>对话<em>${Math.round(used * 0.38)}%</em></span></div>`;
    } else if (id === 'recovery') {
      s.innerHTML = `<h4>恢复点</h4>${['本轮开始 · 刚刚', '修改 login.ts 之前', '会话开始'].map((x, i) => `<div class="git-file">${icon('history')}<span class="path">${x}</span><span class="stat">${i === 0 ? '2 个文件' : ''}</span></div>`).join('')}<p class="muted" style="margin-top:12px">恢复会同时回到这个位置的对话与工作区文件。</p>`;
    } else if (id === 'editor') {
      s.innerHTML = `<h4>src/auth</h4><div class="git-file"><span class="ft">TS</span><span class="path">login.ts</span></div><div class="git-file"><span class="ft">TS</span><span class="path">session.ts</span></div><div class="git-file"><span class="ft tsx">TSX</span><span class="path">LoginForm.tsx</span></div><pre class="ide-code" style="padding:10px 0 0;font-size:12px">${CODE.slice(0, 9).map(([l]) => `<span class="ln">${l}</span>`).join('')}</pre>`;
    } else if (id === 'terminal') {
      s.innerHTML = `<h4>bun test auth</h4><pre class="term">${terminalLog.length ? terminalLog.map((l) => (l.startsWith('$') ? `<span class="cmd">${esc(l)}</span>` : l.startsWith('✓') ? `<span class="ok">${esc(l)}</span>` : esc(l))).join('\n') : '还没有运行过命令。'}</pre>`;
    }
    return s;
  }
  // 面板打开时的增量更新：新成员 / 新文件就地进入，不重建整个面板
  function renderSurface(id) {
    const s = $(`.surface[data-surface="${id}"]`, panelBody);
    if (!s || s.classList.contains('leaving')) return;
    if (id === 'threads') {
      const list = $('.members-list', s);
      const before = list.children.length;
      list.innerHTML = memberRowsHtml();
      [...list.children].slice(before).forEach((r) => enter(r, [{ opacity: 0, transform: 'translateY(6px) scale(.98)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' }));
      M.swapText($('.mc', s), String(members.length));
      const feed = $('.feed', s);
      const hint = $('p.muted', feed);
      if (hint) hint.remove();
    } else if (id === 'git') {
      const fresh = buildSurface('git');
      s.replaceChildren(...fresh.children);
      const rows = $$('.git-file', s);
      if (rows.length) enter(rows[rows.length - 1], [{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
    }
  }

  // ---------------- 弹出菜单：原点落在触发按钮上 + 悬停胶囊 ----------------
  const menu = $('#menu');
  const menuPill = $('.menu-pill', menu);
  let menuState = null;
  const pillY = new M.Spring(0, { token: 'snap', restDelta: 0.2, onUpdate: (v) => (menuPill.style.transform = `translateY(${v}px)`) });
  function movePill(i, instant) {
    if (!menuState || !menuState.buttons[i]) return;
    menuState.active = i;
    const b = menuState.buttons[i];
    menuPill.style.height = `${b.offsetHeight}px`;
    pillY.to(b.offsetTop, { instant: instant || !menuPill.classList.contains('on') || M.legacy });
    menuPill.classList.add('on');
  }
  function openMenu(anchor, items, { side = 'bottom', align = 'start', title, onSelect } = {}) {
    if (menuState && menuState.anchor === anchor) return closeMenu(true);
    if (menuState) closeMenu(false, true);
    $$('.menu-item, .menu-sep, .menu-title', menu).forEach((n) => n.remove());
    menu.getAnimations().forEach((a) => a.cancel());
    if (title) menu.append(h('div', 'menu-title', esc(title)));
    const buttons = [];
    items.forEach((it) => {
      if (it.sep) { menu.append(h('div', 'menu-sep')); return; }
      const b = h('button', `menu-item${it.danger ? ' danger' : ''}`, `${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}${it.desc ? `<span class="desc">${esc(it.desc)}</span>` : ''}</span>${it.checkable ? icon('check', 'check') : ''}`);
      b.type = 'button';
      b.setAttribute('role', it.checkable ? 'menuitemradio' : 'menuitem');
      if (it.checkable) b.setAttribute('aria-checked', String(!!it.checked));
      b.tabIndex = -1;
      b.addEventListener('click', (e) => { closeMenu(true); if (onSelect) onSelect(it, e); });
      b.addEventListener('pointermove', () => movePill(buttons.indexOf(b)));
      menu.append(b);
      buttons.push(b);
    });
    menu.hidden = false;
    menuPill.classList.remove('on');
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.max(8, Math.min(innerWidth - mw - 8, align === 'end' ? r.right - mw : r.left));
    const top = side === 'top' ? r.top - mh - 6 : r.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.transformOrigin = `${Math.max(0, Math.min(mw, r.left + r.width / 2 - left))}px ${side === 'top' ? mh + 6 : -6}px`;
    if (M.legacy) M.animate(menu, [{ opacity: 0, transform: 'scale(.95)' }, { opacity: 1, transform: 'none' }], { duration: 150, easing: 'ease-out' });
    else {
      M.animate(menu, [{ opacity: 0, transform: `translateY(${side === 'top' ? 5 : -5}px) scale(.96)` }, { opacity: 1, transform: 'none' }], { spring: 'snap' });
      buttons.slice(0, 6).forEach((b, i) => M.animate(b, [{ opacity: 0, transform: `translateY(${side === 'top' ? 3 : -3}px)` }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 24 + i * 16 }));
    }
    anchor.setAttribute('aria-expanded', 'true');
    menuState = { anchor, buttons, active: 0 };
    const start = Math.max(0, items.filter((x) => !x.sep).findIndex((x) => x.checked));
    if (buttons[start]) { buttons[start].focus({ preventScroll: true }); movePill(start, true); }
  }
  function closeMenu(focusBack, immediate) {
    if (!menuState) return;
    const { anchor } = menuState;
    menuState = null;
    anchor.setAttribute('aria-expanded', 'false');
    if (immediate) { menu.hidden = true; return; }
    const kf = M.legacy ? [{ opacity: 1 }, { opacity: 0, transform: 'scale(.95)' }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.98)' }];
    M.done(M.animate(menu, kf, M.legacy ? { duration: 150, easing: 'ease', fill: 'forwards' } : { duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' })).then(() => {
      if (!menuState) { menu.hidden = true; menu.getAnimations().forEach((a) => a.cancel()); }
    });
    if (focusBack) anchor.focus({ preventScroll: true });
  }
  menu.addEventListener('keydown', (e) => {
    if (!menuState) return;
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = (menuState.active + (e.key === 'ArrowDown' ? 1 : -1) + menuState.buttons.length) % menuState.buttons.length;
      menuState.buttons[n].focus({ preventScroll: true });
      movePill(n);
    }
  });
  menu.addEventListener('pointerleave', () => menuPill.classList.remove('on'));
  document.addEventListener('pointerdown', (e) => {
    if (menuState && !menu.contains(e.target) && !menuState.anchor.contains(e.target)) closeMenu(false);
  });

  // ---------------- 提示：首次延迟，之后在锚点间滑行 ----------------
  const tip = $('#tooltip');
  let tipAnchor = null, tipVisible = false, tipTimer = 0, tipHideTimer = 0, lastHide = 0;
  const tipPos = { x: 0, y: 0 };
  const placeTip = () => (tip.style.translate = `${tipPos.x}px ${tipPos.y}px`);
  const tipX = new M.Spring(0, { token: 'snap', restDelta: 0.2, onUpdate: (v) => { tipPos.x = v; placeTip(); } });
  const tipY = new M.Spring(0, { token: 'snap', restDelta: 0.2, onUpdate: (v) => { tipPos.y = v; placeTip(); } });
  function showTip(a, warm) {
    if (menuState) return;
    tip.textContent = a.dataset.tip;
    tip.hidden = false;
    const r = a.getBoundingClientRect();
    const side = a.dataset.tipSide || (r.bottom + 44 > innerHeight - 40 ? 'top' : 'bottom');
    let x, y;
    if (side === 'left') { x = r.left - tip.offsetWidth - 8; y = r.top + r.height / 2 - tip.offsetHeight / 2; }
    else {
      x = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2));
      y = side === 'top' ? r.top - tip.offsetHeight - 6 : r.bottom + 6;
    }
    if (tipVisible && warm && !M.legacy) { tipX.to(x); tipY.to(y); }
    else {
      tipX.jump(x); tipY.jump(y);
      const off = side === 'left' ? 'translateX(3px)' : `translateY(${side === 'top' ? 3 : -3}px)`;
      if (!M.legacy) M.animate(tip, [{ opacity: 0, transform: `${off} scale(.96)` }, { opacity: 1, transform: 'none' }], { spring: 'snap' });
    }
    tipVisible = true;
  }
  function hideTip() {
    if (!tipVisible) return;
    tipVisible = false;
    lastHide = performance.now();
    exit(tip, [{ opacity: 1 }, { opacity: 0 }]).then(() => { if (!tipVisible) tip.hidden = true; });
    if (M.legacy) tip.hidden = true;
  }
  document.addEventListener('pointerover', (e) => {
    const a = e.target.closest && e.target.closest('[data-tip]');
    if (!a || a === tipAnchor) return;
    clearTimeout(tipTimer);
    clearTimeout(tipHideTimer);
    tipAnchor = a;
    const warm = !M.legacy && (tipVisible || performance.now() - lastHide < 400 * M.ts);
    if (warm) showTip(a, true);
    else tipTimer = setTimeout(() => tipAnchor === a && showTip(a, false), (M.legacy ? 600 : 520) * M.ts);
  });
  document.addEventListener('pointerout', (e) => {
    const a = e.target.closest && e.target.closest('[data-tip]');
    if (!a || (e.relatedTarget && a.contains(e.relatedTarget))) return;
    clearTimeout(tipTimer);
    tipAnchor = null;
    tipHideTimer = setTimeout(hideTip, (M.legacy ? 300 : 80) * M.ts);
  });
  document.addEventListener('pointerdown', () => { clearTimeout(tipTimer); hideTip(); });

  // ---------------- IDE 工作台 ----------------
  const CODE = [
    ['<span class="k">import</span> { readSession, refreshOnce } <span class="k">from</span> <span class="s">"./session"</span>;', 1],
    ['<span class="k">import</span> { mapAuthError } <span class="k">from</span> <span class="s">"./errors"</span>;', 1],
    ['', 0],
    ['<span class="c">// 提交、重试与错误映射集中在这里，组件只拿可读状态</span>', 1],
    ['<span class="k">export function</span> <span class="f">useLoginFlow</span>() {', 0],
    ['  <span class="k">const</span> [state, setState] = <span class="f">useState</span>&lt;<span class="t">LoginState</span>&gt;({ kind: <span class="s">"idle"</span> });', 0],
    ['  <span class="k">async function</span> <span class="f">submit</span>(form: <span class="t">LoginForm</span>) {', 0],
    ['    <span class="k">const</span> invalid = <span class="f">validate</span>(form);', 1],
    ['    <span class="k">if</span> (invalid) <span class="k">return</span> <span class="f">setState</span>({ kind: <span class="s">"invalid"</span>, field: invalid });', 1],
    ['    <span class="f">setState</span>({ kind: <span class="s">"submitting"</span> });', 0],
    ['    <span class="k">try</span> {', 0],
    ['      <span class="k">const</span> session = <span class="k">await</span> <span class="f">refreshOnce</span>(() =&gt; api.<span class="f">login</span>(form));', 1],
    ['      <span class="f">setState</span>({ kind: <span class="s">"done"</span>, session });', 0],
    ['    } <span class="k">catch</span> (error) {', 0],
    ['      <span class="f">setState</span>({ kind: <span class="s">"failed"</span>, message: <span class="f">mapAuthError</span>(error) });', 1],
    ['    }', 0], ['  }', 0], ['  <span class="k">return</span> { state, submit };', 0], ['}', 0],
  ];
  const rowEl = $('.row');
  const ideLayout = $('#ideLayout');
  const lattice = $('#lattice');
  rowEl.append(ideLayout, lattice);
  function buildIde() {
    const tree = [['folder', 'src', 0], ['folder', 'auth', 1], ['file-code', 'login.ts', 2, true], ['file-code', 'session.ts', 2], ['file-code', 'LoginForm.tsx', 2], ['folder', 'tests', 0], ['file-code', 'auth.test.ts', 1]];
    ideLayout.innerHTML = `<nav class="ide-activity" aria-label="活动栏"><button type="button" aria-pressed="true" aria-label="资源管理器">${icon('file')}</button><button type="button" aria-label="搜索">${icon('search')}</button><button type="button" aria-label="源代码管理">${icon('git-branch')}</button><button type="button" aria-label="终端">${icon('terminal')}</button></nav>
      <div class="ide-tree"><div class="t-title">资源管理器 · VARIN</div>${tree.map(([ic, n, d, a]) => `<div class="row${a ? ' active' : ''}" style="padding-left:${8 + d * 14}px">${icon(ic)}${esc(n)}</div>`).join('')}</div>
      <div class="ide-editor"><div class="ide-tabs"><span class="ide-tab active"><span class="ft">TS</span>login.ts</span><span class="ide-tab"><span class="ft">TS</span>session.ts</span></div><pre class="ide-code">${CODE.map(([l, a]) => `<span class="ln${a ? ' added' : ''}">${l}</span>`).join('')}</pre></div>
      <div class="ide-agent"><div class="ia-head">${icon('chat')}<span>Agent</span></div><div class="ia-body"><div class="user-bubble">把登录模块重构一下</div><p style="margin:0 0 10px">登录模块拆成了三层，令牌读写收进了 <code class="code-inline">session.ts</code>。24 项测试全部通过。</p></div><div class="ia-composer">继续这项工作…</div></div>
      <div class="ide-status"><span>${icon('git-branch')}main</span><span>TypeScript</span><span>UTF-8</span><span class="r">行 12，列 34</span></div>`;
  }
  buildIde();

  let profile = 'agent';
  let wbQueue = Promise.resolve();
  const PROFILES = [{ id: 'agent', label: '工作台', icon: 'workbench' }, { id: 'ide', label: 'IDE', icon: 'code' }, { id: 'bot', label: 'Varin bot', icon: 'bot' }];
  $('#profileBtn').addEventListener('click', (e) => openMenu(e.currentTarget, PROFILES.map((p) => ({ ...p, checkable: true, checked: p.id === profile })), {
    onSelect: (it) => { if (it.id !== 'bot') wbQueue = wbQueue.then(() => switchProfile(it.id)).catch(() => {}); },
  }));
  function swapProfileUi(id) {
    const p = PROFILES.find((x) => x.id === id);
    M.swapText($('#profileLabel'), p.label, { width: true });
    const pill = $('#profileBtn');
    const t = document.createElement('template');
    t.innerHTML = icon(p.icon);
    pill.firstElementChild.replaceWith(t.content.firstChild);
    $('#workspaceBtn').style.display = id === 'agent' ? '' : 'none';
    frame.dataset.profile = id;
  }
  // 晶格波：从切换器向外长满内容区（侧栏与工作区），在完全覆盖的一帧提交，再沿同方向揭开
  async function switchProfile(id) {
    if (id === profile) return;
    profile = id;
    const commit = () => { swapProfileUi(id); ideLayout.hidden = id !== 'ide'; };
    if (M.legacy) return legacySplash(commit);
    if (M.level !== 'full') {
      commit();
      const shown = id === 'ide' ? ideLayout : rowEl;
      await M.done(M.animate(shown, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 }));
      return;
    }
    const sr = rowEl.getBoundingClientRect();
    const k = $('#profileBtn').getBoundingClientRect();
    const size = 44;
    const cols = Math.ceil(sr.width / size);
    const rows = Math.ceil(sr.height / size);
    const ox = k.left + k.width / 2 - sr.left;
    const oy = k.top + k.height / 2 - sr.top;
    lattice.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
    lattice.style.gridAutoRows = `${size}px`;
    const cells = [];
    let maxD = 1;
    const frag = document.createDocumentFragment();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const el = document.createElement('i');
      const d = Math.hypot(c * size + size / 2 - ox, r * size + size / 2 - oy);
      maxD = Math.max(maxD, d);
      cells.push({ el, d });
      frag.append(el);
    }
    lattice.replaceChildren(frag);
    lattice.hidden = false;
    const spread = 230;
    const cover = cells.map(({ el, d }) => M.animate(el, [{ transform: 'scale(0)', opacity: 0.35 }, { transform: 'scale(1.03)', opacity: 1 }], { duration: 150, delay: (d / maxD) * spread, easing: M.ease.out, fill: 'both' }));
    await Promise.all(cover.map(M.done));
    commit();
    M.animate(id === 'ide' ? ideLayout : rowEl, [{ opacity: 0.6, transform: 'scale(.995)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
    const reveal = cells.map(({ el, d }) => M.animate(el, [{ transform: 'scale(1.03)', opacity: 1 }, { transform: 'scale(0)', opacity: 0.2 }], { duration: 170, delay: (d / maxD) * spread, easing: M.ease.exit, fill: 'both' }));
    cover.forEach((a) => a.cancel());
    await Promise.all(reveal.map(M.done));
    lattice.hidden = true;
    lattice.replaceChildren();
  }
  async function legacySplash(commit) {
    const s = $('#legacySplash');
    s.hidden = false;
    await M.done(M.animate(s, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease' }));
    await M.sleep(780);
    commit();
    await M.sleep(780);
    await M.done(M.animate(s, [{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease', fill: 'forwards' }));
    s.hidden = true;
    s.getAnimations().forEach((a) => a.cancel());
  }
  $('#workspaceBtn').addEventListener('click', (e) => openMenu(e.currentTarget, [{ id: 'general', label: '通用', icon: 'general' }, { id: 'research', label: '科研', icon: 'research' }].map((x) => ({ ...x, checkable: true, checked: $('#workspaceLabel .swap-cur').textContent === x.label })), {
    onSelect: (it) => {
      M.swapText($('#workspaceLabel'), it.label, { width: true });
      const pill = $('#workspaceBtn');
      const t = document.createElement('template');
      t.innerHTML = icon(it.icon);
      pill.firstElementChild.replaceWith(t.content.firstChild);
    },
  }));
  const MODELS = [['主力模型', '均衡 · 默认'], ['深度模型', '长推理'], ['快速模型', '低延迟'], ['长上下文', '1M 上下文'], ['本地模型', '离线 · 不出本机']];
  $('#modelBtn').addEventListener('click', (e) => openMenu(e.currentTarget, MODELS.map(([label, desc]) => ({ label, desc, checkable: true, checked: $('#modelLabel .swap-cur').textContent === label })), {
    side: 'top', align: 'end', title: '模型', onSelect: (it) => M.swapText($('#modelLabel'), it.label, { width: true }),
  }));
  $('#thinkingBtn').addEventListener('click', (e) => openMenu(e.currentTarget, ['关闭', '低', '中', '高'].map((label) => ({ label, checkable: true, checked: $('#thinkingLabel .swap-cur').textContent === label })), {
    side: 'top', align: 'end', title: '思考', onSelect: (it) => M.swapText($('#thinkingLabel'), it.label, { width: true }),
  }));

  // ---------------- 会话菜单：归档 / 删除时其余行 FLIP 让位 ----------------
  function openSessionMenu(t, anchor) {
    openMenu(anchor, [{ id: 'rename', label: '重命名', icon: 'pencil' }, { id: 'pin', label: '置顶', icon: 'pin' }, { id: 'copy', label: '复制 ID', icon: 'copy' }, { sep: true }, { id: 'archive', label: '归档', icon: 'archive' }, { id: 'delete', label: '删除', icon: 'trash', danger: true }], {
      align: 'end',
      onSelect: (it) => {
        if (it.id === 'archive' || it.id === 'delete') removeSession(t);
        if (it.id === 'pin') {
          const rows = $$('.session, .group-head', sessions);
          M.flip(rows, () => t.group.itemsEl.prepend(t.item));
          requestAnimationFrame(() => placeSelection());
        }
      },
    });
  }
  async function removeSession(t) {
    if (t.run) t.run.cancel();
    const row = t.item;
    await exit(row, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-8px)' }]);
    const rows = $$('.session, .group-head', sessions).filter((r) => r !== row);
    M.flip(rows, () => row.remove());
    threads.splice(threads.indexOf(t), 1);
    if (current === t) selectThread(draft);
    else requestAnimationFrame(() => placeSelection());
  }

  // ---------------- 主题：View Transition 墨晕，从点击点扩散 ----------------
  async function setTheme(next, e) {
    if (root.dataset.theme === next) return;
    const apply = () => (root.dataset.theme = next);
    if (M.legacy || M.level === 'off' || !document.startViewTransition) {
      root.classList.add('theme-switching');
      apply();
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
      return;
    }
    let x = e && e.clientX, y = e && e.clientY;
    if (!x && !y) { x = innerWidth - 40; y = 24; }
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.classList.add('theme-switching');
    const vt = document.startViewTransition(apply);
    try {
      await vt.ready;
      if (M.level === 'full') root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] }, { duration: 660 * M.ts, easing: M.ease.out, pseudoElement: '::view-transition-new(root)' });
      else root.animate({ opacity: [0, 1] }, { duration: 160 * M.ts, easing: 'ease-out', pseudoElement: '::view-transition-new(root)' });
      await vt.finished;
    } catch (err) { /* 过渡被跳过时主题已经生效 */ } finally { root.classList.remove('theme-switching'); }
  }

  // ---------------- 设置窗口 ----------------
  const SETTINGS_NAV = [
    ['使用偏好', [['general', '通用', 'settings'], ['appearance', '外观', 'palette'], ['chat', '聊天', 'chat'], ['defaults', '对话默认', 'cpu'], ['notify', '通知', 'bell']]],
    ['AGENT', [['models', '模型服务', 'plug'], ['agents', 'Agents', 'bot'], ['memory', '记忆', 'brain']]],
    ['开发与项目', [['projects', '项目', 'folder'], ['editor', '编辑器', 'file-code'], ['terminal', '终端', 'terminal'], ['git', 'Git', 'git-branch']]],
    ['连接与扩展', [['mcp', 'MCP', 'plug'], ['remote', '远程实例', 'stack']]],
  ];
  const PAGE_INDEX = SETTINGS_NAV.flatMap(([g, items]) => items.map(([id, label]) => ({ id, label, group: g })));
  const settingsLayer = $('#settingsLayer');
  const settingsWindow = $('#settingsWindow');
  const settingsNav = $('#settingsNav');
  const snavPill = $('#snavPill');
  const settingsPages = $('#settingsPages');
  let settingsPage = null;
  let settingsOpen = false;
  settingsNav.insertAdjacentHTML('beforeend', `<div class="snav-search">${icon('search')}<span>搜索设置</span></div>`);
  SETTINGS_NAV.forEach(([g, items]) => {
    const grp = h('div', 'snav-group', `<div class="snav-group-title">${esc(g)}</div>`);
    items.forEach(([id, label, ic]) => {
      const b = h('button', 'snav-item', `${icon(ic)}<span>${esc(label)}</span>`);
      b.type = 'button';
      b.dataset.page = id;
      b.addEventListener('click', () => showSettingsPage(id, true));
      grp.append(b);
    });
    settingsNav.append(grp);
  });
  const snavY = new M.Spring(0, { token: 'glide', restDelta: 0.2, onUpdate: (y) => (snavPill.style.transform = `translateY(${y}px)`) });
  const switchHtml = (on, label) => `<label class="lab-switch" style="display:inline-flex"><input type="checkbox" ${on ? 'checked' : ''} aria-label="${esc(label)}"><span class="switch" aria-hidden="true"><i></i></span></label>`;
  const miniTheme = (frameC, bg, line, bubble) => `<div class="mini" style="--m-frame:${frameC};--m-bg:${bg};--m-line:${line};--m-bubble:${bubble}"><div class="ms"></div><div class="mc"><i class="u"></i><i style="width:90%"></i><i style="width:70%"></i><i style="width:80%"></i></div></div>`;
  const miniRead = (rows) => `<div class="mini-read">${rows}</div>`;
  function buildPage(id) {
    const meta = PAGE_INDEX.find((p) => p.id === id);
    const page = h('div', 'spage');
    page.dataset.page = id;
    if (id === 'appearance') {
      const theme = root.dataset.theme;
      page.innerHTML = `<h2>外观</h2><p class="lead">主题、字号与界面动效。</p>
        <section class="ssection"><h3>主题</h3><div class="choice-grid" role="radiogroup" aria-label="主题">
          <button class="choice" type="button" role="radio" data-theme-choice="light" aria-checked="${theme === 'light'}">${miniTheme('#eeedeb', '#fcfbf9', '#18161314', '#f0efed')}<span class="name">Varin 浅色</span><span class="desc">暖纸色画布，单色控件</span></button>
          <button class="choice" type="button" role="radio" data-theme-choice="dark" aria-checked="${theme === 'dark'}">${miniTheme('#0c0c0c', '#161616', '#ffffff14', '#242424')}<span class="name">Varin 深色</span><span class="desc">中性炭灰，低对比边框</span></button>
          <button class="choice" type="button" role="radio" data-theme-choice="system" aria-checked="false">${miniTheme('linear-gradient(90deg,#eeedeb 50%,#0c0c0c 50%)', 'linear-gradient(90deg,#fcfbf9 50%,#161616 50%)', '#8884', '#8883')}<span class="name">跟随系统</span><span class="desc">随系统明暗切换</span></button>
        </div></section>
        <section class="ssection"><h3>界面动效</h3><div class="choice-grid" role="radiogroup" aria-label="界面动效">
          ${[['full', '完整', '弹簧过渡、飞入与晶格波'], ['reduced', '简化', '只保留短暂淡入，不做位移'], ['off', '关闭', '状态直接切换']].map(([v, n, d]) => `<button class="choice" type="button" role="radio" data-level-choice="${v}" aria-checked="${M.level === v}"><span class="name">${n}</span><span class="desc">${d}</span></button>`).join('')}
        </div></section>
        <section class="ssection"><h3>字号</h3><div class="srow"><div class="lbl">正文<small>聊天正文与 Markdown</small></div><span class="muted">15 px</span></div><div class="srow"><div class="lbl">代码<small>代码块与终端</small></div><span class="muted">13 px</span></div></section>`;
    } else if (id === 'chat') {
      const mode = root.dataset.reading;
      page.innerHTML = `<h2>聊天</h2><p class="lead">阅读模式、思考与工具的呈现方式。</p>
        <section class="ssection"><h3>阅读模式</h3><div class="choice-grid" role="radiogroup" aria-label="阅读模式">
          <button class="choice" type="button" role="radio" data-reading-choice="chrono" aria-checked="${mode === 'chrono'}">${miniRead('<i class="p" style="width:60%"></i><i class="r"></i><i class="r" style="width:55%"></i><i class="r" style="width:35%"></i><i class="p" style="width:80%"></i>')}<span class="name">按时间展开</span><span class="desc">文字和工具过程按发生顺序逐步显示。</span></button>
          <button class="choice" type="button" role="radio" data-reading-choice="dialogue" aria-checked="${mode === 'dialogue'}">${miniRead('<i class="p" style="width:60%"></i><i class="r" style="width:45%"></i><i class="p" style="width:85%"></i><i class="r" style="width:30%"></i><i class="p" style="width:70%"></i>')}<span class="name">对话优先</span><span class="desc">保留每段发言，段落间用一条可展开的动态行显示当前动作。</span></button>
          <button class="choice" type="button" role="radio" aria-checked="false" disabled style="opacity:.55;cursor:default">${miniRead('<i class="r" style="width:50%"></i><i class="p" style="width:90%"></i><i class="p" style="width:75%"></i><i class="p" style="width:82%"></i>')}<span class="name">集中展示回答</span><span class="desc">将工作过程收进一组，回答完成后集中显示。原型未包含。</span></button>
        </div></section>
        <section class="ssection"><h3>思考</h3><div class="srow"><div class="lbl">显示思考过程<small>模型公开的推理会出现在过程行里</small></div>${switchHtml(true, '显示思考过程')}</div><div class="srow"><div class="lbl">思考默认收起<small>只显示单行实时预览</small></div>${switchHtml(true, '思考默认收起')}</div></section>`;
    } else if (id === 'general') {
      page.innerHTML = `<h2>通用</h2><p class="lead">语言、启动与窗口行为。</p><section class="ssection"><h3>语言与时间</h3><div class="srow"><div class="lbl">界面语言</div><span class="muted">简体中文</span></div><div class="srow"><div class="lbl">时间格式</div><span class="muted">24 小时</span></div></section><section class="ssection"><h3>启动</h3><div class="srow"><div class="lbl">启动时打开上次的会话</div>${switchHtml(true, '启动时打开上次的会话')}</div><div class="srow"><div class="lbl">关闭窗口时常驻托盘<small>后台任务继续运行</small></div>${switchHtml(false, '常驻托盘')}</div></section>`;
    } else {
      page.innerHTML = `<h2>${esc(meta.label)}</h2><p class="lead">${esc(meta.group)} · 示例页面，结构沿用设置外壳。</p><section class="ssection"><h3>常用</h3><div class="srow"><div class="lbl">启用<small>保存后在下一次请求中生效</small></div>${switchHtml(true, '启用')}</div><div class="srow"><div class="lbl">作用范围<small>全局；项目设置可以覆盖</small></div><span class="muted">全局</span></div></section><section class="ssection"><h3>高级</h3><div class="srow"><div class="lbl">诊断日志</div>${switchHtml(false, '诊断日志')}</div></section>`;
    }
    $$('[data-theme-choice]', page).forEach((b) => b.addEventListener('click', (e) => {
      const v = b.dataset.themeChoice === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : b.dataset.themeChoice;
      $$('[data-theme-choice]', page).forEach((n) => n.setAttribute('aria-checked', String(n === b)));
      setTheme(v, e);
      themeSeg.set(v, { silent: true });
    }));
    $$('[data-level-choice]', page).forEach((b) => b.addEventListener('click', () => {
      $$('[data-level-choice]', page).forEach((n) => n.setAttribute('aria-checked', String(n === b)));
      levelSeg.set(b.dataset.levelChoice);
    }));
    $$('[data-reading-choice]', page).forEach((b) => b.addEventListener('click', () => {
      $$('[data-reading-choice]', page).forEach((n) => n.setAttribute('aria-checked', String(n === b)));
      readingSeg.set(b.dataset.readingChoice);
    }));
    return page;
  }
  function showSettingsPage(id, animate) {
    if (id === settingsPage) return;
    const list = PAGE_INDEX.map((p) => p.id);
    const dir = settingsPage ? Math.sign(list.indexOf(id) - list.indexOf(settingsPage)) || 1 : 1;
    settingsPage = id;
    const meta = PAGE_INDEX.find((p) => p.id === id);
    $$('.snav-item', settingsNav).forEach((b) => (b.dataset.page === id ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    const item = $(`.snav-item[data-page="${id}"]`, settingsNav);
    snavY.to(item.offsetTop, { instant: !animate || M.legacy });
    M.swapText($('#settingsCrumb'), `${meta.group === 'AGENT' ? 'Agent' : meta.group} / ${meta.label}`, { dir });
    // 只更新详情，目录不动：旧页 110ms 退场，新页交叉淡入，章节依次进入
    const old = $('.spage', settingsPages);
    const page = buildPage(id);
    if (old && animate) exit(old, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-4 * dir}px)` }]).then(() => old.remove());
    else if (old) old.remove();
    if (M.legacy && old) old.remove();
    settingsPages.append(page);
    if (animate) [...page.children].slice(0, 6).forEach((c, i) => enter(c, [{ opacity: 0, transform: `translateY(${6 * dir}px)` }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 40 + i * 22 }));
  }
  function openSettings(page = 'appearance') {
    if (settingsOpen) return;
    settingsOpen = true;
    closeMenu(false, true);
    settingsLayer.hidden = false;
    settingsPage = null;
    showSettingsPage(page, false);
    enter($('#settingsBackdrop'), [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: M.ease.out });
    enter(settingsWindow, [{ opacity: 0, transform: 'translateY(10px) scale(.985)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
    [...settingsNav.children].slice(1, 6).forEach((c, i) => enter(c, [{ opacity: 0, transform: 'translateX(-6px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 60 + i * 22 }));
    $('#settingsClose').focus({ preventScroll: true });
  }
  async function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    await Promise.all([exit(settingsWindow, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.985)' }]), exit($('#settingsBackdrop'), [{ opacity: 1 }, { opacity: 0 }], { duration: 160 })]);
    if (!settingsOpen) {
      settingsLayer.hidden = true;
      settingsWindow.getAnimations().forEach((a) => a.cancel());
      $('#settingsBackdrop').getAnimations().forEach((a) => a.cancel());
      $('#openSettings').focus({ preventScroll: true });
    }
  }
  $('#openSettings').addEventListener('click', () => openSettings('appearance'));
  $('#settingsClose').addEventListener('click', closeSettings);
  $('#settingsBackdrop').addEventListener('click', closeSettings);

  // ---------------- 侧栏开关 / 新会话 / 快捷键 ----------------
  const sidebar = $('#sidebar');
  const sidebarInner = $('.sidebar-inner');
  let sideOpen = true;
  const sideW = new M.Spring(268, { token: 'glide', restDelta: 0.5, onUpdate: (w) => (sidebar.style.width = `${w}px`) });
  function toggleSidebar() {
    sideOpen = !sideOpen;
    frame.dataset.sidebar = sideOpen ? 'open' : 'closed';
    $('#sidebarToggle').setAttribute('aria-pressed', String(!sideOpen));
    sideW.to(sideOpen ? 268 : 0, { instant: M.legacy });
    sidebarInner.getAnimations().forEach((a) => a.cancel());
    if (sideOpen) enter(sidebarInner, [{ opacity: 0, transform: 'translateX(-12px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 40 });
    else M.animate(sidebarInner, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-12px)' }], { duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' });
  }
  $('#sidebarToggle').addEventListener('click', toggleSidebar);
  function newThread() {
    if (profile !== 'agent') return;
    selectThread(draft);
    setInput('', true);
    input.focus({ preventScroll: true });
  }
  $('#newThread').addEventListener('click', newThread);
  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'n') { e.preventDefault(); newThread(); }
    if ((e.ctrlKey || e.metaKey) && k === 'b') { e.preventDefault(); toggleSidebar(); }
    if (e.key === 'Escape' && settingsOpen) closeSettings();
  });

  // ---------------- 实验室 ----------------
  const lab = $('#lab');
  $('#labToggle').addEventListener('click', () => {
    const open = lab.dataset.open !== 'true';
    const after = [$('.side-foot')];
    M.flip(after, () => (lab.dataset.open = String(open)));
    $('#labToggle').setAttribute('aria-expanded', String(open));
    if (open) enter($('#labBody'), [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
  });
  const segs = [];
  const versionSeg = Seg($('#versionSeg'), (v) => { M.setLegacy(v === 'legacy'); replay(true); });
  const readingSeg = Seg($('#readingSeg'), (v) => (root.dataset.reading = v));
  const levelSeg = Seg($('#levelSeg'), (v) => M.setLevel(v));
  const themeSeg = Seg($('#themeSeg'), (v, e) => setTheme(v, e));
  segs.push(versionSeg, readingSeg, levelSeg, themeSeg);
  root.dataset.reading = 'dialogue';
  if (M.level !== 'full') levelSeg.set(M.level, { silent: true, instant: true });
  $('#slowmo').addEventListener('change', (e) => M.setTimeScale(e.target.checked ? 4 : 1));
  $('#replay').addEventListener('click', () => replay(true));

  function replay(autoSend) {
    threads.forEach((t) => t.run && t.run.cancel());
    closeMenu(false, true);
    if (profile !== 'agent') { profile = 'agent'; swapProfileUi('agent'); ideLayout.hidden = true; }
    if (current !== draft) selectThread(draft);
    else showDraft(true, true);
    const created = threads.filter((t) => t.kind === 'demo' || t.kind === 'new');
    created.forEach((t) => {
      const row = t.item;
      exit(row, [{ opacity: 1 }, { opacity: 0, transform: 'translateX(-8px)' }]).then(() => {
        M.flip($$('.session, .group-head', sessions).filter((r) => r !== row), () => row.remove());
      });
      if (M.legacy) row.remove();
      threads.splice(threads.indexOf(t), 1);
    });
    members.splice(1);
    members[0].state = '运行中';
    feedItems.length = 0;
    gitFiles.length = 0;
    terminalLog.length = 0;
    railBadge('git', 0);
    $$('.rail-dot', rail).forEach((d) => d.remove());
    if (panelOpen && activeSurface) showSurface(activeSurface, false);
    setInput(DEMO_PROMPT, false);
    setCtxUsage(0);
    if (autoSend) setTimeout(() => { if (current === draft && !draft.run && input.value === DEMO_PROMPT) onSend(); }, 900 * M.ts);
  }

  (function fpsMeter() {
    const el = $('#fps');
    let last = performance.now(), acc = 0;
    const frames = [];
    function f(now) {
      const d = now - last;
      last = now;
      if (d < 1000) { frames.push(d); if (frames.length > 120) frames.shift(); acc += d; }
      if (acc > 500) {
        acc = 0;
        const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
        const long = frames.filter((x) => x > 25).length;
        el.textContent = `${avg.toFixed(1)}ms · 长帧 ${long}`;
        el.classList.toggle('jank', long > 3);
      }
      requestAnimationFrame(f);
    }
    requestAnimationFrame(f);
  })();

  // ---------------- 启动：分段入场 ----------------
  function relayout() {
    segs.forEach((s) => s.place(true));
    placeSelection(true);
    placeRail(true);
    if (canvas.dataset.empty === 'true') placeDock('draft', false);
  }
  addEventListener('resize', relayout);
  selectThread(draft, { instant: true });
  setInput(DEMO_PROMPT, false);
  setCtxUsage(0);
  if (full()) {
    [[$('.sidebar-inner'), 'translateX(-10px)'], [$('#titlebar'), 'translateY(-4px)'], [$('#draftTitle'), 'translateY(8px)'], [dock, 'translateY(12px)'], [$('#railReveal'), 'translateX(8px)']]
      .forEach(([el, tf], i) => M.animate(el, [{ opacity: 0, transform: tf }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: i * 40 }));
    $$('.starter', starters).forEach((s, i) => M.animate(s, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 200 + Math.min(i, 6) * 22 }));
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

  // 供无头验证脚本使用
  window.__varinDemo = { replay, send: onSend, openSurface, setPanel, openSettings, closeSettings, switchProfile: (id) => (wbQueue = wbQueue.then(() => switchProfile(id))), threads, get current() { return current; }, get draft() { return draft; } };
})();
