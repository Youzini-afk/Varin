/* Varin · 总助手设计稿 · 打开的视图：工作详情、电脑、文件（聊天留在旁边） */
(function () {
  'use strict';
  const VC = window.VC, D = VC.data, S = VC.state, ic = VC.icon, esc = VC.esc, $ = VC.$;
  const LOC = {
    ws: { dev: '开发服务器', name: '发布页面工作区', crumbs: ['发布页面工作区', 'src', 'styles'], note: '独立工作区 · 属于「发布页面」· 项目原目录另在 /srv/website' },
    dev: { dev: '开发服务器', name: '/srv/website', crumbs: ['srv', 'website', 'src', 'styles'], note: '网站项目原目录 ·「发布页面」的改动在它的独立工作区里，不在这里' },
    home: { dev: '家中主机', name: 'D:\\工作', crumbs: ['D:', '工作'], note: 'Varin 服务所在的设备' },
    office: { dev: '办公电脑', name: '文档', crumbs: ['C:', '用户', 'youzi', '文档'], note: '经连接地址访问 · 桌面与文件分别可用' },
  };
  const viewLabel = (v) => v.kind === 'work' ? D.works.find((w) => w.id === v.id).name : v.kind === 'computer' ? '电脑 · 办公电脑' : `文件 · ${LOC[S.fileLoc].dev}`;
  const viewIcon = (v) => v.kind === 'work' ? 'list' : v.kind === 'computer' ? 'computer' : 'folder';
  const same = (a, b) => a && b && a.kind === b.kind && (a.kind === 'files' || a.id === b.id);

  VC.openView = (v) => {
    if (!S.views.some((x) => same(x, v))) S.views.push(v);
    S.active = S.views.find((x) => same(x, v)); S.drawer = false; S.svcPop = false; S.settings = null; S.wizard = null; S.panelHidden = false;
    if (v.kind === 'work') { S.flash = v.id; setTimeout(() => { S.flash = null; }, 1300); }
    VC.render();
  };

  // ---------------------------------------------------------------- 工作详情
  const feedRow = ([t, who, h, cur]) => `<div class="feed-row${cur ? ' cur' : ''}"><span class="num">${t}</span>${VC.av(who, 18)}<span>${h}</span></div>`;
  const art = (a) => {
    const th = a.kind === 'shot' ? '<span class="thumb shot"></span>' : `<span class="thumb">${ic(a.kind === 'diff' ? 'diff' : a.kind === 'link' ? 'link' : a.kind === 'sheet' ? 'sheet' : 'doc')}</span>`;
    const vers = a.vers ? `<span class="vers">${a.vers.map((v, i) => `<button aria-pressed="${i === a.vers.length - 1}" title="查看 ${v}">${v}</button>`).join('')}</span>` : '';
    return `<div class="art">${th}<span class="grow"><span class="t">${esc(a.t)}</span><span class="m">${a.m}${vers ? ' · ' + vers : ''}</span></span>
      <span class="end">${a.acts.map((x, i) => `<button class="btn sm${i ? ' ghost' : ''}">${esc(x)}</button>`).join('')}</span></div>`;
  };
  const workDetail = (id) => {
    const w = D.works.find((x) => x.id === id), d = D.detail[id] || D.detail.w1;
    const n = d.now;
    const nowIcon = n.spin ? '<span class="spin"></span>' : n.need ? `<span style="color:var(--warning)">${ic('alert', 'sm')}</span>` : '<span class="dot info"></span>';
    const showQ = id === 'w2';
    return `<div class="wd">
      <div class="wd-title"><h2>${esc(w.name)}</h2><span class="tag ${d.tag[1]}">${esc(d.tag[0])}</span></div>
      <div class="wd-meta">${d.meta.map((m, i) => i === 0 ? `<button class="link">${esc(m)}</button>` : `<span>· ${esc(m)}</span>`).join('')}</div>
      <div class="wd-now">${nowIcon}<span>${esc(n.text)}</span><span class="sub">${esc(n.sub)}</span></div>
      ${showQ ? `<div class="wd-sec"><h4>${S.answered ? '你的回答' : '需要你'}</h4>${VC.questionCard('detail')}</div>` : ''}
      <div class="wd-sec"><h4>成果<span class="faint">当前版本；旧版本可回看</span></h4>${d.arts.map(art).join('')}</div>
      <div class="wd-sec"><h4>最近的动作<span class="faint">来自原工作记录</span><button class="btn sm ghost">在工作台查看完整过程 ${ic('out', 'xs')}</button></h4>
        <div class="feed">${d.feed.map(feedRow).join('')}</div></div>
      ${d.env.length ? `<div class="wd-sec"><h4>使用的环境</h4>${d.env.map((e) => `<div class="envc"><span class="env-ic">${ic(e.k === 'files' ? 'folder' : 'computer', 'sm')}</span><span class="grow"><span class="t">${esc(e.t)}</span><span class="m" style="display:block">${esc(e.m)}</span></span>
        <button class="btn sm" data-act="${e.k === 'files' ? 'open-files' : 'open-computer'}" data-loc="${id === 'w2' ? 'home' : 'ws'}">打开</button></div>`).join('')}</div>` : ''}
      <div class="wd-sec"><h4>执行者</h4><div class="team">${d.team.map((m) => `<div class="mate${m.sub ? ' sub' : ''}">${VC.av(m.a, 24, m.role === '负责人')}<span><b>${esc(D.agents[m.a].name)}</b> <span class="role">${esc(m.role)}</span></span><span class="end">${m.spin ? '<span class="spin"></span>' : ''}${esc(m.state)}</span></div>`).join('')}</div></div>
    </div>
    <div class="wd-foot"><label class="msg-to"><span class="to">给 ${esc(d.to)}</span><input placeholder="直接发给这项工作的执行者…" aria-label="给执行者发消息"><button class="icon-btn" title="发送">${ic('up', 'sm')}</button></label>
      <button class="btn">${ic('workbench', 'sm')}在工作台打开</button><button class="btn ghost danger" title="只停止这项工作，不影响其他工作">停止这项工作</button></div>`;
  };

  // ---------------------------------------------------------------- 电脑：真实画面、操作者、控制权
  const computer = () => {
    const st = S.computer;
    const op = st === 'you' ? `<span class="op you">${ic('hand', 'sm')}你正在操作 · Reviewer 已暂停输入</span>`
      : st === 'handing' ? '<span class="op pending"><span class="spin"></span>正在交接控制…</span>'
        : st === 'off' ? '<span class="op pending"><span class="dot err"></span>画面已断开 · 最后画面 11:26</span>'
          : `<span class="op">${VC.av('reviewer', 18)}Reviewer 正在操作 · 发布页面</span>`;
    const ctl = st === 'you' ? `<button class="btn primary sm" data-act="cv" data-v="watch">${ic('reply', 'sm')}交回 Reviewer</button>`
      : st === 'handing' ? '<button class="btn sm" disabled>交接中</button>'
        : st === 'off' ? '<button class="btn sm" data-act="cv" data-v="watch">重新连接</button>'
          : `<button class="btn sm" data-act="cv" data-v="handing" title="接管后 Reviewer 暂停输入，交回后它会重新确认现场">${ic('hand', 'sm')}接管</button>`;
    return `<div class="cv">
      <div class="cv-bar"><span class="env-ic">${ic('computer', 'sm')}</span><span class="cv-name"><b>办公电脑</b><small>Windows 11 · 桌面 1 · 经家中主机</small></span>${op}<span class="sp"></span>
        <span class="zoom"><button class="btn sm ghost">适应窗口 ${ic('chev', 'xs')}</button><button class="icon-btn" title="桌面 2">${ic('stack', 'sm')}</button></span>${ctl}</div>
      <div class="cv-stage">
        ${st === 'you' ? `<div class="cv-banner">${ic('hand', 'sm')}<span>你正在操作办公电脑，输入会直接发到桌面 1</span><button class="btn sm" data-act="cv" data-v="watch">交回</button></div>` : ''}
        <div class="screen${st === 'off' ? ' dim' : ''}">
          <div class="bwin"><div class="bar"><i></i><i></i><i></i><span></span></div><div class="emu"><div class="h"></div><div class="l"></div><div class="l s"></div><div class="l"></div><div class="cta"></div></div></div>
          <div class="dwin"><i></i><i></i><i class="g"></i><i></i><i></i><i class="g"></i></div>
          <div class="taskbar"><i class="on"></i><i class="on"></i><i></i><i></i><i></i></div>
          ${st === 'off' ? '' : `<div class="cursor" id="cursor"><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10 19z" fill="#fff" stroke="#1b1a18" stroke-width="1.4" stroke-linejoin="round"/></svg><span>${st === 'you' ? '你' : 'Reviewer'}</span></div>`}
        </div>
        ${st === 'off' ? `<div class="cv-off"><div class="card"><b>桌面服务连接中断</b>这是 11:26 的最后画面。Reviewer 的工作仍在继续；办公电脑的文件仍然可以打开。<div class="row2"><button class="btn sm primary" data-act="cv" data-v="watch">重新连接</button><button class="btn sm" data-act="open-files" data-loc="office">打开文件</button><button class="btn sm ghost">查看诊断</button></div></div></div>` : ''}
      </div>
      <div class="cv-foot">${ic('list', 'xs')}<span>关联工作：</span><button class="link" data-act="open-work" data-id="w1">发布页面</button><span class="grow"></span><span>关闭这个视图只结束观看，不停止工作</span></div>
    </div>`;
  };
  let cursorTimer = null;
  const moveCursor = () => {
    clearInterval(cursorTimer);
    if (!(S.active && S.active.kind === 'computer' && (S.computer === 'watch' || S.computer === 'you'))) return;
    cursorTimer = setInterval(() => { const c = $('#cursor'); if (!c) return clearInterval(cursorTimer); c.style.left = `${20 + Math.random() * 55}%`; c.style.top = `${20 + Math.random() * 55}%`; }, 2200);
  };

  // ---------------------------------------------------------------- 文件：显式来源与根位置
  VC.LOC = LOC;
  const files = () => {
    if (S.size === 'mobile' && VC.filesMobile) return VC.filesMobile();
    const L = LOC[S.fileLoc];
    const list = S.fileLoc === 'home' ? [{ n: '汇报', dir: true, d: '11:08' }, { n: '账单', dir: true, d: '11:15' }, { n: 'report-q3.pdf', s: '2.4 MB', d: '10 月 30 日' }]
      : S.fileLoc === 'office' ? [{ n: '截图', dir: true, d: '11:22' }, { n: 'mobile-check.png', s: '412 KB', d: '11:26' }] : D.files;
    const sel = list.find((f) => f.n === S.fileSel);
    const side = D.locations.map((g) => `<h5>${g.group}</h5>${g.items.map((l) => `<button class="fv-loc" data-act="loc" data-v="${l.id}" aria-current="${S.fileLoc === l.id}">${ic(l.id === 'ws' ? 'branch' : l.id === 'dev' ? 'server' : 'computer', 'sm')}<span class="grow"><span class="trunc" style="display:block">${esc(l.name)}</span><small class="trunc">${esc(l.sub)}</small></span><span class="dot ${l.dot}"></span></button>`).join('')}`).join('');
    const rows = list.map((f) => `<button class="fl-row" data-act="fsel" data-v="${esc(f.n)}" aria-selected="${f.n === S.fileSel}">${ic(f.dir ? 'folder' : f.n.endsWith('.png') ? 'image' : 'file', `sm${f.dir ? ' dir' : ''}`)}<span class="trunc">${esc(f.n)}</span><span class="s">${f.s || '—'}</span><span class="d">${esc(f.d)}</span></button>`).join('');
    const code = '<span class="k">.hero</span> {\n  padding: 56px 24px;\n<span class="a">+ gap: clamp(16px, 4vw, 32px);</span>\n}\n<span class="k">@media</span> (max-width: 480px) {\n<span class="a">+ .hero h1 { font-size: 28px; }</span>\n<span class="a">+ .hero .cta { width: 100%; }</span>\n}';
    return `<div class="fv">
      <nav class="fv-side" aria-label="位置">${side}<h5>　</h5><button class="fv-loc" data-act="add-device">${ic('plus', 'sm')}<span>添加设备</span></button></nav>
      <div class="fv-main">
        <div class="fv-src"><span class="where">${esc(L.dev)} <span>· ${esc(L.name)}</span></span><span class="note trunc">${esc(L.note)}</span></div>
        <div class="fv-bar"><div class="crumbs">${L.crumbs.map((c, i) => `${i ? ic('right', 'xs') : ''}<button>${esc(c)}</button>`).join('')}</div>
          <span class="fv-search">${ic('search', 'xs')}搜索此处</span>
          <button class="btn sm" data-act="upload" title="上传到 ${esc(L.dev)}">${ic('upload', 'sm')}上传</button>
          <button class="btn sm ghost">${ic('plus', 'sm')}新建</button></div>
        <div class="fv-list"><div class="fl-head"><span></span><span>名称</span><span class="s">大小</span><span class="d">修改时间</span></div>${rows}</div>
      </div>
      ${sel && !sel.dir ? `<aside class="fv-prev"><div class="ph"><b>${esc(sel.n)}</b><small>${esc(L.dev)} · ${sel.s || ''} · ${S.fileLoc === 'ws' ? '这项工作改过 · +18 −6' : '未改动'}</small></div>
        <div class="code">${sel.n.endsWith('.css') ? code : '（预览图片）'}</div>
        <div class="acts"><button class="btn sm primary" data-act="cite">${ic('at', 'sm')}引用到对话</button><button class="btn sm">交给工作…</button><button class="btn sm ghost">在编辑器打开</button><button class="btn sm ghost">${ic('download', 'sm')}下载</button><button class="icon-btn" title="重命名、移动、复制、删除">${ic('dots', 'sm')}</button></div></aside>` : ''}
      ${S.size !== 'desktop' && sel ? `<div class="selbar"><span class="n">已选 ${esc(sel.n)}</span><button class="btn sm ghost" data-act="cite">引用</button><button class="btn sm ghost">交给工作</button><button class="btn sm ghost">下载</button><button class="icon-btn">${ic('dots', 'sm')}</button></div>` : ''}
      ${S.xfer ? `<div class="xfer"><div class="xfer-h"><span>传输</span><button class="icon-btn" data-act="xfer-x" title="收起">${ic('x', 'sm')}</button></div>
        <div class="xf"><div class="t">${ic('upload', 'xs')}<b>上传 3 个文件</b><span class="grow"></span><span class="faint num" id="upPct">62%</span></div><div class="m">到 开发服务器 · 发布页面工作区 / assets</div><div class="bar-p"><i id="upBar" style="width:62%"></i></div></div>
        <div class="xf"><div class="t">${ic('move', 'xs')}<b>移动 2 个文件</b></div><div class="m warn">report-q3.pdf 已写入家中主机并删除原文件；draft.docx 写入失败：目标空间不足，原文件保留在开发服务器</div></div>
      </div>` : ''}
    </div>`;
  };

  // ---------------------------------------------------------------- 视图区
  VC.parts.views = () => {
    const box = $('#viewbox'), strip = $('#vstrip');
    strip.innerHTML = S.views.length && !S.active ? `<div class="sec-h" style="padding:8px 16px 0">${ic('stack', 'xs')}<span>打开的视图</span></div><div class="w-links" style="padding:4px 14px 8px">${S.views.map((v, i) => `<button class="w-link" data-act="vtab" data-i="${i}">${ic(viewIcon(v), 'xs')}${esc(viewLabel(v))}</button>`).join('')}</div>` : '';
    if (!S.active) { box.innerHTML = ''; box.hidden = true; clearInterval(cursorTimer); return; }
    box.hidden = false;
    const v = S.active, need = VC.needs().length;
    const body = v.kind === 'work' ? workDetail(v.id) : v.kind === 'computer' ? computer() : files();
    box.innerHTML = `<div class="vhead">
        ${S.expanded ? `<button class="back-chat" data-act="expand">${ic('back', 'sm')}回到对话</button>` : ''}
        ${S.size === 'mobile' ? `<button class="vback" data-act="vback" title="回到对话">${ic('back', 'sm')}<span>对话</span></button>`
          : `<button class="vback" data-act="vback" title="回到 Varin 概览"><span class="mini" id="vbFig">${need ? '<span class="tb-badge"></span>' : ''}</span><span>Varin</span></button>`}
        <div class="vtabs" role="tablist">${S.views.map((x, i) => `<button class="vtab" role="tab" data-act="vtab" data-i="${i}" aria-selected="${x === v}">${ic(viewIcon(x), 'sm')}<span class="trunc">${esc(viewLabel(x))}</span><span class="x" data-act="vclose" data-i="${i}" title="关闭">${ic('x', 'xs')}</span></button>`).join('')}</div>
        ${S.size === 'desktop' ? `<button class="icon-btn" data-act="expand" title="${S.expanded ? '还原' : '放大'}">${ic(S.expanded ? 'collapse' : 'expand', 'sm')}</button>` : ''}
      </div><div class="vbody" data-kind="${v.kind}">${body}</div>`;
    VC.figHead($('#vbFig'), 20);
    moveCursor();
  };

  VC.on('open-work', (el) => VC.openView({ kind: 'work', id: el.dataset.id }));
  VC.on('open-computer', () => VC.openView({ kind: 'computer', id: 'c1' }));
  VC.on('open-files', (el) => { S.fileLoc = el.dataset.loc || 'ws'; S.fileSel = S.fileLoc === 'home' ? 'report-q3.pdf' : S.fileLoc === 'office' ? 'mobile-check.png' : 'hero.css'; VC.openView({ kind: 'files' }); });
  VC.on('vtab', (el) => { S.active = S.views[+el.dataset.i]; VC.render(); });
  VC.on('vclose', (el, e) => { e.stopPropagation(); const i = +el.dataset.i, was = S.views[i]; S.views.splice(i, 1); if (S.active === was) S.active = S.views[Math.max(0, i - 1)] || null; if (!S.active) S.expanded = false; VC.render(); });
  VC.on('vback', () => { S.active = null; S.expanded = false; if (S.size === 'mobile') S.drawer = false; VC.render(); });
  VC.on('expand', () => { S.expanded = !S.expanded; VC.render(); });
  VC.on('cv', (el) => {
    S.computer = el.dataset.v; VC.render('views');
    if (S.computer === 'handing') setTimeout(() => { if (S.computer === 'handing') { S.computer = 'you'; VC.render('views'); } }, 1300);
  });
  VC.on('loc', (el) => { S.locSheet = false; S.filePage = null; S.fileLoc = el.dataset.v; S.fileSel = S.fileLoc === 'home' ? 'report-q3.pdf' : S.fileLoc === 'office' ? 'mobile-check.png' : 'hero.css'; VC.render('views', 'title'); });
  VC.on('fsel', (el) => { S.fileSel = el.dataset.v; VC.render('views'); });
  VC.on('xfer-x', () => { S.xfer = false; VC.render('views'); });
  VC.on('upload', () => { S.xfer = true; VC.render('views'); let p = 62; const t = setInterval(() => { p = Math.min(100, p + 9); const b = $('#upBar'), n = $('#upPct'); if (!b) return clearInterval(t); b.style.width = p + '%'; n.textContent = p === 100 ? '完成' : p + '%'; if (p === 100) clearInterval(t); }, 500); });
  VC.on('cite', () => { S.draft = `${S.draft ? S.draft + ' ' : ''}@hero.css（开发服务器 · 发布页面工作区） `; if (S.size !== 'desktop') { S.active = null; } VC.render(); VC.$('#input')?.focus(); });
})();
