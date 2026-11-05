/* Varin · 总助手设计稿 · 装配、场景与原型实验室
 * 只演示界面与交互；数据是示例，不连接 Host。形象由 ../varin-figure-preview/figure.js 绘制。
 */
(function () {
  'use strict';
  const VC = window.VC, D = VC.data, S = VC.state, ic = VC.icon, esc = VC.esc, $ = VC.$;
  const ORIGINAL = JSON.stringify({ works: D.works, detail: D.detail });

  // ---------------------------------------------------------------- 骨架：Bot 区常驻，其余区域各自刷新
  $('#frame').innerHTML = `
    <div class="statusbar" id="sbar"></div>
    <header class="titlebar" id="tb"></header>
    <div class="body">
      <aside class="sidebar" id="sb" aria-label="Bot 与会话"></aside>
      <div class="canvas">
        <section class="chat" id="chat" aria-label="会话"></section>
        <aside class="region" id="region" aria-label="Varin">
          <div class="panel-box" id="panelBox">
            <section class="stage" id="stage"><div class="fig-host" id="stageFig"></div><div class="sill-team l" id="sillL"></div><div class="sill-team r" id="sillR"></div></section>
            <div id="botid"></div>
            <div class="tabs" id="tabs" role="tablist" aria-label="Varin 面板"></div>
            <div id="vstrip"></div>
            <div class="pane" id="pane"></div>
          </div>
          <div class="view-box" id="viewbox" hidden></div>
        </aside>
      </div>
    </div>
    <div id="over"></div>`;
  if (typeof Figure === 'function') {
    try { VC.fig = new Figure($('#stageFig'), { size: 124, frameless: true, wide: true, seed: 7 }); } catch (e) { VC.fig = null; }
  }

  // ---------------------------------------------------------------- 场景
  const reset = () => {
    const o = JSON.parse(ORIGINAL); D.works.splice(0, D.works.length, ...o.works); Object.assign(D.detail, o.detail);
    Object.assign(S, { views: [], active: null, expanded: false, busy: null, now: null, pending: [], extra: [], answered: false, answer: null, answeredBy: null,
      computer: 'watch', settings: null, wizard: null, svcPop: false, tab: 'overview', scope: 'session', draft: '', drawer: false, sendMenu: false,
      actOpen: {}, fileLoc: 'ws', fileSel: 'hero.css', xfer: true, panelHidden: false, stick: true, readAt: 0, island: 'compact', islandEvent: null, filePage: null, locSheet: false, xferSheet: false, fileMore: false, sidebar: false });
  };
  const SCENES = [
    ['chat', '交流与持续工作', '默认：聊天＋正在跟进',
      '<b>正文按内容组织。</b>过程沿用现有的折叠行；需要持续推进的事附原工作入口。子 Agent 的回报沿用现有的 Agent 消息（发送者 → Varin，折叠两行），回报到达就唤醒 Varin，接着是 Varin 的整理。右侧把空间让给正在跟进的工作。', () => {}],
    ['steer', 'Varin 正在工作时补充', '默认立即补充；受理→接收',
      '<b>新消息默认补充到当前交流。</b>按 Enter：先显示“已受理 · 等 Varin 在下一个间隙接收”，收到真实接收事实后才变成“已接收”。Alt+Enter 或发送菜单可以把这一条排到之后，排队的消息仍能“现在发送”。输入框为空时发送键变成“停止当前回应”。', () => { S.busy = 'reading'; S.now = 'reading'; S.draft = '价格调研重点看企业版，个人版不用细看'; S.pending = [{ kind: 'later', text: '都整理好后把对比表发到我邮箱' }]; }],
    ['wait', '等待子任务时说话', '新消息结束这次等待',
      '<b>等待对象写清楚。</b>Varin 在等 Reviewer 时，界面写“在等 Reviewer 检查”，不把整段时间表现成思考。发一条消息：Varin 停止这次等待去读你的话，Reviewer 继续检查，结果之后仍沿原入口送达。', () => { S.busy = 'waiting'; S.now = 'waiting'; S.draft = '按钮再大一点，配色先不动'; }],
    ['work', '工作详情', '聊天留在旁边',
      '<b>点工作名称先看简明详情。</b>当前状态、成果（含旧版本）、最近的动作、使用的环境、执行者；完整过程去原工作台。详情、电脑、文件在右侧以视图打开，聊天和草稿留在左边；左上“Varin”随时回到概览，可以放大。', () => VC.openView({ kind: 'work', id: 'w1' })],
    ['need', '需要你决定', '可以直接选，也可以告诉 Varin',
      '<b>同一个原请求，两种回答方式。</b>可以在卡片里直接选；也可以对 Varin 说“按产品线吧”，Varin 用原请求回答 Writer，问题随之解除，记录里写明是 Varin 按你的话回答的。输入框里已经放好这句话，按 Enter 试试。', () => { VC.openView({ kind: 'work', id: 'w2' }); S.draft = '汇报按产品线来吧'; }],
    ['computer', '电脑', '真实画面、操作者与控制权',
      '<b>画面写清是谁在操作。</b>执行者是 Reviewer 就写 Reviewer。接管先显示“正在交接控制”，交接完成才允许输入；交回后执行者重新确认现场。断开时保留并标明“最后画面”，文件能力仍可用。关闭视图只结束观看。', () => VC.openView({ kind: 'computer', id: 'c1' })],
    ['files', '文件', '显式来源；任务视图与原目录分开',
      '<b>标题一直写“设备 · 位置”。</b>“发布页面工作区”是这项工作的独立工作区，和项目原目录 /srv/website 分开列出，不会因路径相似混成一处。选中文件可以直接引用到对话或交给工作；传输面板如实显示部分完成的移动。', () => VC.openView({ kind: 'files' })],
    ['service', '服务与设备', '标题栏：谁连着谁',
      '<b>前端、Varin 服务、设备分开画。</b>弹层先回答“此界面 → Varin 服务 → 设备”各段是否通；三种操作分别命名：添加设备、切换 Varin 服务、让其他设备连接我。', () => { S.svcPop = true; }],
    ['send', '设置 · 发送', 'Varin 与普通 Agent 分开',
      '<b>两种身份分别设置。</b>Varin 默认立即补充，普通 Agent 保留原选择；按会话的真实身份判断，工作台里打开 Varin 的会话也按 Varin 处理。', () => { S.settings = 'chat'; }],
    ['conn', '设置 · 连接', '按目的分三块',
      '<b>按连接目的组织。</b>顶部是连接路径；下面依次是“设备”（每项能力单独显示状态）、“Varin 服务”、“让其他设备连接我”（写明方向）。地址、SSH、隧道这些细节放在“高级”。', () => { S.settings = 'conn'; }],
    ['add', '添加设备', '检查在真正用资源的一端',
      '<b>检查从家中主机发起。</b>逐项显示文件、执行环境、桌面能不能用；失败时指出是哪一段。接入不迁移已有工作，也不默默改写新工作的默认位置。实验室里可以切到“连接失败”。', () => { S.settings = 'conn'; S.wizard = { step: 3, way: 'ssh', probe: 'ok' }; }],
  ];
  const play = (id) => { reset(); S.scene = id; const sc = SCENES.find((x) => x[0] === id); VC.render(); sc[4](); VC.render(); };

  // ---------------------------------------------------------------- 原型实验室（评审工具，不属于产品）
  VC.parts.lab = () => {
    const sc = SCENES.find((x) => x[0] === S.scene);
    const opt = (k, v, l) => `<button data-act="opt" data-k="${k}" data-v="${v}" aria-pressed="${S[k] === v}">${l}</button>`;
    const extra = S.scene === 'computer' ? `<h6>电脑状态</h6><div class="opts">${[['watch', '观察'], ['handing', '交接中'], ['you', '你在操作'], ['off', '已断开']].map(([v, l]) => `<button data-act="cv" data-v="${v}" aria-pressed="${S.computer === v}">${l}</button>`).join('')}</div>`
      : S.size === 'mobile' && S.scene === 'files' ? `<h6>文件（手机）</h6><div class="opts"><button data-act="locsheet">位置面板</button><button data-act="fopen" data-v="hero.css">预览文件</button><button data-act="fmore">更多操作</button><button data-act="xfersheet">传输详情</button></div>`
      : S.size === 'mobile' && S.scene === 'service' ? `<h6>连接入口（手机）</h6><div class="opts"><button data-act="m-entry" data-v="side">会话列表底部</button><button data-act="m-entry" data-v="island">顶部胶囊</button></div>`
      : S.size === 'mobile' ? `<h6>顶部胶囊事件</h6><div class="opts"><button data-act="is-demo" data-v="result">结果送达</button><button data-act="is-demo" data-v="need">有问题等你</button><button data-act="is-demo" data-v="art">新成果</button></div>`
      : S.scene === 'add' && S.wizard ? `<h6>检查结果</h6><div class="opts"><button data-act="probe" data-v="ok" aria-pressed="${S.wizard.probe === 'ok'}">能力可用</button><button data-act="probe" data-v="err" aria-pressed="${S.wizard.probe === 'err'}">连接失败</button></div>` : '';
    $('#lab').innerHTML = `<div class="lab-h" data-act="lab">原型实验室<small>${$('#lab').dataset.open === 'false' ? '展开' : '评审工具'}</small></div>
      <div class="lab-b">
        <h6>场景</h6><div class="scenes">${SCENES.map(([id, t, s]) => `<button data-act="scene" data-v="${id}" aria-pressed="${S.scene === id}">${t}<small>${s}</small></button>`).join('')}</div>
        ${extra}
        <h6>显示</h6><div class="opts">${opt('theme', 'light', '浅色')}${opt('theme', 'dark', '深色')}</div>
        <div class="opts" style="margin-top:4px">${opt('size', 'desktop', '桌面')}${opt('size', 'narrow', '窄窗口')}${opt('size', 'mobile', '手机')}</div>
        <div class="opts" style="margin-top:4px">${opt('motion', 'on', '动效')}${opt('motion', 'off', '无动效')}</div>
        ${S.size === 'mobile' ? `<h6>机型（摄像头开孔）</h6><div class="opts">${Object.entries(VC.DEVICES).map(([k, l]) => opt('device', k, l)).join('')}</div>` : ''}
        ${sc ? `<div class="why">${sc[3]}</div>` : ''}
      </div>`;
  };
  VC.on('scene', (el) => play(el.dataset.v));
  VC.on('opt', (el) => {
    S[el.dataset.k] = el.dataset.v; if (el.dataset.k === 'size') { S.drawer = false; S.expanded = false; S.island = 'compact'; }
    VC.render();
    if (el.dataset.k === 'size' && el.dataset.v === 'mobile') setTimeout(() => VC.islandEvent('result'), 900);
  });
  VC.on('lab', () => { const l = $('#lab'); l.dataset.open = l.dataset.open === 'false' ? 'true' : 'false'; VC.render('lab'); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (S.wizard) S.wizard = null; else if (S.settings) S.settings = null; else if (S.svcPop) S.svcPop = false; else if (S.sendMenu) S.sendMenu = false; else if (S.expanded) S.expanded = false; else return;
    VC.render();
  });

  S.device = 'island';
  play('chat');
})();
