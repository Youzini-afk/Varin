/* Varin · 设置设计稿 · 模型服务、模型分工 */
(() => {
  const { ic, esc, sw, dd, seg, num, txt, area, sec, row, link, disc, note, empty, header, chip, btn, logo, unitbar, thinkDD, roleRef, cat, ci, sel, info } = K;
  const statusDot = s => s === 'ok' ? '<span class="dot ok" data-tip="已连接"></span>' : s === 'err' ? '<span class="dot err" data-tip="无法连接"></span>' : '<span class="dot off" data-tip="已停用"></span>';

  page('models', {
    title: '模型服务', icon: 'cloud', scope: 'host', keywords: '模型 渠道 服务 API 密钥 接口 代理 重试 获取模型 OpenAI Anthropic',
    desc: '接入的模型服务，以及它们提供的模型。',
    badge: () => DATA.services.some(s => s.status === 'err') ? '<span class="badge warn" data-tip="有服务无法连接">●</span>' : '',
    render() {
      const f = (S.v['filter.models'] || '').toLowerCase();
      const cur = sel('models', 'openai');
      const items = ci('models', '__retry', `<span class="av">${ic('refresh', 'sm')}</span><span class="grow"><span class="cn">失败重试</span><div class="cm">最多 3 次</div></span>`, { first: 'openai', pinned: true }) +
        `<div class="cg"><span>服务</span><span>${DATA.services.length}</span></div>` +
        DATA.services.filter(s => !f || s.name.toLowerCase().includes(f) || s.models.some(m => m.id.includes(f))).map(s => ci('models', s.id, `${logo(s.logo, 'md')}<span class="grow"><span class="cn">${esc(s.name)}</span><div class="cm">${s.models.length} 个模型</div></span><span class="end">${statusDot(s.status)}</span>`, { first: 'openai' })).join('');
      return cat({ key: 'models', title: this.title, desc: this.desc, scope: 'host', filter: '筛选服务或模型', items,
        headActs: btn('', { k: 'ghost', sm: true, icon: 'plus', tip: '接入服务', act: 'toast', v: '选择服务类型：OpenAI、Anthropic、OpenAI 兼容、Ollama …' }),
        detail: cur === '__retry' ? retry() : service(DATA.services.find(s => s.id === cur)) });
    },
  });

  function service(s) {
    const u = 'svc.' + s.id;
    const conn = row('名称', txt(`${u}.name`, s.name, { unit: u })) +
      row('接口地址', txt(`${u}.url`, s.url, { unit: u, mono: true, w: 'wl' })) +
      row('API 密钥', `<span class="secret">${txt(`${u}.key`, '', { unit: u, type: 'password', ph: '已保存，输入新密钥可替换', w: 'wl' })}</span>`, { desc: '密钥只保存在 Varin 服务上，不会发到浏览器。' }) +
      disc('高级', row('代理', dd(`${u}.proxy`, ['跟随网络代理设置', '直连', '使用单独的代理'], '跟随网络代理设置', { unit: u })) +
        row('额外请求头', area(`${u}.headers`, '', { rows: 3, mono: true, ph: '{ "X-Team": "design" }', unit: u }), { stack: true, desc: '只放不敏感的信息。密钥、令牌和 Cookie 请用上面的 API 密钥。' }) +
        row('接口路径', `<span class="muted" style="font-size:12.5px">全部使用默认</span>`, { desc: '对话、嵌入、重排、快速判断、生成图片、修改图片各自的路径。留空使用协议默认值。' })) +
      (s.status === 'err' ? note(`无法连接 <span class="mono">${esc(s.url)}</span>：连接被拒绝。请确认 Ollama 正在运行，然后重试。`, { k: 'warn', inpanel: true }) : '') +
      unitbar(u, { verify: true, save: '测试并保存', msg: '修改连接信息后，需要测试通过才会保存', busy: '正在连接…', ok: `已连接，找到 ${s.models.length} 个模型` });
    const models = s.models.map(m => {
      const ref = DATA.modelRef(s.id, m.id);
      const open = S.v['mopen'] === ref;
      const used = DATA.usedBy(s.id, m.id);
      return `<div class="orow click" data-act="mtoggle" data-v="${esc(ref)}" style="align-items:flex-start"><div class="grow"><div class="ot">${esc(m.id)}</div><div class="od">${esc(m.desc)}</div><div class="caps">${m.caps.map(c => `<span class="cap">${c}</span>`).join('')}${m.ctx ? `<span class="cap">上下文 ${m.ctx}</span>` : ''}${used.map(r => `<button class="cap use" data-go="model-roles" data-flash="${esc(r)}">用于 ${esc(r)}</button>`).join('')}</div></div><div class="oe" style="padding-top:2px">${sw('m.' + ref, true, { label: '启用 ' + m.id })}${ic(open ? 'down' : 'chev', 'sm faint')}</div></div>` +
        (open ? `<div style="padding:0 16px 14px;border-top:0">${row('简介', area('m.desc.' + ref, m.desc, { rows: 2 }), { stack: true, desc: '派发任务时，Varin 会参考这段简介挑选模型。' })}${row('上下文窗口', dd('m.ctx.' + ref, ['128K', '256K', '512K', '1M', '自定义'], m.ctx || '128K', { w: 'ws' }))}${row('最长输出', dd('m.out.' + ref, ['8K', '16K', '32K', '64K', '128K'], '32K', { w: 'ws' }))}${row('价格', `<span class="hstack wrap">${txt('m.pin.' + ref, '', { ph: '输入', w: 'ws' })}${txt('m.pout.' + ref, '', { ph: '输出', w: 'ws' })}<span class="muted" style="font-size:12px">美元 / 百万 Token</span></span>`, { desc: '留空时使用 models.dev 的公开价格；没有公开价格的不计入费用。' })}</div>` : '');
    }).join('');
    return `<div class="oh2">${logo(s.logo, 'lg')}<div class="ttl"><h1>${esc(s.name)}${s.status === 'err' ? chip('无法连接', 'err') : chip('已连接', 'ok')}</h1><div class="sub">${esc(s.kind)} · ${s.models.length} 个模型</div></div><div class="acts">${sw('svc.on.' + s.id, s.status !== 'off', { label: '启用服务' })}${btn('', { k: 'ghost', icon: 'more', tip: '更多', act: 'toast', v: '复制服务 · 导出配置 · 删除服务' })}</div></div>` +
      sec('连接', conn, { desc: '连接信息先测试，通过后才保存。' }) +
      sec('模型', models, { desc: '开关和字段改动会立即保存。点开一行可以写简介、调整容量和价格。', acts: `${btn('获取模型列表', { sm: true, icon: 'refresh', act: 'toast', v: '已从服务获取模型列表' })}${btn('添加', { sm: true, icon: 'plus', act: 'toast', v: '手动添加模型' })}` }) +
      `<div style="margin-top:28px">${btn('删除这个服务', { k: 'ghost danger', sm: true, icon: 'trash', act: 'toast', v: '会先列出受影响的模型分工和 Agent，再确认删除' })}</div>`;
  }
  ACTS.mtoggle = (el, e) => { if (e.target.closest('[data-sw],[data-go]')) return; S.v.mopen = S.v.mopen === el.dataset.v ? '' : el.dataset.v; App.render(); };

  function retry() {
    return `<div class="oh2"><span class="avatar">${ic('refresh')}</span><div class="ttl"><h1>失败重试</h1><div class="sub">模型请求失败时自动重试。对对话、辅助生成和远程检索都有效。</div></div></div>` +
      sec('', row('自动重试失败的请求', sw('rt.on', true, { unit: 'retry' })) +
        row('最多重试', num('rt.max', 3, { unit: '次', unit2: 'retry' }), { desc: '不含第一次请求。' }) +
        row('第一次等待', num('rt.first', 1, { unit: '秒', unit2: 'retry' }), { desc: '之后每次等待逐渐变长，并带一点随机浮动；服务商要求等待更久时以服务商为准。' }) +
        row('最长等待', num('rt.cap', 30, { unit: '秒', unit2: 'retry' })) +
        unitbar('retry', { save: '保存重试设置' })) +
      sec('什么情况下重试', empty('route', '没有自定义规则', '默认重试常见的网络错误，以及 HTTP 408、409、425、429 和 5xx。', btn('添加规则', { sm: true, icon: 'plus', act: 'toast', v: '按状态码、错误代码或错误内容匹配' })) +
        disc('用一个错误试试', row('HTTP 状态码', txt('rt.t.code', '', { ph: '例如 429', w: 'ws' })) + row('错误内容', txt('rt.t.msg', '', { ph: '例如 rate limit exceeded', w: 'wl' })) + row('', btn('测试', { sm: true, act: 'toast', v: '会重试：命中默认规则「HTTP 429」' })), { sum: '不会发送真实请求' }),
      { desc: '规则从上到下匹配，命中第一条就生效。停止任务会立刻取消等待。' });
  }

  /* ── 模型分工 ── */
  /* 功能开关不在这里：每个模型标出它所属功能的开关状态，并链接回去 */
  const gate = {
    searchPick: { go: 'web', t: '网络与文档', on: () => K.get('web.pick', true) },
    readPick: { go: 'web', t: '网络与文档', on: () => K.get('web.read', true) },
    next: { go: 'chat', t: '聊天', on: () => K.get('chat.next', false) },
    dispatch: { go: 'agents', t: 'Agents', on: () => K.get('ag.dispatch', true) },
    permJudge: { go: 'permissions', t: '权限', on: () => K.get('perm.mode', 'normal') === 'smart', yes: '确认方式是「智能判断」，正在使用', no: '确认方式不是「智能判断」，用不到', act: '更改' },
    plan: { go: 'plugins', t: '插件', on: () => K.get('pl.loop', 'default') !== 'default', yes: '当前执行循环需要规划', no: '默认执行循环用不到', act: '更换' },
  };
  function roleRow(k, o = {}) {
    const r = DATA.roles[k];
    const g = gate[k]; const on = g ? g.on() : true;
    const status = g ? `<span class="rs"><span class="dot ${on ? 'ok' : 'off'}"></span>${on ? g.yes || '已开启' : g.no || '未开启'} · <span class="linkish" data-go="${g.go}">在「${g.t}」中${g.act || (on ? '关闭' : '开启')}</span></span>` : '';
    const ctl = roleRef(k, o.none, { w: r.think ? 'w' : 'wl' }) + (r.think ? thinkDD('role.' + k + '.think', r.think) : '');
    return row(r.l, ctl, { desc: r.d + status, item: r.l, dim: false });
  }
  page('model-roles', {
    title: '模型分工', icon: 'route', scope: 'hostProject', keywords: '默认模型 辅助模型 思考 规划 快速决策 嵌入 重排 图像 下一步 派发 标题',
    desc: '每件事交给哪个模型。这里只分配已接入的模型，接入新模型请去「模型服务」。',
    render() {
      const emb = K.get('emb.mode', '模型服务');
      const compact = DATA.agents.find(a => a.id === 'compact');
      return header(this, { acts: btn('模型服务', { k: 'ghost', sm: true, icon: 'cloud', go: 'models' }) }) +
        sec('对话', roleRow('default') + roleRow('assist') + row('标题自动更新', num('roles.title', 5, { unit: '轮' }), { desc: '前几轮对话结束后由辅助模型重拟标题。填 0 表示只在开头起一次标题。' }), { desc: '项目可以单独设置默认模型和思考等级，在「项目」里修改。' }) +
        sec('工作中的判断', roleRow('decide') +
          disc('按用途单独指定快速判断', ['网页搜索结果', '学术检索结果', '整理记忆', '召回记忆'].map(l => row(l, K.modelDD('decide.' + l, '', { w: 'wl', none: '和「快速判断」相同' }), { sub: true })).join('')) +
          roleRow('retrieval') + roleRow('searchPick') + roleRow('readPick') + roleRow('dispatch') + roleRow('permJudge') +
          row('上下文整理', agentRef(compact) + thinkDD('ag.compact.think', compact.think), { desc: '对话太长时整理摘要。' }),
        { desc: '这些模型在后台做小而频繁的决定，选快一些、便宜一些的通常更合适。' }) +
        sec('生成', roleRow('next') + roleRow('imageGen', { none: '不使用' }) + roleRow('imageEdit', { none: '不使用' })) +
        sec('检索', row('向量化', seg('emb.mode', ['本机组件', '模型服务', '关闭'], '模型服务', { re: true }), { desc: emb === '关闭' ? '记忆和 Bot 知识改用文本检索。' : emb === '本机组件' ? '在 Varin 服务上本地计算，不需要外部服务。' : '记忆和 Bot 知识的语义检索。' }) +
          (emb === '模型服务' ? row('向量化模型', roleRef('embed'), { sub: true, item: '向量化模型' }) : '') +
          roleRow('rerank', { none: '不重排' }) +
          link('向量化的请求节奏', 'memory', { desc: '并发数、后台请求间隔和本机 CPU 线程，在「记忆」里设置。' })) +
        sec('插件', roleRow('plan', { none: '不单独规划' }), { desc: '插件可以替换 Agent 的执行循环。只有它声明需要时，才会用到这里的模型。' });
    },
  });
  /* 由内置 Agent 负责的工作：显示它当前的模型，点开去那个 Agent */
  function agentRef(a) {
    const m = K.get('ag.' + a.id + '.model', a.model); const md = DATA.model(m);
    const provider = md && DATA.isSharedModel(md.id) ? `<span class="via">${esc(md.service.name)}</span>` : '';
    return `<button class="dd" data-go="agents" data-sel="${a.id}" data-tip="在「Agents · ${esc(a.name)}」中更改">${md ? logo(md.service.logo) : ic('users', 'sm')}<span class="lbl">${esc(md?.id || m || '沿用当前对话')}</span>${provider}${ic('ext', 'xs chev')}</button>`;
  }
})();
