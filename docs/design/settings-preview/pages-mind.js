/* Varin · 设置设计稿 · 指令、记忆、上下文 */
(() => {
  const { ic, esc, sw, dd, seg, num, txt, area, sec, row, link, disc, note, empty, header, chip, btn, roleRef, tabs, dock } = K;

  page('instructions', {
    title: '指令', icon: 'file', scope: 'host', keywords: '系统提示词 自定义指令 风格 信息密度 自主 语言风格',
    desc: '告诉 Agent 你希望它怎样说话、怎样做事。保存后从下一次请求开始生效。',
    render() {
      const [tb, t] = tabs('instr', [{ v: 'mine', l: '我的指令' }, { v: 'full', l: '完整系统提示词' }]);
      const where = K.get('instr.scope', '全局');
      const top = `<div class="hstack" style="margin:-8px 0 18px">${seg('instr.scope', ['全局', '项目 · launch-site', '当前对话'], '全局', { re: true })}<span class="faint" style="font-size:12px">${where === '全局' ? '所有对话都会带上。' : where === '当前对话' ? '只对这一个对话有效，优先于项目和全局。' : '只对这个项目里的对话有效，优先于全局。'}</span></div>`;
      if (t === 'full') return header(this) + tb + top +
        sec('组成', [['Varin 基础指令', '2.1K'], ['工具说明', '6.8K'], ['你的指令（全局）', '0.3K'], ['项目指令 · AGENTS.md', '1.2K'], ['记忆快照', '0.9K']].map(([n, k]) => `<div class="orow"><div class="grow ot">${n}</div><div class="oe faint num" style="font-size:12.5px">${k} Token</div></div>`).join(''), { desc: '下一次请求实际发送给模型的系统提示词，按这些部分拼成。只读。' }) +
        sec('预览', `<div class="doc"><div class="bar">${ic('eye', 'sm')}只读<span class="grow"></span>${btn('复制', { k: 'ghost', sm: true, icon: 'copy', act: 'toast', v: '已复制' })}</div><textarea class="area mono" readonly rows="12">你是 Varin，用户的长期工作伙伴……\n\n## 工具\nfile_read：读取文件内容……\n\n## 用户的指令\n回答先给结论，再讲理由。\n</textarea></div>`, { raw: true });
      return header(this) + tb + top +
        sec('风格', row('详略', seg('instr.density', ['默认', '精简', '适中', '充分'])) +
          row('语气', seg('instr.tone', ['默认', '直接', '自然', '正式'])) +
          row('自主程度', dd('instr.auto', [{ v: '默认', l: '默认' }, { v: '先讨论', l: '先讨论方案', d: '动手前先说明打算怎么做' }, { v: '自主', l: '自主完成明确的任务', d: '目标清楚时直接做完再汇报' }, { v: '主动', l: '主动推进', d: '会主动发现并处理相关的事' }], '默认')), { desc: '选「默认」时由 Varin 的基础指令决定。' }) +
        sec('补充说明', `<div class="doc"><div class="bar">Markdown<span class="grow"></span>${btn('恢复默认', { k: 'ghost', sm: true, act: 'toast', v: '已清空自定义说明' })}</div>${area('instr.text', '回答先给结论，再讲理由。\n涉及删除文件、花钱或对外发送的操作，先问我。', { rows: 10, unit: 'instr', ph: '写下你希望 Agent 一直记得的要求…' })}</div>`, { raw: true, desc: '写得具体一些效果更好，例如「回答先给结论」比「回答要好」更有用。' });
    },
    dock() { return dock('instr', { save: '保存指令', msg: '指令有未保存的修改' }); },
  });

  page('memory', {
    title: '记忆', icon: 'notebook', scope: 'host', keywords: '记忆 知识 嵌入 向量 检索 并发 忘记',
    desc: 'Varin 和 Agent 长期记住的事。你可以修改，也可以让它忘记。',
    render() {
      const mems = [
        ['回答先给结论，再讲理由；不喜欢长篇大论。', '对话「准备周五的发布」', '11 月 16 日'],
        ['launch-site 的亮色和暗色使用同一套布局，截图放在功能列表之前。', '项目 launch-site', '11 月 14 日'],
        ['周五下午固定和设计组开会，这段时间不要安排需要确认的事。', 'Varin', '11 月 9 日'],
      ];
      const scope = K.get('mem.scope', '全局');
      return header(this, { acts: btn('添加', { sm: true, icon: 'plus', act: 'toast', v: '写下一条要记住的事' }) }) +
        `<div class="hstack" style="margin:-8px 0 14px">${seg('mem.scope', ['全局', '项目', '对话'], '全局', { re: true })}<span class="grow"></span>${txt('mem.q', '', { ph: '查找记忆', w: '' })}</div>` +
        sec('', scope === '对话' ? empty('notebook', '这个范围还没有记忆', '在对话中说「记住……」，或者点右上角添加。') : mems.map(([t, s, d]) => `<div class="mem"><p>${esc(t)}</p><div class="meta"><span>${esc(s)}</span>·<span>${d}</span><span class="grow"></span><span class="linkish" data-act="toast" data-v="编辑这条记忆">编辑</span><span class="linkish" data-act="toast" data-v="已忘记，并从依赖它的记忆中撤回">忘记</span></div></div>`).join(''), { desc: '修改会立即保存；正在进行的对话会在下一轮收到更新。' }) +
        sec('检索', row('向量化模型', roleRef('embed'), { desc: '用于按意思找到相关的记忆。' }) +
          row('同时发送的请求数', num('mem.conc', 2)) +
          row('后台请求最少间隔', num('mem.gap', 200, { unit: '毫秒' }), { desc: '只限制后台整理，你在对话里检索时优先处理。' }) +
          disc('本机计算', row('CPU 使用偏好', dd('mem.cpu', ['自动', '性能优先', '省电优先'], '自动', { w: 'ws' })) + row('最多使用的线程', num('mem.threads', '', { ph: '自动' }))), { desc: '记忆和 Bot 知识共用这些设置。', after: note('修改请求节奏和本机计算后，需要重启 Varin 服务才会生效。', { icon: 'refresh' }) });
    },
  });

  page('context', {
    title: '上下文', icon: 'layers', scope: 'hostProject', keywords: '上下文 压缩 摘要 替换 预留 停滞 重试 时间 时区',
    desc: '对话变长时，Varin 怎样整理内容、腾出空间。',
    render() {
      const prep = +K.get('ctx.prep', 75), rep = +K.get('ctx.rep', 90), base = (rep * prep / 100).toFixed(1);
      return header(this) +
        sec('整理长对话', row('提前在后台准备摘要', sw('ctx.bg', true), { desc: '对话接近上限前先准备好摘要，需要时直接换上，不用停下来等。' }) +
          `<div style="padding:4px 16px 6px"><div class="ctxbar" style="--prep:${base}%;--rep:${rep}%"><div class="track"></div><span class="mk" style="left:${base}%" data-l="开始准备 ${base}%" data-tip="拖动调整；方向键微调"></span><span class="mk b" style="left:${rep}%" data-l="换上摘要 ${rep}%" data-tip="拖动调整；方向键微调"></span><span class="end" style="left:0">0</span><span class="end" style="right:0">模型上限</span></div></div>` +
          row('换上摘要的位置', num('ctx.rep', 90, { unit: '% 的上限' }), { desc: `用到这里时换上准备好的摘要；摘要还没好就稍等。等于给回复预留 ${100 - rep}% 的空间。` }) +
          row('开始准备的位置', num('ctx.prep', 75, { unit: '% 的可用空间' }), { desc: `相当于整个上限的 ${base}%。对话增长很快时会更早开始。` }) +
          disc('这两个数字怎么换算', `<div class="note inpanel">开始准备 = 换上位置 × 准备比例。调整「换上位置」时，准备比例保持不变，准备标记跟着移动。关闭后台准备后，到达换上位置时仍会整理，只是需要当场等待。</div>`)) +
        sec('由谁整理', link('上下文整理 Agent', 'agents', { sel: 'compact', desc: '负责写摘要的内置 Agent：模型、思考等级、工作指令和提示词组成都在那里。' })) +
        sec('回复卡住时', row('检测到卡住时自动重试', sw('ctx.stall', true), { tag: chip('暂未生效', 'warn') }) +
          row('多久没有输出算卡住', num('ctx.idle', 60, { unit: '秒' }), { sub: true }) +
          row('等待第一个字的时间', num('ctx.first', 120, { unit: '秒' }), { sub: true }) +
          row('最多重试', num('ctx.retries', 2, { unit: '次' }), { sub: true }),
        { desc: '这些设置会保留下来，但当前的运行方式还没有用到它们。' }) +
        sec('消息时间', row('发送消息时附上当时的时间', sw('ctx.time', false, { re: true }), { desc: '方便 Agent 理解「今天」「下周」这类说法。同一轮里的工具调用沿用这次的时间。' }) +
          (K.get('ctx.time', false) ? row('时区', dd('ctx.tz', ['跟随这台设备', '亚洲/上海', 'UTC'], '跟随这台设备'), { sub: true }) : ''));
    },
  });
})();
