/* Varin · 设置设计稿 · 设备，以及能力组里的浏览器、电脑操作
 * 每台机器只列一次，用三个角色说明它在 Varin 里做什么：运行 Varin 服务、用来打开 Varin、供 Agent 使用。
 * 同一台机器在不同角色里原本是互不相干的记录（这台设备的服务目录、服务上的已配对设备、Agent 可用的资源），
 * 这里按机器合并显示。后端目前没有跨角色的设备标识，落地时需要补上，见 README。
 */
(() => {
  const { ic, esc, sw, dd, seg, num, txt, tags, sec, row, link, disc, note, empty, header, chip, btn, cards, cat, ci, sel, unitbar } = K;
  const desk = '<span class="chip" style="height:18px;font-size:11px">桌面版</span>';
  const muted = s => `<span class="muted" style="font-size:12.5px">${s}</span>`;
  const local = () => S.host === 'local';
  const svcId = () => (local() ? 'studio-pc' : 'home-server');
  const meId = () => (S.size === 'phone' ? 'iphone' : 'studio-pc');
  const merged = () => K.get('dev.merge.home', false);
  const KIND = { desktop: 'monitor', laptop: 'laptop', server: 'server', phone: 'phone', drive: 'drive' };

  /* of：只有通过 studio-pc 上的服务才知道的设备（它的已配对设备和 Agent 资源）
   * mergeInto：可归在同一设备下的连接记录 */
  const ALL = [
    { id: 'studio-pc', kind: 'desktop', os: 'Windows 11', addr: '本机' },
    { id: 'home-server', kind: 'server', os: 'Ubuntu 24.04', addr: '192.168.1.20' },
    { id: 'gpu-box', kind: 'server', os: 'Ubuntu 22.04', addr: '10.0.0.8', of: 1 },
    { id: 'macbook', name: 'MacBook Air', kind: 'laptop', os: 'macOS', addr: '192.168.1.31', of: 1, from: ['已配对的浏览器界面', 'Chrome 扩展'] },
    { id: 'iphone', name: 'iPhone', kind: 'phone', os: 'iOS', of: 1 },
    { id: 'nas', kind: 'drive', os: '远程代理', addr: 'nas.example.com', of: 1 },
    { id: 'ssh-192', name: '192.168.1.20', kind: 'server', os: 'SSH 主机', addr: 'admin@192.168.1.20', of: 1, mergeInto: 'home-server' },
  ];
  const SSH_FOUND = [['build-runner', 'ci@10.0.0.12'], ['pi-lab', 'pi@raspberrypi.local']];
  /* 每台设备的工作区：默认目录、系统（决定可选的命令行）、隔离工作副本的后端 */
  const WS = {
    'studio-pc': { dir: 'C:\\Users\\user', os: 'win', iso: 'missing' },
    'home-server': { dir: '/home/admin', os: 'linux', iso: 'fuse' },
    'ssh-192': { dir: '/home/admin', os: 'linux', iso: 'fuse' },
    'gpu-box': { dir: '/home/deploy', os: 'linux', iso: 'fuse' },
    nas: { dir: '/volume1/work', os: 'linux', iso: 'none' },
  };
  const shellOpts = os => (os === 'win'
    ? [{ v: 'auto', l: '自动 · Git Bash' }, { v: 'pwsh', l: 'PowerShell 7' }, { v: 'cmd', l: '命令提示符' }, { v: 'wsl', l: 'WSL · Ubuntu' }]
    : [{ v: 'auto', l: '自动 · bash' }, { v: 'zsh', l: 'zsh' }, { v: 'sh', l: 'sh' }]);
  /* 设备提供给 Agent 的三项能力。每项可以单独关闭；「能力」里的工作区、电脑操作、浏览器页用同一个开关 */
  const CAPS = [
    { k: 'ws', l: '工作区', icon: 'drive', go: 'workspaces', has: a => a.files },
    { k: 'dt', l: '电脑操作', icon: 'pointer', go: 'desktops', has: a => a.desk },
    { k: 'br', l: '浏览器', icon: 'browser', go: 'browsers', has: a => a.br },
  ];
  const capOn = (k, id) => K.get(`${k}.on.${id}`, true);
  const nm = d => d.name || d.id;
  const byId = id => ALL.find(x => x.id === id);
  const agentId = d => local() && d.id === 'home-server' && merged() ? 'ssh-192' : d.id;

  /* 一台设备在当前视角下扮演的角色。服务角色来自这台设备的服务目录；其余两个只看当前连接的服务。 */
  function roles(d) {
    const cur = svcId(), me = meId();
    const r = { svc: null, client: null, agent: null };
    if (d.id === 'studio-pc') r.svc = { cur: cur === 'studio-pc', url: 'http://127.0.0.1:3902', how: '本机' };
    if (d.id === 'home-server') r.svc = { cur: cur === 'home-server', url: 'http://192.168.1.20:3902', how: '局域网 · 已配对' };
    if (d.id === me) r.client = { me: true, app: d.kind === 'phone' ? 'Varin 手机端' : 'Varin 桌面版' };
    else if (local()) {
      if (d.id === 'studio-pc') r.client = { app: 'Varin 桌面版 · 本机直接打开', seen: '正在使用' };
      if (d.id === 'iphone') r.client = { app: 'Varin 手机端', seen: '2 小时前', push: true, via: '中继' };
      if (d.id === 'macbook') r.client = { app: '在浏览器里打开', seen: '昨天', via: '局域网' };
    }
    if (local()) {
      if (d.id === 'studio-pc') r.agent = { via: 'host', files: true, desk: '当前登录的桌面 · Windows', br: '内置浏览器、Chrome · 个人' };
      if (d.id === 'gpu-box') r.agent = { via: 'ssh', ssh: 'deploy@10.0.0.8', files: true };
      if (d.id === 'macbook') r.agent = { via: 'ext', br: 'Chrome · 工作 · 分享了 2 个标签页' };
      if (d.id === 'nas') r.agent = { via: 'proxy', url: 'https://nas.example.com', files: true, off: '离线 · 3 小时前' };
      if (agentId(d) === 'ssh-192') r.agent = { via: 'ssh', ssh: byId('ssh-192').addr, files: true };
    } else if (d.id === 'home-server') r.agent = { via: 'host', files: true };
    return r;
  }
  const capText = (a, id) => CAPS.filter(c => c.has(a) && capOn(c.k, id)).map(c => c.l).join(' · ') || '已全部关闭';
  const summary = d => {
    const r = roles(d); const p = [];
    if (r.svc) p.push(r.svc.cur ? '当前服务' : '另一台 Varin 服务');
    if (r.client) p.push(r.client.me ? '你在用' : r.client.push ? '已配对 · 推送已开启' : '已配对');
    if (r.agent) p.push(r.agent.off ? 'Agent 可用 · 离线' : r.agent.via === 'ext' ? 'Agent 可用浏览器' : r.agent.via === 'ssh' && !r.svc ? 'Agent 可用 · SSH' : 'Agent 可用');
    return p.join(' · ') || '还没有角色';
  };
  const visible = () => {
    const me = meId(), cur = svcId();
    return ALL.filter(d => (!d.of || local() || d.id === me) && !(d.mergeInto && merged()))
      .sort((a, b) => (b.id === me) - (a.id === me) || (b.id === cur) - (a.id === cur));
  };
  const suggesting = () => local() && !merged() && !K.get('dev.merge.no', false);

  ACTS['dev-merge'] = () => { K.set('dev.merge.home', true); S.sel.devices = 'home-server'; S.tab['dev.home-server'] = 'agent'; App.render(); App.toast('已归在同一台设备'); };
  ACTS['dev-split'] = () => { K.set('dev.merge.home', false); S.tab['dev.home-server'] = 'svc'; App.render(); App.toast('已拆开显示'); };
  ACTS['dev-nomerge'] = () => { K.set('dev.merge.no', true); App.render(); App.toast('不再提示'); };
  ACTS['dev-default'] = el => { K.set('dev.default', el.dataset.v); App.render(); App.flashSaved(); };
  ACTS['dev-open'] = el => { const [id, tab] = el.dataset.v.split(':'); S.sel.devices = id; if (tab) S.tab['dev.' + id] = tab; S.mstage.devices = 'detail'; App.go('devices'); };
  ACTS['dev-add-ssh'] = el => { S.sel.devices = '__add'; S.mstage.devices = 'detail'; K.set('add.intent', 'agent'); K.set('add.how', 'SSH'); K.set('add.host', el.dataset.v); S.unit.add = 'dirty'; App.render(); };
  ACTS['dev-fill'] = el => { K.set('add.host', el.dataset.v); S.unit.add = 'dirty'; App.render(); };
  /* 从能力页跳到某台设备的某个角色 */
  const devBtn = (id, tab = 'agent') => btn('设备详情', { k: 'ghost', sm: true, act: 'dev-open', v: id + ':' + tab });

  page('devices', {
    title: '设备', icon: 'monitor', scope: 'mixed',
    keywords: '设备 服务 服务器 切换 远程实例 地址 版本 配对 二维码 授权 撤销 登出 密码 passkey 公网 HTTPS 隧道 反向代理 FRP Cloudflare 外部访问 代理 出站网络 直连 PAC SSH 远程代理 工作设备 端口转发 合并 本地服务 启动 连接关系',
    desc: '查看设备上的 Varin 服务、客户端和 Agent 连接。',
    badge: () => (local() ? '<span class="badge warn" data-tip="有设备离线">●</span>' : ''),
    render() {
      const f = (S.v['filter.devices'] || '').trim().toLowerCase();
      const list = visible().filter(d => !f || nm(d).toLowerCase().includes(f) || summary(d).includes(f));
      const cur = sel('devices', '__map');
      const item = d => ci('devices', d.id, `<span class="av">${ic(KIND[d.kind], 'sm')}</span><span class="grow"><span class="cn">${esc(nm(d))}${d.id === meId() ? '<span class="faint" style="font-size:12px"> · 这台设备</span>' : ''}</span><div class="cm trunc">${esc(summary(d))}</div></span>${roles(d).agent?.off ? '<span class="end"><span class="dot err" data-tip="离线"></span></span>' : ''}`, { first: '__map' });
      const hidden = ALL.filter(d => d.of && !d.mergeInto && d.id !== meId()).length;
      const items = ci('devices', '__map', `<span class="av">${ic('route', 'sm')}</span><span class="grow"><span class="cn">连接关系</span><div class="cm">这些设备怎样连在一起</div></span>`, { first: '__map', pinned: true }) +
        (suggesting() ? `<button class="mhint" data-sel="devices" data-v="home-server">${ic('link', 'sm')}<span class="grow">有 2 条记录可能是同一台设备</span>${ic('chev', 'sm')}</button>` : '') +
        `<div class="cg"><span>设备</span><span>${list.length}</span></div>` + list.map(item).join('') +
        (local()
          ? '<div class="cg"><span>在 SSH 配置里找到</span></div>' + SSH_FOUND.map(([n, a]) => `<button class="ci dim" data-act="dev-add-ssh" data-v="${n}" data-tip="让 Agent 使用这台主机"><span class="av">${ic('term2', 'sm')}</span><span class="grow"><span class="cn">${n}</span><div class="cm mono trunc">${a}</div></span><span class="end">${ic('plus', 'sm')}</span></button>`).join('')
          : `<p class="cat-note">studio-pc 上的服务还管理着 ${hidden} 台设备，切换过去才能查看。</p>`);
      const d = byId(cur);
      const showable = d && visible().includes(d);
      return cat({ key: 'devices', title: '设备', desc: this.desc, scope: 'mixed', filter: '查找设备', items,
        headActs: btn('', { k: 'ghost', sm: true, icon: 'plus', tip: '添加设备', sel: 'devices', v: '__add' }),
        detail: cur === '__add' ? addPanel() : showable ? device(d) : map() });
    },
    after: c => drawMap(c),
  });
  addEventListener('resize', () => { if (S.page === 'devices') drawMap(document.getElementById('canvas')); });

  /* ── 连接关系：左边打开 Varin 的设备，中间当前服务，右边 Agent 能用的设备 ── */
  function map() {
    const list = visible(); const svc = byId(svcId());
    const clients = list.filter(d => roles(d).client), agents = list.filter(d => roles(d).agent);
    const others = list.filter(d => roles(d).svc && !roles(d).svc.cur);
    const node = (d, side) => {
      const r = roles(d);
      const sub = side === 'l' ? (r.client.me ? '你正在用' : r.client.app)
        : capText(r.agent, agentId(d)) + (r.agent.off ? ' · 离线' : '');
      return `<button class="mnode ${side === 'r' && r.agent.off ? 'off' : ''} ${d.mergeInto ? 'dup' : ''}" data-sel="devices" data-v="${d.id}" data-side="${side}">${ic(KIND[d.kind], 'sm')}<span class="grow"><b>${esc(nm(d))}</b><small>${esc(sub)}</small></span>${side === 'r' && r.agent.off ? '<span class="dot err"></span>' : ''}</button>`;
    };
    return `<div class="oh2"><span class="avatar">${ic('route')}</span><div class="ttl"><h1>连接关系</h1><div class="sub">左边是你用来打开 Varin 的设备，右边是 Agent 能使用的设备。同一台设备可以同时在两边。</div></div></div>
      <div class="map">
        <div class="mcol"><div class="mh">用来打开 Varin</div>${clients.map(d => node(d, 'l')).join('')}</div>
        <div class="mhub"><button class="hub" data-sel="devices" data-v="${svc.id}">${ic('server')}<b>Varin 服务</b><small>${esc(nm(svc))}</small><span>对话、设置和 Agent 都在这里</span></button></div>
        <div class="mcol"><div class="mh">供 Agent 使用</div>${agents.map(d => node(d, 'r')).join('')}</div>
        <svg class="mlines" aria-hidden="true"></svg>
      </div>` +
      note('能打开 Varin，不代表 Agent 能使用这台设备上的文件。要让 Agent 使用某台设备，需要把它加到右边。') +
      (others.length ? sec('其他 Varin 服务', others.map(d => `<div class="orow"><span>${ic('server', 'sm')}</span><div class="grow"><div class="ot">${esc(nm(d))}</div><div class="od">${roles(d).svc.how} · ${roles(d).svc.url}</div></div><div class="oe">${btn('切换过去', { sm: true, act: 'host', v: d.id === 'studio-pc' ? 'local' : 'remote' })}${btn('详情', { k: 'ghost', sm: true, sel: 'devices', v: d.id })}</div></div>`).join(''),
        { desc: '每台 Varin 服务有自己的对话和设置。切换后界面显示那台服务的内容，两边正在进行的工作都不受影响。' }) : '');
  }
  function drawMap(c) {
    const m = c && c.querySelector('.map'); if (!m) return;
    const svg = m.querySelector('.mlines'); const hub = m.querySelector('.hub');
    if (getComputedStyle(svg).display === 'none') return;
    const R = m.getBoundingClientRect(), h = hub.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${R.width} ${R.height}`);
    const hy = h.top + h.height / 2 - R.top;
    svg.innerHTML = [...m.querySelectorAll('.mnode')].map(n => {
      const b = n.getBoundingClientRect(); const y = b.top + b.height / 2 - R.top; const left = n.dataset.side === 'l';
      const x1 = left ? b.right - R.left : h.right - R.left, x2 = left ? h.left - R.left : b.left - R.left;
      const y1 = left ? y : hy, y2 = left ? hy : y; const mx = (x1 + x2) / 2;
      return `<path class="${n.classList.contains('off') ? 'off' : ''}" d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}"/>`;
    }).join('');
  }

  /* ── 一台设备：三个角色做成可切换的卡片，下面是所选角色的设置 ── */
  function device(d) {
    const r = roles(d); const me = d.id === meId();
    const def = (r.svc && r.svc.cur && 'svc') || ['svc', 'client', 'agent'].find(k => r[k]) || 'agent';
    const tab = S.tab['dev.' + d.id] || def;
    const tile = (k, icon, title, short, state) => `<button class="rtile ${r[k] ? 'on' : ''}" role="tab" data-tab="dev.${d.id}" data-v="${k}" aria-selected="${tab === k}" aria-label="${title}，${esc(state)}">${ic(icon, 'sm')}<b class="role-long">${title}</b><b class="role-short">${short}</b><span>${esc(state)}</span></button>`;
    const svcState = r.svc ? (r.svc.cur ? '当前连接的服务' : '另一台服务，可以切换过去') : d.kind === 'phone' ? '手机不能运行' : '没有运行';
    const cliState = r.client ? (r.client.me ? '你正在用' : `已配对 · ${r.client.seen}`) : '还没有配对';
    const agState = r.agent ? (r.agent.off || capText(r.agent, agentId(d))) : d.kind === 'phone' ? '手机不能供 Agent 使用' : '还没有添加';
    const twin = d.id === 'home-server' ? byId('ssh-192') : d.mergeInto ? byId(d.mergeInto) : null;
    const suggest = twin && suggesting()
      ? `<div class="msug">${ic('link', 'sm')}<div class="grow">${d.mergeInto ? `这条 SSH 连接和 Varin 服务 <b>home-server</b> 使用相同地址，可能是同一台设备。` : `SSH 连接 <span class="mono">admin@192.168.1.20</span> 使用相同地址，可能是同一台设备。`}<div class="hstack wrap" style="margin-top:8px">${btn('归在同一台设备', { sm: true, act: 'dev-merge' })}${btn('不是同一台', { sm: true, k: 'ghost', act: 'dev-nomerge' })}</div></div></div>` : '';
    const associated = agentId(d) !== d.id
      ? `<div class="from">${ic('link', 'xs')}<span class="grow">Varin 服务与 SSH 连接 <span class="mono">${esc(r.agent.ssh)}</span> 已归在这里</span>${btn('拆开显示', { k: 'ghost', sm: true, act: 'dev-split' })}</div>`
      : d.from ? `<div class="from">${ic('link', 'xs')}<span>${d.from.join(' · ')}</span></div>` : '';
    const body = tab === 'svc' ? svcPanel(d, r) : tab === 'client' ? clientPanel(d, r) : agentPanel(d, r);
    return `<div class="oh2"><span class="avatar">${ic(KIND[d.kind])}</span><div class="ttl"><h1>${esc(nm(d))}${me ? chip('这台设备') : ''}${r.svc && r.svc.cur ? chip('当前服务', 'primary') : ''}</h1><div class="sub">${esc(d.os)}${d.addr ? ' · ' + esc(d.addr) : ''}</div></div><div class="acts">${btn('', { k: 'ghost', icon: 'more', tip: '更多', act: 'toast', v: '重命名 · 移除' })}</div></div>` +
      associated + suggest +
      `<div class="rtiles" role="tablist" aria-label="这台设备的角色">${tile('svc', 'server', '运行 Varin 服务', '服务', svcState)}${tile('client', 'eye', '用来打开 Varin', '客户端', cliState)}${tile('agent', 'wrench', '供 Agent 使用', 'Agent', agState)}</div>` + body;
  }

  const localHostRow = () => row('打开 Varin 时在本机启动服务', sw('svc.localHost', true, { re: true }), { tag: desk, desc: K.get('svc.localHost', true) ? '这台电脑上的桌面版同时运行 Varin 服务。这项保存在这台设备上。' : '下次启动只作为界面，连接其他 Varin 服务；本机的工作和 SSH 转发不会运行。' }) +
    (K.get('svc.localHost', true) ? '' : row('', btn('重启 Varin', { sm: true, act: 'toast', v: '会关闭所有窗口和本机服务，再重新打开；远程服务不受影响' }), { desc: '已保存，重启后生效。' }));

  function svcPanel(d, r) {
    if (!r.svc) return d.kind === 'phone' ? empty('phone', '手机不能运行 Varin 服务', '手机只能用来打开 Varin。')
      : empty('server', '这台设备没有运行 Varin 服务', '装上 Varin 服务后，它会有自己的对话和设置，可以从别的设备连过去。', btn('查看安装方法', { sm: true, act: 'toast', v: '打开安装说明' }));
    const u = 'dev.' + d.id;
    const otherService = d.id === 'home-server' ? sec('同一设备上的其他服务',
      disc('实验实例', row('地址', txt(u + '.lab.url', 'http://192.168.1.20:4902', { mono: true, w: 'wl', unit: u + '.lab' })) +
        unitbar(u + '.lab', { verify: true, save: '测试并保存', busy: '正在连接…', ok: '已保存连接' }),
      { sum: '未连接' })) : '';
    if (!r.svc.cur) {
      const how = K.get(u + '.how', '直接连接');
      return sec('', row('状态', chip('已配对'), { desc: `${r.svc.how} · ${r.svc.url} · 版本 0.9.50` }) +
          row('切换到这台服务', btn('切换', { k: 'primary', sm: true, act: 'host', v: d.id === 'studio-pc' ? 'local' : 'remote' }), { desc: '界面会显示那台服务上的对话和设置。两边正在进行的工作都不受影响。' }) +
          (d.id === meId() ? localHostRow() : '')) +
        sec('怎样连接', row('方式', seg(u + '.how', ['直接连接', '通过 SSH 启动', '中继'], '直接连接', { re: true })) +
          (how === '直接连接' ? row('地址', txt(u + '.url', r.svc.url, { mono: true, w: 'wl', unit: u + '.s' }))
            : how === '中继' ? row('配对链接', txt(u + '.relay', '', { ph: '粘贴那台服务给出的配对链接', w: 'wl', unit: u + '.s' }), { desc: '两台设备不在同一网络时使用。只用中继连接的服务，不能再给 Agent 当作工作设备。' })
              : row('SSH 命令', txt(u + '.ssh', 'ssh admin@192.168.1.20', { mono: true, w: 'wl', unit: u + '.s' }), { desc: 'Varin 通过 SSH 在那台设备上启动服务，并在本机打开一个端口连过去。' }) +
                row('那台设备上的 Varin', seg(u + '.run', ['需要时启动', '已经在运行'])) +
                row('本机端口', num(u + '.lport', '', { ph: '自动', unit2: u + '.s' }), { desc: '留空自动选择。' }) +
                disc('端口转发', row('', btn('添加转发', { sm: true, icon: 'plus', act: 'toast', v: '把那台设备上的端口转到本机，或反过来' })), { sum: '没有转发' })) +
          unitbar(u + '.s', { verify: true, save: '测试并保存', busy: '正在连接…', ok: '已连接并保存' }),
        { desc: '保存在这台设备的服务目录里。' }) + otherService;
    }
    /* 当前连接的服务：远程访问和网络代理是服务本身的属性，各自有单独的页面，这里给状态和入口 */
    return sec('', row('状态', chip('已连接', 'ok'), { desc: `${r.svc.how} · ${r.svc.url} · 版本 0.9.50` }) + (d.id === meId() ? localHostRow() : '')) +
      sec('这台服务的访问和网络', link('远程访问', 'remote-access', { lead: 'qr', desc: raSummary() }) + link('网络代理', 'proxy', { lead: 'network', desc: pxSummary() })) + otherService;
  }

  function clientPanel(d, r) {
    const svc = byId(svcId());
    if (!r.client) return empty('qr', '还没有用这台设备打开 Varin', '配对后，可以在它上面查看对话、继续工作、接收通知。', btn('配对', { sm: true, k: 'primary', sel: 'devices', v: '__add' }));
    if (r.client.me) return sec('', row('正在使用', muted(r.client.app)) + row('连接到', `<span class="hstack" style="gap:6px"><span class="dot ok"></span>${esc(nm(svc))}</span>`, { desc: '要换一台服务，打开那台服务的详情，或者在「连接关系」里切换。' }));
    return sec('', row('使用方式', muted(r.client.app)) + (r.client.via ? row('连接方式', muted(r.client.via), { desc: r.client.via === '中继' ? '通过 Varin 中继连接，在家和外出都能用。' : '同一网络里直接连接。' }) : '') + row('最近使用', muted(r.client.seen)) +
      (r.client.push ? row('推送通知', muted('已开启'), { desc: '在手机端设置。工作完成或需要你时推送到这台手机。' }) : '') +
      row('撤销访问', btn('撤销', { k: 'ghost danger', sm: true, act: 'toast', v: '撤销后这台设备需要重新配对' }), { desc: '撤销只影响之后的连接，已经交给服务的工作会继续。' }),
    { desc: `配对在 Varin 服务 ${nm(svc)} 上。全部授权设备在「远程访问」里管理。` });
  }

  function agentPanel(d, r) {
    const svc = nm(byId(svcId()));
    if (!r.agent) {
      if (d.kind === 'phone') return empty('phone', '手机不能供 Agent 使用', '手机上的文件和应用不对 Agent 开放。需要时，把文件作为附件发给 Varin。');
      return empty('wrench', 'Agent 还不能使用这台设备', `让 Varin 服务 ${svc} 通过 SSH 连到它，或者在它上面运行 Varin 服务后添加，它就能提供工作区，也可能提供电脑操作和浏览器。`,
        `<span class="hstack">${btn('通过 SSH 添加', { sm: true, k: 'primary', act: 'dev-add-ssh', v: d.addr && d.addr !== '本机' ? d.addr : nm(d) })}${btn('其他方式', { sm: true, sel: 'devices', v: '__add' })}</span>`);
    }
    const a = r.agent; const id = agentId(d); const u = 'dev.' + id; const w = WS[id] || {};
    const via = a.via === 'host' ? row('连接方式', muted('Varin 服务所在的电脑'), { desc: '不需要额外连接。' })
      : a.via === 'ssh' ? row('SSH', txt(u + '.ssh', a.ssh, { mono: true, unit: u + '.c' }), { desc: `由 ${svc} 发起连接，凭据保存在 ${svc} 上。` }) + row('认证', dd(u + '.key', ['~/.ssh/id_ed25519', '使用 SSH agent', '密码'], '~/.ssh/id_ed25519', { unit: u + '.c' })) + unitbar(u + '.c', { verify: true, save: '测试并保存', busy: '正在连接…', ok: '已连接并保存' })
        : a.via === 'ext' ? row('连接方式', muted('Varin 浏览器扩展'), { desc: '扩展直接连接 Varin 服务，这台设备上不需要再装别的。Agent 只能使用分享出来的标签页。' })
          : row('远程代理', txt(u + '.url', a.url, { mono: true, w: 'wl', unit: u + '.c' }), { desc: '这台设备上运行的 Varin 服务地址。' }) + unitbar(u + '.c', { verify: true, save: '测试并保存', busy: '正在连接…', ok: '已连接并保存' });
    const isDef = K.get('dev.default', 'studio-pc') === id;
    const capRow = c => {
      const val = c.has(a);
      if (!val) {
        const why = c.k === 'ws' ? '浏览器扩展只提供浏览器。要在这台设备上读写文件、运行命令，需要通过 SSH 或 Varin 服务添加。'
          : c.k === 'dt' ? (d.kind === 'server' ? '没有图形桌面。可以在「电脑操作」里准备常驻 Linux 桌面。' : '没有可用的桌面。')
            : (d.kind === 'server' ? '没有浏览器。准备常驻 Linux 桌面后可以用其中的 Chromium。' : '没有连接的浏览器。');
        return `<div class="row link soft" data-go="${c.go}" role="link" tabindex="0" data-item="${c.l}"><span class="lead">${ic(c.icon, 'sm')}</span><div class="rl"><div class="t">${c.l}<span class="faint" style="font-size:12px">不提供</span></div><div class="d">${why}</div></div><div class="rc">${ic('chev', 'sm')}</div></div>`;
      }
      const on = capOn(c.k, id);
      const desc = c.k === 'ws' ? `读写文件、运行命令 · 默认目录 <span class="mono">${esc(K.get('ws.dir.' + id, w.dir || '~'))}</span>${isDef ? ' · 新工作默认用这里' : ''}` : esc(val);
      return row(c.l, `${sw(`${c.k}.on.${id}`, true, { re: true, label: '提供' + c.l })}${btn('', { k: 'ghost', sm: true, icon: 'chev', tip: `在「${c.l}」中设置`, go: c.go })}`, { lead: c.icon, desc: on ? desc : '已关闭，新的工作里 Agent 不会用到它。', item: c.l });
    };
    return (a.off ? note(`这台设备${a.off}。Agent 暂时不能使用它，恢复连接后自动可用。`, { k: 'warn' }) + '<div style="height:14px"></div>' : '') +
      sec('提供给 Agent 的能力', CAPS.map(capRow).join(''), { desc: `每项可以单独关闭，关闭后新的工作里 Agent 不会用到它。能提供什么由 Varin 服务 ${svc} 实际检查。` }) +
      sec('连接', via) +
      (a.via === 'ssh' ? sec('', disc('端口转发', row('', btn('添加转发', { sm: true, icon: 'plus', act: 'toast', v: '在这台设备上打开端口转回服务，或把服务的端口转过去' })), { sum: '没有转发' })) : '');
  }

  /* ── 添加设备：先问想做什么 ── */
  const qr = () => {
    let s = 11; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280; const N = 25; let p = '';
    const inF = (x, y) => (x < 8 && y < 8) || (x > N - 9 && y < 8) || (x < 8 && y > N - 9);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!inF(x, y) && rnd() > 0.52) p += `M${x} ${y}h1v1h-1z`;
    const f = (x, y) => `<path fill-rule="evenodd" d="M${x} ${y}h7v7h-7z M${x + 1} ${y + 1}v5h5v-5z"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
    return `<svg viewBox="-1 -1 ${N + 2} ${N + 2}" shape-rendering="crispEdges" fill="currentColor"><path d="${p}"/>${f(0, 0)}${f(N - 7, 0)}${f(0, N - 7)}</svg>`;
  };
  function addPanel() {
    const intent = K.get('add.intent', 'use'); const svc = nm(byId(svcId()));
    let body;
    if (intent === 'use') {
      body = pairing() + note('外出时也想用？在 <span class="linkish" data-go="remote-access">远程访问</span> 里开启 Varin 中继、临时隧道或公网访问。');
    } else if (intent === 'agent') {
      const how = K.get('add.how', 'SSH');
      body = sec('', row('方式', seg('add.how', ['SSH', '运行 Varin 服务'], 'SSH', { re: true })) +
        (how === 'SSH'
          ? row('主机', txt('add.host', '', { ph: 'user@host，或 SSH 配置里的名字', w: 'wl', mono: true, unit: 'add' }), { desc: `在 ${svc} 的 SSH 配置里找到：${SSH_FOUND.map(([n]) => `<button class="chip" style="height:20px;cursor:pointer" data-act="dev-fill" data-v="${n}">${n}</button>`).join(' ')}` }) +
            row('端口', num('add.port', 22, { unit2: 'add' })) + row('认证', dd('add.key', ['~/.ssh/id_ed25519', '使用 SSH agent', '密码'], '~/.ssh/id_ed25519', { unit: 'add' })) +
            row('显示名称', txt('add.name', '', { ph: '留空使用主机名', unit: 'add' }), { desc: '如果它已经在列表里（比如是另一台 Varin 服务），用同一个名字会合并成一台。' })
          : row('服务地址', txt('add.url', '', { ph: 'https://gpu-box.example.com:3902', w: 'wl', mono: true, unit: 'add' }), { desc: '先在那台设备上安装并启动 Varin 服务，再填它的地址。' }) + row('配对码', txt('add.code', '', { ph: '那台服务上显示的配对码', unit: 'add' }))) +
        unitbar('add', { verify: true, save: '测试并添加', busy: '正在连接…', ok: '已添加' }),
      { desc: `由 Varin 服务 ${svc} 发起连接，凭据保存在 ${svc} 上。只用中继连接的设备暂时不能给 Agent 使用。` });
    } else {
      const how = K.get('add.svcHow', '地址或配对链接');
      body = sec('', row('方式', seg('add.svcHow', ['地址或配对链接', '通过 SSH 启动'], '地址或配对链接', { re: true })) +
        (how === '地址或配对链接'
          ? row('地址', txt('add.svcUrl', '', { ph: 'http://192.168.1.20:3902 或配对链接', w: 'wl', mono: true, unit: 'add2' }))
          : row('SSH 命令', txt('add.sshCmd', '', { ph: 'ssh user@host', w: 'wl', mono: true, unit: 'add2' }), { desc: 'Varin 通过 SSH 在那台设备上启动服务，并在本机打开一个端口连过去。' }) + row('本机端口', num('add.lport', '', { ph: '自动', unit2: 'add2' }))) +
        unitbar('add2', { verify: true, save: '测试并添加', busy: '正在连接…', ok: '已添加' }),
      { desc: '保存在这台设备的服务目录里。添加后可以随时切换过去。' });
    }
    return `<div class="oh2"><span class="avatar">${ic('plus')}</span><div class="ttl"><h1>添加设备</h1><div class="sub">先选想做什么。同一台设备可以做好几件事，之后在它的详情里继续添加。</div></div></div>` +
      sec('', cards('add.intent', [
        { v: 'use', l: '在它上面用 Varin', icon: 'phone', d: '手机、平板或另一台电脑：查看对话、继续工作、接收通知。' },
        { v: 'agent', l: '让 Agent 使用它', icon: 'wrench', d: '在另一台电脑或服务器上读写文件、运行命令。' },
        { v: 'svc', l: '连接它上面的 Varin 服务', icon: 'server', d: '那台设备已经运行 Varin 服务，有自己的对话和设置。' },
      ], 'use', { re: true }), { raw: true }) + body +
      sec('', link('让 Agent 使用某台电脑上的 Chrome / Edge', 'browsers', { lead: 'browser', desc: '装上 Varin 浏览器扩展并配对，在「浏览器」里操作。' }));
  }

  /* ── 配对新设备：先选它会在哪里用，再生成一次性二维码。「远程访问」和「添加设备」共用 ── */
  ACTS['pair-make'] = () => { K.set('pair.made', true); App.render(); };
  function pairing() {
    const where = K.get('pair.where', 'lan'); const relay = K.get('ra.relay', true);
    const hint = { local: '给同一台电脑上的应用使用。', lan: '通过 Wi‑Fi 直接连接，离开这个网络就用不了。', any: relay ? '在家和外出都能用。外出时经过 Varin 中继，端到端加密。' : '需要先在「访问方式」里启用 Varin 中继。' }[where];
    const link2 = where === 'any' ? 'varin://pair?relay=1&k=3F9QW2' : 'http://192.168.1.12:3902/pair#k3F9-QW2';
    return sec('配对新设备', row('你会在哪里用这台设备', seg('pair.where', [{ v: 'local', l: '仅这台电脑' }, { v: 'lan', l: '仅家里的网络' }, { v: 'any', l: '任何地方' }], 'lan', { re: true }), { desc: hint }) +
      (where === 'any' ? row('在家时优先直接连接', sw('pair.preferLocal', true), { sub: true }) : where === 'lan' ? row('外出时也允许通过中继连接', sw('pair.fallback', false, { off: !relay }), { sub: true, desc: relay ? '' : '中继还没启用。', dim: !relay }) : '') +
      row('设备名称', txt('pair.label', '', { ph: '例如 我的 iPhone' }), { desc: '方便之后在列表里认出它。' }) +
      row('扫一次就完成配对', sw('pair.token', true), { desc: '关闭后，设备连上以后还要用界面密码登录。' }) +
      (K.get('pair.made', false)
        ? `<div class="pair inpanel"><div class="qr">${qr()}</div><div class="grow"><b>用另一台设备上的 Varin 扫码</b><p>或者在那台设备的浏览器里打开链接。配对完成后，它会出现在「设备」和授权列表里。</p><div class="hstack">${txt('pair.link', link2, { mono: true, w: 'wl' })}${btn('复制', { sm: true, icon: 'copy', act: 'toast', v: '已复制配对链接' })}</div><p class="faint" style="margin-top:8px">只能用一次，10 分钟后过期。这个链接能访问这台服务，不要分享给别人。</p></div></div>`
        : row('', btn('创建二维码', { k: 'primary', sm: true, act: 'pair-make' }))));
  }

  /* 远程访问和网络代理在设备详情里的摘要 */
  const raSummary = () => [K.get('ra.lan', true) ? '局域网已开启' : '局域网关闭', K.get('ra.relay', true) ? '中继已连接' : '中继未启用', K.get('tn.on', false) ? '临时隧道运行中' : '', K.get('ra.open', false) ? '公网访问已开放' : '公网访问未开启', `已授权 ${visible().filter(x => roles(x).client).length} 台设备`].filter(Boolean).join(' · ');
  const pxSummary = () => ({ auto: '自动：跟随系统的代理设置', direct: '直连', manual: '指定代理' + (K.get('px.url', '') ? ' · ' + K.get('px.url', '') : '') })[K.get('px.mode', 'auto')];

  /* ── 远程访问：按访问方式组织，每种方式一行状态，展开就是它的设置 ── */
  ACTS['ra-acc'] = el => { K.set('ra.acc', K.get('ra.acc', '') === el.dataset.v ? '' : el.dataset.v); App.render(); };
  ACTS['ra-pair'] = () => { K.set('ra.pairing', !K.get('ra.pairing', false)); K.set('pair.made', false); App.render(); };
  ACTS['ra-relay'] = () => { const on = !K.get('ra.relay', true); K.set('ra.relay', on); App.render(); App.toast(on ? '中继已启用' : '已停用，通过中继连接的设备已断开'); };
  ACTS['ra-pw'] = () => App.flashItem('界面密码');
  ACTS['tn-start'] = () => { K.set('tn.on', true); App.render(); App.toast('隧道已就绪'); };
  ACTS['tn-stop'] = () => { K.set('tn.on', false); App.render(); App.toast('隧道已停止，连接链接已失效'); };
  page('remote-access', {
    title: '远程访问', icon: 'qr', scope: 'host',
    keywords: '远程访问 配对 二维码 授权 撤销 登出 密码 passkey 局域网 Wi-Fi 中继 relay 隧道 Cloudflare ngrok Quick Managed 公网 HTTPS 反向代理 FRP frpc 外部访问 唤醒',
    desc: '别的设备怎样打开这台 Varin 服务：从哪些网络能访问、谁能访问、怎样登录。',
    badge: () => (K.get('tn.on', false) ? '<span class="badge" data-tip="临时隧道运行中">●</span>' : ''),
    render() {
      const svc = nm(byId(svcId())); const pw = K.get('ra.pw', false);
      const lan = K.get('ra.lan', true), relay = K.get('ra.relay', true), tn = K.get('tn.on', false), pub = K.get('ra.open', false);
      const acc = (id, icon, title, desc, status, body, extra = '') => { const open = K.get('ra.acc', '') === id; return `<div class="acc ${open ? 'open' : ''}" data-item="${title}"><button class="acc-h" data-act="ra-acc" data-v="${id}" aria-expanded="${open}"><span class="acc-i">${ic(icon, 'sm')}</span><span class="grow"><b>${title}${extra}</b><small>${desc}</small></span>${status}${ic('chev', 'sm chev')}</button>${open ? `<div class="acc-b">${body}</div>` : ''}</div>`; };
      const beta = '<span class="chip warn" style="height:18px;font-size:11px;margin-left:6px">测试版</span>';

      const lanBody = row('允许同一网络的设备打开 Varin', sw('ra.lan', true, { re: true }), { tag: desk, desc: '手机、平板和同一 Wi‑Fi 下的其他电脑可以访问。修改后 Varin 会重启。' }) +
        (lan ? row('地址', `<span class="hstack"><span class="mono muted" style="font-size:12.5px">http://192.168.1.12:3902</span>${btn('', { k: 'ghost', sm: true, icon: 'copy', tip: '复制', act: 'toast', v: '已复制' })}</span>`) : '') +
        row('Varin 运行时保持电脑唤醒', sw('ra.awake', false), { tag: desk, desc: '让手机可以继续打开 Varin。屏幕仍然可以关闭。' }) +
        (lan && !pw ? note('还没有设置界面密码，同一网络里能连到这台电脑的人可以直接使用 Varin。<span class="linkish" data-act="ra-pw">去设置</span>', { k: 'warn', inpanel: true }) : '');

      const relayBody = row('Varin 中继', relay ? btn('停用', { sm: true, k: 'ghost danger', act: 'ra-relay' }) : btn('启用中继', { sm: true, k: 'primary', act: 'ra-relay' }),
        { desc: relay ? '已连接，1 台设备正在通过中继连接。停用后，这些设备会立刻断开。' : '不用开放端口，就能让你的其他设备从任何地方连接。在这里启用之前，不会共享任何内容。' }) +
        note('流量端到端加密，中继读不到内容。中继地址由服务的 VARIN_RELAY_URL 决定。只通过中继连接的设备，不能给 Agent 当作工作设备。', { inpanel: true });

      const prov = K.get('tn.prov', 'Cloudflare'), mode = K.get('tn.mode', 'quick');
      const tnBody = row('提供方', seg('tn.prov', ['Cloudflare', 'ngrok'], 'Cloudflare', { re: true }), { desc: `需要在 ${svc} 上安装 ${prov === 'Cloudflare' ? 'cloudflared' : 'ngrok'}。` }) +
        (prov === 'Cloudflare' ? row('隧道类型', seg('tn.mode', [{ v: 'quick', l: '快速' }, { v: 'remote', l: '托管 · 远程' }, { v: 'local', l: '托管 · 本地' }], 'quick', { re: true }),
          { desc: { quick: '临时地址，只尽力提供，不保证可用。需要长期访问请用托管类型。', remote: '用你的 Cloudflare 账号和域名，长期可用。', local: '使用服务上的 cloudflared 配置文件。' }[mode] }) : '') +
        (prov === 'Cloudflare' && mode === 'remote' ? `<div class="orow"><span>${ic('globe', 'sm')}</span><div class="grow"><div class="ot">Production</div><div class="od mono">varin.example.com · token 已保存</div></div><div class="oe">${btn('移除', { k: 'ghost', sm: true, act: 'toast', v: '已移除' })}</div></div>` +
          row('', btn('添加托管隧道', { sm: true, icon: 'plus', act: 'toast', v: '填写名称、主机名和 token' }), { desc: 'token 按隧道保存在服务上，之后重复使用。主机名需要是你 Cloudflare 账号里的域名。' }) : '') +
        (prov === 'Cloudflare' && mode === 'local' ? row('配置文件', txt('tn.cfg', '', { ph: '留空使用 ~/.cloudflared/config.yml', mono: true, w: 'wl' })) : '') +
        row('连接链接有效期', dd('tn.ttl', ['10 分钟', '1 小时', '24 小时', '不过期'], '1 小时', { w: 'ws' })) +
        row('远程会话有效期', dd('tn.sttl', ['8 小时', '24 小时', '7 天'], '24 小时', { w: 'ws' }), { desc: '扫码登录后，这台设备能用多久。' }) +
        (tn ? row('状态', chip('隧道已就绪', 'ok'), { desc: '公开地址 https://quiet-river-1234.trycloudflare.com，没有连接链接打不开。' }) +
            `<div class="pair inpanel"><div class="qr">${qr()}</div><div class="grow"><b>用手机扫码连接</b><p>一次性链接，${K.get('tn.ttl', '1 小时')}内有效。隧道停止或链接过期后失效。</p><div class="hstack">${txt('tn.link', 'https://quiet-river-1234.trycloudflare.com/connect#t=…', { mono: true, w: 'wl' })}${btn('复制', { sm: true, icon: 'copy', act: 'toast', v: '已复制连接链接' })}</div><div class="hstack" style="margin-top:10px">${btn('新建连接链接', { sm: true, act: 'toast', v: '已生成新的一次性链接' })}${btn('停止隧道', { sm: true, k: 'ghost danger', act: 'tn-stop' })}</div></div></div>` +
            disc('已兑换的访问链接', `<div class="orow"><span>${ic('phone', 'sm')}</span><div class="grow"><div class="ot">iPhone</div><div class="od">已兑换 · 10 分钟前 · 23 小时后过期</div></div><div class="oe">${btn('吊销', { k: 'ghost danger', sm: true, act: 'toast', v: '已吊销' })}</div></div>`, { sum: '1 个' })
          : row('', btn('启动隧道', { k: 'primary', sm: true, act: 'tn-start' }), { desc: '启动后生成一次性连接链接。隧道运行期间不要关闭 Varin；再启动一个隧道会替换当前这个。' }));

      const way = K.get('ra.way', 'proxy');
      const pubBody = row('状态', pub ? chip('已开放', 'ok') : chip('未开启'), { desc: `访问的是 ${svc} 上的服务。` }) +
        `<div style="padding:4px 16px 14px">${cards('ra.way', [{ v: 'proxy', l: '已有 HTTPS 反向代理', d: 'Nginx、Caddy 等已经配置好域名和证书。' }, { v: 'frp', l: 'FRP', d: '使用你已有的 FRP 服务器，Varin 在本机运行 frpc。' }], 'proxy', { re: true, n: 2 })}</div>` +
        (way === 'proxy'
          ? row('公网地址', txt('ra.url', '', { ph: 'https://varin.example.com', w: 'wl', mono: true, unit: 'ra' })) +
            row('本机监听', `<span class="hstack">${txt('ra.ip', '127.0.0.1', { w: 'ws', unit: 'ra' })}${txt('ra.port', '3902', { w: 'ws', unit: 'ra' })}</span>`, { desc: '反向代理和服务在同一台机器上时，保持 127.0.0.1。' })
          : row('FRP 服务器', txt('ra.frps', '', { ph: 'frp.example.com:7000', mono: true, unit: 'ra' })) +
            row('Token', txt('ra.frpt', '', { type: 'password', unit: 'ra' }), { desc: '保存在服务上，不会写进文件或命令行参数。' }) +
            row('公网地址', txt('ra.url', '', { ph: 'https://varin.example.com', w: 'wl', mono: true, unit: 'ra' }), { desc: 'FRP 服务器上为 Varin 准备好的 HTTPS 地址。' }) +
            row('frpc', `<span class="hstack">${muted('未安装')}${btn('安装', { sm: true, act: 'toast', v: '下载官方发布包，校验后只解出 frpc' })}</span>`)) +
        disc('部署文件与连接详情', row('', `${btn('下载部署文件', { sm: true, icon: 'download', act: 'toast', v: '生成 Nginx / Caddy / FRP 配置示例' })}${btn('复制连接详情', { sm: true, icon: 'copy', act: 'toast', v: '已复制' })}`)) +
        K.unitbar('ra', { save: '保存配置', msg: '保存配置不会立刻开放访问' }) +
        row('开放公网访问', sw('ra.open', false, { re: true }), { desc: '保存配置和开放访问是两步，方便先检查再开放。关闭只断开公网连接，不删除设备授权，也不取消已经交给服务的工作。' }) +
        note('Varin 不会替你登录服务器、申请证书或修改服务器上的配置，只检查公网地址能不能打开这台服务。', { inpanel: true });

      const clients = visible().filter(x => roles(x).client);
      return header(this, { acts: btn(K.get('ra.pairing', false) ? '收起配对' : '配对新设备', { sm: true, k: K.get('ra.pairing', false) ? '' : 'primary', icon: 'qr', act: 'ra-pair' }) }) +
        (K.get('ra.pairing', false) ? pairing() : '') +
        sec('访问方式',
          acc('lan', 'network', '局域网', '同一 Wi‑Fi 下的手机、平板和电脑', lan ? chip('已开启', 'ok') : chip('关闭'), lanBody) +
          acc('relay', 'link', 'Varin 中继', '不开放端口，在任何地方连接', relay ? chip('已连接', 'ok') : chip('未启用'), relayBody) +
          acc('tunnel', 'zap', '临时隧道', 'Cloudflare 或 ngrok 生成一次性连接链接', tn ? chip('运行中', 'ok') : chip('未启动'), tnBody, beta) +
          acc('public', 'globe', '公网访问', '用你自己的域名：HTTPS 反向代理或 FRP', pub ? chip('已开放', 'ok') : chip('未开启'), pubBody, beta),
        { raw: true, desc: '可以同时开启几种。点开一行查看和修改它的设置。' }) +
        sec('已授权的设备', clients.map(x => { const c = roles(x).client; return `<div class="orow"><span>${ic(KIND[x.kind], 'sm')}</span><div class="grow"><div class="ot">${esc(nm(x))}${c.me ? chip('这台设备') : ''}</div><div class="od">${esc(c.app)}${c.via ? ' · ' + c.via : ''}${c.me ? ' · 正在使用' : ' · 上次使用 ' + c.seen}</div></div><div class="oe">${c.me ? '' : btn('撤销', { k: 'ghost danger', sm: true, act: 'toast', v: `已撤销 ${nm(x)}，它需要重新配对` })}${btn('', { k: 'ghost', sm: true, icon: 'chev', tip: '设备详情', act: 'dev-open', v: x.id + ':client' })}</div></div>`; }).join(''),
          { desc: '撤销只影响之后的连接，已经交给服务的工作会继续。', acts: `${btn('清除已撤销', { k: 'ghost', sm: true, act: 'toast', v: '已清除' })}${btn('全部登出', { k: 'ghost danger', sm: true, act: 'toast', v: '所有设备都需要重新登录' })}` }) +
        sec('登录保护', row('界面密码', sw('ra.pw', false, { re: true }), { desc: '从局域网、中继或公网打开 Varin 时需要输入。本机直接打开不受影响。' }) +
          (pw ? row('密码', txt('ra.pwv', '', { type: 'password', ph: '输入新密码', unit: 'pw' }), { sub: true, desc: '重启后要求输入，之后登录过期时再次要求。登录时可以选「信任此设备」。' }) + K.unitbar('pw', { save: '保存密码' }) : '') +
          row('Passkey', btn('添加', { sm: true, off: !pw, act: 'toast', v: '用这台设备的指纹或面容创建 passkey' }), { desc: pw ? '用指纹、面容或安全密钥代替输入密码。' : '开启界面密码后才能使用。', dim: !pw }));
    },
  });

  /* ── 网络代理 ── */
  page('proxy', {
    title: '网络代理', icon: 'network', scope: 'host', keywords: '代理 出站网络 直连 PAC 系统代理 测试 HTTP SOCKS 虚拟网卡',
    desc: 'Varin 服务访问外部网络时是否经过代理，包括模型服务、网页搜索和下载。',
    render() {
      const name = nm(byId(svcId())); const m = K.get('px.mode', 'auto');
      return header(this) +
        sec('', cards('px.mode', [
          { v: 'auto', l: '自动', d: '优先使用系统环境里的代理；桌面版没有配置时，跟随系统网络设置（代理、PAC、虚拟网卡）。' },
          { v: 'direct', l: '直连', d: '不经过任何代理。' },
          { v: 'manual', l: '指定代理', d: '所有外部请求都经过你填写的代理。' },
        ], 'auto', { re: true }), { raw: true }) +
        (m === 'manual' ? sec('代理', row('代理地址', txt('px.url', '', { ph: 'http://127.0.0.1:7890', w: 'wl', mono: true })) + row('不经过代理', tags('px.bypass', ['localhost', '127.0.0.1', '*.local']), { stack: true })) : '') +
        sec('测试', row('测试网址', `<span class="hstack">${txt('px.test', 'https://api.openai.com', { w: 'wl', mono: true })}${btn('测试', { sm: true, act: 'toast', v: `从 ${name} 访问成功 · 320 毫秒 · ${m === 'manual' ? '经过代理' : '直连'}` })}</span>`, { desc: `在 Varin 服务 ${name} 上测试，不是在你正在用的设备上。` }),
          { after: note('单个模型服务可以另设代理，在「模型服务」的高级设置里。') });
    },
  });

  /* ── 能力 · 工作区：按设备分组 ── */
  ACTS['dev-add-agent'] = () => { S.sel.devices = '__add'; S.mstage.devices = 'detail'; K.set('add.intent', 'agent'); App.go('devices'); };
  page('workspaces', {
    title: '工作区', icon: 'drive', scope: 'host',
    keywords: '工作区 文件 命令 目录 默认目录 shell 命令行 Git Bash PowerShell WSL bash zsh 隔离 工作副本 版本化 WinFsp FUSE 远端项目 SSH 默认设备',
    desc: 'Agent 读写文件、运行命令的地方。每台设备可以提供一个工作区，下面按设备列出。',
    render() {
      const list = visible().filter(d => roles(d).agent && roles(d).agent.files);
      const saved = K.get('dev.default', 'studio-pc'); const def = list.some(d => agentId(d) === saved) ? saved : list[0] && agentId(list[0]);
      const group = d => {
        const id = agentId(d); const a = roles(d).agent; const w = WS[id] || { dir: '~', os: 'linux', iso: 'none' }; const on = capOn('ws', id);
        const projs = DATA.projects.filter(p => (p.dev || 'studio-pc') === id);
        const viaText = a.via === 'host' ? 'Varin 服务所在的电脑' : a.via === 'ssh' ? 'SSH · ' + a.ssh : '远程代理 · ' + a.url;
        const iso = w.iso === 'fuse' ? chip('可用 · FUSE', 'ok') : w.iso === 'missing' ? `<span class="hstack">${muted('需要 WinFsp')}${btn('安装', { sm: true, act: 'toast', v: '下载 WinFsp 安装程序，装好后重新检测' })}</span>` : chip('不支持');
        const isoDesc = w.iso === 'missing' ? '版本化工作区和工作副本需要它，Agent 可以在不改动原文件的情况下工作。不装也能正常读写。' : w.iso === 'fuse' ? '可以给这里的项目开启版本化工作区和工作副本。' : '这台设备不支持，只能直接读写原文件。';
        const body = (a.off ? note(`${nm(d)}${a.off}，暂时不能使用。`, { k: 'warn', inpanel: true }) : '') +
          row('提供给 Agent', sw('ws.on.' + id, true, { re: true, label: '提供工作区' }), { desc: viaText }) +
          (on ? row('默认目录', txt('ws.dir.' + id, w.dir, { mono: true }), { desc: '没有项目时，命令从这里开始。绝对路径仍然可以访问这个账户能访问的其他位置。' }) +
            row('运行命令使用', `${dd('ws.shell.' + id, shellOpts(w.os), 'auto')}${btn('', { k: 'ghost', sm: true, icon: 'refresh', tip: '重新检测', act: 'toast', v: `已在 ${nm(d)} 上重新检测命令行` })}`, { desc: '修改后从下一次请求开始生效。' }) +
            row('隔离工作副本', iso, { desc: isoDesc }) +
            row('在这里的项目', projs.length ? `<span class="hstack wrap" style="justify-content:flex-end">${projs.map(p => `<button class="chip" data-go="projects" data-sel="${p.id}" style="cursor:pointer">${esc(p.name)}</button>`).join('')}</span>` : muted('还没有'), { desc: '添加项目时选择它在哪个工作区。' })
            : row('', '', { desc: '已关闭。新的工作里 Agent 不会用到这个工作区，项目也暂时打不开。' }));
        return sec(groupTitle(d.id), body, { acts: `${def === id ? chip('新工作默认', 'primary') : ''}${devBtn(d.id)}` });
      };
      return header(this, { acts: btn('添加工作区', { sm: true, icon: 'plus', act: 'dev-add-agent' }) }) +
        sec('', row('新工作默认使用', dd('dev.default', list.map(d => ({ v: agentId(d), l: groupTitle(d.id), icon: KIND[d.kind] })), def, { w: 'wl', re: true }), { desc: '没有项目、也没有指定时使用。对话里可以随时换；已经开始的工作沿用原来的工作区。' })) +
        list.map(group).join('') +
        note('添加工作区就是让 Agent 使用另一台设备：通过 SSH，或者在那台设备上运行 Varin 服务。只通过中继连接的设备不能提供工作区。');
    },
  });

  /* ── 能力 · 浏览器：按设备分组 ── */
  const groupTitle = id => { const d = byId(id); return nm(d) + (id === meId() ? ' · 这台设备' : ''); };
  page('browsers', {
    title: '浏览器', icon: 'browser', scope: 'host', keywords: '浏览器 Chrome Edge CDP 调试端口 扩展 配对 默认浏览器 标签页 内置浏览器',
    desc: 'Agent 能操作的浏览器。每个浏览器都在某台设备上，下面按设备列出。',
    render() {
      const g = (logoName, n, d) => `<div class="orow">${logoName ? `<img class="logo md keep" src="../../../packages/ui/src/assets/provider-logos/${logoName}.svg" alt="">` : `<span class="lead">${ic('browser', 'sm')}</span>`}<div class="grow"><div class="ot">${n}</div><div class="od">${d}</div></div><div class="oe"><span class="dot ok"></span>${btn('', { k: 'ghost', sm: true, icon: 'more', tip: '更多', act: 'toast', v: '查看标签页 · 断开' })}</div></div>`;
      const none = (txt2, go) => row('没有浏览器', go ? btn('电脑操作', { k: 'ghost', sm: true, go }) : '', { desc: txt2 });
      const grp = (id, body) => sec(groupTitle(id), capOn('br', id) ? body : row('已关闭', '', { desc: '新的工作里 Agent 不会用到这台设备上的浏览器。' }), { acts: `${sw('br.on.' + id, true, { re: true, label: '提供浏览器' })}${devBtn(id)}` });
      const groups = local()
        ? grp('studio-pc', g('', '内置浏览器', 'Varin 桌面版自带 · 登录网站后可以交给 Agent') + g('', 'Chrome · 个人', 'Varin 浏览器扩展 · 分享了 4 个标签页')) +
          grp('macbook', g('', 'Chrome · 工作', 'Varin 浏览器扩展 · 分享了 2 个标签页')) +
          sec(groupTitle('gpu-box'), none('准备常驻 Linux 桌面后，可以用其中的 Chromium。', 'desktops'), { acts: devBtn('gpu-box') })
        : sec(groupTitle('home-server'), none('这台服务上还没有浏览器。'), { acts: devBtn('home-server') });
      return header(this, { acts: btn('刷新', { k: 'ghost', sm: true, icon: 'refresh', act: 'toast', v: '已刷新浏览器列表' }) }) +
        sec('', row('默认浏览器', dd('br.default', local() ? ['自动选择', '内置浏览器（studio-pc）', 'Chrome · 个人（studio-pc）', 'Chrome · 工作（MacBook Air）'] : ['自动选择'], '自动选择', { w: 'wl' }), { desc: '任务没有指定浏览器时使用；每个任务也可以单独选。' })) +
        groups +
        sec('连接新的浏览器', row('连接正在用的 Chrome / Edge', btn('安装扩展并配对', { sm: true, act: 'toast', v: '下载 Varin 浏览器扩展，在扩展里选择服务并配对' }), { desc: '扩展直接连接 Varin 服务，那台电脑上不需要再装别的。配对后分享哪些标签页由你决定。' }) +
          disc('添加调试端口（CDP）', row('在哪台设备上', dd('br.cdpHost', local() ? [{ v: 'studio-pc', l: 'studio-pc（Varin 服务所在的电脑）' }, { v: 'gpu-box', l: 'gpu-box' }] : [{ v: 'home-server', l: 'home-server' }], local() ? 'studio-pc' : 'home-server', { w: 'wl', unit: 'cdp' }), { desc: '地址、请求头和文件交接目录都由这台设备解释。' }) +
            row('地址', txt('br.cdp', '', { ph: 'http://127.0.0.1:9222', mono: true, unit: 'cdp' })) +
            row('认证请求头', txt('br.cdpH', '', { ph: '可选', unit: 'cdp' })) +
            row('文件交接目录', txt('br.cdpDir', '', { ph: '可选，用于上传和下载', mono: true, unit: 'cdp' })) +
            unitbar('cdp', { verify: true, save: '测试并添加', busy: '正在连接…', ok: '已添加' })));
    },
  });

  /* ── 能力 · 电脑操作：按设备分组 ── */
  page('desktops', {
    title: '电脑操作', icon: 'pointer', scope: 'host', keywords: 'Computer Use 电脑操作 桌面 虚拟机 libvirt Linux 截图 键鼠 观看 控制',
    desc: 'Agent 能看到并操作的电脑桌面。每个桌面都在某台设备上，下面按设备列出。',
    render() {
      const caps = ['读取界面结构', '截图', '点击元素', '键盘鼠标', '拖拽'];
      const groups = local()
        ? sec(groupTitle('studio-pc'), !capOn('dt', 'studio-pc') ? row('已关闭', '', { desc: '新的工作里 Agent 不会用到这台设备的桌面。' }) : `<div class="orow"><span class="lead" style="width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:color-mix(in srgb,var(--foreground) 5%,transparent)">${ic('monitor', 'sm')}</span><div class="grow"><div class="ot">当前登录的桌面</div><div class="od">Windows 11</div><div class="caps">${caps.map(x => `<span class="cap">${x}</span>`).join('')}</div></div><div class="oe"><span class="dot ok"></span><span class="muted" style="font-size:12.5px">可用</span>${btn('观看', { sm: true, icon: 'eye', act: 'toast', v: '在侧边面板中观看这个桌面' })}${btn('', { k: 'ghost', sm: true, icon: 'more', tip: '更多', act: 'toast', v: '重新检测能力' })}</div></div>`, { acts: `${sw('dt.on.studio-pc', true, { re: true, label: '提供电脑操作' })}${devBtn('studio-pc')}` }) +
          sec(groupTitle('gpu-box'), row('常驻 Linux 桌面', btn('准备', { sm: true, act: 'toast', v: '在 gpu-box 上准备 Debian 桌面和浏览器' }), { desc: '关掉观看窗口后程序继续运行，重启后保留文件和浏览器数据。' }), { acts: devBtn('gpu-box') })
        : sec(groupTitle('home-server'), row('常驻 Linux 桌面', btn('准备', { sm: true, act: 'toast', v: '在 home-server 上准备 Debian 桌面和浏览器' }), { desc: '关掉观看窗口后程序继续运行，重启后保留文件和浏览器数据。' }), { acts: devBtn('home-server') });
      return header(this) +
        sec('', row('默认桌面', dd('dt.default', local() ? ['自动选择', 'studio-pc · 当前登录的桌面'] : ['自动选择'], local() ? 'studio-pc · 当前登录的桌面' : '自动选择', { w: 'wl' }), { desc: '工作没有指定桌面时使用。修改不影响正在运行的任务；自动选择可能使用唯一可用的桌面。' })) +
        groups +
        sec('虚拟机', empty('layers', '还没有虚拟机', '添加虚拟化服务（libvirt）后，可以在这里创建和管理虚拟机。', btn('添加虚拟化服务', { sm: true, icon: 'plus', act: 'toast', v: '填写 libvirt 地址，例如 qemu+ssh://gpu-box/system' }))) +
        note('桌面可用、是否允许输入、当前由谁控制，会分别检查。一个桌面同一时间只能由一方控制，可以有多方观看。');
    },
  });
})();
