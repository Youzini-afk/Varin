/* Varin · 总助手设计稿 · 手机端：文件浏览、连接面板、会话列表的连接入口
 * 手机上不并排：来源选择器 → 列表 → 预览页；位置、更多操作、传输、连接都用底部面板。
 */
(function () {
  'use strict';
  const VC = window.VC, D = VC.data, S = VC.state, ic = VC.icon, esc = VC.esc;

  const listFor = (loc) => loc === 'home' ? [{ n: '汇报', dir: true, d: '11:08' }, { n: '账单', dir: true, d: '11:15' }, { n: 'report-q3.pdf', s: '2.4 MB', d: '10 月 30 日' }]
    : loc === 'office' ? [{ n: '截图', dir: true, d: '11:22' }, { n: 'mobile-check.png', s: '412 KB', d: '11:26' }] : D.files;
  const devIcon = (loc) => loc === 'ws' ? 'branch' : loc === 'dev' ? 'server' : 'computer';
  const sheet = (body, close = 'sheet-x') => `<div class="sheet-scrim" data-act="${close}"></div><div class="sheet" role="dialog"><div class="grab"></div>${body}</div>`;
  const CODE = '<span class="k">.hero</span> {\n  padding: 56px 24px;\n<span class="a">+ gap: clamp(16px, 4vw, 32px);</span>\n}\n<span class="k">@media</span> (max-width: 480px) {\n<span class="a">+ .hero h1 { font-size: 28px; }</span>\n<span class="a">+ .hero .cta { width: 100%; }</span>\n}';

  // ---------------------------------------------------------------- 文件
  const preview = (L, sel) => {
    const changed = S.fileLoc === 'ws' && sel.n === 'hero.css';
    return `<div class="mfv">
      <div class="mtools"><button class="vback" data-act="fback">${ic('back', 'sm')}<span>${esc(L.crumbs[L.crumbs.length - 1])}</span></button><span class="grow"></span><button class="icon-btn" title="下载到这台手机">${ic('download', 'sm')}</button></div>
      <div class="mprev-t"><b>${esc(sel.n)}</b><small>${esc(L.dev)} · ${esc(L.name)} · ${sel.s || ''}${changed ? ' · 这项工作改过 <span style="color:var(--add)">+18 −6</span>' : ''}</small></div>
      <div class="code m">${sel.n.endsWith('.css') ? CODE : '（图片预览）'}</div>
      <div class="mbar"><button class="btn primary" data-act="cite">${ic('at', 'sm')}引用到对话</button><button class="btn">交给工作…</button><button class="icon-btn" data-act="fmore" title="更多">${ic('dots')}</button></div>
      ${S.fileMore ? sheet(`<h4>${esc(sel.n)}</h4><p class="sub">${esc(L.dev)} · ${esc(L.name)}</p>
        <button class="s-row"><span class="env-ic">${ic('download', 'sm')}</span><span>下载到这台手机<small>从 ${esc(L.dev)} 传到 iPhone 16</small></span></button>
        <button class="s-row"><span class="env-ic">${ic('edit', 'sm')}</span><span>在编辑器打开<small>保存回 ${esc(L.dev)}</small></span></button>
        <div class="s-sep"></div>
        <button class="s-row"><span class="env-ic">${ic('doc', 'sm')}</span><span>重命名</span></button>
        <button class="s-row"><span class="env-ic">${ic('move', 'sm')}</span><span>移动到…<small>可以移到另一台设备；目标写好后才删除原文件</small></span></button>
        <button class="s-row"><span class="env-ic">${ic('copy', 'sm')}</span><span>复制到…</span></button>
        <button class="s-row danger"><span class="env-ic">${ic('trash', 'sm')}</span><span>删除</span></button>`) : ''}
    </div>`;
  };
  const xferItems = () => `<div class="xf"><div class="t">${ic('upload', 'xs')}<b>上传 3 个文件</b><span class="grow"></span><span class="faint num">62%</span></div><div class="m">从这台手机到 开发服务器 · 发布页面工作区 / assets</div><div class="bar-p"><i style="width:62%"></i></div></div>
    <div class="xf"><div class="t">${ic('move', 'xs')}<b>移动 2 个文件</b></div><div class="m warn">report-q3.pdf 已写入家中主机并删除原文件；draft.docx 写入失败：目标空间不足，原文件保留在开发服务器</div>
      <div style="display:flex;gap:6px;margin-top:8px"><button class="btn sm">重试 draft.docx</button><button class="btn sm ghost">换个位置</button></div></div>`;

  VC.filesMobile = () => {
    const L = VC.LOC[S.fileLoc], list = listFor(S.fileLoc), sel = list.find((f) => f.n === S.fileSel);
    if (S.filePage === 'preview' && sel && !sel.dir) return preview(L, sel);
    const rows = list.map((f) => `<button class="mfl-row" data-act="fopen" data-v="${esc(f.n)}"><span class="env-ic${f.dir ? ' dir' : ''}">${ic(f.dir ? 'folder' : f.n.endsWith('.png') ? 'image' : 'file', 'sm')}</span>
      <span class="grow"><b class="trunc">${esc(f.n)}</b><small>${f.dir ? '文件夹' : esc(f.s)} · ${esc(f.d)}${S.fileLoc === 'ws' && f.n === 'hero.css' ? ' · <span class="chg">这项工作改过</span>' : ''}</small></span>${f.dir ? ic('right', 'sm') : ''}</button>`).join('');
    const locRows = D.locations.map((g) => `<h5>${g.group}</h5>${g.items.map((l) => `<button class="s-row${S.fileLoc === l.id ? ' cur' : ''}" data-act="loc" data-v="${l.id}"><span class="env-ic">${ic(devIcon(l.id), 'sm')}</span><span class="grow">${esc(l.name)}<small>${esc(l.sub)}</small></span><span class="end">${S.fileLoc === l.id ? ic('check', 'sm') : `<span class="dot ${l.dot}"></span>`}</span></button>`).join('')}`).join('');
    return `<div class="mfv">
      <button class="msrc" data-act="locsheet"><span class="env-ic">${ic(devIcon(S.fileLoc), 'sm')}</span><span class="grow"><b class="trunc">${esc(L.dev)} · ${esc(L.name)}</b><small>${esc(L.note)}</small></span>${ic('chev', 'sm')}</button>
      <div class="mtools"><div class="crumbs">${L.crumbs.map((c, i) => `${i ? ic('right', 'xs') : ''}<button>${esc(c)}</button>`).join('')}</div>
        <button class="icon-btn" title="搜索此处">${ic('search', 'sm')}</button><button class="icon-btn" data-act="upload" title="从这台手机上传到 ${esc(L.dev)}">${ic('upload', 'sm')}</button><button class="icon-btn" title="新建">${ic('plus', 'sm')}</button></div>
      <div class="mfl">${rows}</div>
      ${S.xfer ? `<button class="mxfer" data-act="xfersheet">${ic('upload', 'sm')}<span class="grow"><span>上传 3 个文件 · <span class="num" id="upPct">62%</span></span><small>另有 1 项移动没有完成</small></span>${ic('chev', 'sm')}<span class="pbar" id="upBar" style="width:62%"></span></button>` : ''}
      ${S.locSheet ? sheet(`<h4>位置</h4><p class="sub">只改变这里看哪儿，不影响正在进行的工作使用的位置。</p>${locRows}<div class="s-sep"></div><button class="s-row" data-act="add-device"><span class="env-ic">${ic('plus', 'sm')}</span><span>添加设备</span></button>`) : ''}
      ${S.xferSheet ? sheet(`<h4>传输</h4><p class="sub">进度和结果来自实际的文件事务。</p>${xferItems()}`) : ''}
    </div>`;
  };

  // ---------------------------------------------------------------- 服务与设备：底部面板
  VC.svcSheet = () => sheet(`<h4>这里的连接</h4><p class="sub">这台手机只负责显示和输入；会话与 Agent 在家中主机上运行。</p>
    <div class="s-path">
      <div class="hop"><span class="env-ic">${ic('phone', 'sm')}</span><span><b>此界面</b><small>iPhone 16 · Varin 手机版 · 已配对</small></span><span class="end"><span class="dot ok"></span>已连接</span></div>
      <div class="hop"><span class="env-ic">${ic('stack', 'sm')}</span><span><b>Varin 服务 · 家中主机</b><small>会话、记忆与 Agent 在这里运行</small></span><span class="end"><span class="dot ok"></span>正常</span></div>
      <div class="hops-res">
        <div class="hop"><span class="env-ic">${ic('server', 'sm')}</span><span><b>开发服务器</b><small>文件 · 执行环境 · 经 SSH</small></span><span class="end"><span class="dot ok"></span>可用</span></div>
        <div class="hop"><span class="env-ic">${ic('computer', 'sm')}</span><span><b>办公电脑</b><small>桌面 · 文件 · 经连接地址</small></span><span class="end"><span class="dot ok"></span>可用</span></div>
      </div>
    </div>
    <div class="s-sep"></div>
    <button class="s-row" data-act="add-device"><span class="env-ic">${ic('plus', 'sm')}</span><span>添加设备<small>让 Varin 使用另一台设备的文件、执行环境或桌面</small></span></button>
    <button class="s-row" data-act="settings" data-page="conn"><span class="env-ic">${ic('stack', 'sm')}</span><span>切换 Varin 服务<small>打开另一处的会话与设置；这里的工作留在原处</small></span></button>
    <button class="s-row" data-act="settings" data-page="conn" data-anchor="pair"><span class="env-ic">${ic('laptop', 'sm')}</span><span>让其他设备连接我<small>这台手机已经配对；还可以再配对一台电脑</small></span></button>
    <button class="s-row" data-act="settings" data-page="conn"><span class="env-ic">${ic('gear', 'sm')}</span><span>连接设置</span></button>`, 'svc');

  // ---------------------------------------------------------------- 会话列表：手机整页，底部是连接入口
  VC.decorateSidebar = (box) => {
    if (!box) return;
    box.insertAdjacentHTML('afterbegin', `<div class="sb-mhead"><b>会话</b><span class="grow"></span><button class="icon-btn" data-act="sidebar" title="关闭">${ic('x')}</button></div>`);
    box.insertAdjacentHTML('beforeend', `<button class="sb-conn" data-act="svc"><span class="dot ok"></span><span>家中主机<small>Varin 服务正常 · 2 台设备可用</small></span>${ic('right', 'sm')}</button>`);
  };

  VC.on('fopen', (el) => { const f = listFor(S.fileLoc).find((x) => x.n === el.dataset.v); if (!f || f.dir) return; S.fileSel = f.n; S.filePage = 'preview'; S.fileMore = false; VC.render('views'); });
  VC.on('fback', () => { S.filePage = null; S.fileMore = false; VC.render('views'); });
  VC.on('fmore', () => { if (!S.filePage) { S.filePage = 'preview'; } S.fileMore = true; VC.render('views'); });
  VC.on('locsheet', () => { S.filePage = null; S.locSheet = true; VC.render('views'); });
  VC.on('xfersheet', () => { S.filePage = null; S.xfer = true; S.xferSheet = true; VC.render('views'); });
  VC.on('sheet-x', () => { S.locSheet = false; S.xferSheet = false; S.fileMore = false; VC.render('views'); });
  VC.on('is-conn', () => { S.island = 'compact'; VC.updateIsland?.(); S.svcPop = true; VC.render('over'); });
  // 评审用：展示手机上进入“这里的连接”的两个入口
  VC.on('m-entry', (el) => {
    S.svcPop = false;
    if (el.dataset.v === 'side') { S.sidebar = true; S.island = 'compact'; } else { S.sidebar = false; S.island = 'open'; }
    VC.render();
  });
})();
