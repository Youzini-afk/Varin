/* Varin · 设置设计稿 · 能力：工具、权限、网络与文档、MCP、技能、插件 */
(() => {
  const { ic, esc, sw, dd, seg, num, txt, area, tags, sec, row, link, disc, note, empty, header, chip, btn, roleRef, cat, ci, sel, tabs, cards, unitbar, dock } = K;

  page('tools', {
    title: '工具', icon: 'wrench', scope: 'hostProject', keywords: '工具 命令 网页搜索 文档阅读 学术 资料集 预览 注册工具',
    desc: 'Agent 能用哪些工具、在什么命令行里运行命令，以及工具结果怎样展示。',
    render() {
      const q = (K.get('tools.q', '') || '').trim();
      const total = DATA.toolGroups.reduce((n, [, t]) => n + t.split(' ').length, 0);
      return header(this) +
        sec('可选工具', row('网页搜索', sw('t.search', true), { desc: '按关键词搜索网页，可以一次查多个问题。用哪个搜索服务在「网络与文档」里设置。' }) +
          row('读取网页', sw('t.fetch', true), { desc: '打开网址读取内容，并保留一份快照；需要时重新抓取。' }) +
          row('阅读 PDF', sw('t.pdf', true), { desc: '搜索文字、查看指定页面和选区，必要时分析版面结构。' }) +
          row('学术搜索', sw('t.paper', true), { desc: '在 OpenAlex 和 Semantic Scholar 上找论文，查看引用关系。' }) +
          row('资料集', sw('t.materials', true), { desc: '把网页、快照和论文收进有名字的集合，之后在集合里检索；不同对话可以共用。' }), { desc: '关闭后，Agent 在新的请求里就拿不到这个工具。' }) +
        sec('命令行', link('运行命令使用的命令行', 'workspaces', { desc: '每个工作区单独设置：这台电脑用 Git Bash，Linux 设备用 bash，等等。', end: '自动 · Git Bash' })) +
        sec('结果展示', row('长结果只预览', num('t.preview', 24, { unit: 'KiB' }), { desc: '超过这个大小的结果只显示开头和结尾，Agent 需要时会继续读全文。指定范围的读取不受影响。' })) +
        sec(`全部工具（${total}）`, `<div style="padding:12px 16px 4px">${K.txt('tools.q', '', { ph: '按名称查找，例如 file_read', w: 'wfull' })}</div>` +
          DATA.toolGroups.map(([g, ts]) => { const list = ts.split(' ').filter(t => !q || t.includes(q)); return list.length ? disc(g, `<div class="toolgrid">${list.map(t => `<span class="tool" data-act="toast" data-v="${t}：查看参数和说明">${t}</span>`).join('')}</div>`, { sum: list.length + ' 个', open: !!q }) : ''; }).join('') +
          link('为某个 Agent 挑选工具', 'agents', { lead: 'users' }) + link('哪些工具需要先问你', 'permissions', { lead: 'shield' }),
        { desc: '这里列出 Varin 实际提供给模型的工具，点开可以看参数和说明。' });
    },
  });

  page('permissions', {
    title: '权限', icon: 'shield', scope: 'hostProject', keywords: '权限 确认 审批 规则 策略 允许 拒绝 MCP 扩展',
    desc: 'Agent 调用工具之前，什么时候需要先问你。',
    render() {
      const rules = K.get('perm.rules', [['允许', 'mcp · github / 读取类工具', '全部参数'], ['询问', 'mcp · github / create_pull_request', '全部参数'], ['拒绝', '扩展 · 文件同步 / delete_remote', '全部参数']]);
      const kind = { 允许: 'ok', 询问: '', 拒绝: 'err' };
      const mode = K.get('perm.mode', 'normal');
      return header(this) +
        sec('确认方式', cards('perm.mode', [
          { v: 'normal', l: '先问我', icon: 'help', d: '没有匹配规则的工具，先问你再执行。' },
          { v: 'smart', l: '智能判断', icon: 'scale', d: '由权限判断模型看这一次调用：常规操作直接执行，有风险或拿不准的再问你。' },
          { v: 'skip', l: '直接执行', icon: 'zap', d: '普通工具直接执行。修改权限、把凭据发到新的地方，仍然会问你。' },
        ], 'normal', { n: 3, re: true }), { raw: true, after: (mode === 'smart' ? `<div class="panel" style="margin-top:10px">${row('权限判断模型', roleRef('permJudge'), { desc: '选快一些的模型，判断不会明显拖慢工作。模型不可用时按「先问我」处理。' })}</div>` : '') + note('规则总是先于确认方式生效。这里管的是扩展和 MCP 提供的工具；读写文件、运行命令由项目的文件夹授权决定，在 <span class="linkish" data-go="projects">项目</span> 里管理。') }) +
        sec('规则', rules.map(([a, p, s]) => `<div class="rule"><span class="grip">${ic('grip', 'sm')}</span><span>${chip(a, kind[a])}</span><span class="vstack"><span class="trunc">${esc(p)}</span><span class="faint" style="font-size:12px">${s}</span></span><span class="hstack">${btn('', { k: 'ghost', sm: true, icon: 'edit', tip: '编辑', act: 'toast', v: '编辑规则' })}${btn('', { k: 'ghost', sm: true, icon: 'trash', tip: '删除', act: 'perm-del' })}</span></div>`).join('') + unitbar('perm', { save: '保存规则', msg: '规则顺序或内容有修改' }),
        { desc: '从上到下匹配，命中第一条就生效；拖动可以调整顺序。在对话里选「一直允许」时，也会加到这里。项目里的约束优先。', acts: btn('添加规则', { sm: true, icon: 'plus', act: 'toast', v: '选择工具、动作（允许 / 询问 / 拒绝）和适用参数' }) });
    },
  });
  ACTS['perm-del'] = el => { const rules = [...K.get('perm.rules', [['允许', 'mcp · github / 读取类工具', '全部参数'], ['询问', 'mcp · github / create_pull_request', '全部参数'], ['拒绝', '扩展 · 文件同步 / delete_remote', '全部参数']])]; const i = [...el.closest('.panel').querySelectorAll('.rule')].indexOf(el.closest('.rule')); rules.splice(i, 1); K.set('perm.rules', rules); S.unit.perm = 'dirty'; App.render(); };

  page('web', {
    title: '网络与文档', icon: 'globe', scope: 'hostProject', keywords: '网页搜索 Exa Parallel Brave Tavily Jina SearXNG 域名 网站 OCR Docling Tesseract 渲染 来源',
    desc: '网页搜索用哪些服务、Agent 能访问哪些网站，以及怎样读取扫描件。',
    render() {
      const svc = [['Exa', '免费 · 默认使用', 'ok'], ['Parallel', '免费 · Exa 不可用时使用', 'ok']];
      return header(this) +
        sec('网页搜索', row('允许网页搜索', sw('web.on', true)) +
          svc.map(([n, d], i) => `<div class="orow"><span class="lead" style="width:28px;height:28px;border-radius:8px;display:grid;place-items:center;background:color-mix(in srgb,var(--foreground) 5%,transparent)">${ic('search', 'sm')}</span><div class="grow"><div class="ot">${n}${i === 0 ? chip('默认') : ''}</div><div class="od">${d}</div></div><div class="oe"><span class="dot ok"></span>${btn('', { k: 'ghost', sm: true, icon: 'more', tip: '更多', act: 'toast', v: '设为默认 · 测试 · 移除' })}</div></div>`).join('') +
          `<div class="orow click" data-act="toast" data-v="可添加 Brave、Tavily、Jina、SearXNG、AnySearch，需要各自的密钥或地址"><span style="color:var(--primary)">${ic('plus', 'sm')}</span><div class="grow ot" style="color:var(--primary)">添加搜索服务</div></div>`,
        { desc: '免费服务有用量限制。不会使用模型账号自带的搜索功能。' }) +
        sec('智能辅助', row('有多个搜索服务时自动挑选', sw('web.pick', true)) + row('挑选搜索服务的模型', roleRef('searchPick'), { sub: true }) +
          row('读网页时按问题挑出相关段落', sw('web.read', true)) + row('挑选段落的模型', roleRef('readPick'), { sub: true }),
        { desc: '辅助失败时，照常搜索和整页阅读。' }) +
        sec('动态网页', row('需要时用浏览器打开网页', sw('web.render', true), { tag: '<span class="chip" style="height:18px;font-size:11px">桌面版</span>', desc: '在后台用浏览器加载页面，能读到脚本生成的内容。连接远程服务时不可用。' })) +
        sec('扫描件与复杂排版', row('Docling 程序', txt('web.docling', 'docling', { mono: true }), { desc: '填写程序名或完整路径，不支持拼接命令。' }) +
          row('Tesseract 程序', txt('web.tess', 'tesseract', { mono: true })) +
          row('识别语言', tags('web.ocr', ['eng', 'chi_sim']), { stack: true }),
        { desc: '普通 PDF 的文字和页面截图默认就能读。扫描件和复杂版面需要在 Varin 服务上安装 Docling 和 Tesseract。' }) +
        sec('来源偏好', row('优先这些网站', tags('web.prefer', ['developer.mozilla.org', 'arxiv.org']), { stack: true }) +
          row('默认排除这些网站', tags('web.exclude', ['content-farm.example']), { stack: true }), { desc: '新搜索的默认偏好，单次搜索可以另外指定。' }) +
        sec('网站访问限制', row('只允许访问列出的网站', sw('web.allowOnly', false, { re: true }), { desc: K.get('web.allowOnly', false) ? '只能访问下面列出的网站及其子域名；列表为空时不能访问任何网站。' : '开启后，Agent 只能访问你列出的网站。' }) +
          (K.get('web.allowOnly', false) ? row('允许的网站', tags('web.allow', []), { stack: true }) : '') +
          row('始终阻止', tags('web.block', ['internal.corp.example']), { stack: true }), { desc: '搜索和读取网页共用这套规则。项目只能在此基础上进一步收紧。' });
    },
  });

  /* MCP：和技能一样用目录。左边按配置来源分组，右边是一台服务器的连接、登录和工具 */
  const MCP = [
    { id: 'github', tr: 'http', src: '全局', st: 'ok', s: '已连接', tools: 18, url: 'https://api.githubcopilot.com/mcp/', auth: 'in', desc: '仓库、Issue 和 Pull Request。', list: ['search_repositories', 'get_file_contents', 'list_issues', 'create_issue', 'create_pull_request', 'merge_pull_request'] },
    { id: 'figma', tr: 'http', src: '全局', st: 'warn', s: '需要登录', tools: 0, cached: 12, url: 'https://mcp.figma.com/mcp', auth: 'need', desc: '', list: ['get_design_context', 'get_screenshot', 'get_variable_defs'] },
    { id: 'local-db', tr: 'cmd', src: '全局', st: 'off', s: '已停用', tools: 0, cached: 6, cmd: 'uvx', args: ['mcp-sqlite', '--db', 'data.db'], desc: '本地 SQLite 数据库。', list: ['read_query', 'write_query', 'list_tables'] },
    { id: 'playwright', tr: 'cmd', src: '项目 · launch-site', st: 'ok', s: '已连接', tools: 21, cmd: 'npx', args: ['@playwright/mcp@latest'], desc: '', list: ['browser_navigate', 'browser_click', 'browser_snapshot', 'browser_take_screenshot'] },
  ];
  const TR = { http: 'HTTP', cmd: '本地命令', sock: '本地套接字' };
  const EXPOSE = [{ v: 'codemode', l: '写成脚本调用（默认）', d: 'Agent 用一小段脚本组合调用，省上下文' }, { v: 'deferred', l: '搜索到时再加载', d: '先只给名字，需要时再加载说明' }, { v: 'direct', l: '直接提供给模型', d: '每次请求都带上全部说明' }, { v: 'catalog', l: '放进独立能力目录', d: '和插件能力放在一起，按需查找' }, { v: 'hidden', l: '隐藏', d: '不提供给 Agent' }];
  const mcpLine = m => m.st === 'ok' ? `${m.s} · ${m.tools} 个工具` : m.s;
  page('mcp', {
    title: 'MCP', icon: 'plug', scope: 'hostProject', keywords: 'MCP 服务器 OAuth 登录 工具 mcp.json codemode 传输 命令 请求头 环境变量',
    desc: '通过 MCP 接入的外部工具服务。',
    render() {
      const cur = sel('mcp', 'github');
      const groups = [...new Set(MCP.map(m => m.src))];
      const items = ci('mcp', '__cfg', `<span class="av">${ic('file', 'sm')}</span><span class="grow"><span class="cn">配置文件</span><div class="cm">全局和项目的 mcp.json</div></span>`, { first: 'github', pinned: true }) +
        groups.map(g => `<div class="cg"><span>${esc(g)}</span></div>` + MCP.filter(m => m.src === g).map(m => ci('mcp', m.id, `<span class="av">${m.id[0].toUpperCase()}</span><span class="grow"><span class="cn">${esc(m.id)}</span><div class="cm hstack" style="gap:5px"><span class="dot ${m.st}"></span>${esc(mcpLine(m))}</div></span>`, { first: 'github' })).join('')).join('');
      return cat({ key: 'mcp', title: 'MCP', desc: this.desc, scope: 'hostProject', filter: '查找服务器', items,
        headActs: btn('', { k: 'ghost', sm: true, icon: 'plus', tip: '添加服务器', act: 'toast', v: '粘贴一段 JSON 配置，或填写地址 / 命令；选择保存到全局还是项目' }),
        detail: cur === '__cfg' ? mcpConfig() : mcpServer(MCP.find(m => m.id === cur)) });
    },
  });
  function mcpServer(m) {
    const u = 'mcp.' + m.id; const tr = K.get(u + '.tr', m.tr); const on = K.get(u + '.on', m.st !== 'off');
    const st = !on ? 'off' : m.st; const proj = m.src.startsWith('项目');
    const action = !on ? '' : st === 'warn' ? btn('登录', { k: 'primary', sm: true, act: 'toast', v: `在浏览器中完成 ${m.id} 的授权` }) : `${btn('重新连接', { sm: true, icon: 'refresh', act: 'toast', v: '已重新连接 ' + m.id })}${btn('断开此视图', { k: 'ghost', sm: true, act: 'toast', v: '只释放这个视图的连接，其他运行可能仍在使用' })}`;
    const conn = tr === 'http'
      ? row('服务器地址', txt(u + '.url', m.url, { w: 'wl', mono: true, unit: u })) + row('请求头', `<span class="hstack">${txt(u + '.hk', '', { ph: '名称', w: 'ws', unit: u })}${txt(u + '.hv', '', { ph: '值', unit: u })}${btn('', { k: 'ghost', sm: true, icon: 'plus', tip: '添加请求头', act: 'toast', v: '再加一行' })}</span>`, { desc: '例如 Authorization。值不会显示在日志里。' })
      : tr === 'cmd'
        ? row('命令', txt(u + '.cmd', m.cmd || '', { mono: true, unit: u })) + row('参数', tags(u + '.args', m.args || []), { stack: true }) + row('工作目录', txt(u + '.cwd', '', { ph: proj ? '项目根目录' : '~', mono: true, unit: u })) + row('环境变量', `<span class="hstack">${txt(u + '.ek', '', { ph: '名称', w: 'ws', unit: u })}${txt(u + '.ev', '', { ph: '值', unit: u })}${btn('', { k: 'ghost', sm: true, icon: 'plus', tip: '添加环境变量', act: 'toast', v: '再加一行' })}</span>`)
        : row('套接字路径', txt(u + '.sock', '', { ph: '/tmp/mcp.sock', w: 'wl', mono: true, unit: u }));
    return `<div class="oh2"><span class="avatar">${m.id[0].toUpperCase()}</span><div class="ttl"><h1>${esc(m.id)}${chip(TR[tr])}</h1><div class="sub">${chip(m.src, '', proj ? 'folder' : 'globe')}<span class="hstack" style="gap:5px"><span class="dot ${st}"></span>${on ? esc(mcpLine(m)) : '已停用'}</span></div></div><div class="acts">${sw(u + '.on', m.st !== 'off', { re: true, label: '启用' })}${btn('', { k: 'ghost', icon: 'more', tip: '更多', act: 'toast', v: '查看日志 · 复制配置 · 删除' })}</div></div>` +
      (action ? sec('', row('连接', `<span class="hstack">${action}</span>`, { desc: st === 'warn' ? '登录后才能使用它的工具。尝试登录时会先检查服务器是否支持 OAuth。' : `缓存 ${m.cached || m.tools} 个工具 · 在线 ${m.tools} 个。` })) : '') +
      sec('连接方式', row('传输方式', seg(u + '.tr', [{ v: 'http', l: 'HTTP' }, { v: 'cmd', l: '本地命令' }, { v: 'sock', l: '本地套接字' }], m.tr, { re: true }), { desc: '换传输方式会去掉不适用的字段。' }) + conn +
        row('请求超时', num(u + '.timeout', 60, { unit: '秒', unit2: u })) +
        K.unitbar(u, { verify: true, save: '测试并保存', busy: '正在连接…', ok: '已连接并保存', msg: '连接方式有修改，测试通过后保存' }),
      { desc: proj ? '保存在项目的 .varin/mcp.json，只覆盖这台服务器的设置。' : '保存在全局 mcp.json。本地命令在 Varin 服务上运行。' }) +
      (tr === 'http' ? sec('登录', row('账号', m.auth === 'in' ? `<span class="hstack"><span class="muted hstack" style="font-size:12.5px;gap:4px">${ic('check', 'xs')} 已登录</span>${btn('退出登录', { k: 'ghost', sm: true, act: 'toast', v: '已退出登录' })}</span>` : m.auth === 'need' ? '<span class="muted" style="font-size:12.5px">未登录</span>' : btn('尝试登录', { sm: true, act: 'toast', v: '检查服务器是否支持 OAuth；支持就打开登录页面' }), { desc: '服务器支持 OAuth 时使用。' }) +
        (proj ? '' : row('使用模型服务的凭据', dd(u + '.authp', ['不使用', 'GitHub Copilot', 'OpenAI'], '不使用'), { desc: '让这台服务器使用「模型服务」里已经登录的账号。只能在全局配置里设置。' }))) : '') +
      sec(`工具（${m.list.length}）`, row('提供给 Agent 的方式', dd(u + '.expose', EXPOSE, 'codemode', { w: 'wl' })) +
        m.list.map(t => `<div class="orow" data-item="${esc(t)}"><div class="grow"><div class="ot mono" style="font-size:12.5px">${esc(t)}</div></div><div class="oe">${dd(u + '.t.' + t, [{ v: '', l: '跟随上面' }, ...EXPOSE], '', { w: 'ws', plain: true })}</div></div>`).join(''),
      { desc: '单个工具可以另外指定，例如把会写数据的工具隐藏。是否需要先问你，在「权限」里设置。' }) +
      sec('说明', row('服务描述', txt(u + '.desc', m.desc, { ph: '例如：公司内部的工单系统', w: 'wl' }), { desc: 'Agent 会看到这段描述，用来判断什么时候用这台服务器。' }), proj ? { after: note('项目里的 MCP 配置，只有在项目受信任后才会加载。') } : {});
  }
  function mcpConfig() {
    return `<div class="oh2"><span class="avatar">${ic('file')}</span><div class="ttl"><h1>配置文件</h1><div class="sub">界面里的修改都写回这些文件；直接改文件后点「重新加载」。</div></div></div>` +
      sec('来源', row('全局', `${btn('打开', { sm: true, act: 'toast', v: '在编辑器中打开 mcp.json' })}${btn('重新加载', { sm: true, icon: 'refresh', act: 'toast', v: '已重新加载' })}`, { desc: '<span class="mono">~/.varin/mcp.json</span> · 3 台服务器' }) +
        row('项目 · launch-site', `${btn('打开', { sm: true, act: 'toast', v: '在编辑器中打开 .varin/mcp.json' })}${btn('重新加载', { sm: true, icon: 'refresh', act: 'toast', v: '已重新加载' })}`, { desc: '<span class="mono">.varin/mcp.json</span> · 1 台服务器 · 项目已受信任' }) +
        row('项目 · varin-docs', chip('未信任'), { desc: '信任这个项目后才会读取它的 MCP 配置。', dim: true })) +
      sec('默认', row('MCP 工具默认写成脚本调用', sw('mcp.codemode', true), { desc: 'Agent 用一小段脚本组合调用多个工具，比逐个声明更省上下文。单台服务器可以另外指定。' })) +
      sec('', disc('查看合并后的配置', `<div style="padding:0 16px 14px"><textarea class="area mono" rows="8" readonly>{\n  "github": { "url": "https://api.githubcopilot.com/mcp/" },\n  "figma": { "url": "https://mcp.figma.com/mcp" },\n  "local-db": { "command": "uvx", "args": ["mcp-sqlite", "--db", "data.db"], "enabled": false },\n  "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }\n}</textarea></div>`));
  }

  page('skills', {
    title: '技能', icon: 'sparkle', scope: 'hostProject', keywords: '技能 skill SKILL.md 命令 slash 斜杠',
    desc: '技能是写给 Agent 的操作说明，也可以用 /skill:名称 直接调用。',
    render() {
      const cur = sel('skills', 'release-notes');
      const groups = [...new Set(DATA.skills.map(s => s.src.split(' · ')[0]))];
      const items = ci('skills', '__cmds', `<span class="av">${ic('slash', 'sm')}</span><span class="grow"><span class="cn">全部命令</span><div class="cm">${DATA.skills.filter(s => s.on).length + 3} 条可用</div></span>`, { first: 'release-notes', pinned: true }) +
        groups.map(g => `<div class="cg"><span>${g}</span></div>` + DATA.skills.filter(s => s.src.startsWith(g)).map(s => ci('skills', s.id, `<span class="grow"><span class="cn">${esc(s.name)}</span><div class="cm trunc">${esc(s.desc)}</div></span>${s.on ? '' : '<span class="end">已停用</span>'}`, { first: 'release-notes' })).join('')).join('');
      return cat({ key: 'skills', title: '技能', desc: this.desc, scope: 'hostProject', filter: '查找技能', items,
        headActs: btn('', { k: 'ghost', sm: true, icon: 'plus', tip: '新建技能', act: 'toast', v: '新建技能：选择保存位置（用户 / 项目）' }),
        detail: cur === '__cmds' ? commands() : skill(DATA.skills.find(s => s.id === cur)),
        dock: cur === '__cmds' ? '' : dock('skill', { save: '保存', msg: 'SKILL.md 有未保存的修改' }) });
    },
  });
  function skill(s) {
    return `<div class="oh2"><span class="avatar">${ic('sparkle')}</span><div class="ttl"><h1>${esc(s.name)}</h1><div class="sub">${chip(s.src)}<span class="mono">/skill:${esc(s.name)}</span></div></div><div class="acts">${sw('sk.' + s.id, s.on, { label: '启用' })}${btn('', { k: 'ghost', icon: 'more', tip: '更多', act: 'toast', v: '在文件夹中显示 · 复制 · 删除' })}</div></div>` +
      `<div class="doc"><div class="bar">${ic('file', 'sm')}SKILL.md<span class="grow"></span><span class="faint">Ctrl S 保存</span></div>${area('sk.body.' + s.id, `---\nname: ${s.name}\ndescription: ${s.desc}\n---\n\n# ${s.name}\n\n## 什么时候使用\n…\n\n## 步骤\n1. …\n`, { rows: 16, mono: true, unit: 'skill' })}</div>` +
      sec('来源', row('文件位置', `<span class="mono muted" style="font-size:12px">~/.agents/skills/${esc(s.name)}/SKILL.md</span>`) + row('生效范围', `<span class="muted" style="font-size:12.5px">${s.src.startsWith('项目') ? '只在这个项目里' : '所有对话'}</span>`), { after: note('修改技能后，正在进行的对话需要刷新上下文才会看到。') });
  }
  function commands() {
    const cmds = [...DATA.skills.filter(s => s.on).map(s => ['/skill:' + s.name, s.desc, '技能']), ['/compact', '立即整理当前对话的上下文', '内置'], ['/review', '审阅当前的改动', '内置'], ['/export', '把对话导出为 Markdown', '插件 · 导出工具']];
    return `<div class="oh2"><span class="avatar">${ic('slash')}</span><div class="ttl"><h1>全部命令</h1><div class="sub">在输入框里输入 / 就能看到这些命令。</div></div><div class="acts">${btn('刷新', { k: 'ghost', sm: true, icon: 'refresh', act: 'toast', v: '已刷新命令列表' })}</div></div>` +
      sec('', cmds.map(([c, d, src]) => `<div class="orow"><div class="grow"><div class="ot mono">${esc(c)}</div><div class="od">${esc(d)}</div></div><div class="oe">${chip(src)}</div></div>`).join(''), { desc: '技能命令随技能启停；插件命令在「插件」里管理。' });
  }

  page('plugins', {
    title: '插件', icon: 'blocks', scope: 'host', keywords: '插件 扩展 安装 目录 市场 Varin Extensions',
    desc: '为 Varin 增加新的界面、工具和命令。',
    render() {
      const [tb, t] = tabs('plugins', [{ v: 'find', l: '发现' }, { v: 'mine', l: '已安装', n: 3 }]);
      const find = [['导出工具', '把对话导出为 Markdown、PDF 或网页。', '工具'], ['数据工具', '表格清洗、透视和图表技能。', '技能'], ['日程同步', '把定时任务同步到系统日历。', '集成'], ['主题包 · 雾', '一组低对比度的浅色和深色主题。', '外观']];
      return header(this, { acts: btn('从链接安装', { sm: true, icon: 'link', act: 'toast', v: '粘贴插件链接或选择本地文件夹' }) }) + tb +
        (t === 'find'
          ? `<div class="hstack" style="margin:-6px 0 16px">${seg('pl.cat', ['全部', '工具', '技能', '集成', '外观'])}<span class="grow"></span><span class="faint" style="font-size:12px">目录更新于 11 月 7 日</span>${btn('', { k: 'ghost', sm: true, icon: 'refresh', tip: '刷新目录', act: 'toast', v: '已刷新' })}</div><div class="pgrid">${find.map(([n, d, c]) => `<div class="pcard"><span class="pi">${ic('blocks')}</span><div class="grow"><b>${n}</b><p>${d}</p><div class="hstack">${btn('安装', { sm: true, act: 'toast', v: '安装前会列出它需要的权限' })}<span class="cap">${c}</span></div></div></div>`).join('')}</div>`
          : sec('', [['导出工具', '1.2.0 · 提供 1 条命令', true], ['示例扩展', '0.1.0 · 本地开发', false], ['计划优先', '0.3.1 · 提供 1 种执行循环', true]].map(([n, d, on]) => `<div class="orow"><span class="pi" style="width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:color-mix(in srgb,var(--foreground) 6%,transparent);color:var(--muted)">${ic('blocks', 'sm')}</span><div class="grow"><div class="ot">${n}</div><div class="od">${d}</div></div><div class="oe">${sw('pl.' + n, on, { label: '启用 ' + n })}${btn('', { k: 'ghost', sm: true, icon: 'more', tip: '更多', act: 'toast', v: '查看权限 · 更新 · 卸载' })}</div></div>`).join('')) +
            sec('执行循环', row('Agent 的执行循环', dd('pl.loop', [{ v: 'default', l: '默认', d: 'Varin 内置' }, { v: 'plan-first', l: '计划优先', d: '插件「计划优先」· 先拟计划再动手' }], 'default', { re: true, w: 'wl' }), { desc: '执行循环决定 Agent 怎样一步步推进工作。只对新开始的工作生效；安装插件不会自动换上。' }) +
              (K.get('pl.loop', 'default') !== 'default' ? row('规划模型', roleRef('plan', '不单独规划'), { sub: true, desc: '这个执行循环要求先单独规划。没指定模型时不规划，也不会改用默认模型。' }) : ''),
            { after: `<div style="margin-top:14px">${btn('内置扩展与高级管理', { k: 'ghost', sm: true, act: 'toast', v: '查看 Varin 内置扩展及其能力，单独启停' })}</div>` }));
    },
  });
})();
