/* Varin · 设置设计稿 · 数据：存储、历史与恢复、关于 */
(() => {
  const { ic, esc, sw, dd, seg, num, sec, row, link, disc, note, header, chip, btn, cards } = K;

  page('storage', {
    title: '存储', icon: 'drive', scope: 'host', keywords: '存储 空间 磁盘 清理 缓存 工作副本 占用',
    desc: 'Varin 在这台服务上占用的空间，以及可以清理的内容。',
    render() {
      const cats = [['恢复与工作状态', '检查点、恢复记录和工作区版本', 6.1, 's1'], ['独立工作副本', 'Agent 单独工作用的文件夹副本', 4.2, 's2'], ['对话与附件', '对话记录、上传的文件和生成的图片', 3.3, 's3'], ['共享模型资源', '语音识别、本机向量化等模型', 2.4, 's4'], ['记忆与知识', '记忆条目和 Bot 知识的向量', 1.6, 's5'], ['其他', '日志、设置和临时文件', 0.8, '']];
      const total = cats.reduce((n, c) => n + c[2], 0);
      return header(this, { acts: btn('重新统计', { k: 'ghost', sm: true, icon: 'refresh', act: 'toast', v: '正在重新统计…' }) }) +
        `<div class="hstack" style="margin:-8px 0 16px">${dd('st.scope', ['全部工作区与共享数据', '只看 launch-site'], '全部工作区与共享数据', { w: 'wl' })}</div>` +
        sec('', `<div style="padding:16px 16px 12px"><div class="hstack" style="align-items:baseline;gap:10px"><span style="font-size:22px;font-weight:600" class="num">${total.toFixed(1)} GB</span><span class="muted" style="font-size:12.5px">Varin 数据 · 磁盘 D: 还剩 212 GB</span></div><div class="stack" role="img" aria-label="存储构成">${cats.map(([n, , v, c]) => `<i style="flex:${v};background:${c ? `var(--${c})` : 'color-mix(in srgb,var(--foreground) 22%,transparent)'}" data-tip="${n} · ${v} GB"></i>`).join('')}</div></div><div class="legend">${cats.map(([n, d, v, c]) => `<div class="orow"><span class="sw2" style="background:${c ? `var(--${c})` : 'color-mix(in srgb,var(--foreground) 22%,transparent)'}"></span><div class="grow"><div class="ot">${n}</div><div class="od">${d}</div></div><div class="oe num">${v} GB</div></div>`).join('')}</div>`, { desc: '' }) +
        sec('整理空间', row('缓存和没有被引用的内容', btn('查看可清理项', { sm: true, act: 'toast', v: '先列出要清理的内容和能腾出的空间，确认后才删除' }), { desc: '先列出要清理的内容、范围和能腾出的空间，确认后才删除。' }) +
          link('独立工作副本', 'projects', { desc: '可能有未提交的改动或运行中的进程，这里只统计，不自动删除。到项目里逐个处理。', end: '4.2 GB' }) +
          link('恢复记录的保留上限', 'history', { desc: '限制检查点数量和保留时间，自动回收较早的记录。' })) +
        `<p class="faint" style="font-size:12px;margin:16px 2px 0;line-height:1.6">只统计 Varin 管理的目录，不扫描你的项目文件夹。硬链接只算一次；共享数据不重复分摊到每个工作区，所以和磁盘实际占用可能略有差别。</p>`;
    },
  });

  page('history', {
    title: '历史与恢复', icon: 'history', scope: 'host', keywords: '历史 恢复 回退 检查点 保留 归档 删除 清理',
    desc: '对话保留多久、回退时怎样处理文件，以及恢复记录的保留规则。',
    render() {
      const auto = K.get('hi.auto', false);
      return header(this) +
        sec('对话保留', row('自动清理旧对话', sw('hi.auto', false, { re: true })) +
          row('保留', num('hi.days', 90, { unit: '天' }), { sub: true, dim: !auto }) +
          row('到期后', seg('hi.then', ['归档', '删除'], '归档'), { sub: true, dim: !auto, desc: '归档的对话可以在侧边栏的「归档」里找回。' }) +
          row('现在清理一次', btn('清理', { sm: true, act: 'toast', v: '现在没有需要归档的对话' }), { desc: '按上面的规则，现在有 0 个对话可以归档。' })) +
        sec('回退方式', cards('hi.rewind', [
          { v: 'conv', l: '只回退对话', d: '切回之前的分支，提示词可以重新编辑；不动文件。' },
          { v: 'both', l: '对话和文件一起回退', d: '同时撤销这几轮实际改过的文件；文件后来又被改过时会提示冲突。' },
          { v: 'ask', l: '每次都问我', d: '每次选择：只回退对话、原地恢复文件，或新建一个恢复副本。' },
        ], 'ask'), { raw: true, desc: '在对话里点「回退到这里」时默认怎么做。Varin 只恢复每轮实际改过的文件，不会重置整个工作区。' }) +
        sec('恢复记录', row('恢复数据库', `<span class="muted num" style="font-size:12.5px">6.1 GB · 8,362 个内容对象</span>${btn('', { k: 'ghost', sm: true, icon: 'refresh', tip: '刷新', act: 'toast', v: '已刷新' })}`, { desc: '文件恢复和工作区版本共用这份数据。这是数据库大小，不等于可以清理的量。' }) +
          `<div class="orow"><span>${ic('folder', 'sm')}</span><div class="grow"><div class="ot mono">~/work/launch-site</div><div class="od">41 个检查点 · 最近一次 11 月 3 日 11:40</div></div></div>`) +
        sec('保留上限', row('自动检查点最多', num('hi.cp', '', { ph: '不限', unit: '个' })) + row('已完成的恢复操作最多', num('hi.ops', '', { ph: '不限', unit: '个' })) +
          row('最长保留', num('hi.keep', '', { ph: '不限', unit: '天' })) + row('历史总大小最多', num('hi.size', '', { ph: '不限', unit: 'MiB' })) +
          row('', btn('清除所有上限', { k: 'ghost', sm: true, act: 'toast', v: '已清除，所有恢复记录都会保留' })),
          { desc: '留空表示不限。每轮对话结束后按上限回收；带名字的检查点、未完成或需要处理的操作始终保留。被回收的检查点不能再用来回退文件，对话本身仍会保留。', after: note('按现在的规则，没有可以回收的检查点；0 条记录受保护。') });
    },
  });

  page('about', {
    title: '关于', icon: 'info', scope: 'device', keywords: '版本 更新 许可 GitHub 官网 第三方',
    desc: '',
    render() {
      return `<div style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:30px 0 26px"><span style="width:56px;height:56px;color:var(--fg)">${MARK}</span><h1 style="margin:14px 0 2px;font-size:20px;font-weight:600">Varin</h1><div class="muted">版本 0.9.50 · 已是最新</div><div style="margin-top:14px">${btn('检查更新', { sm: true, icon: 'refresh', act: 'toast', v: '已是最新版本' })}</div></div>` +
        sec('', row('自动检查更新', sw('ab.auto', true), { desc: '发现新版本时，在侧边栏显示更新按钮。关闭后仍可以手动检查。' })) +
        sec('', link('官网', 'about', { lead: 'globe', end: 'varin.dev' }) + link('用户指南', 'about', { lead: 'book' }) + link('更新日志', 'about', { lead: 'history' }) + link('GitHub', 'about', { lead: 'code' })) +
        sec('', row('许可', '<span class="muted" style="font-size:12.5px">AGPL-3.0</span>') + link('第三方软件声明', 'about', { lead: 'file' }) + link('联系我们', 'about', { lead: 'chat' }));
    },
  });
})();
