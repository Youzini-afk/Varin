/* Varin · Bot 工作台原型
 * 只演示界面、交互和动效；数据是示例，不连接 Host。
 * 动效引擎复用 ../motion-preview/motion.js（四个弹簧、动效级别、慢放）。
 */
(function () {
  'use strict';
  const M = window.VarinMotion;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const frame = $('#frame');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------------------------------------------------------------- 图标
  const ICONS = {
    side: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M9 4.5v15"/>',
    panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M15 4.5v15"/>',
    chev: '<path d="M7 10l5 5 5-5"/>',
    right: '<path d="M10 7l5 5-5 5"/>',
    back: '<path d="M14 7l-5 5 5 5"/>',
    down: '<path d="M12 6v12M6.5 12.5L12 18l5.5-5.5"/>',
    stack: '<path d="M12 4l8 4.5-8 4.5-8-4.5z"/><path d="M4 13l8 4.5 8-4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    at: '<circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.4a2.4 2.4 0 0 0 4.8 0V12a8.4 8.4 0 1 0-3.3 6.7"/>',
    up: '<path d="M12 18V6M6.5 11.5L12 6l5.5 5.5"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2.5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    new: '<rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M12 8.5v7M8.5 12h7"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4L18 18M6 18l1.6-1.6M16.4 7.6L18 6"/>',
    dots: '<circle cx="6" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="18" cy="12" r="1.1"/>',
    out: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v3.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 17.5v-10A1.5 1.5 0 0 1 6.5 6H10"/>',
    pause: '<path d="M9.5 7v10M14.5 7v10"/>',
    check: '<path d="M5.5 12.5l4.2 4.2 8.8-9.4"/>',
    hand: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5M12 15.8v.2"/>',
    shield: '<path d="M12 3.5l7 3v5.2c0 4.2-3 7.4-7 8.8-4-1.4-7-4.6-7-8.8V6.5z"/><path d="M12 9v3.5M12 15.6v.2"/>',
    bot: '<rect x="4" y="5" width="16" height="14" rx="5"/><rect x="7" y="8" width="10" height="7" rx="3"/>',
    workbench: '<rect x="4" y="4.5" width="16" height="15" rx="3"/><path d="M4 9h16M9.5 9v10.5"/>',
    folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 8v8M17 10c0 4-5 3.5-9.5 6.5"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5A2 2 0 0 0 13.5 4.5h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
    retry: '<path d="M5 12a7 7 0 1 0 2-4.9"/><path d="M5 4.5V8h3.5"/>',
    moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
    sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6"/>',
    user: '<circle cx="12" cy="9" r="3.5"/><path d="M5.5 19.5c1.2-3.2 3.6-4.8 6.5-4.8s5.3 1.6 6.5 4.8"/>',
    archive: '<rect x="4" y="5" width="16" height="4" rx="1.5"/><path d="M5.5 9v8.5A1.5 1.5 0 0 0 7 19h10a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l.8 11a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7"/>',
    pin: '<path d="M9 4h6l-1 5 3 3H7l3-3z"/><path d="M12 15v5"/>',
    cal: '<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M9 3.5v4M15 3.5v4"/>',
    x: '<path d="M7 7l10 10M17 7L7 17"/>',
    edit: '<path d="M5 19l1-4 9.5-9.5a2 2 0 0 1 2.8 2.8L8.8 17.8z"/>',
  };
  const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  function hydrate(root = document) {
    root.querySelectorAll('i[data-ic]').forEach((i) => {
      const t = document.createElement('template');
      t.innerHTML = icon(i.dataset.ic, i.className);
      i.replaceWith(t.content.firstChild);
    });
    root.querySelectorAll('[data-tip]').forEach((n) => { if (!n.title) n.title = n.dataset.tip; });
  }

  // ---------------------------------------------------------------- 产品头像（取自 agent-avatar-art.ts 的原图形）
  const ART = {
    'slant-mint': { body: 'M11 19Q12 13 20 13L44 10Q50 9 53 16L61 43Q64 52 54 54L18 58Q10 59 8 51L5 29Q4 22 11 19Z', color: '#96C4B4', eyes: 'M19 31L24 30Q27 30 27 32Q27 34 25 34L20 35Q17 35 17 33Q17 31 19 31ZM40 28L45 27Q48 27 48 29Q48 31 46 31L41 32Q38 32 38 30Q38 28 40 28Z' },
    'pebble-blue': { body: 'M7 28Q15 11 30 11L37 11Q49 12 56 27Q62 39 59 48Q57 55 47 56Q30 60 14 56Q5 54 4 44Q3 36 7 28Z', color: '#85B3D2', eyes: 'M18 31H24Q26 31 26 33Q26 35 24 35H18Q16 35 16 33Q16 31 18 31ZM40 31H46Q48 31 48 33Q48 35 46 35H40Q38 35 38 33Q38 31 40 31Z' },
    'notch-ochre': { body: 'M5 31Q9 13 28 12Q34 12 38 17Q41 21 48 21Q59 22 61 34L62 43Q63 54 50 55L18 55Q4 55 3 44Q2 37 5 31Z', color: '#E9C16E', eyes: 'M20 30H23Q26 30 26 33V34Q26 37 23 37H20Q18 37 18 34V33Q18 30 20 30ZM40 33H46Q48 33 48 35Q48 37 46 37H40Q38 37 38 35Q38 33 40 33Z' },
    'slope-lilac': { body: 'M13 18Q15 14 21 13L43 8Q47 7 50 10L57 17Q59 19 59 24L61 47Q62 54 54 55L13 60Q6 61 7 53L10 26Q11 21 13 18Z', color: '#C7B5EF', eyes: 'M19 31L24 30Q27 30 27 32Q27 34 25 34L20 35Q17 35 17 33Q17 31 19 31ZM40 28L45 27Q48 27 48 29Q48 31 46 31L41 32Q38 32 38 30Q38 28 40 28Z' },
    'dome-ivory': { body: 'M5 43C6 23 18 12 32 12C49 12 59 26 60 45Q61 51 54 52Q32 55 10 52Q3 52 5 43Z', color: '#E9DED0', eyes: 'M21 29H24Q26 29 26 32V34Q26 36 23 36H21Q19 36 19 33V32Q19 29 21 29ZM41 29H44Q46 29 46 32V34Q46 36 43 36H41Q39 36 39 33V32Q39 29 41 29Z' },
    'taper-sage': { body: 'M15 13Q19 8 25 9L45 12Q51 13 53 20L61 48Q63 55 55 55L10 53Q3 53 5 46L11 23Q12 17 15 13Z', color: '#A8BD96', eyes: 'M20 29L25 30Q27 30 27 32Q27 34 25 34L20 33Q18 33 18 31Q18 29 20 29Z', eyeStroke: 'M40 33Q44 27 48 33' },
  };
  function avatar(id, cls = '') {
    const a = ART[id] || ART['pebble-blue'];
    return `<span class="av ${cls}"><svg viewBox="0 0 64 64" aria-hidden="true">${a.accent ? `<path fill="${a.accent.color}" d="${a.accent.path}"/>` : ''}<path fill="${a.color}" d="${a.body}"/><path fill="#202326" d="${a.eyes}"/>${a.eyeStroke ? `<path fill="none" stroke="#202326" stroke-width="4" stroke-linecap="round" d="${a.eyeStroke}"/>` : ''}</svg></span>`;
  }

  // ---------------------------------------------------------------- Bot 形象（占位美术，状态合同见 bot-ui.md 5.7）
  function figure(state, cls = '') {
    return `<span class="fig ${cls}" data-state="${state}"><i class="f-glow"></i><svg viewBox="0 0 76 68" aria-hidden="true"><g class="f-body"><rect class="f-shell" x="2.5" y="2.5" width="71" height="63" rx="22"/><rect class="f-visor" x="11" y="11" width="54" height="40" rx="14"/><g class="f-eyes"><rect class="f-eye" x="25" y="25" width="8" height="13" rx="4"/><rect class="f-eye" x="43" y="25" width="8" height="13" rx="4"/></g><path class="f-closed" d="M24 32Q29 37 34 32M42 32Q47 37 52 32"/><path class="f-happy" d="M24 34Q29 27 34 34M42 34Q47 27 52 34"/></g><g class="f-zz"><text x="62" y="8">z</text><text x="68" y="0" style="font-size:9px">z</text><text x="73" y="-7" style="font-size:7px">z</text></g></svg></span>`;
  }

  // ---------------------------------------------------------------- 示例数据
  const MIN = 60 * 1000;
  function initialData() {
    const now = Date.now();
    return {
      offline: false,
      bots: [
        { id: 'varin', name: 'Varin', label: '总助手', open: true, sleeping: false, waking: false, model: '主力模型', organize: true,
          instructions: '我们长期合作。小事你直接处理，需要连续探索或大量执行的工作交给合适的 Agent。重要的变化回来告诉我，不用每个子任务都汇报。',
          sessions: ['daily', 'release', 'trip', 'trip-alt'] },
        { id: 'lit', name: '文献助理', label: '文献', open: false, sleeping: true, waking: false, model: '主力模型', organize: true,
          instructions: '帮我跟踪检索增强与长上下文方向的新论文，每周整理一次。',
          sessions: ['lit-main'] },
      ],
      sessions: {
        daily: { id: 'daily', bot: 'varin', title: '日常', parent: null, unread: false, msgs: [
          { k: 'd1', type: 'day', text: '今天 11:46' },
          { k: 'd2', type: 'me', text: '帮我看看这次依赖升级要动哪些地方，顺便评估一下风险。' },
          { k: 'd3', type: 'say', text: '好，我让依赖调查先把影响面列出来，有结论了告诉你。' },
          { k: 'd4', type: 'dispatch', works: ['w-deps'] },
          { k: 'd5', type: 'day', text: '13:05' },
          { k: 'd6', type: 'report', work: 'w-deps', text: '三个包的升级会改公开 API，需要手动处理；其余 14 个可以直接升，锁文件已经生成。', file: 'deps-report.md' },
          { k: 'd7', type: 'say', text: '依赖升级查完了。三个包要手动改，其余可以直接升。要我先把能直接升的那部分做掉吗？', ops: true },
          { k: 'd8', type: 'day', text: '14:18' },
          { k: 'd9', type: 'me', text: '先不急。论文第 3 节按新提纲改，提纲在 notes/outline-v2.md。' },
          { k: 'd10', type: 'say', text: '好。写作上次改过这一节，我让它接着那版改，新提纲已经交给它。' },
          { k: 'd11', type: 'dispatch', works: ['w-writer'] },
        ] },
        release: { id: 'release', bot: 'varin', title: '发布 v0.9', parent: null, unread: false, msgs: [
          { k: 'r1', type: 'day', text: '昨天 21:30' },
          { k: 'r2', type: 'me', text: '准备发 0.9。先打 Windows 包，移动端这次不发。' },
          { k: 'r3', type: 'say', text: '好，我让发布按桌面安装包来打，同时让验证在干净环境里跑一遍完整冒烟。' },
          { k: 'r4', type: 'dispatch', works: ['w-release', 'w-smoke'] },
          { k: 'r5', type: 'day', text: '今天 14:19' },
          { k: 'r6', type: 'me', text: '发布先停一下，打包目标我要再想想。' },
          { k: 'r7', type: 'say', text: '好，发布停在打包前了，等你确认打包目标再继续。冒烟测试不受影响，还在跑。', ops: true },
        ] },
        trip: { id: 'trip', bot: 'varin', title: '旅行安排', parent: null, unread: false, msgs: [
          { k: 't1', type: 'day', text: '10月24日' },
          { k: 't2', type: 'me', text: '下个月去京都五天，帮我排个不太赶的行程。' },
          { k: 't3', type: 'say', text: '按你说的不赶：每天只排一个主要区域，下午留半天随便逛。住在四条附近，去哪都方便。第一天东山，第二天岚山，第三天留给奈良，第四天北边的大德寺和上贺茂，最后一天买东西、早点去机场。', ops: true },
        ] },
        'trip-alt': { id: 'trip-alt', bot: 'varin', title: '改成大阪进出', parent: 'trip', unread: false, msgs: [
          { k: 'a1', type: 'day', text: '10月25日' },
          { k: 'a2', type: 'me', text: '如果改成大阪进出呢？' },
          { k: 'a3', type: 'say', text: '那第一晚住大阪，第二天坐京阪到祇园四条，其余安排不变；最后一天从京都回大阪，晚上在难波吃饭，第二天早上从关西机场走。', ops: true },
        ] },
        'lit-main': { id: 'lit-main', bot: 'lit', title: '每周文献', parent: null, unread: false, msgs: [
          { k: 'l1', type: 'day', text: '10月26日' },
          { k: 'l2', type: 'me', text: '把这周新出的检索增强论文列一下。' },
          { k: 'l3', type: 'say', text: '列了 6 篇。和你现在的工作最相关的是两篇：一篇讨论召回结果的去重顺序，一篇比较长上下文和检索在多跳问题上的成本。', ops: true },
        ] },
      },
      work: [
        { id: 'w-writer', bot: 'varin', agent: '写作', av: 'slant-mint', title: '按新提纲重写第 3 节', task: '按新提纲重写第 3 节', project: 'paper', session: 'daily', state: 'running', doing: '正在编辑 sec3.md', since: now - 12 * MIN, round: 2,
          brief: '按 notes/outline-v2.md 的新提纲重写第 3 节。保留 3.3 的实验数据，旧基线换掉。',
          tools: [['读取', 'notes/outline-v2.md', 'L1–86'], ['编辑', 'paper/sec3.md', '<span class="add">+38</span> <span class="del">−52</span>'], ['编辑', 'paper/sec3.md · 3.2', '进行中']],
          text: '3.1 已经按新提纲收窄成两个问题。3.2 的对比实验要换掉旧基线，我先列出候选。' },
        { id: 'w-release', bot: 'varin', agent: '发布', av: 'notch-ochre', title: '打 0.9 的桌面安装包', task: '停在打包前', project: 'varin', session: 'release', state: 'paused', round: 3,
          brief: '打 0.9 的桌面安装包，移动端这次不发。打包前先跑完整冒烟。',
          tools: [['读取', 'scripts/package.config.ts', 'L1–64'], ['运行', 'bun run package:prepare', '退出码 0']],
          text: '打包配置已经准备好，按你的要求停在打包前。' },
        { id: 'w-smoke', bot: 'varin', agent: '验证', av: 'taper-sage', title: '跑完整安装包冒烟', task: '跑完整安装包冒烟', project: 'varin', session: 'release', state: 'running', doing: '正在运行冒烟清单', since: now - 26 * MIN, round: 1,
          brief: '在干净环境里安装 0.9 候选包，跑一遍完整冒烟清单。',
          tools: [['运行', 'bun run smoke:installed', '进行中']],
          text: '', report: '冒烟清单 23 项全部通过。首次启动 4.1 秒，比 0.8 慢 0.3 秒，原因是新增的索引预热。' },
        { id: 'w-deps', bot: 'varin', agent: '依赖调查', av: 'pebble-blue', title: '评估这次依赖升级', task: '评估这次依赖升级', project: 'varin', session: 'daily', state: 'done', round: 1,
          brief: '评估这次依赖升级的影响面和风险，列出需要手动处理的包。',
          tools: [['检索', 'package.json · bun.lock', '17 个包'], ['运行', 'bun outdated', '退出码 0'], ['写入', 'deps-report.md', '<span class="add">+64</span>']],
          text: '三个包的升级会改公开 API，需要手动处理；其余 14 个可以直接升，锁文件已经生成。' },
      ],
      needs: [],
      latestReport: { work: 'w-deps', session: 'daily', msg: 'd6', t: '13:05', unread: false },
      activity: [
        { id: 'a1', bot: 'varin', day: '今天', t: '14:20', kind: 'dispatch', session: 'daily', work: 'w-writer', html: '派发给 <b>写作</b>：按新提纲重写第 3 节' },
        { id: 'a2', bot: 'varin', day: '今天', t: '14:19', kind: 'pause', session: 'release', work: 'w-release', html: '暂停了 <b>发布</b>，停在打包前' },
        { id: 'a3', bot: 'varin', day: '今天', t: '14:02', kind: 'you', session: 'release', work: 'w-release', html: '你在 <b>发布</b> 里改了打包目标' },
        { id: 'a4', bot: 'varin', day: '今天', t: '13:05', kind: 'report', session: 'daily', work: 'w-deps', msg: 'd6', html: '<b>依赖调查</b> 返回了结果' },
        { id: 'a5', bot: 'varin', day: '今天', t: '12:31', kind: 'quiet', session: 'release', html: '处理了 2 份回报，没有打扰你', sub: '验证的环境检查 · 发布的配置核对' },
        { id: 'a6', bot: 'varin', day: '今天', t: '11:47', kind: 'dispatch', session: 'daily', work: 'w-deps', html: '派发给 <b>依赖调查</b>：评估这次依赖升级' },
        { id: 'a7', bot: 'varin', day: '昨天', t: '21:31', kind: 'dispatch', session: 'release', work: 'w-smoke', html: '派发给 <b>验证</b>：跑完整安装包冒烟' },
        { id: 'a8', bot: 'varin', day: '昨天', t: '21:31', kind: 'dispatch', session: 'release', work: 'w-release', html: '派发给 <b>发布</b>：打 0.9 的桌面安装包' },
        { id: 'a9', bot: 'varin', day: '昨天', t: '21:30', kind: 'memory', session: 'release', mem: 'm2', html: '记住了：这一版先不发移动端' },
        { id: 'b1', bot: 'lit', day: '10月26日', t: '20:12', kind: 'quiet', session: 'lit-main', html: '整理了本周的 6 篇论文' },
      ],
      memories: [
        { id: 'm2', bot: 'varin', text: '这一版先不发移动端；桌面安装包跑完完整冒烟才算能发。', when: '昨天', status: 'current',
          sources: [{ date: '昨天 21:30', session: '发布 v0.9', sid: 'release', msg: 'r2', quote: '准备发 0.9。先打 Windows 包，移动端这次不发。' }] },
        { id: 'm1', bot: 'varin', text: '写论文习惯先定提纲再动正文；提纲一改就整节重写，不在旧稿上打补丁。', when: '10月22日', status: 'current',
          sources: [{ date: '10月22日', session: '日常', sid: 'daily', quote: '提纲变了就整节重写吧，别在旧稿上补。' }, { date: '10月14日', session: '日常', sid: 'daily', quote: '我一般先把提纲定死再写正文。' }],
          rev: '10月22日补充了“提纲一改就整节重写”' },
        { id: 'm3', bot: 'varin', text: '出门旅行不追求景点数量，每天留半天空白；住在交通方便的地方。', when: '10月24日', status: 'current',
          sources: [{ date: '10月24日', session: '旅行安排', sid: 'trip', msg: 't2', quote: '下个月去京都五天，帮我排个不太赶的行程。' }] },
        { id: 'm4', bot: 'varin', text: '默认用蓝色作为界面强调色。', when: '10月9日', status: 'obsolete',
          sources: [{ date: '10月9日', session: '日常', sid: 'daily', quote: '强调色先用蓝的吧。' }], rev: '10月20日不再适用：改用中性墨色' },
        { id: 'n1', bot: 'lit', text: '只关注检索增强与长上下文两个方向，综述类文章不用列。', when: '10月12日', status: 'current',
          sources: [{ date: '10月12日', session: '每周文献', sid: 'lit-main', quote: '综述就别列了，只看这两个方向。' }] },
      ],
      schedules: [
        { id: 's1', bot: 'varin', when: '18:00', day: '周五', title: '检查发布状态', target: '发布 v0.9', rule: '一次', missed: '跳过', paused: false },
        { id: 's2', bot: 'varin', when: '09:00', day: '明天', title: '晨间简报', target: '日常', rule: '每天', missed: '补一次', paused: false },
        { id: 's3', bot: 'varin', when: '20:00', day: '周日', title: '整理本周记忆', target: '日常', rule: '每周日', missed: '跳过', paused: true },
        { id: 's4', bot: 'lit', when: '19:00', day: '周日', title: '整理本周论文', target: '每周文献', rule: '每周日', missed: '补一次', paused: false },
      ],
    };
  }
  let D = initialData();

  const ui = {
    bot: 'varin', session: 'daily', tab: 'overview', page: null,
    sidebar: false, panel: true, panelW: 360, sheet: false,
    actScope: 'all', memScope: 'current', memQuery: '', memOpen: new Set(), memEdit: null, memConfirm: null, schOpen: new Set(),
    busy: false, typing: false, resultFlash: null, figOverride: '', queue: [],
    tabDots: {}, returnTo: null, run: null, profileDraft: null,
  };

  // ---------------------------------------------------------------- 取数
  const bot = (id = ui.bot) => D.bots.find((b) => b.id === id);
  const sess = (id = ui.session) => D.sessions[id];
  const work = (id) => D.work.find((w) => w.id === id);
  const needsOf = (b = bot()) => D.needs.filter((n) => work(n.work)?.bot === b.id);
  const runningOf = (b = bot()) => D.work.filter((w) => w.bot === b.id && ['running', 'preparing', 'waiting'].includes(w.state));
  const liveOf = (b = bot()) => D.work.filter((w) => w.bot === b.id && !['done', 'stopped'].includes(w.state));
  const sessionOrder = () => D.bots.flatMap((b) => b.sessions);
  const minutes = (w) => (w.since ? Math.max(1, Math.round((Date.now() - w.since) / MIN)) : 0);
  // 示例时钟：从 14:26 开始走，和示例数据的时间线衔接
  const DEMO_START = Date.now();
  const clock = () => { const m = 14 * 60 + 26 + Math.floor((Date.now() - DEMO_START) / MIN); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

  function figState(b = bot()) {
    if (ui.figOverride && b.id === ui.bot) return ui.figOverride;
    if (D.offline) return 'offline';
    if (b.waking) return 'waking';
    if (b.sleeping) return 'sleeping';
    if (needsOf(b).length) return 'waiting';
    if (ui.resultFlash && ui.resultFlash.bot === b.id) return 'result';
    if (ui.busy && sess().bot === b.id) return 'thinking';
    if (runningOf(b).some((w) => w.state !== 'waiting')) return 'working';
    if (ui.typing && b.id === ui.bot) return 'listening';
    return 'idle';
  }
  function stateLine(b = bot()) {
    const s = figState(b);
    const needs = needsOf(b);
    const run = runningOf(b).filter((w) => w.state !== 'waiting');
    switch (s) {
      case 'offline': return { text: '电脑没连上 · 只能查看', tone: '' };
      case 'waking': return { text: '正在醒来…', tone: '' };
      case 'sleeping': return { text: '休息中', tone: '', wake: true };
      case 'waiting': {
        const w = work(needs[0]?.work);
        return { text: needs.length > 1 ? `${needs.length} 件事在等你` : `${w ? w.agent : '有一项工作'}在等你确认`, tone: 'warn' };
      }
      case 'result': return { text: `${ui.resultFlash?.agent || '子任务'}返回了结果`, tone: '' };
      case 'thinking': return { text: '正在想…', tone: '' };
      case 'working': return { text: run.length > 1 ? `${run.length} 项工作在进行` : `${run[0].agent}${run[0].doing || '正在工作'}`, tone: '' };
      case 'listening': return { text: '在听', tone: '' };
      default: return { text: '空闲', tone: '' };
    }
  }
  function shortState(b) {
    const s = figState(b);
    if (s === 'sleeping') return { text: '休息中', tone: '' };
    if (s === 'offline') return { text: '离线', tone: '' };
    if (s === 'waiting') return { text: '等你', tone: 'warn' };
    if (s === 'working' || s === 'thinking') return { text: '工作中', tone: '' };
    return { text: '', tone: '' };
  }
  function workStatus(w) {
    switch (w.state) {
      case 'running': return { html: `<span class="ring"></span>${esc(w.doing ? w.doing.replace(/ .*/, '') : '正在工作')}` };
      case 'preparing': return { html: '<span class="ring"></span>准备中' };
      case 'waiting': return { html: `${icon('hand')}等你确认`, warn: true };
      case 'paused': return { html: `${icon('pause')}已暂停` };
      case 'queued': return { html: '排队中' };
      case 'stopped': return { html: '已停止' };
      default: return { html: `${icon('check')}已返回结果` };
    }
  }

  // ---------------------------------------------------------------- 动效辅助
  const full = () => M.level === 'full';
  // 带 key 的增量替换：已有行 FLIP 到新位置，新行进场，带 data-s 的文字变化原位换字
  function patch(container, html, { enter = 'settle' } = {}) {
    const prevTop = new Map();
    container.querySelectorAll(':scope > [data-k]').forEach((n) => prevTop.set(n.dataset.k, n.getBoundingClientRect().top));
    const prevKeys = new Set($$('[data-k]', container).map((n) => n.dataset.k));
    const prevText = new Map($$('[data-s]', container).map((n) => [n.dataset.s, n.textContent]));
    const st = container.scrollTop;
    container.innerHTML = html;
    container.scrollTop = st;
    let i = 0;
    $$('[data-k]', container).forEach((n) => {
      const k = n.dataset.k;
      if (!prevKeys.has(k)) {
        const parent = n.parentElement.closest('[data-k]');
        if (parent && container.contains(parent) && !prevKeys.has(parent.dataset.k)) return;
        if (prevKeys.size) M.animate(n, [{ opacity: 0, transform: 'translateY(-6px) scale(.97)' }, { opacity: 1, transform: 'none' }], { spring: enter, delay: Math.min(i++, 5) * 20 });
        return;
      }
      if (prevTop.has(k) && n.parentElement === container) {
        const dy = prevTop.get(k) - n.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) M.animate(n, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { spring: 'glide' });
      }
    });
    $$('[data-s]', container).forEach((n) => {
      const t = prevText.get(n.dataset.s);
      if (t !== undefined && t !== n.textContent) M.animate(n, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
    });
  }
  // 同格换内容（状态文字、图标）
  function swapIn(el, html, { pop = false } = {}) {
    if (!el || el.innerHTML === html) return;
    el.innerHTML = html;
    if (pop) M.animate(el, [{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
    else M.animate(el, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide' });
  }
  function setText(host, text, dir = 1) { M.swapText(host, text, { dir }); }
  function flash(el) {
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    el.scrollIntoView({ block: 'nearest', behavior: full() ? 'smooth' : 'auto' });
    setTimeout(() => el.classList.remove('flash'), 1300 * M.ts);
  }
  function showDot(el, on) {
    if (!el) return;
    const was = !el.hidden;
    el.hidden = !on;
    if (on && !was) M.animate(el, [{ transform: 'scale(.2)', opacity: 0 }, { transform: 'none', opacity: 1 }], { spring: 'settle' });
  }
  function hop(el, kind = 'hop') {
    if (!el || !full()) return;
    if (kind === 'squash') {
      M.animate(el, [{ transform: 'scale(1.08, .9)' }, { transform: 'none' }], { spring: 'settle' });
      return;
    }
    M.done(M.animate(el, [{ transform: 'none' }, { transform: 'translateY(-8px) scale(1.03)' }], { duration: 150, easing: M.ease.out, fill: 'forwards' }))
      .then(() => M.animate(el, [{ transform: 'translateY(-8px) scale(1.03)' }, { transform: 'none' }], { spring: 'settle' }));
  }

  // 分段控件滑块：记住上一次位置，重建后从旧位置滑到新位置
  const segMemory = new Map();
  function placeSeg(seg) {
    const knob = seg.querySelector('.seg-knob');
    const on = seg.querySelector('button[aria-pressed="true"]');
    if (!knob || !on) return;
    const key = seg.dataset.seg || seg.dataset.lab || '';
    const to = { x: on.offsetLeft, w: on.offsetWidth };
    const from = segMemory.get(key);
    const apply = () => { knob.style.transform = `translateX(${knob._x.x}px)`; knob.style.width = `${knob._w.x}px`; };
    knob._x = new M.Spring(from ? from.x : to.x, { token: 'glide', onUpdate: apply });
    knob._w = new M.Spring(from ? from.w : to.w, { token: 'glide', onUpdate: apply });
    apply();
    if (from) { knob._x.to(to.x); knob._w.to(to.w); }
    segMemory.set(key, to);
  }

  // 提示
  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    M.animate(t, [{ opacity: 0, transform: 'translateY(12px) scale(.96)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      M.done(M.animate(t, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px)' }], { duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' })).then(() => { t.hidden = true; });
    }, 2800 * M.ts);
  }

  // 菜单：从触发点生长，选项交错
  let menuHandler = null;
  function openMenu(items, { anchor, x, y } = {}, onPick) {
    const m = $('#menu');
    m.innerHTML = items.map((it) => (it === '-' ? '<hr>' : `<button type="button" role="menuitem" data-mi="${it.id}" class="${it.danger ? 'danger' : ''}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`)).join('');
    m.hidden = false;
    const fr = frame.getBoundingClientRect();
    let left; let top;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      left = r.right - fr.left - m.offsetWidth;
      top = r.bottom - fr.top + 6;
      m.style.transformOrigin = 'top right';
    } else {
      left = x - fr.left;
      top = y - fr.top;
      m.style.transformOrigin = 'top left';
    }
    m.style.left = `${clamp(left, 8, fr.width - m.offsetWidth - 8)}px`;
    m.style.top = `${clamp(top, 8, fr.height - m.offsetHeight - 8)}px`;
    M.animate(m, [{ opacity: 0, transform: 'translateY(-5px) scale(.96)' }, { opacity: 1, transform: 'none' }], { spring: 'snap' });
    $$('button', m).forEach((b, i) => M.animate(b, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: i * 16, easing: M.ease.out }));
    menuHandler = onPick;
    m.querySelector('button')?.focus({ preventScroll: true });
  }
  function closeMenu() {
    const m = $('#menu');
    if (m.hidden) return;
    menuHandler = null;
    M.done(M.animate(m, [{ opacity: 1 }, { opacity: 0, transform: 'scale(.97)' }], { duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' })).then(() => { m.hidden = true; });
  }
  $('#menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mi]');
    if (!b) return;
    const fn = menuHandler;
    closeMenu();
    fn?.(b.dataset.mi);
  });
  $('#menu').addEventListener('keydown', (e) => {
    const items = $$('#menu button');
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });

  // 晶格波：去工作台和回来共用。cover 从原点向外铺满；reveal 向外揭开，inward 时从四周收回到原点。
  function pointOf(el) {
    const fr = frame.getBoundingClientRect();
    if (!el) return { x: fr.width / 2, y: fr.height / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - fr.left, y: r.top + r.height / 2 - fr.top };
  }
  async function lattice(phase, pt, { inward = false } = {}) {
    const layer = $('#lattice');
    if (M.level === 'off') { layer.hidden = phase !== 'cover'; return; }
    if (M.level === 'reduced') {
      layer.hidden = false;
      layer.style.background = 'var(--frame)';
      layer.replaceChildren();
      const a = M.animate(layer, phase === 'cover' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: M.ease.out, fill: 'forwards' });
      await M.done(a);
      if (phase === 'reveal') { layer.hidden = true; layer.getAnimations().forEach((x) => x.cancel()); layer.style.background = ''; }
      return;
    }
    const W = frame.clientWidth; const H = frame.clientHeight; const S = 44;
    if (phase === 'cover') {
      layer.style.background = '';
      layer.getAnimations().forEach((x) => x.cancel());
      const cols = Math.ceil(W / S); const rows = Math.ceil(H / S);
      let html = '';
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) html += `<i style="left:${c * S}px;top:${r * S}px"></i>`;
      layer.innerHTML = html;
      layer.hidden = false;
    }
    const cells = $$('i', layer);
    const maxD = Math.hypot(Math.max(pt.x, W - pt.x), Math.max(pt.y, H - pt.y));
    const spread = 230; const each = 190;
    const anims = cells.map((cell) => {
      const cx = parseFloat(cell.style.left) + S / 2; const cy = parseFloat(cell.style.top) + S / 2;
      const d = Math.hypot(cx - pt.x, cy - pt.y) / maxD;
      const order = phase === 'reveal' && inward ? 1 - d : d;
      const frames = phase === 'cover' ? [{ transform: 'scale(0)', opacity: 0.4 }, { transform: 'scale(1.02)', opacity: 1 }] : [{ transform: 'scale(1.02)', opacity: 1 }, { transform: 'scale(0)', opacity: 0.3 }];
      return M.animate(cell, frames, { duration: each, delay: order * spread, easing: phase === 'cover' ? M.ease.out : M.ease.exit, fill: 'forwards' });
    });
    await Promise.all(anims.map(M.done));
    if (phase === 'reveal') { layer.hidden = true; layer.replaceChildren(); }
  }

  // ---------------------------------------------------------------- 侧栏：Bot → 会话 → 分支
  function sessIcon(id) {
    const live = D.work.filter((w) => w.session === id);
    if (live.some((w) => w.state === 'waiting')) return { key: 'warn', html: '<i class="s-dot warn"></i>' };
    if (D.sessions[id].unread) return { key: 'unread', html: '<i class="s-dot"></i>' };
    if (live.some((w) => w.state === 'running' || w.state === 'preparing')) return { key: 'run', html: '<span class="ring"></span>' };
    return { key: '', html: '' };
  }
  function sessRow(id) {
    const s = D.sessions[id];
    const ic = sessIcon(id);
    return `<button class="sess${s.parent ? ' branch' : ''}" type="button" data-act="session" data-s="${id}" aria-current="${id === ui.session}"><span class="s-title">${esc(s.title)}</span><span class="s-ico" data-ico="${ic.key}">${ic.html}</span></button>`;
  }
  function renderSidebar() {
    $('#sbGroups').innerHTML = D.bots.map((b) => {
      const st = shortState(b);
      return `<div class="bot-g" data-bot="${b.id}" data-open="${b.open}">
        <button class="bot-h" type="button" data-act="bot-toggle" data-bot="${b.id}" aria-expanded="${b.open}">${figure(figState(b), 'sm')}<span>${esc(b.name)}</span><span class="bh-state ${st.tone}">${st.text}</span><span class="bh-chev">${icon('chev')}</span></button>
        <div class="bot-sessions" ${b.open ? '' : 'style="height:0"'}>${b.sessions.map(sessRow).join('')}</div></div>`;
    }).join('');
    placeSel(true);
  }
  function refreshSidebar() {
    D.bots.forEach((b) => {
      const g = $(`.bot-g[data-bot="${b.id}"]`);
      if (!g) return;
      const f = g.querySelector('.bot-h .fig');
      if (f) f.dataset.state = figState(b);
      const st = shortState(b);
      const el = g.querySelector('.bh-state');
      if (el.textContent !== st.text) swapIn(el, st.text);
      el.className = `bh-state ${st.tone}`;
    });
    $$('.sess').forEach((row) => {
      const ic = sessIcon(row.dataset.s);
      const host = row.querySelector('.s-ico');
      row.setAttribute('aria-current', String(row.dataset.s === ui.session));
      if (host.dataset.ico !== ic.key) { host.dataset.ico = ic.key; swapIn(host, ic.html, { pop: true }); }
      const t = row.querySelector('.s-title');
      const title = D.sessions[row.dataset.s].title;
      if (t.textContent !== title) setText(t, title);
    });
    const hiddenNews = Object.values(D.sessions).some((s) => s.id !== ui.session && (s.unread || sessIcon(s.id).key === 'warn'));
    showDot($('#sidebarDot'), !ui.sidebar && hiddenNews);
  }
  // 选中胶囊 / 悬停胶囊：整列只画一个高亮，用可打断弹簧移动
  const selPill = $('#selPill'); const hovPill = $('#hovPill');
  const pillY = new M.Spring(0, { token: 'glide', onUpdate: () => { selPill.style.transform = `translateY(${pillY.x}px)`; } });
  const hovY = new M.Spring(0, { token: 'snap', onUpdate: () => { hovPill.style.transform = `translateY(${hovY.x}px)`; } });
  function rowTop(row) { const list = $('#sbList'); return row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop; }
  function placeSel(instant = false) {
    const row = $(`.sess[data-s="${ui.session}"]`);
    const visible = row && row.closest('.bot-g').dataset.open === 'true';
    selPill.style.opacity = visible ? '1' : '0';
    if (!visible) return;
    selPill.style.height = `${row.offsetHeight}px`;
    pillY.to(rowTop(row), { instant: instant || selPill.dataset.placed !== '1' });
    selPill.dataset.placed = '1';
  }
  $('#sbList').addEventListener('pointerover', (e) => {
    const row = e.target.closest('.sess, .bot-h');
    if (!row) return;
    hovPill.style.height = `${row.offsetHeight}px`;
    const first = hovPill.style.opacity !== '1';
    hovPill.style.opacity = '1';
    hovY.to(rowTop(row), { instant: first });
  });
  $('#sbList').addEventListener('pointerleave', () => { hovPill.style.opacity = '0'; });

  function toggleGroup(id) {
    const b = bot(id);
    const g = $(`.bot-g[data-bot="${id}"]`);
    const box = g.querySelector('.bot-sessions');
    const h0 = box.offsetHeight;
    b.open = !b.open;
    g.dataset.open = String(b.open);
    g.querySelector('.bot-h').setAttribute('aria-expanded', String(b.open));
    box.style.height = 'auto';
    const h1 = b.open ? box.offsetHeight : 0;
    box.style.height = `${h1}px`;
    const a = M.animate(box, [{ height: `${h0}px` }, { height: `${h1}px` }], { spring: 'glide' });
    if (b.open) $$('.sess', box).forEach((r, i) => M.animate(r, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: i * 20 }));
    M.done(a).then(() => { box.style.height = b.open ? '' : '0px'; placeSel(true); });
    selPill.style.opacity = '0';
  }

  // ---------------------------------------------------------------- 标题栏与形象
  function sessionSub(s = sess()) {
    const b = bot(s.bot);
    return s.parent ? `${b.name} · 从「${D.sessions[s.parent].title}」分支` : b.name;
  }
  function renderTitle(dir = 1) {
    setText($('#sessionTitle'), sess().title, dir);
    setText($('#sessionSub'), sessionSub(), dir);
  }
  let lastFig = null;
  function refreshState({ quiet = false } = {}) {
    const b = bot();
    const s = figState(b);
    $$('.fig.cur').forEach((f) => { f.dataset.state = s; });
    const line = stateLine(b);
    const host = $('#stageStateText');
    if (host.textContent !== line.text) setText(host, line.text);
    if ($('#tbBotState').textContent !== line.text) setText($('#tbBotState'), line.text);
    $('#stageState').dataset.tone = line.tone;
    $('#tbBotState').classList.toggle('warn-text', line.tone === 'warn');
    $('#stageWake').hidden = !line.wake || D.offline;
    if (!quiet && lastFig !== null && lastFig !== s) {
      if (s === 'waiting') { hop($('#stageFig')); hop($('#tbBot .fig')); }
      if (s === 'result') { hop($('#stageFig'), 'squash'); }
    }
    lastFig = s;
    refreshSidebar();
    showDot($('#panelDot'), !ui.panel && needsOf(b).length > 0);
    updateComposer();
  }
  function mountFigures() {
    const s = figState();
    $$('.fig-host').forEach((h) => {
      const kind = h.dataset.fig;
      h.innerHTML = figure(s, kind === 'back' ? 'sm' : 'cur');
    });
  }

  // ---------------------------------------------------------------- 会话正文
  function mrow(w) {
    const st = workStatus(w);
    const cont = w.round > 1 ? ' · 接着上次' : '';
    return `<button class="mrow" type="button" data-act="open-work" data-w="${w.id}">${avatar(w.av)}<span class="nm">${esc(w.agent)}</span><span class="tk">${esc(w.task)}${cont}</span><span class="st"><span class="now${st.warn ? ' warn' : ''}" data-now>${st.html}</span><span class="go">在工作台打开${icon('out')}</span></span></button>`;
  }
  function msgHTML(m) {
    switch (m.type) {
      case 'day': return `<div class="m-day" data-mk="${m.k}">${esc(m.text)}</div>`;
      case 'me': return `<div class="m-me" data-mk="${m.k}">${esc(m.text)}</div>`;
      case 'say': return `<div class="m-say" data-mk="${m.k}">${esc(m.text)}</div>${m.ops ? `<div class="m-ops">${icon('copy')}${icon('branch')}${icon('retry')}</div>` : ''}`;
      case 'new': return `<div class="m-new" data-mk="${m.k}">新</div>`;
      case 'ops': return `<div class="m-ops" data-mk="${m.k}">${icon('copy')}${icon('branch')}${icon('retry')}</div>`;
      case 'proc': return `<div class="m-proc" data-mk="${m.k}"><span class="shim">${esc(m.text)}</span></div>`;
      case 'memtool': return `<button class="m-proc" type="button" data-mk="${m.k}" data-act="goto-mem" data-id="${m.mem}">${icon('check')}<span>记住了 · ${esc(m.text)}</span></button>`;
      case 'dispatch': {
        const ws = m.works.map(work).filter(Boolean);
        return `<div class="m-dispatch" data-mk="${m.k}"><div class="m-sec">已分派 ${ws.length} 个任务</div><div class="m-rows">${ws.map(mrow).join('')}</div></div>`;
      }
      case 'report': {
        const w = work(m.work);
        return `<div class="m-rep" data-mk="${m.k}"><div class="rh">${avatar(w.av)}<b>${esc(w.agent)}</b> · 返回了结果</div><div class="rb">${esc(m.text)}</div>${m.file ? `<div class="rf"><em>MD</em>${esc(m.file)}</div>` : ''}</div>`;
      }
      default: return '';
    }
  }
  const scroller = $('#scroller'); const col = $('#col');
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  function toBottom(smooth = false) { scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && full() ? 'smooth' : 'auto' }); }
  scroller.addEventListener('scroll', () => {
    const away = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 160;
    const j = $('#jump');
    if (away && j.hidden && sess().msgs.length) { j.hidden = false; M.animate(j, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { spring: 'snap' }); }
    if (!away) j.hidden = true;
  });
  $('#jump').addEventListener('click', () => toBottom(true));

  let chatToken = 0;
  function setDraftMode(on, { animate = false } = {}) {
    const composer = $('#composer');
    const draft = $('#draft');
    if (on) {
      draft.hidden = false;
      scroller.style.visibility = 'hidden';
      $('#draftTitle').textContent = `和 ${bot().name} 聊点什么`;
      $('#starters').innerHTML = ['接手一个正在进行的会话', '整理这周各项目的进展', '每天 9 点告诉我昨天发生了什么', '记住我写东西的习惯']
        .map((t) => `<button class="starter" type="button" data-act="starter" data-text="${esc(t)}">${esc(t)}</button>`).join('');
      $('#draftSlot').append(composer);
      if (animate) $$('#draft > *').forEach((n, i) => M.animate(n, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: i * 40 }));
      return Promise.resolve();
    }
    if (draft.hidden) return Promise.resolve();
    // 首次发送：输入框 travel 停靠到底部；标题与起始建议下沉淡出
    const r0 = composer.getBoundingClientRect();
    const ghosts = [...$$('#draft .fig-host, #draft .draft-title, #draft .starter')];
    ghosts.forEach((n, i) => M.animate(n, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(10px)' }], { duration: 160, delay: i * 18, easing: M.ease.exit, fill: 'forwards' }));
    $('#dock').append(composer);
    const r1 = composer.getBoundingClientRect();
    scroller.style.visibility = '';
    const a = M.animate(composer, [{ transform: `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px)` }, { transform: 'none' }], { spring: 'travel' });
    return M.done(a).then(() => { draft.hidden = true; ghosts.forEach((n) => n.getAnimations().forEach((x) => x.cancel())); });
  }
  async function renderChat({ animate = false, dir = 1 } = {}) {
    const token = ++chatToken;
    const s = sess();
    if (animate && full() && col.children.length) {
      await M.done(M.animate(col, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${-8 * dir}px)` }], { duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' }));
      if (token !== chatToken) return;
      col.getAnimations().forEach((a) => a.cancel());
    }
    if (!s.msgs.length) {
      col.innerHTML = '';
      $('#dock').append($('#composer'));
      setDraftMode(true, { animate });
      return;
    }
    $('#draft').hidden = true;
    scroller.style.visibility = '';
    $('#dock').append($('#composer'));
    col.innerHTML = s.msgs.map(msgHTML).join('');
    toBottom();
    if (animate) {
      const kids = [...col.children].slice(-7);
      kids.forEach((k, i) => M.animate(k, [{ opacity: 0, transform: `translateY(${10 * dir}px)` }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: i * 22 }));
    }
  }
  function appendMsg(m, { into = ui.session, enter = 'glide' } = {}) {
    const s = D.sessions[into];
    s.msgs.push(m);
    if (into !== ui.session) return null;
    const follow = nearBottom();
    col.insertAdjacentHTML('beforeend', msgHTML(m));
    const els = $$(`[data-mk="${m.k}"]`, col);
    const el = els[0];
    if (m.type === 'dispatch') {
      M.animate(el.querySelector('.m-sec'), [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: M.ease.out });
      $$('.mrow', el).forEach((r, i) => {
        M.animate(r, [{ opacity: 0, transform: 'translateY(8px) scale(.98)' }, { opacity: 1, transform: 'none' }], { spring: 'settle', delay: 60 + i * 24 });
        M.animate(r.querySelector('.av'), [{ transform: 'rotate(-14deg) scale(.7)' }, { transform: 'none' }], { spring: 'settle', delay: 60 + i * 24 });
      });
    } else if (m.type === 'me') {
      M.animate(el, [{ opacity: 0, transform: 'translateY(14px) scale(.98)' }, { opacity: 1, transform: 'none' }], { spring: 'travel' });
    } else {
      M.animate(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { spring: enter });
    }
    if (follow || m.type === 'me') requestAnimationFrame(() => toBottom(true));
    return el;
  }
  function removeMsg(k, into = ui.session) {
    const s = D.sessions[into];
    s.msgs = s.msgs.filter((m) => m.k !== k);
    const el = $(`[data-mk="${k}"]`, col);
    if (el && into === ui.session) M.done(M.animate(el, [{ opacity: 1 }, { opacity: 0 }], { duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' })).then(() => el.remove());
  }
  async function streamSay(text, run, into = ui.session, withOps = true) {
    const m = { k: `m${Date.now()}`, type: 'say', text: '', ops: false };
    const el = appendMsg(m, { into });
    let shown = 0;
    while (shown < text.length) {
      run?.check();
      shown = Math.min(text.length, shown + 2);
      m.text = text.slice(0, shown);
      if (el) { el.innerHTML = `${esc(m.text)}<span class="cursor"></span>`; if (nearBottom()) toBottom(); }
      await M.sleep(M.level === 'off' ? 0 : 38, run);
    }
    m.text = text;
    m.ops = withOps;
    if (el) {
      el.textContent = text;
      if (withOps) { el.insertAdjacentHTML('afterend', `<div class="m-ops">${icon('copy')}${icon('branch')}${icon('retry')}</div>`); M.animate(el.nextElementSibling, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: M.ease.out }); }
    }
    return m;
  }
  function refreshWorkViews(id) {
    const w = work(id);
    if (!w) return;
    const st = workStatus(w);
    $$(`[data-w="${id}"] [data-now]`).forEach((n) => { n.classList.toggle('warn', !!st.warn); swapIn(n, st.html); });
  }

  // ---------------------------------------------------------------- 会话切换
  async function switchSession(id, { flashMsg } = {}) {
    if (!D.sessions[id]) return;
    if (id === ui.session) { if (flashMsg) flash($(`[data-mk="${flashMsg}"]`, col)); return; }
    const order = sessionOrder();
    const dir = order.indexOf(id) >= order.indexOf(ui.session) ? 1 : -1;
    const prevBot = ui.bot;
    ui.session = id;
    const s = sess();
    s.unread = false;
    if (D.latestReport && D.latestReport.session === id) D.latestReport.unread = false;
    ui.bot = s.bot;
    const b = bot();
    if (!b.open) toggleGroup(b.id);
    placeSel();
    renderTitle(dir);
    if (frame.dataset.size !== 'desktop') setSidebar(false);
    if (prevBot !== ui.bot) switchBotStage(dir);
    else refreshPane();
    refreshState({ quiet: prevBot !== ui.bot });
    await renderChat({ animate: true, dir });
    if (flashMsg) flash($(`[data-mk="${flashMsg}"]`, col));
  }
  function switchBotStage(dir) {
    const host = $('#stageFig .fig-host');
    const old = host.firstElementChild;
    const next = () => {
      host.innerHTML = figure(figState(), 'cur');
      M.animate(host.firstElementChild, [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
    };
    if (old && full()) M.done(M.animate(old, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' })).then(next);
    else next();
    $$('.fig-host[data-fig="tb"], .fig-host[data-fig="draft"]').forEach((h) => { h.innerHTML = figure(figState(), 'cur'); });
    setText($('#stageName'), bot().name, dir);
    $('#tbBotName').textContent = bot().name;
    $('#input').placeholder = `和 ${bot().name} 说…`;
    if (ui.page) closePage(false);
    renderPane({ animate: true, dir });
    placeInk();
    renderTabDots();
  }

  function newSession() {
    const b = bot();
    const id = `s${Date.now()}`;
    D.sessions[id] = { id, bot: b.id, title: '新会话', parent: null, unread: false, msgs: [] };
    b.sessions.splice(0, 0, id);
    const g = $(`.bot-g[data-bot="${b.id}"] .bot-sessions`);
    if (!b.open) toggleGroup(b.id);
    const rows = $$('.sess', g);
    const tops = rows.map((r) => r.getBoundingClientRect().top);
    g.insertAdjacentHTML('afterbegin', sessRow(id));
    rows.forEach((r, i) => { const dy = tops[i] - r.getBoundingClientRect().top; M.animate(r, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { spring: 'glide' }); });
    M.animate(g.firstElementChild, [{ opacity: 0, transform: 'translateY(-6px) scale(.97)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
    switchSession(id);
    setTimeout(() => $('#input').focus(), 60);
  }

  // ---------------------------------------------------------------- 输入框与一轮对话
  const input = $('#input'); const sendBtn = $('#send');
  function updateComposer() {
    const b = bot();
    const blocked = D.offline ? '电脑没连上，只能查看记录' : b.sleeping || b.waking ? `${b.name} 在休息，叫醒后才能继续` : '';
    input.disabled = !!blocked;
    input.placeholder = blocked || `和 ${b.name} 说…`;
    $('#composer').dataset.disabled = String(!!blocked);
    sendBtn.dataset.ready = String(!!input.value.trim() && !blocked);
    sendBtn.dataset.state = ui.busy && sess().bot === b.id ? 'busy' : 'idle';
    sendBtn.setAttribute('aria-label', sendBtn.dataset.state === 'busy' ? '停止' : '发送');
  }
  let typingTimer = 0;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
    const was = ui.typing;
    ui.typing = !!input.value.trim();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { ui.typing = false; refreshState(); }, 1600);
    if (was !== ui.typing) refreshState();
    else updateComposer();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  sendBtn.addEventListener('click', () => (sendBtn.dataset.state === 'busy' ? stopTurn() : submit()));
  function submit(textArg) {
    const text = (textArg ?? input.value).trim();
    if (!text || input.disabled) return;
    input.value = '';
    input.style.height = '';
    ui.typing = false;
    if (ui.busy) { ui.queue.push({ id: `q${Date.now()}`, text, session: ui.session }); renderQueue(true); updateComposer(); return; }
    runTurn(text);
  }
  function renderQueue(enterLast = false) {
    const q = $('#queue');
    q.innerHTML = ui.queue.filter((x) => x.session === ui.session).map((x) => `<div class="q-item" data-q="${x.id}"><b>排队</b><span>${esc(x.text)}</span><button type="button" data-act="unqueue" data-q="${x.id}" aria-label="撤回">${icon('x')}</button></div>`).join('');
    const last = q.lastElementChild;
    if (enterLast && last) M.animate(last, [{ opacity: 0, transform: 'translateY(6px) scale(.98)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
  }
  function stopTurn() { ui.run?.cancel(); }

  // 示例意图：含“帮我 / 让 / 更新 / 改 / 查 / 整理”的消息会派发一个任务
  function intentWork(text) {
    if (!/帮我|让.+去|更新|改一下|查一下|整理|评估|写/.test(text)) return null;
    if (/README|文档|安装/.test(text)) return { agent: '文档', av: 'dome-ivory', title: '更新 README 安装步骤', task: '更新 README 安装步骤', project: 'varin', doing: '正在编辑 README.md',
      brief: '把 README 的安装步骤更新到 0.9：新的安装包名称、系统要求和首次启动说明。', tools: [['读取', 'README.md', 'L1–120'], ['编辑', 'README.md', '进行中']], text: '' };
    if (/论文|引用|文献/.test(text)) return { agent: '写作', av: 'slant-mint', title: '整理第 3 节引用', task: '整理第 3 节引用', project: 'paper', doing: '正在核对引用', brief: text, tools: [['读取', 'paper/refs.bib', 'L1–310']], text: '' };
    return { agent: '调研', av: 'slope-lilac', title: text.slice(0, 14), task: text.replace(/^帮我/, '').slice(0, 18), project: 'varin', doing: '正在检索资料', brief: text, tools: [['检索', '项目文档与记录', '进行中']], text: '' };
  }
  async function runTurn(text, { reply, memory } = {}) {
    const into = ui.session;
    const s = sess();
    const b = bot();
    const run = M.createRun();
    ui.run = run;
    ui.busy = true;
    if (!s.msgs.length) {
      await setDraftMode(false);
      const title = text.replace(/^(帮我|请|麻烦)/, '').slice(0, 12);
      s.title = title;
      renderTitle(1);
      refreshSidebar();
    }
    appendMsg({ k: `m${Date.now()}u`, type: 'me', text });
    refreshState();
    const pk = `p${Date.now()}`;
    appendMsg({ k: pk, type: 'proc', text: '正在想…' });
    try {
      await M.sleep(900, run);
      removeMsg(pk, into);
      const w = memory ? null : intentWork(text);
      const answer = reply || (w ? `好，我让${w.agent}去做，做完回来告诉你。` : '收到。这件事我直接处理就好，不用另外派人。');
      await streamSay(answer, run, into, false);
      if (memory) {
        const m = { id: `m${Date.now()}`, bot: b.id, text: memory, when: '刚刚', status: 'current', fresh: true,
          sources: [{ date: `今天 ${clock()}`, session: s.title, sid: into, quote: text }] };
        D.memories.unshift(m);
        appendMsg({ k: `t${Date.now()}`, type: 'memtool', mem: m.id, text: memory }, { into });
        addActivity({ kind: 'memory', session: into, mem: m.id, html: `记住了：${esc(memory)}` });
      }
      if (w) {
        const id = `w${Date.now()}`;
        D.work.push(Object.assign({ id, bot: b.id, session: into, state: 'preparing', round: 1, since: Date.now() }, w));
        appendMsg({ k: `x${Date.now()}`, type: 'dispatch', works: [id] }, { into });
        addActivity({ kind: 'dispatch', session: into, work: id, html: `派发给 <b>${esc(w.agent)}</b>：${esc(w.task)}` });
        setTimeout(() => { const x = work(id); if (x && x.state === 'preparing') { x.state = 'running'; refreshWorkViews(id); refreshPane(); refreshState(); } }, 1400 * M.ts);
      }
      // 轮末操作在整轮结束后出现，不夹在正文和派发之间
      const opsEl = appendMsg({ k: `o${Date.now()}`, type: 'ops' }, { into });
      if (opsEl) M.animate(opsEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 60, easing: M.ease.out });
    } catch (e) {
      if (!(e instanceof M.Cancelled)) throw e;
      removeMsg(pk, into);
      appendMsg({ k: `c${Date.now()}`, type: 'proc', text: '已停止' }, { into });
      $(`[data-mk] .shim`, col)?.classList.remove('shim');
    } finally {
      ui.busy = false;
      ui.run = null;
      refreshState();
      refreshPane();
      const nextIdx = ui.queue.findIndex((x) => x.session === into);
      if (nextIdx >= 0) {
        const [next] = ui.queue.splice(nextIdx, 1);
        renderQueue();
        if (into === ui.session) runTurn(next.text);
      }
    }
  }
  function addActivity(entry) {
    D.activity.unshift(Object.assign({ id: `a${Date.now()}${Math.random().toString(36).slice(2, 5)}`, bot: ui.bot, day: '今天', t: clock() }, entry));
    const owner = entry.bot || ui.bot; if (!(owner === ui.bot && ui.tab === 'activity')) { dotsOf(owner).activity = true; renderTabDots(); }
  }

  // ---------------------------------------------------------------- 右侧面板：页签
  const TABS = [['overview', '概览'], ['activity', '动态'], ['memory', '记忆'], ['schedule', '日程']];
  const ink = $('#tabInk');
  const inkX = new M.Spring(0, { token: 'glide', onUpdate: () => applyInk() });
  const inkW = new M.Spring(30, { token: 'glide', onUpdate: () => applyInk() });
  function applyInk() { ink.style.transform = `translateX(${inkX.x}px)`; ink.style.width = `${inkW.x}px`; }
  function renderTabs() {
    $$('.tab', $('#tabs')).forEach((t) => t.remove());
    $('#tabs').insertAdjacentHTML('beforeend', TABS.map(([id, label]) => `<button class="tab" type="button" role="tab" id="tab-${id}" data-tab="${id}" aria-selected="${ui.tab === id && !ui.page}" tabindex="${ui.tab === id ? 0 : -1}">${label}<i class="t-dot" hidden></i></button>`).join(''));
    renderTabDots();
    placeInk(true);
  }
  function dotsOf(id = ui.bot) { return (ui.tabDots[id] ||= { overview: false, activity: false }); }
  function renderTabDots() {
    const needs = needsOf().length > 0;
    const ov = $('.tab[data-tab="overview"] .t-dot');
    const ac = $('.tab[data-tab="activity"] .t-dot');
    if (!ov) return;
    ov.classList.add('warn');
    showDot(ov, ui.tab !== 'overview' && dotsOf().overview && needs);
    showDot(ac, ui.tab !== 'activity' && dotsOf().activity);
  }
  function placeInk(instant = false) {
    const t = $(`.tab[data-tab="${ui.tab}"]`);
    if (!t) return;
    ink.style.opacity = ui.page ? '0' : '1';
    inkX.to(t.offsetLeft + 10, { instant });
    inkW.to(t.offsetWidth - 20, { instant });
  }
  function switchTab(tab, { highlight } = {}) {
    if (ui.page) closePage(false);
    const order = TABS.map((t) => t[0]);
    const dir = order.indexOf(tab) >= order.indexOf(ui.tab) ? 1 : -1;
    if (tab !== ui.tab) {
      ui.tab = tab;
      if (tab === 'overview') dotsOf().overview = false;
      if (tab === 'activity') dotsOf().activity = false;
      $$('.tab').forEach((t) => { const on = t.dataset.tab === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
      placeInk();
      renderTabDots();
      renderPane({ animate: true, dir });
    }
    if (highlight) setTimeout(() => flash($(`[data-k="${highlight}"]`, paneEl)), 180 * M.ts);
  }

  // ---------------------------------------------------------------- 页签内容
  const blk = (key, label, inner, target, id = '') => `<button class="ov-blk" type="button" data-k="blk-${key}" data-act="ov" data-target="${target}" data-id="${id}"><div class="bh">${label}${icon('right')}</div>${inner}</button>`;
  function paneOverview() {
    const b = bot();
    const needs = needsOf(b);
    const run = runningOf(b).filter((w) => w.state !== 'waiting');
    const mem = D.memories.find((m) => m.bot === b.id && m.status === 'current');
    const sch = D.schedules.find((x) => x.bot === b.id && !x.paused);
    const rep = D.latestReport && work(D.latestReport.work)?.bot === b.id ? D.latestReport : null;
    let h = '';
    h += needs.slice(0, 3).map((n) => { const w = work(n.work); return `<button class="ov-need" type="button" data-k="need-${n.id}" data-act="open-work" data-w="${w.id}">${avatar(w.av)}<span class="t"><b>${esc(w.agent)}</b><span>${esc(n.text)}</span></span><span class="go">去处理${icon('out')}</span></button>`; }).join('');
    if (needs.length > 3) h += `<div class="grp" data-k="need-more">还有 ${needs.length - 3} 件在等你</div>`;
    if (run.length) {
      const w0 = run[run.length - 1];
      h += blk('run', '进行中', `<div class="big" data-s="runcount">${run.length} 项工作在进行</div><div class="sm"><span class="faces">${run.slice(0, 4).map((w) => avatar(w.av)).join('')}</span><span data-s="runline">${esc(w0.agent)}${esc(w0.doing || '正在工作')}${minutes(w0) ? ` · ${minutes(w0)} 分钟` : ''}</span></div>`, 'activity');
    }
    if (rep) {
      const w = work(rep.work);
      h += blk('latest', '刚刚', `<div class="big" data-s="latest"><b>${esc(w.agent)}</b> 返回了结果</div><div class="sm">${rep.unread ? '<i class="u-dot"></i>' : ''}<span>${rep.t} · 回到「${esc(D.sessions[rep.session].title)}」</span></div>`, 'report');
    }
    if (mem) h += blk('mem', '记忆', `<div class="quote" data-s="memq">${esc(mem.text)}</div><div class="sm"><span>${esc(mem.when)} · 来自「${esc(mem.sources[0].session)}」</span></div>`, 'memory', mem.id);
    if (sch) {
      const paused = D.schedules.filter((x) => x.bot === b.id && x.paused).length;
      h += blk('sch', '日程', `<div class="big">${sch.day} ${sch.when}　${esc(sch.title)}</div><div class="sm"><span>${sch.rule}${paused ? ` · 另有 ${paused} 个已暂停` : ''}</span></div>`, 'schedule', sch.id);
    }
    if (!needs.length && !run.length && !rep) h += `<div class="ov-empty" data-k="empty">现在没有进行中的工作。<br>交给 ${esc(b.name)} 的事会出现在这里。</div>`;
    return h;
  }
  function paneActivity() {
    const b = bot();
    const here = ui.actScope === 'here';
    const live = liveOf(b).filter((w) => !here || w.session === ui.session)
      .sort((x, y) => (x.state === 'waiting' ? -1 : 0) - (y.state === 'waiting' ? -1 : 0));
    let h = `<div class="pane-bar" data-k="bar"><div class="seg" data-seg="act"><span class="seg-knob"></span><button type="button" data-act="scope" data-v="all" aria-pressed="${!here}">全部会话</button><button type="button" data-act="scope" data-v="here" aria-pressed="${here}">本会话</button></div></div>`;
    if (live.length) {
      h += '<div class="grp" data-k="g-live">进行中</div>';
      h += live.map((w) => { const st = workStatus(w); return `<button class="arow" type="button" data-k="w-${w.id}" data-act="open-work" data-w="${w.id}">${avatar(w.av)}<span class="t"><b>${esc(w.agent)}</b><span>${esc(w.task)}${here ? '' : ` <i>· ${esc(D.sessions[w.session].title)}</i>`}</span></span><span class="st"><span class="now${st.warn ? ' warn' : ''}" data-now>${st.html}</span><span class="go">打开${icon('out')}</span></span></button>`; }).join('');
    }
    const entries = D.activity.filter((a) => a.bot === b.id && (!here || a.session === ui.session));
    const days = [...new Set(entries.map((a) => a.day))];
    days.forEach((d) => {
      h += `<div class="grp" data-k="g-${d}">${d}</div><div class="tl" data-k="tl-${d}">${entries.filter((a) => a.day === d).map((a) => `<button class="te" type="button" data-k="${a.id}" data-kind="${a.kind}" data-act="act" data-id="${a.id}"><span class="tm">${a.t}</span><span class="tx">${a.html}${a.sub ? `<span class="sub">${esc(a.sub)}</span>` : ''}${!here && a.session ? `<span class="sub">${esc(D.sessions[a.session]?.title || '')}</span>` : ''}</span></button>`).join('')}</div>`;
    });
    if (!live.length && !entries.length) h += `<div class="ov-empty" data-k="empty">${here ? '这个会话还没有派发过工作。' : '还没有动态。'}</div>`;
    return h;
  }
  function memDetail(m) {
    const srcs = m.sources.map((s, i) => `<div class="src"><div class="sh">${esc(s.date)} · ${esc(s.session)}${s.sid ? `<button type="button" data-act="mem-src" data-id="${m.id}" data-i="${i}">打开原话</button>` : ''}</div>${s.quote ? `<q>${esc(s.quote)}</q>` : ''}</div>`).join('');
    let acts;
    if (ui.memEdit === m.id) acts = `<textarea data-edit="${m.id}" aria-label="编辑记忆">${esc(m.text)}</textarea><div class="mem-acts"><button class="btn pri" type="button" data-act="mem-save" data-id="${m.id}">保存</button><button class="btn" type="button" data-act="mem-cancel" data-id="${m.id}">取消</button></div>`;
    else if (ui.memConfirm === m.id) acts = `<div class="confirm">忘掉后，之后的对话不会再用到这段，相关概述会重建。已经发出的请求无法撤回。</div><div class="mem-acts"><button class="btn danger pri" type="button" data-act="mem-forget-yes" data-id="${m.id}">忘掉</button><button class="btn" type="button" data-act="mem-cancel" data-id="${m.id}">取消</button></div>`;
    else acts = `<div class="mem-acts"><button class="btn" type="button" data-act="mem-edit" data-id="${m.id}">${icon('edit')}编辑</button><button class="btn" type="button" data-act="mem-obsolete" data-id="${m.id}">${m.status === 'obsolete' ? '恢复适用' : '不再适用'}</button><button class="btn danger" type="button" data-act="mem-forget" data-id="${m.id}">忘掉</button></div>`;
    return `<div class="mem-detail">${srcs}${m.rev ? `<div class="rev">${esc(m.rev)}</div>` : ''}${acts}</div>`;
  }
  function memInner(m) {
    const meta = `${m.status === 'obsolete' ? '<span class="tagx">已不再适用</span>' : ''}${esc(m.when)} · ${m.sources.length > 1 ? `${m.sources.length} 处来源` : `来自「${esc(m.sources[0].session)}」`}`;
    return `<button class="mem-head" type="button" data-act="mem-toggle" data-id="${m.id}" aria-expanded="${ui.memOpen.has(m.id)}"><p>${esc(m.text)}</p><span class="meta">${meta}</span></button>${ui.memOpen.has(m.id) ? memDetail(m) : ''}`;
  }
  function paneMemory() {
    const b = bot();
    const all = ui.memScope === 'all';
    const q = ui.memQuery.trim();
    const list = D.memories.filter((m) => m.bot === b.id && (all || m.status === 'current') && (!q || m.text.includes(q) || m.sources.some((s) => (s.quote || '').includes(q))));
    let h = `<div class="pane-bar" data-k="bar"><label class="search grow">${icon('search')}<input id="memSearch" type="search" placeholder="搜索 ${esc(b.name)} 记得的事" value="${esc(ui.memQuery)}" autocomplete="off"></label><div class="seg" data-seg="mem"><span class="seg-knob"></span><button type="button" data-act="memscope" data-v="current" aria-pressed="${!all}">当前</button><button type="button" data-act="memscope" data-v="all" aria-pressed="${all}">全部</button></div></div>`;
    h += `<div class="mems" data-k="mems">${list.map((m) => `<div class="mem" data-k="m-${m.id}" data-id="${m.id}" data-status="${m.status}" data-open="${ui.memOpen.has(m.id)}">${memInner(m)}</div>`).join('')}</div>`;
    if (!list.length) h += `<div class="ov-empty" data-k="empty">${q ? '没有找到相关的记忆。' : `${esc(b.name)} 还没有记住什么。`}</div>`;
    return h;
  }
  function schInner(x) {
    return `<div class="sch-row"><span class="when"><b>${x.when}</b><span>${x.day}</span></span><span class="what"><b>${esc(x.title)}</b><span>${x.paused ? '已暂停 · ' : ''}${x.rule} · ${esc(x.target)}</span></span></div>${ui.schOpen.has(x.id) ? `<dl class="sch-detail"><dt>规则</dt><dd>${x.rule} ${x.when}</dd><dt>发到</dt><dd>${esc(x.target)}</dd><dt>错过时</dt><dd>${x.missed}</dd><div class="acts"><button class="btn" type="button" data-act="sch-edit" data-id="${x.id}">编辑</button><button class="btn" type="button" data-act="sch-pause" data-id="${x.id}">${x.paused ? '恢复' : '暂停'}</button></div></dl>` : ''}`;
  }
  function paneSchedule() {
    const b = bot();
    const list = D.schedules.filter((x) => x.bot === b.id);
    const active = list.filter((x) => !x.paused); const paused = list.filter((x) => x.paused);
    let h = '';
    const rows = (xs) => xs.map((x) => `<div class="sch" role="button" tabindex="0" data-k="sch-${x.id}" data-act="sch-toggle" data-id="${x.id}" data-open="${ui.schOpen.has(x.id)}" data-paused="${x.paused}">${schInner(x)}</div>`).join('');
    if (active.length) h += `<div class="grp" data-k="g-next">接下来</div>${rows(active)}`;
    if (paused.length) h += `<div class="grp" data-k="g-paused">已暂停</div>${rows(paused)}`;
    if (!list.length) h += `<div class="ov-empty" data-k="empty">还没有日程。</div>`;
    h += `<button class="addrow" type="button" data-k="add" data-act="sch-new">${icon('plus')}新建日程</button>`;
    return h;
  }
  const PANES = { overview: paneOverview, activity: paneActivity, memory: paneMemory, schedule: paneSchedule };
  let paneEl = null;
  function afterPane(el) {
    $$('.seg', el).forEach(placeSeg);
    const s = $('#memSearch', el);
    if (s) s.addEventListener('input', () => { ui.memQuery = s.value; const pos = s.selectionStart; refreshPane(); const n = $('#memSearch'); n.focus(); n.setSelectionRange(pos, pos); });
  }
  function renderPane({ animate = false, dir = 1 } = {}) {
    const panes = $('#panes');
    const next = document.createElement('div');
    next.className = 'pane';
    next.setAttribute('role', 'tabpanel');
    next.setAttribute('aria-labelledby', `tab-${ui.tab}`);
    next.innerHTML = PANES[ui.tab]();
    const old = paneEl;
    panes.querySelectorAll('.pane:not(.pane-page)').forEach((p) => { if (p !== old) p.remove(); });
    panes.append(next);
    paneEl = next;
    afterPane(next);
    if (!old) return;
    old.style.pointerEvents = 'none';
    if (animate && M.level !== 'off') {
      M.done(M.animate(old, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${-6 * dir}px)` }], { duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' })).then(() => old.remove());
      [...next.children].slice(0, 6).forEach((k, i) => M.animate(k, [{ opacity: 0, transform: `translateX(${8 * dir}px)` }, { opacity: 1, transform: 'none' }], { spring: 'glide', delay: 40 + i * 18 }));
    } else old.remove();
  }
  function refreshPane() {
    if (!paneEl) return;
    patch(paneEl, PANES[ui.tab]());
    afterPane(paneEl);
    renderTabDots();
  }

  // ---------------------------------------------------------------- 档案页（推入，盖住页签内容）
  let pageEl = null;
  function profileHTML() {
    const b = bot(); const d = ui.profileDraft;
    const dirty = d.name !== b.name || d.label !== b.label || d.instructions !== b.instructions || d.model !== b.model || d.organize !== b.organize;
    return `<div class="page-head"><button class="tb-btn" type="button" data-act="page-back" aria-label="返回">${icon('back')}</button>档案</div>
      <div class="page-body">
        <div class="field"><label for="pfName">名字</label><input type="text" id="pfName" data-pf="name" value="${esc(d.name)}"></div>
        <div class="field"><label for="pfLabel">标签</label><input type="text" id="pfLabel" data-pf="label" value="${esc(d.label)}"></div>
        <div class="field"><label for="pfIns">合作指令</label><textarea id="pfIns" data-pf="instructions">${esc(d.instructions)}</textarea><span class="hint">每次对话都会带上这段话。</span></div>
        <div class="field"><label for="pfModel">模型</label><select id="pfModel" data-pf="model">${['主力模型', '快速模型', '长上下文模型'].map((m) => `<option ${m === d.model ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <label class="toggle-row"><span class="grow">后台整理记忆</span><input type="checkbox" data-pf="organize" ${d.organize ? 'checked' : ''}><span class="switch"><i></i></span></label>
        <div class="field"><span class="fl">状态</span><div class="mem-acts">${b.sleeping ? `<button class="btn" type="button" data-act="wake">${icon('sun')}叫醒</button>` : `<button class="btn" type="button" data-act="sleep">${icon('moon')}让它休息</button>`}</div><span class="hint">休息时不开始新的工作，回报照常保存。</span></div>
        <div class="danger-zone"><button class="btn" type="button" data-act="noop">${icon('archive')}归档</button><button class="btn danger" type="button" data-act="noop">${icon('trash')}删除</button></div>
      </div>
      ${dirty ? `<div class="savebar"><span class="grow">有未保存的修改</span><button class="btn" type="button" data-act="pf-discard">放弃</button><button class="btn pri" type="button" data-act="pf-save">保存</button></div>` : ''}`;
  }
  function openPage() {
    if (ui.page) return;
    const b = bot();
    ui.page = 'profile';
    ui.profileDraft = { name: b.name, label: b.label, instructions: b.instructions, model: b.model, organize: b.organize };
    pageEl = document.createElement('div');
    pageEl.className = 'pane pane-page';
    pageEl.innerHTML = profileHTML();
    $('#panes').append(pageEl);
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', 'false'));
    ink.style.opacity = '0';
    M.animate(pageEl, [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], { spring: 'travel' });
    if (paneEl) M.animate(paneEl, [{ opacity: 1 }, { opacity: 0.4 }], { duration: 160, easing: M.ease.out, fill: 'forwards' });
    setTimeout(() => $('#pfName')?.focus({ preventScroll: true }), 200);
  }
  function closePage(animate = true) {
    if (!ui.page) return;
    ui.page = null;
    const el = pageEl; pageEl = null;
    paneEl?.getAnimations().forEach((a) => a.cancel());
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === ui.tab)));
    ink.style.opacity = '1';
    if (!animate) { el.remove(); return; }
    M.done(M.animate(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(24px)' }], { duration: 160, easing: M.ease.exit, fill: 'forwards' })).then(() => el.remove());
  }
  function refreshPage() {
    if (!pageEl) return;
    const had = !!pageEl.querySelector('.savebar');
    const focus = document.activeElement?.dataset?.pf;
    const sel = focus && document.activeElement.selectionStart;
    pageEl.innerHTML = profileHTML();
    if (focus) { const n = $(`[data-pf="${focus}"]`, pageEl); n?.focus({ preventScroll: true }); if (sel != null && n.setSelectionRange) n.setSelectionRange(sel, sel); }
    const bar = pageEl.querySelector('.savebar');
    if (bar && !had) M.animate(bar, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
  }
  $('#panes').addEventListener('input', (e) => {
    const k = e.target.dataset?.pf;
    if (!k || !ui.profileDraft) return;
    ui.profileDraft[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    refreshPage();
  });
  $('#panes').addEventListener('change', (e) => {
    const k = e.target.dataset?.pf;
    if (!k || !ui.profileDraft) return;
    ui.profileDraft[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    refreshPage();
  });

  // ---------------------------------------------------------------- 面板开合与拖宽
  const rp = $('#rp'); const rpInner = $('#rpInner'); const handle = $('#rpHandle');
  const P = { min: 300, max: 560, def: 360, collapse: 240 };
  let panelMode = 'toggle';
  const wSpring = new M.Spring(360, { token: 'glide', onUpdate: (w) => applyPanel(w) });
  function applyPanel(w) {
    if (frame.dataset.size === 'mobile') return;
    rp.style.width = `${Math.max(0, w)}px`;
    if (panelMode === 'resize') {
      rpInner.style.width = `${w}px`;
      rpInner.style.transform = '';
      rpInner.style.opacity = '';
    } else {
      rpInner.style.width = `${ui.panelW}px`;
      const p = clamp(w / ui.panelW, 0, 1);
      rpInner.style.transform = `translateX(${(1 - p) * 28}px)`;
      rpInner.style.opacity = String(clamp(p / 0.35, 0, 1));
    }
    handle.setAttribute('aria-valuenow', String(Math.round(w)));
  }
  function setPanel(open) {
    if (frame.dataset.size === 'mobile') { setSheet(open); return; }
    ui.panel = open;
    panelMode = 'toggle';
    frame.dataset.panel = open ? 'open' : 'closed';
    $('#panelToggle').setAttribute('aria-pressed', String(open));
    wSpring.to(open ? ui.panelW : 0);
    if (open && paneEl) [...paneEl.children].slice(0, 6).forEach((k, i) => M.animate(k, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 80 + i * 20, easing: M.ease.out }));
    refreshState({ quiet: true });
  }
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    if (frame.dataset.size === 'mobile' || !ui.panel) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    wSpring.stop();
    drag = { x: e.clientX, w: rp.offsetWidth, prev: ui.panelW, raw: rp.offsetWidth };
    panelMode = 'resize';
    rp.dataset.dragging = 'true';
    document.body.style.cursor = 'col-resize';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const raw = drag.w + (drag.x - e.clientX);
    drag.raw = raw;
    let w = raw;
    if (raw > P.max) w = P.max + (raw - P.max) * 0.3;
    if (raw < P.min) w = P.min - (P.min - raw) * 0.3;
    wSpring.jump(w);
  });
  const endDrag = () => {
    if (!drag) return;
    const { raw, prev } = drag;
    drag = null;
    rp.dataset.dragging = 'false';
    document.body.style.cursor = '';
    if (raw < P.collapse) {
      ui.panelW = prev;
      rpInner.style.width = `${ui.panelW}px`;
      panelMode = 'toggle';
      setPanel(false);
      return;
    }
    const target = clamp(raw, P.min, P.max);
    ui.panelW = target;
    wSpring.to(target);
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', () => { panelMode = 'resize'; ui.panelW = P.def; wSpring.to(P.def); });
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { setPanel(!ui.panel); return; }
    const d = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
    if (!d) return;
    e.preventDefault();
    panelMode = 'resize';
    ui.panelW = clamp(ui.panelW + d, P.min, P.max);
    wSpring.to(ui.panelW);
  });

  // ---------------------------------------------------------------- 侧栏
  function setSidebar(open) {
    ui.sidebar = open;
    frame.dataset.sidebar = open ? 'open' : 'closed';
    $('#sidebarToggle').setAttribute('aria-pressed', String(open));
    if (open) setTimeout(() => placeSel(true), 30);
    refreshSidebar();
  }

  // ---------------------------------------------------------------- 手机：底部面板，跟手拖动
  const sheetY = new M.Spring(1, { token: 'glide', onUpdate: (y) => { if (frame.dataset.size === 'mobile') rp.style.transform = `translateY(${y * 105}%)`; } });
  function setSheet(open) {
    ui.sheet = open;
    frame.dataset.sheet = open ? 'open' : 'closed';
    sheetY.to(open ? 0 : 1);
  }
  let sheetDrag = null;
  $('#sheetGrab').addEventListener('pointerdown', (e) => {
    if (frame.dataset.size !== 'mobile') return;
    $('#sheetGrab').setPointerCapture(e.pointerId);
    sheetY.stop();
    sheetDrag = { y: e.clientY, from: sheetY.x, h: rp.offsetHeight * 1.05, t: performance.now(), lastY: e.clientY, v: 0 };
  });
  $('#sheetGrab').addEventListener('pointermove', (e) => {
    if (!sheetDrag) return;
    const now = performance.now();
    sheetDrag.v = (e.clientY - sheetDrag.lastY) / Math.max(1, now - sheetDrag.t);
    sheetDrag.t = now; sheetDrag.lastY = e.clientY;
    let y = sheetDrag.from + (e.clientY - sheetDrag.y) / sheetDrag.h;
    if (y < 0) y *= 0.25;
    sheetY.jump(y);
  });
  const endSheet = () => {
    if (!sheetDrag) return;
    const close = sheetDrag.v > 0.5 || sheetY.x > 0.35;
    sheetDrag = null;
    setSheet(!close);
  };
  $('#sheetGrab').addEventListener('pointerup', endSheet);
  $('#sheetGrab').addEventListener('pointercancel', endSheet);

  // ---------------------------------------------------------------- 工作台（跳转目标）
  function renderWorkbench(w) {
    const b = bot(w.bot);
    $('#backLabel').textContent = `${b.name} · ${D.sessions[w.session].title}`;
    $('#wbShell .fig-host[data-fig="back"]').innerHTML = figure(figState(b), 'sm');
    $('#wbTitle').textContent = w.title;
    $('#wbSub').textContent = `${w.project} · 由 ${b.name} 交办`;
    $('#wbProject').textContent = w.project;
    const projects = {};
    D.work.forEach((x) => { (projects[x.project] ||= []).push({ id: x.id, title: x.title, bot: true, run: x.state === 'running' || x.state === 'preparing', warn: x.state === 'waiting' }); });
    (projects.paper ||= []).push({ title: '参考文献格式统一' });
    (projects.varin ||= []).push({ title: '索引清理的实现检查' });
    $('#wbSide').innerHTML = `<div class="sb-actions"><button class="sb-new" type="button">${icon('new')}<span>新建会话</span></button></div>${Object.entries(projects).map(([p, rows]) => `<div class="proj">${icon('folder')}${p}</div>${rows.map((r) => `<div class="wsess${r.id === w.id ? ' sel' : ''}">${r.bot ? figure('idle', 'sm bm') : ''}<span class="s-title">${esc(r.title)}</span><span class="s-ico">${r.warn ? '<i class="s-dot warn"></i>' : r.run ? '<span class="ring"></span>' : ''}</span></div>`).join('')}`).join('')}`;
    const need = D.needs.find((n) => n.work === w.id);
    const tools = w.tools.map(([a, o, r]) => `<div class="tool"><span>${a}</span><span class="obj">${esc(o)}</span><span class="r">${r === '进行中' && w.state !== 'running' ? (w.state === 'done' ? '完成' : '—') : r}</span></div>`).join('');
    let tail = '';
    if (need) tail = `<div class="perm" data-perm="${need.id}"><div class="ph">${icon('shield')}${esc(w.agent)} 想写入 ${esc(need.path)}</div><code>${esc(need.detail)}</code><div class="pa"><button class="btn pri" type="button" data-act="perm" data-v="once" data-id="${need.id}">允许一次</button><button class="btn" type="button" data-act="perm" data-v="always" data-id="${need.id}">一直允许</button><button class="btn" type="button" data-act="perm" data-v="deny" data-id="${need.id}">拒绝</button></div></div>`;
    else if (w.state === 'done' && (w.report || w.text)) tail = `<div class="m-say">${esc(w.report || w.text)}</div>`;
    else if (w.text) tail = `<div class="m-say">${esc(w.text)}</div>`;
    if (w.state === 'running' && !need) tail += `<div class="m-proc"><span class="shim">${esc(w.doing || '正在工作')}…</span></div>`;
    $('#wbCol').innerHTML = `<div class="route">${figure(figState(b), 'sm')}<b>${esc(b.name)}</b>→ ${esc(w.agent)} · ${w.round > 1 ? `第 ${w.round} 次交办` : '交办'}</div><div class="task-bubble">${esc(w.brief)}</div>${tools}${tail}`;
  }
  async function goWorkbench(id, origin) {
    const w = work(id);
    if (!w) return;
    closeMenu();
    ui.returnTo = { session: ui.session, scroll: scroller.scrollTop, work: id, from: origin?.closest('.pane') ? 'pane' : 'chat' };
    const pt = pointOf(origin);
    await lattice('cover', pt);
    $('#botShell').hidden = true;
    $('#wbShell').hidden = false;
    renderWorkbench(w);
    await lattice('reveal', pt);
  }
  async function goBack() {
    const pt = pointOf($('#backChip'));
    await lattice('cover', pt);
    $('#wbShell').hidden = true;
    $('#botShell').hidden = false;
    const r = ui.returnTo;
    if (r && r.session !== ui.session) { ui.session = r.session; ui.bot = sess().bot; renderTitle(); await renderChat(); }
    if (r) scroller.scrollTop = r.scroll;
    refreshState({ quiet: true });
    refreshPane();
    await lattice('reveal', pt, { inward: true });
    const target = r?.from === 'pane' ? $(`[data-w="${r.work}"]`, paneEl) : $(`.mrow[data-w="${r?.work}"]`, col);
    if (target) { target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); }
  }
  $('#backChip').addEventListener('click', goBack);
  $('#wbShell').addEventListener('click', (e) => {
    const p = e.target.closest('[data-act="perm"]');
    if (!p) return;
    const n = D.needs.find((x) => x.id === p.dataset.id);
    if (!n) return;
    const w = work(n.work);
    const deny = p.dataset.v === 'deny';
    D.needs = D.needs.filter((x) => x.id !== n.id);
    w.state = deny ? 'paused' : 'running';
    w.doing = deny ? '' : `正在写入 ${n.path}`;
    const card = p.closest('.perm');
    const label = deny ? '你拒绝了这次写入' : p.dataset.v === 'always' ? '已允许，之后同类写入不再询问' : '已允许一次';
    card.outerHTML = `<div class="perm-done">${icon(deny ? 'x' : 'check')}${label}</div>`;
    M.animate($('#wbCol .perm-done'), [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { spring: 'settle' });
    addActivity({ bot: w.bot, kind: 'you', session: w.session, work: w.id, html: `你${deny ? '拒绝了' : '允许了'} <b>${esc(w.agent)}</b> 写入 ${esc(n.path)}` });
    $('#backChip .fig')?.setAttribute('data-state', figState(bot(w.bot)));
  });

  // ---------------------------------------------------------------- Bot 外壳的点击
  $('#botShell').addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    switch (act) {
      case 'session': switchSession(t.dataset.s); break;
      case 'bot-toggle': toggleGroup(t.dataset.bot); break;
      case 'open-work': goWorkbench(t.dataset.w, t); break;
      case 'starter': submit(t.dataset.text); break;
      case 'unqueue': ui.queue = ui.queue.filter((x) => x.id !== t.dataset.q); renderQueue(); break;
      case 'goto-mem': if (!ui.panel) setPanel(true); switchTab('memory', { highlight: `m-${t.dataset.id}` }); break;
      case 'ov': overviewGo(t); break;
      case 'scope': ui.actScope = t.dataset.v; refreshPane(); break;
      case 'memscope': ui.memScope = t.dataset.v; refreshPane(); break;
      case 'act': activityGo(t.dataset.id, t); break;
      case 'mem-toggle': memToggle(t.dataset.id); break;
      case 'mem-edit': ui.memEdit = t.dataset.id; ui.memConfirm = null; memRerender(t.dataset.id, true); setTimeout(() => $(`[data-edit="${t.dataset.id}"]`)?.focus(), 50); break;
      case 'mem-cancel': ui.memEdit = null; ui.memConfirm = null; memRerender(t.dataset.id, true); break;
      case 'mem-save': memSave(t.dataset.id); break;
      case 'mem-obsolete': memObsolete(t.dataset.id); break;
      case 'mem-forget': ui.memConfirm = t.dataset.id; ui.memEdit = null; memRerender(t.dataset.id, true); break;
      case 'mem-forget-yes': memForget(t.dataset.id); break;
      case 'mem-src': { const m = D.memories.find((x) => x.id === t.dataset.id); const s = m.sources[+t.dataset.i]; if (s?.sid) switchSession(s.sid, { flashMsg: s.msg }); break; }
      case 'sch-toggle': schToggle(t.dataset.id); break;
      case 'sch-pause': { const x = D.schedules.find((y) => y.id === t.dataset.id); x.paused = !x.paused; ui.schOpen.delete(x.id); refreshPane(); toast(x.paused ? '已暂停这个日程' : '已恢复这个日程'); break; }
      case 'sch-edit': toast('编辑沿用现有的日程对话框'); break;
      case 'sch-new': input.value = '每天 9 点告诉我昨天各项目的进展'; input.dispatchEvent(new Event('input')); input.focus(); break;
      case 'page-back': closePage(); break;
      case 'pf-discard': { const b = bot(); ui.profileDraft = { name: b.name, label: b.label, instructions: b.instructions, model: b.model, organize: b.organize }; refreshPage(); break; }
      case 'pf-save': profileSave(); break;
      case 'sleep': setSleep(true); break;
      case 'wake': setSleep(false); break;
      case 'noop': toast('原型里不执行这个操作'); break;
      default: break;
    }
  });
  $('#botShell').addEventListener('keydown', (e) => {
    const t = e.target.closest('[data-act="sch-toggle"]');
    if (t && (e.key === 'Enter' || e.key === ' ') && e.target === t) { e.preventDefault(); schToggle(t.dataset.id); }
  });
  $('#sbGroups').addEventListener('contextmenu', (e) => {
    const h = e.target.closest('.bot-h');
    if (!h) return;
    e.preventDefault();
    const b = bot(h.dataset.bot);
    openMenu(botMenuItems(b, true), { x: e.clientX, y: e.clientY }, (id) => botMenuPick(b, id));
  });
  function botMenuItems(b, more = false) {
    const items = [{ id: 'profile', icon: 'user', label: '档案' }, { id: 'new', icon: 'new', label: '新会话' }, b.sleeping ? { id: 'wake', icon: 'sun', label: '叫醒' } : { id: 'sleep', icon: 'moon', label: '让它休息' }];
    if (more) items.push('-', { id: 'pin', icon: 'pin', label: '置顶' }, { id: 'archive', icon: 'archive', label: '归档' }, { id: 'delete', icon: 'trash', label: '删除', danger: true });
    else items.push('-', { id: 'settings', icon: 'gear', label: '设置' });
    return items;
  }
  function botMenuPick(b, id) {
    if (b.id !== ui.bot && ['profile', 'new', 'sleep', 'wake'].includes(id)) { switchSession(b.sessions[0]); setTimeout(() => botMenuPick(b, id), 420 * M.ts); return; }
    if (id === 'profile') { if (!ui.panel) setPanel(true); if (frame.dataset.size === 'mobile') setSheet(true); openPage(); }
    else if (id === 'new') newSession();
    else if (id === 'sleep') setSleep(true);
    else if (id === 'wake') setSleep(false);
    else toast('原型里不执行这个操作');
  }
  $('#stageMenu').addEventListener('click', (e) => { e.stopPropagation(); openMenu(botMenuItems(bot()), { anchor: $('#stageMenu') }, (id) => botMenuPick(bot(), id)); });
  $('#stageName').addEventListener('click', openPage);
  $('#stageFig').addEventListener('click', () => { if (figState() === 'idle' || figState() === 'working') hop($('#stageFig'), 'squash'); });
  $('#stageWake').addEventListener('click', () => setSleep(false));
  $('#tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) switchTab(t.dataset.tab); });
  $('#tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const order = TABS.map((x) => x[0]);
    const i = (order.indexOf(ui.tab) + (e.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length;
    switchTab(order[i]);
    $(`.tab[data-tab="${order[i]}"]`).focus();
  });
  $('#sidebarToggle').addEventListener('click', () => setSidebar(!ui.sidebar));
  $('#sidebarScrim').addEventListener('click', () => setSidebar(false));
  $('#sheetScrim').addEventListener('click', () => setSheet(false));
  $('#panelToggle').addEventListener('click', () => setPanel(!ui.panel));
  $('#tbBot').addEventListener('click', () => setSheet(true));
  $('#newSession').addEventListener('click', newSession);
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu, #stageMenu')) closeMenu(); });
  $('#chat').addEventListener('pointerdown', () => { if (frame.dataset.size === 'narrow' && ui.panel) setPanel(false); });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); setSidebar(!ui.sidebar); }
    if (e.key === 'Escape') {
      if (!$('#menu').hidden) closeMenu();
      else if (ui.page) closePage();
      else if (ui.sheet) setSheet(false);
      else if (ui.sidebar && frame.dataset.size !== 'desktop') setSidebar(false);
    }
  });

  function overviewGo(t) {
    const target = t.dataset.target;
    if (target === 'activity') switchTab('activity', { highlight: 'g-live' });
    else if (target === 'memory') switchTab('memory', { highlight: `m-${t.dataset.id}` });
    else if (target === 'schedule') switchTab('schedule', { highlight: `sch-${t.dataset.id}` });
    else if (target === 'report' && D.latestReport) { const r = D.latestReport; r.unread = false; switchSession(r.session, { flashMsg: r.msg }); refreshPane(); }
  }
  function activityGo(id, el) {
    const a = D.activity.find((x) => x.id === id);
    if (!a) return;
    if (a.kind === 'memory' && a.mem) switchTab('memory', { highlight: `m-${a.mem}` });
    else if (a.kind === 'report' && a.msg) switchSession(a.session, { flashMsg: a.msg });
    else if (a.work) goWorkbench(a.work, el);
    else if (a.kind === 'quiet') { const sub = el.querySelector('.sub'); if (sub) flash(el); }
  }

  // 记忆操作
  function memRerender(id, animate) {
    const el = $(`.mem[data-id="${id}"]`, paneEl);
    const m = D.memories.find((x) => x.id === id);
    if (!el || !m) return;
    const mutate = () => { el.dataset.open = String(ui.memOpen.has(id)); el.innerHTML = memInner(m); };
    if (animate) M.resize(el, mutate, { stop: el.parentElement }); else mutate();
  }
  function memToggle(id) {
    if (ui.memOpen.has(id)) { ui.memOpen.delete(id); if (ui.memEdit === id) ui.memEdit = null; if (ui.memConfirm === id) ui.memConfirm = null; } else ui.memOpen.add(id);
    memRerender(id, true);
  }
  function memSave(id) {
    const m = D.memories.find((x) => x.id === id);
    const v = $(`[data-edit="${id}"]`)?.value.trim();
    if (!m || !v) return;
    m.text = v; m.when = '刚刚'; m.rev = `今天 ${clock()} 你修改了这段`;
    ui.memEdit = null;
    memRerender(id, true);
    addActivity({ kind: 'memory', session: ui.session, mem: id, html: '你修改了一段记忆' });
    toast('已保存修改');
  }
  async function collapseOut(el) {
    const h = el.offsetHeight;
    await M.done(M.animate(el, [{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(2px)' }], { duration: M.dur.exit, easing: M.ease.exit, fill: 'forwards' }));
    await M.done(M.animate(el, [{ height: `${h}px`, paddingTop: getComputedStyle(el).paddingTop, paddingBottom: getComputedStyle(el).paddingBottom }, { height: '0px', paddingTop: '0px', paddingBottom: '0px' }], { spring: 'glide', fill: 'forwards' }));
  }
  async function memObsolete(id) {
    const m = D.memories.find((x) => x.id === id);
    const restoring = m.status === 'obsolete';
    m.status = restoring ? 'current' : 'obsolete';
    m.rev = restoring ? `今天 ${clock()} 恢复适用` : `今天 ${clock()} 你标为不再适用`;
    const el = $(`.mem[data-id="${id}"]`, paneEl);
    if (!restoring && ui.memScope === 'current' && el) { ui.memOpen.delete(id); await collapseOut(el); }
    refreshPane();
    toast(restoring ? '已恢复适用' : '已标为不再适用，可以在“全部”里找到');
  }
  async function memForget(id) {
    const el = $(`.mem[data-id="${id}"]`, paneEl);
    ui.memConfirm = null; ui.memOpen.delete(id);
    if (el) await collapseOut(el);
    D.memories = D.memories.filter((x) => x.id !== id);
    addActivity({ kind: 'memory', session: ui.session, html: '忘掉了一段记忆，相关概述已标记重建' });
    refreshPane();
    toast('已忘掉。之后的对话不会再用到这段');
  }
  function schToggle(id) {
    const el = $(`.sch[data-id="${id}"]`, paneEl);
    const x = D.schedules.find((y) => y.id === id);
    if (ui.schOpen.has(id)) ui.schOpen.delete(id); else ui.schOpen.add(id);
    M.resize(el, () => { el.dataset.open = String(ui.schOpen.has(id)); el.innerHTML = schInner(x); }, { stop: el.parentElement });
  }
  function profileSave() {
    const b = bot(); const d = ui.profileDraft;
    const renamed = d.name !== b.name;
    Object.assign(b, { name: d.name.trim() || b.name, label: d.label, instructions: d.instructions, model: d.model, organize: d.organize });
    refreshPage();
    if (renamed) { setText($('#stageName'), b.name); $('#tbBotName').textContent = b.name; renderSidebar(); renderTitle(); }
    updateComposer();
    toast('档案已保存，下一次请求开始生效');
  }
  async function setSleep(sleep) {
    const b = bot();
    if (sleep === b.sleeping) return;
    if (sleep) {
      setText($('#stageStateText'), '正在让它休息…');
      await M.sleep(700);
      b.sleeping = true;
      D.work.filter((w) => w.bot === b.id && w.state === 'running').forEach((w) => { w.state = 'paused'; w.resume = true; refreshWorkViews(w.id); });
      addActivity({ kind: 'pause', session: ui.session, html: `${esc(b.name)} 开始休息，进行中的工作已暂停` });
    } else {
      b.sleeping = false; b.waking = true;
      refreshState();
      await M.sleep(1400);
      b.waking = false;
      D.work.filter((w) => w.bot === b.id && w.resume).forEach((w) => { w.state = 'running'; delete w.resume; refreshWorkViews(w.id); });
      addActivity({ kind: 'dispatch', session: ui.session, html: `${esc(b.name)} 醒了，接着之前的工作` });
    }
    refreshState();
    refreshPane();
    refreshPage();
  }

  // ---------------------------------------------------------------- 场景
  const PATHS = { 写作: ['paper/figures/', 'write_file paper/figures/fig3-baseline.svg'], 文档: ['docs/install/', 'write_file docs/install/windows.md'], 验证: ['~/.cache/varin-smoke/', 'write_file ~/.cache/varin-smoke/report.json'] };
  let sceneBusy = false;
  async function scene(name) {
    if (sceneBusy && name !== 'reset') return;
    sceneBusy = true;
    try {
      if (name === 'reset') return resetAll();
      if (!$('#wbShell').hidden) await goBack();
      const b = bot('varin');
      if (name === 'sleep') { if (ui.bot !== 'varin') await switchSession('daily'); await setSleep(!b.sleeping); return; }
      if (name === 'offline') {
        D.offline = !D.offline;
        const pill = $('#botShell .local-pill');
        swapIn(pill.querySelector('span'), D.offline ? '未连接' : 'Local');
        pill.classList.toggle('warn-text', D.offline);
        refreshState(); refreshPane();
        toast(D.offline ? '电脑断开了：可以查看记录，不能开始新工作' : '电脑重新连上了');
        return;
      }
      if (D.offline || b.sleeping) { toast(D.offline ? '先恢复电脑连接' : '先叫醒 Varin'); return; }
      if (ui.bot !== 'varin') await switchSession('daily');
      if (name === 'dispatch') {
        if (ui.busy) return;
        const text = '帮我把 README 的安装步骤更新到 0.9';
        input.focus();
        for (let i = 1; i <= text.length; i++) { input.value = text.slice(0, i); input.dispatchEvent(new Event('input')); await M.sleep(M.level === 'off' ? 0 : 28); }
        await M.sleep(260);
        submit();
      } else if (name === 'need') {
        const w = D.work.find((x) => x.bot === 'varin' && x.state === 'running' && x.id === 'w-writer') || D.work.find((x) => x.bot === 'varin' && x.state === 'running');
        if (!w) { toast('现在没有进行中的工作'); return; }
        const [path, detail] = PATHS[w.agent] || ['output/', 'write_file output/result.md'];
        D.needs.push({ id: `n${Date.now()}`, work: w.id, text: `想写入 ${path}，在等你确认`, path, detail });
        w.state = 'waiting';
        refreshWorkViews(w.id);
        addActivity({ kind: 'need', session: w.session, work: w.id, html: `<b>${esc(w.agent)}</b> 想写入 ${esc(path)}，在等你确认` });
        dotsOf('varin').overview = true;
        refreshState();
        refreshPane();
      } else if (name === 'report') {
        let w = ui.session !== 'release' ? work('w-smoke') : null;
        if (!w || w.state !== 'running') w = D.work.find((x) => x.bot === 'varin' && x.state === 'running' && x.session !== ui.session) || D.work.find((x) => x.bot === 'varin' && ['running', 'waiting'].includes(x.state));
        if (!w) { toast('现在没有进行中的工作'); return; }
        D.needs = D.needs.filter((n) => n.work !== w.id);
        w.state = 'done';
        const target = w.session; const s = D.sessions[target];
        const k = `rp${Date.now()}`;
        const reportText = w.report || `${w.task}已经完成，改动都在原会话里。`;
        const follow = w.id === 'w-smoke' ? '冒烟全部通过，首次启动慢了 0.3 秒，是新增的索引预热。打包目标定了告诉我，我让发布继续。'
          : w.agent === '写作' ? '第 3 节改完了：按新提纲整节重写，旧基线换成了两组新对比。要我顺便检查一下引用吗？'
            : `${w.agent}做完了。我看过结果，没有需要你处理的地方。`;
        const msgs = [];
        if (s.msgs[s.msgs.length - 1]?.type !== 'new' && target !== ui.session) msgs.push({ k: `${k}n`, type: 'new' });
        msgs.push({ k: `${k}d`, type: 'day', text: clock() }, { k, type: 'report', work: w.id, text: reportText }, { k: `${k}s`, type: 'say', text: follow, ops: true });
        if (target === ui.session) msgs.forEach((m) => appendMsg(m, { into: target }));
        else { s.msgs.push(...msgs); s.unread = true; }
        refreshWorkViews(w.id);
        D.latestReport = { work: w.id, session: target, msg: k, t: clock(), unread: target !== ui.session };
        addActivity({ kind: 'report', session: target, work: w.id, msg: k, html: `<b>${esc(w.agent)}</b> 返回了结果` });
        ui.resultFlash = { bot: 'varin', agent: w.agent };
        refreshState();
        refreshPane();
        setTimeout(() => { ui.resultFlash = null; refreshState(); }, 3000 * M.ts);
      } else if (name === 'remember') {
        if (ui.busy) return;
        await runTurn('以后依赖升级前先锁版本，升完再一个个放开。', { reply: '记下了。以后升级依赖都先锁版本，升完再逐个放开。', memory: '依赖升级前先锁版本，升完再逐个放开。' });
      }
    } finally { sceneBusy = false; }
  }
  $$('[data-scene]').forEach((b) => b.addEventListener('click', () => scene(b.dataset.scene)));

  function resetAll() {
    ui.run?.cancel();
    D = initialData();
    Object.assign(ui, { bot: 'varin', session: 'daily', tab: 'overview', page: null, busy: false, typing: false, resultFlash: null, queue: [], memOpen: new Set(), schOpen: new Set(), memEdit: null, memConfirm: null, memQuery: '', actScope: 'all', memScope: 'current', tabDots: {} });
    $('#wbShell').hidden = true; $('#botShell').hidden = false; $('#lattice').hidden = true;
    $('#panes').innerHTML = ''; paneEl = null; pageEl = null;
    const pill = $('#botShell .local-pill'); pill.querySelector('span').textContent = 'Local'; pill.classList.remove('warn-text');
    mountFigures();
    $('#stageName').innerHTML = '<span class="swap-cur">Varin</span>';
    $('#tbBotName').textContent = 'Varin';
    renderSidebar(); renderTabs(); renderPane(); renderQueue();
    renderTitle(); renderChat();
    lastFig = null;
    refreshState({ quiet: true });
    toast('已重置');
  }

  // ---------------------------------------------------------------- 实验室
  $('#labToggle').addEventListener('click', () => {
    const lab = $('#lab');
    const open = lab.dataset.open !== 'true';
    lab.dataset.open = String(open);
    $('#labToggle').setAttribute('aria-expanded', String(open));
    if (open) $$('.lab .seg').forEach(placeSeg);
  });
  function setTheme(v, pt) {
    const apply = () => { document.documentElement.dataset.theme = v; };
    if (!document.startViewTransition || !full()) { apply(); return; }
    const t = document.startViewTransition(apply);
    t.ready.then(() => {
      const r = Math.hypot(Math.max(pt.x, innerWidth - pt.x), Math.max(pt.y, innerHeight - pt.y));
      document.documentElement.animate({ clipPath: [`circle(0px at ${pt.x}px ${pt.y}px)`, `circle(${r}px at ${pt.x}px ${pt.y}px)`] }, { duration: 660 * M.ts, easing: M.ease.out, pseudoElement: '::view-transition-new(root)' });
    }).catch(() => {});
  }
  let panelOnWide = true;
  function applySize(v) {
    const was = frame.dataset.size;
    if (was === 'desktop') panelOnWide = ui.panel;
    frame.dataset.size = v;
    // 窄窗口里面板是浮层，默认收起，需要时再打开；回到宽窗口恢复原来的开合
    if (v === 'narrow' && ui.panel) { ui.panel = false; frame.dataset.panel = 'closed'; $('#panelToggle').setAttribute('aria-pressed', 'false'); }
    if (v === 'desktop' && was !== 'desktop') { ui.panel = panelOnWide; frame.dataset.panel = ui.panel ? 'open' : 'closed'; $('#panelToggle').setAttribute('aria-pressed', String(ui.panel)); }
    if (v === 'mobile') {
      setSidebar(false);
      rp.style.width = ''; rpInner.style.width = ''; rpInner.style.transform = ''; rpInner.style.opacity = '';
      sheetY.jump(1); ui.sheet = false; frame.dataset.sheet = 'closed';
    } else {
      rp.style.transform = '';
      frame.dataset.sheet = 'closed'; ui.sheet = false;
      panelMode = 'toggle';
      wSpring.jump(ui.panel ? ui.panelW : 0);
      if (v === 'narrow' && ui.sidebar) setSidebar(false);
    }
    setTimeout(() => { placeInk(true); placeSel(true); updateCompact(); }, 380 * M.ts);
  }
  $$('.lab .seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $$('button', seg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      placeSeg(seg);
      const v = b.dataset.v;
      const kind = seg.dataset.lab;
      if (kind === 'size') applySize(v);
      if (kind === 'theme') { const r = b.getBoundingClientRect(); setTheme(v, { x: r.left + r.width / 2, y: r.top + r.height / 2 }); }
      if (kind === 'motion') M.setLevel(v);
    });
  });
  $('#slowmo').addEventListener('change', (e) => M.setTimeScale(e.target.checked ? 4 : 1));
  $('#figOverride').addEventListener('change', (e) => { ui.figOverride = e.target.value; refreshState(); });

  // ---------------------------------------------------------------- 尺寸与启动
  function updateCompact() { rp.dataset.compact = String(frame.dataset.size !== 'mobile' && frame.clientHeight < 700); }
  new ResizeObserver(() => { updateCompact(); placeInk(true); }).observe(frame);

  hydrate(document);
  mountFigures();
  renderSidebar();
  renderTabs();
  renderPane();
  renderTitle();
  renderChat();
  panelMode = 'toggle';
  wSpring.jump(ui.panelW);
  refreshState({ quiet: true });
  updateCompact();
  $$('.lab .seg').forEach(placeSeg);
  document.fonts?.ready.then(() => { placeInk(true); $$('.lab .seg').forEach((s) => { segMemory.delete(s.dataset.lab); placeSeg(s); }); });
  window.BotPreview = { ui, get data() { return D; }, scene };
})();
