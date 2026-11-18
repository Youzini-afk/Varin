/* Varin · 设置设计稿 · 项目、编辑器、终端、Git、代码智能 */
(() => {
  const { ic, esc, sw, dd, seg, num, txt, sec, row, link, disc, note, empty, header, chip, btn, roleRef, modelDD, thinkDD, cat, ci, sel, tabs } = K;
  const follow = (k, d = '跟随界面') => seg(k, ['跟随界面', '开', '关'], d);

  page('projects', {
    title: '项目', icon: 'folder', scope: 'project', keywords: '项目 信任 文件夹 工作副本 worktree 启动动作 默认模型 工作侧重 图标 颜色',
    desc: '每个项目的信任、默认设置、文件夹和工作副本。',
    render() {
      const cur = sel('projects', 'launch-site'); const p = DATA.projects.find(x => x.id === cur);
      const items = DATA.projects.map(x => ci('projects', x.id, `<span class="av" style="background:${x.color};color:#fff">${esc(x.name[0].toUpperCase())}</span><span class="grow"><span class="cn">${esc(x.name)}</span><div class="cm trunc">${x.dev && x.dev !== 'studio-pc' ? esc(x.dev) + ' · ' : ''}${esc(x.path)}</div></span>${x.trusted ? '' : `<span class="end" data-tip="还没有信任这个项目">${ic('alert', 'xs')}</span>`}`, { first: 'launch-site' })).join('');
      const [tb, t] = tabs('proj.' + cur, [{ v: 'basic', l: '基本' }, { v: 'folders', l: '文件夹', n: p.folders }, { v: 'actions', l: '启动动作' }, { v: 'trees', l: '工作副本' }]);
      const u = 'pj.' + p.id;
      const body = t === 'basic'
        ? sec('信任', row(p.trusted ? '已信任这个项目' : '还没有信任这个项目', p.trusted ? btn('撤销信任', { sm: true, act: 'toast', v: '撤销后，项目里的技能、MCP 和扩展代码将停止加载' }) : btn('信任', { sm: true, k: 'primary', act: 'toast', v: '确认后加载项目里的设置、技能、MCP 和扩展代码' }), { lead: p.trusted ? 'shield' : 'alert', desc: '信任后，这个项目及其子文件夹里的设置、技能、MCP 服务器和扩展代码才会加载。只信任来源可靠的项目。' })) +
          sec('位置', row('所在工作区', `<span class="hstack"><span class="muted hstack" style="font-size:12.5px;gap:6px">${ic(p.dev === 'gpu-box' ? 'server' : 'monitor', 'sm')}${esc(p.dev || 'studio-pc')}${(p.dev || 'studio-pc') === 'studio-pc' ? ' · 这台设备' : ''}</span>${btn('', { k: 'ghost', sm: true, icon: 'chev', tip: '工作区设置', go: 'workspaces' })}</span>`, { desc: (p.dev || 'studio-pc') === 'studio-pc' ? '文件、命令和 Git 都在这台设备上。' : '文件、命令和 Git 都在 ' + p.dev + ' 上，通过 Varin 服务 studio-pc 连接。项目的默认模型等设置仍保存在 studio-pc 上。' })) +
          sec('外观', row('名称', txt(u + '.name', p.name)) + row('颜色', `<span class="hstack">${['#4b6fac', '#5f8d3d', '#b35017', '#8d6c15', '#7a5bb5', '#6b6b6b'].map(c => `<button data-act="toast" data-v="已更换颜色" style="width:22px;height:22px;border-radius:50%;background:${c};box-shadow:${c === p.color ? '0 0 0 2px var(--canvas),0 0 0 3.5px ' + c : 'none'}"></button>`).join('')}</span>`) + row('图标', `${btn('上传', { sm: true, icon: 'upload', act: 'toast', v: '选择图片' })}${btn('从网站获取', { sm: true, act: 'toast', v: '从项目的网站获取图标' })}`)) +
          sec('这个项目里的对话', row('默认模型', modelDD(u + '.model', '', { none: '跟随全局', w: 'w' }) + thinkDD(u + '.think', '默认')) + row('默认工作侧重', seg(u + '.focus', ['通用', '编程', '科研', '办公'], '编程'), { desc: '新对话开始时采用；之后每个对话各自保留。' }), { desc: '留空时跟随「模型分工」里的全局设置。' })
        : t === 'folders'
          ? sec('', `<div class="orow"><span>${ic('folder', 'sm')}</span><div class="grow"><div class="ot mono">${esc(p.path)}</div><div class="od">主文件夹 · 可读写</div></div></div>` + (p.folders > 1 ? `<div class="orow"><span>${ic('folder', 'sm')}</span><div class="grow"><div class="ot mono">~/work/shared-assets</div><div class="od">只读</div></div><div class="oe">${btn('', { k: 'ghost', sm: true, icon: 'more', tip: '更多', act: 'toast', v: '改为可读写 · 移除' })}</div></div>` : ''), { desc: `Agent 在这个项目里能访问的文件夹，都在 ${p.dev || 'studio-pc'} 的工作区里。`, acts: btn('添加文件夹', { sm: true, icon: 'plus', act: 'toast', v: '选择文件夹，并决定只读还是可读写' }) })
          : t === 'actions'
            ? sec('', [['安装依赖', 'bun install'], ['启动开发服务', 'bun run dev']].map(([n, c]) => `<div class="orow"><span>${ic('play', 'sm')}</span><div class="grow"><div class="ot">${n}</div><div class="od mono">${c}</div></div><div class="oe hov">${btn('', { k: 'ghost', sm: true, icon: 'edit', tip: '编辑', act: 'toast', v: '编辑动作' })}</div></div>`).join(''), { desc: '在项目里一键运行的命令，会出现在项目菜单和命令面板里。', acts: btn('添加', { sm: true, icon: 'plus', act: 'toast', v: '名称和命令' }) })
            : sec('', `<div class="orow"><span>${ic('branch', 'sm')}</span><div class="grow"><div class="ot">feature/hero-copy</div><div class="od">2 个未提交的改动 · 开发服务运行中</div></div><div class="oe">${btn('打开', { sm: true, act: 'toast', v: '在工作台打开' })}${btn('', { k: 'ghost', sm: true, icon: 'trash', tip: '删除', act: 'toast', v: '删除前会先确认未提交的改动和正在运行的进程' })}</div></div>`, { desc: '工作副本让 Agent 在不影响主文件夹的情况下工作。删除前会检查未提交的改动和正在运行的进程。', acts: btn('新建', { sm: true, icon: 'plus', act: 'toast', v: '从分支新建工作副本' }) });
      return cat({ key: 'projects', title: '项目', desc: this.desc, filter: '查找项目', items,
        foot: btn('添加项目', { sm: true, icon: 'plus', act: 'toast', v: '先选在哪个工作区，再选文件夹；没信任过的文件夹会先请你确认' }),
        detail: `<div class="oh2"><span class="avatar" style="background:${p.color};color:#fff;font-weight:600">${esc(p.name[0].toUpperCase())}</span><div class="ttl"><h1>${esc(p.name)}${p.trusted ? chip('已信任', 'ok') : chip('未信任', 'warn')}</h1><div class="sub mono">${p.dev && p.dev !== 'studio-pc' ? esc(p.dev) + ' · ' : ''}${esc(p.path)}</div></div><div class="acts">${btn('', { k: 'ghost', icon: 'more', tip: '更多', act: 'toast', v: '在文件夹中显示 · 从 Varin 移除' })}</div></div>${tb}${body}` });
    },
  });

  page('editor', {
    title: '编辑器', icon: 'code', scope: 'device', keywords: '编辑器 字体 字号 换行 缩略图 行号 缩进 格式化 自动保存 Vim 键位 连字',
    desc: '打开文件时的字体、显示方式和编辑行为。',
    render() {
      return header(this) +
        sec('', `<pre class="mono" style="margin:0;padding:14px 16px;font-size:${K.get('ed.size', 13)}px;line-height:1.7;color:var(--fg)"><span style="color:var(--chart-1)">export function</span> Welcome() {\n  <span style="color:var(--chart-1)">const</span> message = <span style="color:var(--chart-2)">"准备好了"</span>;\n  <span style="color:var(--chart-1)">return</span> &lt;h1&gt;{message}&lt;/h1&gt;;\n}</pre>`, { raw: false }) +
        sec('字体', row('代码字体', dd('ed.font', ['系统等宽', 'JetBrains Mono', 'Cascadia Code', 'Fira Code', '霞鹜文楷等宽'])) + row('字号', num('ed.size', 13, { unit: 'px' })) + row('连字', sw('ed.lig', false), { desc: '把 => 、 != 这类符号显示成连在一起的字形。' })) +
        sec('显示', row('自动换行', follow('ed.wrap')) + row('代码缩略图', follow('ed.mini')) + row('固定当前作用域的标题', follow('ed.sticky')) + row('行号', follow('ed.ln')) +
          row('空白字符', dd('ed.ws', ['不显示', '选中时', '全部'], '选中时', { w: 'ws' })) + row('始终显示编辑器工具栏', sw('ed.toolbar', false), { desc: '固定在文件标签下方。' }) + row('屏幕阅读器支持', dd('ed.sr', ['自动', '开', '关'], '自动', { w: 'ws' })),
        { desc: '「跟随界面」时，工作台和 IDE 各用自己的默认值。' }) +
        sec('缩进', row('从文件识别缩进', sw('ed.detect', true)) + row('缩进宽度', num('ed.tab', 2, { unit: '个空格' }), { desc: '识别不出来时使用。' }) + row('按 Tab 时插入空格', sw('ed.spaces', true))) +
        sec('编辑', row('键位', dd('ed.keys', ['默认', 'Vim', 'Emacs'], '默认', { w: 'ws' })) + row('自动保存', dd('ed.auto', ['关闭', '切换窗口时', '停止输入 1 秒后'], '关闭')) +
          row('自动补全括号和引号', sw('ed.pairs', true)) + row('显示折叠按钮', sw('ed.fold', true)) + row('平滑滚动', sw('ed.smooth', true)) +
          row('输入时格式化', sw('ed.fmtType', false)) + row('保存前格式化', sw('ed.fmtSave', true), { desc: '使用项目里配置的格式化工具；没有就跳过。' }));
    },
  });

  page('terminal', {
    title: '终端', icon: 'term2', scope: 'device', keywords: '终端 Shell PowerShell 字体 字号 编码',
    desc: '你自己打开的终端：字体和命令行。',
    render() {
      return header(this) +
        sec('', `<pre class="mono" style="margin:0;padding:14px 16px;font-size:${K.get('tm.size', 13)}px;line-height:1.6;background:color-mix(in srgb,var(--foreground) 3%,transparent)">$ git status\nOn branch main\nnothing to commit, working tree clean\n$ <span style="background:var(--fg)">&nbsp;</span></pre>`) +
        sec('', row('字体', dd('tm.font', ['和代码字体相同', '系统等宽', 'JetBrains Mono'], '和代码字体相同')) + row('字号', num('tm.size', 13, { unit: 'px' }))) +
        sec('命令行', row('终端使用', `${dd('tm.shell', ['自动 · PowerShell 7', 'Git Bash', '命令提示符', 'WSL · Ubuntu'], '自动 · PowerShell 7')}${btn('', { k: 'ghost', sm: true, icon: 'refresh', tip: '重新检测', act: 'toast', v: '已重新检测' })}`, { desc: '修改后，新建或重启的终端生效。编码沿用命令行自己的设置。' }), { after: note('Agent 运行命令用的命令行在 <span class="linkish" data-go="tools">工具</span> 里单独设置。') }) +
        sec('', link('终端快捷键', 'shortcuts', { desc: '显示或隐藏终端、展开终端等。' }));
    },
  });

  page('git', {
    title: 'Git', icon: 'branch', scope: 'host', keywords: 'Git GitHub 账号 OAuth 身份 SSH 提交 Gitmoji 忽略文件',
    desc: 'GitHub 账号、提交时使用的身份，以及改动列表的显示方式。',
    render() {
      return header(this) +
        sec('GitHub 账号', `<div class="orow"><span class="av" style="width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:#2d72c4;color:#fff;font-size:12px">E</span><div class="grow"><div class="ot">example-user${chip('默认')}</div><div class="od">通过 gh 命令行登录</div></div><div class="oe">${btn('停用', { k: 'ghost', sm: true, act: 'toast', v: '停用后不再用这个账号访问 GitHub' })}</div></div>`, { desc: '用于拉取请求、议题和私有仓库。', acts: btn('添加账号', { sm: true, icon: 'plus', act: 'toast', v: '在浏览器中授权 GitHub' }) }) +
        sec('提交身份', `<div class="orow"><span>${ic('key', 'sm')}</span><div class="grow"><div class="ot">全局身份${chip('系统')}</div><div class="od">Example User · user@example.com · SSH</div></div><div class="oe hov">${btn('', { k: 'ghost', sm: true, icon: 'edit', tip: '编辑', act: 'toast', v: '编辑身份' })}</div></div>`, { desc: '提交时使用的名字、邮箱和密钥。可以为不同项目准备不同身份。', acts: btn('新建', { sm: true, icon: 'plus', act: 'toast', v: '名字、邮箱、SSH 密钥或 HTTPS 凭据' }) }) +
        sec('显示', row('改动列表', seg('git.view', ['平铺', '树形'])) + row('提交时显示 Gitmoji 选择', sw('git.moji', false)) + row('显示被 .gitignore 忽略的文件', sw('git.ignored', false)));
    },
  });

  page('code-intel', {
    title: '代码智能', icon: 'braces', scope: 'hostProject', keywords: '语言 语言服务 LSP tree-sitter 结构 定义 错误检查 代码检索 重排',
    desc: '帮助 Agent 和编辑器理解代码：语言服务和代码检索。',
    render() {
      const langs = [['TypeScript', '结构识别 · 定义跳转 · 错误检查', 'ok', '已就绪'], ['CSS', '结构识别 · 错误检查', 'ok', '已就绪'], ['Rust', '首次使用时准备 · 约 34 MB', '', '未准备']];
      return header(this) +
        sec('这个项目里的语言', langs.map(([n, d, st, s]) => `<div class="orow"><div class="grow"><div class="ot">${n}</div><div class="od">${d}</div></div><div class="oe">${st ? `<span class="dot ok"></span><span class="muted" style="font-size:12.5px">${s}</span>` : btn('现在准备', { sm: true, act: 'toast', v: '开始下载 Rust 语言组件' })}</div></div>`).join(''),
          { desc: '语言服务在需要时启动，较大的组件第一次用到时自动准备。', acts: btn('', { k: 'ghost', sm: true, icon: 'refresh', tip: '重新检测', act: 'toast', v: '重新检测项目里的语言' }) }) +
        sec('代码检索', row('判断检索结果', roleRef('retrieval'), { desc: '查代码时判断哪些结果相关，以及要不要继续找。' }) + row('重排', roleRef('rerank', '不重排'), { desc: '把候选结果按相关程度重新排序。' }),
          { desc: 'Agent 用普通的搜索、读取和终端调查代码，不依赖向量索引或语言服务；这里的模型帮它判断得更快。' });
    },
  });
})();
