/* Varin · 设置设计稿 · Varin（Bot）、Agents、外部 Agent */
(() => {
  const { ic, esc, sw, dd, seg, num, txt, area, sec, row, link, disc, note, empty, header, chip, btn, logo, unitbar, modelDD, thinkDD, roleRef, cat, ci, sel, tabs } = K;
  const botAv = (b, big) => b.main ? `<span class="${big ? 'avatar' : 'av'}" style="padding:${big ? 9 : 5}px;color:var(--fg)">${MARK}</span>` : `<span class="${big ? 'avatar' : 'av'}">${DATA.blob(b.id === 'scholar' ? '#7aa0d6' : '#e3b58a', big ? 26 : 18)}</span>`;

  page('varin', {
    title: 'Varin', icon: 'bot', scope: 'host', keywords: 'Bot 助手 形象 人设 指令 分组 入口',
    desc: '长期陪你工作的助手：身份、指令，以及它在跟进的事。',
    render() {
      const cur = sel('varin', 'varin'); const b = DATA.bots.find(x => x.id === cur);
      const groups = [...new Set(DATA.bots.map(x => x.group))];
      const items = groups.map(g => (g ? `<div class="cg"><span>${esc(g)}</span></div>` : '') + DATA.bots.filter(x => x.group === g).map(x => ci('varin', x.id, `${botAv(x)}<span class="grow"><span class="cn">${esc(x.name)}</span><div class="cm">${esc(x.state)}</div></span>`, { first: 'varin' })).join('')).join('');
      const [tb, t] = tabs('varin.' + cur, [{ v: 'profile', l: '档案' }, { v: 'work', l: '在跟进的事', n: b.main ? 2 : 0 }, { v: 'memory', l: '记忆' }]);
      const u = 'bot.' + b.id;
      const body = t === 'profile'
        ? sec('', row('形象', `${btn('更换形象', { sm: true, act: 'toast', v: '打开形象库：内置形象、自定义图片，可单独配色' })}`, { desc: b.main ? 'Varin 默认形象 · 跟随主题配色' : '团子 · 自动分配' }) +
            row('名称', txt(u + '.name', b.name)) +
            row('分组', dd(u + '.group', [{ v: '', l: '不分组' }, ...['工作', '生活'].map(v => ({ v, l: v })), { sep: 1 }, { v: '+', l: '新建分组…' }], b.group, { w: 'ws' }))) +
          sec('指令', area(u + '.prompt', b.main ? '' : '你是一名耐心的研究助理，回答时给出处。', { rows: 7, ph: '例如：你是我的长期助手。说话直接，先给结论；涉及花钱或对外发送的事先问我。', unit: u }) + unitbar(u, { save: '保存指令' }), { raw: true, desc: '这个 Bot 每一轮都会看到的人设和要求。保存后从下一轮开始生效。' }) +
          sec('模型', row('交流和执行使用', modelDD(u + '.model', 'claude-sonnet-5-5', { w: 'w' }) + thinkDD(u + '.think', '高'), { desc: '这个 Bot 优先使用的模型。对话里仍然可以临时切换。' }))
        : t === 'work'
          ? (b.main ? sec('正在跟进', ['发布页面|完善简介与配图顺序', '用户反馈整理|整理反馈与反复出现的问题'].map(s => { const [n, d] = s.split('|'); return `<div class="orow click" data-act="toast" data-v="在 Varin 里打开这项工作"><span class="spin"></span><div class="grow"><div class="ot">${n}</div><div class="od">${d}</div></div><div class="oe">${chip('进行中')}${ic('chev', 'sm faint')}</div></div>`; }).join('')) + sec('最近完成', `<div class="orow"><span style="color:var(--ok)">${ic('check', 'sm')}</span><div class="grow"><div class="ot">整理 0.9.50 版本说明</div><div class="od">昨天 18:20</div></div></div>`) : empty('inbox', '现在没有在跟进的事', '交给它一件事后，会出现在这里。'))
          : sec('', link('它记住的事', 'memory', { desc: `${b.name} 记住了 23 件事。可以在「记忆」里查看、修改或让它忘记。`, end: '23 条' }) + row('从对话中自动记住', sw(u + '.autoMem', true), { desc: '关闭后只在你明确要求时才记住。' }));
      return cat({ key: 'varin', title: 'Varin', desc: '你的长期助手。通常一个就够用。', scope: 'host', items,
        headActs: btn('', { k: 'ghost', sm: true, icon: 'plus', tip: '新建 Bot 或分组', act: 'toast', v: '新建 Bot · 新建分组' }),
        detail: `<div class="oh2">${botAv(b, true)}<div class="ttl"><h1>${esc(b.name)}${b.main ? chip('默认') : ''}</h1><div class="sub">${esc(b.state)}</div></div><div class="acts">${btn('打开对话', { sm: true, icon: 'chat', act: 'toast', v: '回到与 ' + b.name + ' 的对话' })}${btn('', { k: 'ghost', icon: 'more', tip: '更多', act: 'toast', v: '移动到分组 · 复制 · 删除' })}</div></div>${tb}${body}` });
    },
  });

  page('agents', {
    title: 'Agents', icon: 'users', scope: 'host', keywords: '智能体 预设 派发 子 Agent 工具 工作指令 头像 工作侧重 Worker 验证 调研',
    desc: '派发任务时可以调用的 Agent。',
    render() {
      const cur = sel('agents', 'worker');
      const all = K.get('ag.allFocus', '编程');
      const list = DATA.agents.filter(a => all === '全部' || a.focus.includes('编程'));
      const item = a => ci('agents', a.id, `<span class="av" style="background:none">${DATA.blob(a.color, 24)}</span><span class="grow"><span class="cn">${esc(a.name)}</span><div class="cm">${a.auto ? '自动运行' : a.model ? esc(a.model) : '跟随派发者的模型'}</div></span>`, { first: 'worker' });
      const items = ci('agents', '__dispatch', `<span class="av">${ic('route', 'sm')}</span><span class="grow"><span class="cn">派发时自动选模型</span><div class="cm">${K.get('ag.dispatch', true) ? '已开启' : '未开启'}</div></span>`, { first: 'worker', pinned: true }) +
        `<div style="padding:8px 10px 2px">${seg('ag.allFocus', [{ v: '编程', l: '当前侧重：编程' }, { v: '全部', l: '全部' }], '编程', { re: true })}</div>` +
        `<div class="cg"><span>内置</span></div>${list.filter(a => a.builtin).map(item).join('')}<div class="cg"><span>自定义</span></div>${list.filter(a => !a.builtin).map(item).join('') || '<div class="faint" style="padding:6px 10px;font-size:12px">当前侧重下没有自定义 Agent</div>'}`;
      return cat({ key: 'agents', title: 'Agents', desc: this.desc, scope: 'host', filter: '按名称、职责或模型查找', items,
        foot: btn('新建 Agent', { sm: true, icon: 'plus', act: 'toast', v: '从空白开始，或复制一个内置 Agent' }),
        detail: cur === '__dispatch' ? dispatch() : agent(DATA.agents.find(a => a.id === cur)) });
    },
  });
  function dispatch() {
    return `<div class="oh2"><span class="avatar">${ic('route')}</span><div class="ttl"><h1>派发时自动选模型</h1><div class="sub">派发任务时，按任务内容和各模型的简介挑一个合适的模型。</div></div></div>` +
      sec('', row('自动选模型', sw('ag.dispatch', true, { re: true }), { desc: '关闭时使用 Agent 自己设置的模型；没设置就跟随派发者。' }) +
        row('负责挑选的模型', roleRef('dispatch'), { desc: '只在你启用的对话模型里挑。' }) +
        link('写好模型简介', 'models', { desc: '简介越准确，挑选越准。在「模型服务」里点开模型即可编辑。' }));
  }
  function agent(a) {
    const u = 'ag.' + a.id;
    const tmode = K.get(u + '.tools', '默认');
    return `<div class="oh2"><span class="avatar" style="background:none;box-shadow:none">${DATA.blob(a.color, 40)}</span><div class="ttl"><h1>${esc(a.name)}${a.builtin ? chip('内置') : ''}</h1><div class="sub">${esc(a.desc)}</div></div><div class="acts">${sw(u + '.on', true, { label: '启用' })}${btn('', { k: 'ghost', icon: 'more', tip: '更多', act: 'toast', v: a.builtin ? '复制为自定义 Agent · 恢复默认' : '复制 · 删除' })}</div></div>` +
      sec('身份', row('名称', txt(u + '.name', a.name)) + row('职责简介', txt(u + '.desc', a.desc, { w: 'wl' }), { desc: '派发任务的一方会看到这段简介，用它判断该找谁。' }) + row('头像', btn('自动分配', { sm: true, act: 'toast', v: '从头像库挑选，或保持自动分配' }))) +
      sec('执行', row('由谁执行', dd(u + '.exec', [{ v: 'varin', l: 'Varin', logo: '@' }, { sep: 1 }, ...DATA.externalAgents.filter(x => x.on).map(x => ({ v: x.id, l: x.name, logo: x.logo }))], 'varin', { w: 'w' }), { desc: '选外部 Agent 时，模型和工具沿用它自己的配置。' }) +
        row('模型', modelDD(u + '.model', a.model, { none: '跟随派发者', w: 'w' }) + thinkDD(u + '.think', a.think)) +
        disc('高级', row('Temperature', num(u + '.temp', '', { ph: '默认' }), { desc: '留空时使用服务商的默认值。' }))) +
      sec('工作指令', area(u + '.prompt', a.builtin ? '拿到任务后先确认目标和验收方式；完成后汇报结果、证据和没解决的问题。' : '', { rows: 5, unit: u }) + unitbar(u, { save: '保存指令' }), { raw: true, desc: '每次派给它的任务都会带上这段指令。' }) +
      sec('工具', row('可以使用', seg(u + '.tools', ['默认', '自定义', '不使用'], '默认', { re: true }), { desc: tmode === '默认' ? '使用运行时的默认工具，Varin 更新后自动包含新工具。' : tmode === '不使用' ? '只能对话，不能读写文件或运行命令。' : '点选下面的工具。划掉的不会提供给这个 Agent。' }) +
        (tmode === '自定义' ? DATA.toolGroups.slice(0, 7).map(([g, ts]) => `<div style="padding:10px 16px 0;font-size:12px;color:var(--muted)">${g}</div><div class="toolgrid">${ts.split(' ').slice(0, 12).map((t, i) => `<span class="tool ${i % 5 === 4 ? 'off' : 'on'}" data-act="toast" data-v="${t}">${t}</span>`).join('')}</div>`).join('') : '')) +
      sec('适用的工作侧重', `<div class="toolgrid" style="padding:14px 16px">${['通用', '编程', '科研', '办公'].map(f => `<span class="tool ${a.focus.includes(f) ? 'on' : ''}" style="font-family:var(--font-sans);font-size:12.5px;height:26px;line-height:26px;padding:0 10px">${a.focus.includes(f) ? '✓ ' : ''}${f}</span>`).join('')}</div>`, { desc: '只在这些工作侧重下出现在可派发列表里。' });
  }

  page('external-agents', {
    title: '外部 Agent', icon: 'terminal', scope: 'host', keywords: 'Codex Claude Code OpenCode Pi ACP 安装 Harness',
    desc: '在执行设备上安装和管理 Codex、Claude Code 等 Agent。它们沿用自己的配置和账号。',
    render() {
      const st = { ready: chip('已安装', 'ok'), update: chip('有更新', 'warn') };
      return header(this, { acts: btn('刷新', { k: 'ghost', sm: true, icon: 'refresh', act: 'toast', v: '重新检测已安装的程序' }) }) +
        sec('', row('运行在', dd('ext.dev', [{ v: 'studio-pc', l: 'studio-pc（当前服务）', icon: 'server' }, { v: 'gpu-box', l: 'gpu-box', icon: 'monitor' }], 'studio-pc'), { desc: '检测、安装和运行都在这台设备上完成。' })) +
        sec('已接入', DATA.externalAgents.map(a => `<div class="orow"><img class="logo md keep" src="${a.logo}" alt=""><div class="grow"><div class="ot">${a.name}${st[a.state]}</div><div class="od">版本 ${a.ver}${a.state === 'update' ? ' · 可以更新到 0.86.0' : ''}</div></div><div class="oe">${a.state === 'update' ? btn('更新', { sm: true, act: 'toast', v: '在 studio-pc 上更新 Pi' }) : ''}${sw('ext.' + a.id, a.on, { label: '启用 ' + a.name })}${btn('', { k: 'ghost', sm: true, icon: 'more', tip: '更多', act: 'toast', v: '打开配置目录 · 查看日志 · 卸载' })}</div></div>`).join(''), { desc: '关闭后不会出现在 Agent 选择里，已经开始的对话不受影响。' }) +
        sec('可以安装', `<div class="pgrid">${[['Gemini CLI', 'gemini.png', 'Google 的命令行 Agent'], ['Kimi CLI', 'kimi.png', '月之暗面的编程 Agent'], ['Qoder', 'qoder.svg', '阿里巴巴的编程 Agent'], ['自定义 ACP 程序', '', '接入任何支持 ACP 协议的程序']].map(([n, l, d]) => `<div class="pcard"><span class="pi">${l ? `<img class="logo md keep" src="../../../packages/ui/src/assets/harness-logos/${l}" alt="">` : ic('plus')}</span><div class="grow"><b>${n}</b><p>${d}</p>${btn(l ? '安装' : '添加', { sm: true, act: 'toast', v: l ? '在 studio-pc 上安装 ' + n : '填写启动命令和工作目录' })}</div></div>`).join('')}</div>`, { raw: true });
    },
  });
})();
