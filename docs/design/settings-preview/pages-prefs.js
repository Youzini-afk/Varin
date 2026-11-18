/* Varin · 设置设计稿 · 偏好 */
(() => {
  const { ic, sw, dd, seg, num, txt, sec, row, note, cards, header, chip, btn, kbd, esc } = K;
  const desk = '<span class="chip" style="height:18px;font-size:11px">桌面版</span>';
  const bars = (w, o = '') => `<i style="display:block;height:5px;border-radius:3px;background:currentColor;opacity:${o || .18};width:${w}%;margin:5px 0"></i>`;

  page('general', {
    title: '通用', icon: 'sliders', scope: 'device', keywords: '语言 时间 启动 托盘 安装 PWA 键盘',
    desc: '语言和时间格式，以及应用怎样启动、怎样安装。',
    render() {
      return header(this) +
        sec('语言与区域', row('界面语言', dd('gen.lang', ['跟随系统', '简体中文', '繁體中文', 'English', '日本語', 'Français'], '简体中文')) +
          row('时间格式', seg('gen.clock', ['自动', '24 小时', '12 小时'])) +
          row('每周从哪天开始', seg('gen.week', ['自动', '周一', '周日']))) +
        sec('启动', row('登录电脑后自动打开 Varin', sw('gen.login', false), { tag: desk }) +
          row('关闭窗口后留在托盘', sw('gen.tray', true), { tag: desk, desc: '工作会在后台继续；从托盘图标重新打开窗口。' }) +
          row('在 macOS 菜单栏显示 Varin', sw('gen.menubar', true), { tag: '<span class="chip" style="height:18px;font-size:11px">macOS</span>', desc: '需要重启应用。关闭后不会创建菜单栏项目，也不会在那里显示会话、审批和用量。' })) +
        sec('安装为应用', row('应用名称', txt('gen.pwaName', 'Varin'), { desc: '浏览器把 Varin 安装为应用时显示的名字。' }) +
          row('屏幕方向', dd('gen.orient', ['跟随系统', '竖屏', '横屏'])), { desc: '只对从浏览器安装的 Varin 有效；修改后需要重新安装。' }) +
        sec('手机与平板', row('弹出键盘时', dd('gen.kbd', [{ v: '跟随浏览器', l: '跟随浏览器' }, { v: '缩小页面', l: '缩小页面', d: '输入框始终在键盘上方' }, { v: '覆盖内容', l: '覆盖内容', d: '页面大小不变，键盘盖住下半部分' }])));
    },
  });

  const modeArt = (bg, fg, split) => `<div style="position:absolute;inset:0;display:flex;${split ? 'background:linear-gradient(105deg,#f4f4f4 50%,#1b1b1b 50%)' : `background:${bg}`}"><div style="width:26%;margin:8px 0 8px 8px;border-radius:5px;background:${split ? '#e6e6e6' : fg};opacity:.9"></div><div style="flex:1;padding:12px 12px;color:${split ? '#888' : (bg === '#f4f4f4' ? '#333' : '#ddd')}">${bars(70, .3)}${bars(52)}${bars(60)}<i style="display:block;margin-top:9px;height:12px;border-radius:4px;background:#4b6fac;opacity:.55;width:40%"></i></div></div>`;
  page('appearance', {
    title: '外观', icon: 'palette', scope: 'mixed', wide: true, keywords: '主题 颜色 深色 浅色 字体 字号 间距 动效 减少动态效果',
    desc: '主题、颜色、字体和动效。右侧示例会跟着变化。',
    render() {
      const left = sec('颜色模式', cards('ap.mode', [
        { v: 'light', l: '浅色', art: modeArt('#f4f4f4', '#e3e3e3') },
        { v: 'dark', l: '深色', art: modeArt('#1b1b1b', '#2a2a2a') },
        { v: 'system', l: '跟随系统', art: modeArt('', '', true) },
      ], S.theme, { re: true }), { raw: true }) +
        sec('主题', row('浅色时使用', dd('ap.lt', [{ v: 'varin', l: 'Varin（默认）', d: '中性灰，蓝色重点色' }, { sep: 1 }, { v: 'import', l: '导入主题…' }], 'varin')) +
          row('深色时使用', dd('ap.dt', [{ v: 'varin', l: 'Varin（默认）', d: '中性灰，蓝色重点色' }, { sep: 1 }, { v: 'import', l: '导入主题…' }], 'varin')) +
          row('自定义主题', `${btn('复制当前主题', { sm: true, act: 'toast', v: '已复制为 JSON，可以在编辑后导入' })}${btn('导入', { sm: true, icon: 'upload', act: 'toast', v: '选择主题 JSON 文件' })}`, { desc: '主题是一份 JSON。导入后会出现在上面的列表里。' }), { desc: '内置主题底色都是中性的，区别在重点色和代码高亮。' }) +
        sec('颜色微调', ['重点色:#4b6fac', '背景:#f3f3f3', '文字:#383838'].map(s => { const [l, c] = s.split(':'); return row(l, `<span class="hstack"><span class="mono muted" style="font-size:12px">${c}</span><span style="width:26px;height:26px;border-radius:7px;background:${c};box-shadow:inset 0 0 0 1px #0002"></span></span>`); }).join('') +
          row('', btn('恢复主题默认颜色', { k: 'ghost', sm: true, act: 'toast', v: '已恢复' })), { desc: '浅色和深色各自保存。保存在 Varin 服务上，换一台设备也一样。' }) +
        sec('字体与间距', row('界面字体', dd('ap.font', ['系统默认', 'Inter', '思源黑体', 'HarmonyOS Sans'])) +
          row('文字大小', num('ap.size', 100, { unit: '%' })) +
          row('间距', num('ap.pad', 100, { unit: '%' }), { desc: '小于 100% 时更紧凑，一屏能看到更多内容。' }) +
          `<a class="row link" data-go="editor"><div class="rl"><div class="t">代码和终端字体</div><div class="d">在「编辑器」和「终端」里分别设置。</div></div><div class="rc">${ic('chev', 'sm')}</div></a>`) +
        sec('动效', cards('ap.motion', [
          { v: 'full', l: '完整', d: '面板滑入、消息浮现、文字逐渐显现。' },
          { v: 'reduced', l: '简化', d: '只保留短暂的淡入和颜色变化。' },
          { v: 'off', l: '关闭', d: '状态直接切换。' },
        ], 'full'), { raw: true, desc: '系统开启「减少动态效果」时，「完整」会按「简化」处理。', after: '<div class="faint" style="font-size:12px;margin:8px 2px 0">保存在此设备</div>' });
      return withPreview(header(this) + left);
    },
    preview: () => chatPreview(),
    after(c) { c.querySelectorAll('[data-card="ap.mode"]').forEach(b => b.addEventListener('click', () => { const v = b.dataset.v; document.documentElement.dataset.theme = v === 'system' ? 'light' : v; S.theme = v === 'system' ? 'light' : v; })); },
  });

  /* ── 实时示例：聊天和外观共用，跟着当前设置变化。只用示例内容，不发送、不改文件 ── */
  /* 桌面宽度：右侧常驻；窄窗口和手机：放在表单上方，可以收起 */
  function withPreview(form) {
    if (S.size === 'desktop') return `<div class="pv-layout"><div>${form}</div><aside class="pv-side"><div id="live">${chatPreview()}</div></aside></div>`;
    const folded = K.get('pv.fold', S.size === 'phone');
    return form.replace('</header>', `</header><div class="pv-top ${folded ? 'folded' : ''}"><button class="pv-fold" data-act="pv-fold">${ic('eye', 'sm')}实时示例<span class="grow"></span>${ic('chev', 'sm chev')}</button>${folded ? '' : `<div id="live">${chatPreview()}</div>`}</div>`);
  }
  ACTS['pv-fold'] = () => { K.set('pv.fold', !K.get('pv.fold', S.size === 'phone')); App.render(); };
  ACTS['pv-toggle'] = el => { S.v['pv.open.' + el.dataset.v] = el.getAttribute('aria-expanded') !== 'true'; App.refreshLive(); };
  ACTS['pv-send'] = () => { const t = (K.get('pv.draft', '') || '').trim(); if (!t) return; const busy = K.get('pv.busy', '任务进行中') === '任务进行中'; K.set('pv.sent', { t, m: !busy ? '示例已发送' : K.get('chat.sendWb', '排队') === '排队' ? '示例已加入队列，这一轮结束后处理' : '示例已交给正在进行的任务' }); K.set('pv.draft', ''); App.refreshLive(); };
  ACTS['pv-starter'] = el => { K.set('pv.draft', el.dataset.v); App.refreshLive(); };
  ACTS['pv-revisit'] = () => { if (!K.get('chat.draft', true)) K.set('pv.draft', ''); K.set('pv.sent', null); App.refreshLive(); App.toast(K.get('chat.draft', true) ? '草稿还在' : '草稿已清空'); };
  ACTS['pv-reset'] = () => { Object.keys(S.v).filter(k => k.startsWith('pv.') && k !== 'pv.fold').forEach(k => delete S.v[k]); App.refreshLive(); };

  const isOpen = (id, d) => (('pv.open.' + id) in S.v ? S.v['pv.open.' + id] : d);
  const step = (id, label, open, body, o = {}) => `<div class="pv-step"><button class="pv-tog" data-act="pv-toggle" data-v="${id}" aria-expanded="${open}">${ic('chev', 'xs chev')}${o.icon ? ic(o.icon, 'xs') : ''}<span class="trunc">${label}</span>${o.end ? `<span class="pv-end">${o.end}</span>` : ''}</button>${open && body ? `<div class="pv-body">${body}</div>` : ''}</div>`;
  const md = s => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const USER = '请给 `validate.ts` 补上**空输入检查**。\n\n保留现有接口，补一个测试，再简单说明修改。用一张小图展示处理顺序。';
  const THINK = '先确认现有校验逻辑，再为缺少输入的情况添加测试。保持返回结构不变。';
  const OUT = '✓ 空输入返回 false\n✓ 保留已有校验行为\n2 passed · 124 ms';
  const fileIcon = (name, on) => on ? `<span class="pv-fi ${name.endsWith('.md') ? 'md' : 'ts'}">${name.endsWith('.md') ? 'M' : 'TS'}</span>` : '';
  const diffHTML = side => side
    ? `<div class="pv-diff two mono"><div><div class="dl">1 export const validate = …</div><div class="dl del">2   if (!input) return true;</div><div class="dl">3   return input.trim()…</div></div><div><div class="dl">1 export const validate = …</div><div class="dl add">2   if (!input) return false;</div><div class="dl">3   return input.trim()…</div></div></div>`
    : `<div class="pv-diff mono"><div class="dl">1    export const validate = (input: string) => {</div><div class="dl del">2 −    if (!input) return true;</div><div class="dl add">2 +    if (!input) return false;</div><div class="dl">3      return input.trim().length > 0;</div></div>`;
  const codeHTML = wrap => `<div class="pv-code"><div class="pv-code-h">ts<span class="grow"></span>${ic('copy', 'xs')}</div><pre class="mono ${wrap ? 'wrap' : ''}">const result = validate(input, { allowEmpty: false, normalizeWhitespace: true });</pre></div>`;

  function chatPreview() {
    const scene = K.get('pv.scene', '对话');
    const widthKey = K.get('chat.width', '舒展');
    const px = widthKey === '自定义' ? +K.get('chat.px', 960) || 960 : { 紧凑: 640, 适中: 800, 舒展: 960 }[widthKey];
    const end = scene === '对话' ? `<span class="faint num" style="font-size:11.5px">${px} px</span>` : '';
    const body = scene === '对话' ? convScene(px) : scene === '文件与图表' ? filesScene() : inputScene();
    return `<div class="pv">
      <div class="pv-head"><span class="pv-dot"></span><b>实时示例</b><span class="faint">随设置变化</span></div>
      <div class="pv-tabs">${seg('pv.scene', ['对话', '文件与图表', '输入'])}<span class="grow"></span>${end}${btn('重置', { k: 'ghost', sm: true, act: 'pv-reset', tip: '恢复示例的初始状态' })}</div>
      <div class="pv-view" style="font-size:${(13 * K.get('ap.size', 100) / 100).toFixed(1)}px;--pad:${(16 * K.get('ap.pad', 100) / 100).toFixed(0)}px">${body}</div>
      <div class="pv-foot">只用示例内容，不会发送消息或修改文件。</div>
    </div>`;
  }

  function convScene(px) {
    const mode = K.get('chat.mode', 'chat');
    const think = K.get('chat.think', true);
    const thinkStep = () => think ? step('think', isOpen('think', K.get('chat.thinkOpen', false)) ? '思考了 3 秒' : `思考 · <span class="faint">${THINK}</span>`, isOpen('think', K.get('chat.thinkOpen', false)), `<div class="pv-think">${THINK}</div>`, { icon: 'sparkle' }) : '';
    const read = step('read', '读取 <span class="mono">src/validate.ts</span>', false, '', { icon: 'file' });
    const edit = step('edit', '修改 <span class="mono">validate.ts</span>', isOpen('edit', K.get('chat.diffOpen', true)), diffHTML(false), { icon: 'edit', end: '<span class="pv-add">+1</span> <span class="pv-del">−1</span>' });
    const cmd = step('cmd', '运行 <span class="mono">bun test validate</span>', isOpen('cmd', K.get('chat.cmdOpen', false)), `<pre class="mono pv-out">${OUT}</pre>`, { icon: 'term2', end: '<span class="pv-add">通过</span>' });
    const narr = '<p>我先检查现有逻辑，再补上测试。</p>';
    const answer = `<p>${md('已补上空输入检查，并增加对应测试。缺少输入时返回 `false`，其他行为保持不变。')}</p>${codeHTML(K.get('chat.wrap', true))}`;
    let flow;
    if (mode === 'chat') {
      const o = isOpen('proc', false);
      flow = narr + `<div class="pv-step"><button class="pv-tog" data-act="pv-toggle" data-v="proc" aria-expanded="${o}">${ic('chev', 'xs chev')}<span>${think ? '思考 · ' : ''}读取 1 个文件 · 修改 1 个文件 · 运行 1 条命令</span></button>${o ? `<div class="pv-group">${thinkStep()}${read}${edit}${cmd}</div>` : ''}</div>` + answer;
    } else if (mode === 'time') {
      flow = thinkStep() + narr + read + edit + cmd + answer;
    } else {
      const o = isOpen('proc', K.get('chat.activity', '默认收起') === '默认展开');
      flow = `<div class="pv-step"><button class="pv-tog" data-act="pv-toggle" data-v="proc" aria-expanded="${o}">${ic('chev', 'xs chev')}<span>工作过程 · ${think ? 5 : 4} 步</span><span class="pv-end">12 秒</span></button>${o ? `<div class="pv-group">${thinkStep()}${narr}${read}${edit}${cmd}</div>` : ''}</div>` + answer;
    }
    const fold = K.get('chat.foldMine', true);
    const mine = K.get('chat.mine', '纯文本') === 'Markdown' ? md(USER).replace(/\n\n/g, '<br><br>') : esc(USER).replace(/\n/g, '<br>');
    const userOpen = isOpen('user', !fold);
    const user = `<div class="pv-user-wrap ${K.get('chat.pin', true) ? 'pin' : ''}"><div class="pv-user ${userOpen ? '' : 'clamp'} ${K.get('chat.mine', '纯文本') === 'Markdown' ? '' : 'plain'}">${mine}</div>${fold ? `<button class="pv-more" data-act="pv-toggle" data-v="user" aria-expanded="${userOpen}">${userOpen ? '收起' : '展开全部'}</button>` : ''}</div>`;
    const sum = K.get('chat.sum', true) ? `<div class="pv-sum">${ic('edit', 'xs')}改动了 1 个文件<span class="mono">validate.ts</span><span class="pv-add">+1</span><span class="pv-del">−1</span></div>` : '';
    const speed = K.get('chat.speed', false) ? '<div class="pv-meta">48 字/秒 · 12 秒</div>' : '';
    const nav = K.get('chat.nav', true) ? `<div class="pv-nav" data-tip="轮次导航：点击回到这一轮的提问"><i></i><span>1</span></div>` : '';
    const w = Math.min(100, Math.max(40, px / 1152 * 100));
    return `<div class="pv-conv">${nav}<div class="pv-col" style="width:${w}%">${user}<div class="pv-reply">${flow}${sum}${speed}</div></div></div>`;
  }

  function filesScene() {
    const icons = K.get('chat.ficon', true);
    const d = K.get('chat.diff', '自动');
    const side = d === '并排';
    const ascii = K.get('chat.chart', '图形') === '字符图';
    const readmeOpen = isOpen('readme', true);
    const readme = K.get('chat.preview', true)
      ? '<div class="pv-md"><b>输入校验</b><p>拒绝空输入，保留有效内容。</p><code>2 项测试通过</code></div>'
      : '<pre class="mono pv-raw"># 输入校验\n\n拒绝空输入，保留有效内容。\n\n`2 项测试通过`</pre>';
    return `<div class="pv-files">
      <div class="pv-fh">${fileIcon('validate.ts', icons)}<span class="mono">src/validate.ts</span>${d === '自动' ? '<span class="faint" style="margin-left:auto;font-size:11.5px">宽度不够，按行内显示</span>' : ''}</div>
      ${diffHTML(side)}
      ${codeHTML(K.get('chat.wrap', true))}
      ${ascii ? '<pre class="mono pv-ascii">[输入] ──▶ [空值检查] ──▶ [格式校验]</pre>' : '<div class="pv-flow"><span>输入</span><i></i><span>空值检查</span><i></i><span>格式校验</span></div>'}
      <div class="pv-tree">
        <button class="pv-tog" data-act="pv-toggle" data-v="readme" aria-expanded="${readmeOpen}">${ic('chev', 'xs chev')}${fileIcon('README.md', icons)}<span>README.md</span></button>
        ${readmeOpen ? readme : ''}
        ${K.get('chat.dot', false) ? `<div class="pv-tog" style="cursor:default">${icons ? ic('folder', 'xs') : ''}<span>.varin</span></div>` : ''}
      </div></div>`;
  }

  function inputScene() {
    const busy = K.get('pv.busy', '任务进行中') === '任务进行中';
    const queue = K.get('chat.sendWb', '排队') === '排队';
    const sent = K.get('pv.sent', null);
    const draft = K.get('pv.draft', '');
    return `<div class="pv-input">
      <div style="text-align:center">${seg('pv.busy', ['新对话', '任务进行中'], '任务进行中')}</div>
      ${busy ? '<div class="pv-hello"><span class="spin"></span>Varin 正在检查项目</div>' : `<div class="pv-hello">今天想做点什么？</div>${K.get('chat.starters', true) ? `<div class="pv-starters"><button class="chip" data-act="pv-starter" data-v="检查这个项目的测试覆盖">检查这个项目的测试覆盖</button><button class="chip" data-act="pv-starter" data-v="解释最近一次提交">解释最近一次提交</button></div>` : ''}`}
      ${sent ? `<div class="pv-sent"><small>${esc(sent.m)}</small><div>${esc(sent.t)}</div></div>` : ''}
      <div class="pv-composer"><textarea data-in="pv.draft" rows="3" placeholder="试着写一条示例消息…" spellcheck="${K.get('chat.spell', false)}">${esc(draft)}</textarea>
        <div class="pv-cbar"><span class="faint">${busy ? (queue ? '工作进行中：发送会排队' : '工作进行中：发送会补充给当前任务') : ''}</span><span class="grow"></span>${btn(!busy ? '发送' : queue ? '排队' : '补充', { k: 'primary', sm: true, act: 'pv-send' })}</div></div>
      <div class="pv-meta" style="display:flex">${K.get('chat.draft', true) ? '离开再回来时保留草稿' : '离开再回来时清空草稿'}<span class="grow"></span><span class="linkish" data-act="pv-revisit">离开再回来</span></div>
    </div>`;
  }

  const readArt = kind => {
    const line = (w, o) => bars(w, o);
    const fold = `<div style="display:flex;align-items:center;gap:4px;margin:6px 0;opacity:.5"><i style="width:6px;height:6px;border-right:1.5px solid;border-bottom:1.5px solid;transform:rotate(-45deg)"></i><i style="flex:none;width:40%;height:4px;border-radius:3px;background:currentColor;opacity:.4"></i></div>`;
    const inner = kind === 'chat' ? line(80, .35) + fold + line(65, .35) + fold + line(50, .35)
      : kind === 'time' ? line(80, .35) + line(70) + line(74) + line(60, .35) + line(66) + line(55)
        : `<div style="border-radius:4px;background:currentColor;opacity:.08;height:16px;margin:4px 0 8px"></div>` + line(85, .35) + line(78, .35) + line(60, .35);
    return `<div style="position:absolute;inset:0;padding:10px 14px;color:var(--fg)">${inner}</div>`;
  };
  page('chat', {
    title: '聊天', icon: 'chat', scope: 'device', wide: true, keywords: '思考 工具 展开 宽度 草稿 排队 拼写 对比 图表 点文件 删除 建议 示例 预览',
    desc: '回复怎样呈现，输入框怎样工作，代码和文件怎样显示。示例会跟着变化。',
    preview: () => chatPreview(),
    render() {
      const thinking = K.get('chat.think', true);
      const mode = K.get('chat.mode', 'chat');
      return withPreview(header(this) +
        sec('回复的呈现方式', cards('chat.mode', [
          { v: 'chat', l: '对话优先', d: '保留每段发言，中间的动作收成一行，需要时展开。', art: readArt('chat') },
          { v: 'time', l: '按时间展开', d: '文字和工具过程按发生顺序全部列出。', art: readArt('time') },
          { v: 'answer', l: '只看回答', d: '过程收成一组，回答完成后集中显示。', art: readArt('answer') },
        ], 'chat', { re: true }), { raw: true, after: `<div class="panel" style="margin-top:10px">${mode === 'chat' ? note('过程默认收起。下面的展开偏好在你打开过程后生效。', { inpanel: true }) : ''}${mode === 'answer' ? row('工作过程', seg('chat.activity', ['默认收起', '默认展开'])) : ''}${row('显示思考过程', sw('chat.think', true, { re: true }))}${row('思考时自动展开', sw('chat.thinkOpen', false), { sub: true, dim: !thinking, desc: '关闭时只用一行滚动显示最新的思考。' })}${row('默认展开命令输出', sw('chat.cmdOpen', false))}${row('默认展开文件修改', sw('chat.diffOpen', true))}${row('显示生成速度', sw('chat.speed', false), { desc: '在每段回复末尾显示每秒生成的字数。' })}</div>` }) +
        sec('阅读', row('对话宽度', seg('chat.width', ['紧凑', '适中', '舒展', '自定义'], '舒展', { re: true }), { desc: '消息和输入框一起调整；窗口较窄时自动适应。' }) +
          (K.get('chat.width', '舒展') === '自定义' ? row('自定义宽度', num('chat.px', 960, { unit: 'px' }), { sub: true }) : '') +
          row('我的消息显示为', seg('chat.mine', ['纯文本', 'Markdown'])) +
          row('折叠我发送的长消息', sw('chat.foldMine', true)) +
          row('滚动时固定当前提问', sw('chat.pin', true), { desc: '往下读回复时，提问停留在顶部。' }) +
          row('显示轮次导航', sw('chat.nav', true), { desc: '在右侧显示一条刻度，点击跳到对应的提问。' })) +
        sec('输入', row('在 Varin 里，工作进行中发送的消息', seg('chat.sendBot', ['补充当前任务', '排队'], '补充当前任务'), { desc: '补充会立刻交给正在进行的工作；排队会等这一轮结束再处理。' }) +
          row('在工作台里，工作进行中发送的消息', seg('chat.sendWb', ['补充当前任务', '排队'], '排队'), { desc: '示例的「输入」里可以试。' }) +
          row('每轮结束后建议下一句', `${sw('chat.next', false)}`, { desc: '灰字显示在输入框里，按 Tab 采用。使用的模型在「模型分工」里设置。' }) +
          row('任务没有进展时提醒我', num('chat.idle', 10, { unit: '分钟', ph: '不提醒' }), { desc: '留空表示不提醒。' }) +
          row('保留没发出去的草稿', sw('chat.draft', true)) +
          row('输入时检查拼写', sw('chat.spell', false)) +
          row('新对话里显示建议的开场', sw('chat.starters', true))) +
        sec('代码、图表与文件', row('文件对比', seg('chat.diff', ['自动', '行内', '并排']), { desc: '自动：宽度够时并排，窄时行内。' }) +
          row('图表显示为', seg('chat.chart', ['图形', '字符图'])) +
          row('代码长行自动换行', sw('chat.wrap', true)) +
          row('显示文件图标', sw('chat.ficon', true)) +
          row('每轮末尾汇总改动的文件', sw('chat.sum', true)) +
          row('能预览的文件先打开预览', sw('chat.preview', true), { desc: '例如 Markdown、图片和 HTML。' }) +
          row('显示以 . 开头的文件', sw('chat.dot', false))) +
        sec('确认', row('删除对话前先确认', sw('chat.confirmDel', true))));
    },
  });

  page('notifications', {
    title: '通知', icon: 'bell', scope: 'device', keywords: '提醒 推送 桌面通知',
    desc: '工作完成或需要你时，怎样提醒你。',
    render() {
      return header(this) +
        sec('', row('桌面通知', sw('n.on', true, { re: true }), { desc: 'Varin 不在前台时，用系统通知提醒你。' }) +
          row('推送到手机', sw('n.push', false), { desc: '通过已配对的 Varin 手机端推送。需要先在「远程访问」里配对手机。' })) +
        sec('示例', `<div style="display:flex;justify-content:center;padding:26px 0"><div style="width:340px;padding:12px 14px;border-radius:14px;background:var(--panel);box-shadow:var(--shadow-pop);display:flex;gap:11px;${K.get('n.on', true) ? '' : 'opacity:.4'}"><span style="width:30px;height:30px;border-radius:8px;background:var(--fg);color:var(--canvas);display:grid;place-items:center;flex:none;padding:6px">${MARK}</span><div><div style="font-weight:500">Varin · 发布页面</div><div class="muted" style="font-size:12.5px">页面改好了，需要你看一眼截图顺序。</div></div></div></div>`, { raw: true });
    },
  });

  /* 语音：朗读和识别各自选「在哪里处理」，再给出该方式需要的设置 */
  const STT = [
    { id: 'whisper-turbo', n: 'Whisper large-v3 Turbo', langs: 100, zh: true, en: true, mb: 564, def: true, st: 'ok' },
    { id: 'sensevoice', n: 'SenseVoice Small', langs: ['中文', '粤语', '英语', '日语', '韩语'], zh: true, en: true, mb: 166, st: 'ok' },
    { id: 'qwen3-asr', n: 'Qwen3-ASR 0.6B', langs: 30, zh: true, en: true, mb: 879 },
    { id: 'parakeet', n: 'Parakeet v3', langs: 25, zh: false, en: true, mb: 488, note: '欧洲语言' },
    { id: 'whisper-base', n: 'Whisper base', langs: 99, zh: true, en: true, mb: 208 },
    { id: 'whisper-tiny', n: 'Whisper tiny', langs: 99, zh: true, en: true, mb: 117 },
  ];
  const range = (k, d, o) => { const v = K.get(k, d); return `<span class="rangef"><input type="range" class="range" data-in="${k}" min="${o.min}" max="${o.max}" step="${o.step}" value="${v}" data-fmt="${o.fmt || ''}" aria-label="${esc(o.label || k)}"><span class="rv num">${o.fmt === '%' ? Math.round(v * 100) + '%' : o.fmt === 'x' ? (+v).toFixed(1) + '×' : v + (o.fmt || '')}</span></span>`; };
  window.K.range = range;
  ACTS['vm-pick'] = el => {
    const id = el.dataset.v; const m = STT.find(x => x.id === id);
    if (K.get('vm.st.' + id, m.st) === 'ok') { K.set('v.model', id); App.render(); App.flashSaved(); return; }
    let p = 0; K.set('vm.st.' + id, 'dl'); K.set('vm.p.' + id, 0); App.render();
    const t = setInterval(() => { p += 17; K.set('vm.p.' + id, Math.min(p, 100)); if (p >= 100) { clearInterval(t); K.set('vm.st.' + id, 'ok'); K.set('v.model', id); App.toast(m.n + ' 已下载，正在使用'); } if (S.page === 'voice') App.render(); }, 260);
  };
  ACTS['vm-del'] = el => { const id = el.dataset.v; K.set('vm.st.' + id, ''); if (K.get('v.model', 'whisper-turbo') === id) K.set('v.model', 'whisper-turbo'); App.render(); App.toast('已删除，需要时可以重新下载'); };

  page('voice', {
    title: '语音', icon: 'mic', scope: 'mixed', keywords: '朗读 听写 语音输入 识别 whisper 模型 下载 声音 语速 音高 音量 Kokoro OpenAI 静音',
    desc: '朗读回复和语音输入。两者都可以选择在哪里处理。',
    render() {
      const svc = S.host === 'local' ? 'studio-pc' : 'home-server';
      const read = K.get('v.read', true), tts = K.get('v.tts', 'browser');
      const ttsOpts = [
        { v: 'browser', l: '浏览器自带', d: '免费、离线；手机上支持有限' },
        { v: 'local', l: `Varin 服务本地合成`, d: `在 ${svc} 上运行 Kokoro，仅英语，不需要密钥` },
        { v: 'openai', l: 'OpenAI', d: '质量高，手机上也能用，需要 API Key' },
        { v: 'custom', l: '自定义服务', d: 'OpenAI 兼容的语音服务，例如自建 Kokoro' },
        { v: 'say', l: '系统朗读（macOS）', d: '快速、免费、离线' },
      ];
      const voices = { browser: ['自动', 'Microsoft Xiaoxiao', 'Microsoft Yunxi', 'Google 普通话'], local: ['af_heart', 'af_bella', 'am_adam', 'bf_emma'], openai: ['alloy', 'coral', 'nova', 'sage', 'verse'], say: ['Tingting', 'Meijia', 'Samantha'] };
      const preview = btn('试听', { sm: true, icon: 'volume', act: 'toast', v: '你好！这是现在的声音效果。' });
      const ttsRows = tts === 'custom'
        ? row('服务地址', txt('v.ttsUrl', '', { ph: 'http://localhost:8880/v1', w: 'wl', mono: true }), { sub: true }) + row('API Key', txt('v.ttsKey', '', { ph: '可选', type: 'password' }), { sub: true }) + row('模型', txt('v.ttsModel', '', { ph: 'speaches-ai/Kokoro-82M-v1.0-ONNX', w: 'wl', mono: true }), { sub: true }) + row('声音', `<span class="hstack">${txt('v.ttsVoice', '', { ph: '服务支持的声音标识' })}${preview}</span>`, { sub: true })
        : (tts === 'local' ? row('Kokoro 模型', `<span class="hstack"><span class="muted hstack" style="font-size:12.5px;gap:4px">${ic('check', 'xs')} 已下载 · 330 MB</span>${btn('删除', { k: 'ghost', sm: true, act: 'toast', v: '删除后，下次朗读时重新下载' })}</span>`, { sub: true, desc: `保存在 Varin 服务 ${svc} 上。` }) : '') +
          (tts === 'openai' ? row('API Key', txt('v.oaKey', '', { ph: '留空则使用「模型服务」里的 OpenAI 密钥', type: 'password', w: 'wl' }), { sub: true }) : '') +
          row('声音', `<span class="hstack">${dd('v.voice.' + tts, voices[tts])}${preview}</span>`, { sub: true });
      const stt = K.get('v.stt', 'local'), lang = K.get('v.lang', '自动检测');
      const cur = K.get('v.model', 'whisper-turbo');
      const fits = m => lang === '中文' ? m.zh : lang === 'English' ? m.en : lang === '日本語' ? m.langs === 99 || m.langs === 100 || (Array.isArray(m.langs) && m.langs.includes('日语')) || m.langs === 30 : true;
      const list = [...STT].sort((a, b) => fits(b) - fits(a));
      const installed = STT.filter(m => K.get('vm.st.' + m.id, m.st) === 'ok');
      const card = m => {
        const st = K.get('vm.st.' + m.id, m.st); const ok = fits(m); const on = cur === m.id;
        const langs = Array.isArray(m.langs) ? m.langs.join('、') : `${m.langs} 种语言${m.note ? ' · ' + m.note : ''}`;
        const foot = st === 'ok' ? `<span class="vm-ok">${ic('check', 'xs')}已下载</span><span class="faint">${m.mb} MB</span>${on ? '' : `<button class="btn ghost sm icon" data-act="vm-del" data-v="${m.id}" data-tip="删除模型文件" aria-label="删除">${ic('trash', 'sm')}</button>`}`
          : st === 'dl' ? `<span class="vm-bar"><i style="width:${K.get('vm.p.' + m.id, 0)}%"></i></span><span class="faint num">${K.get('vm.p.' + m.id, 0)}%</span>`
            : `<span class="faint">${ic('download', 'xs')} 选择后下载 · ${m.mb} MB</span>`;
        return `<div class="vm ${on ? 'on' : ''} ${ok ? '' : 'unfit'}" role="radio" aria-checked="${on}" tabindex="0" data-act="vm-pick" data-v="${m.id}" data-item="${esc(m.n)}"><div class="vm-h"><b>${esc(m.n)}</b>${m.def ? chip('默认') : ''}<span class="grow"></span><span class="radio"></span></div><div class="vm-l">${ok ? esc(langs) : `不支持${lang === 'English' ? '英语' : lang === '日本語' ? '日语' : '中文'} · ${esc(langs)}`}</div><div class="vm-f">${foot}</div></div>`;
      };
      return header(this) +
        sec('朗读', row('在回复上显示朗读按钮', sw('v.read', true, { re: true })) +
          (read ? row('声音来源', dd('v.tts', ttsOpts, 'browser', { re: true, w: 'wl' })) + ttsRows +
            row('语速', range('v.rate', 1, { min: 0.5, max: 2, step: 0.1, fmt: 'x', label: '语速' })) +
            row('音高', range('v.pitch', 1, { min: 0.5, max: 2, step: 0.1, fmt: 'x', label: '音高' })) +
            row('音量', range('v.vol', 1, { min: 0, max: 1, step: 0.1, fmt: '%', label: '音量' })) +
            row('朗读内容', seg('v.ttsMode', ['清理后的文本', '原始 Markdown', '先摘要再读']), { desc: '清理后的文本会去掉代码块、链接地址和格式符号。' }) : ''),
        { after: '<div class="faint" style="font-size:12px;margin:8px 2px 0">保存在此设备</div>' }) +
        sec('语音输入', row('启用语音输入', sw('v.in', true, { re: true }), { desc: `按 ${K.kbd('Ctrl+Shift+Space')} 开始；按住 Shift 点麦克风，切换连续听写。` }) +
          (K.get('v.in', true) ? row('在哪里识别', seg('v.stt', [{ v: 'local', l: 'Varin 服务本地识别' }, { v: 'server', l: '识别服务' }], 'local', { re: true }), { desc: stt === 'local' ? `声音发送到 Varin 服务 ${svc} 转写，不需要密钥。` : 'OpenAI 兼容的 Whisper 服务，支持任意语言。' }) +
            (stt === 'server'
              ? row('服务地址', txt('v.sttUrl', '', { ph: 'http://localhost:8000/v1', w: 'wl', mono: true }), { sub: true }) + row('API Key', txt('v.sttKey', '', { ph: '可选', type: 'password' }), { sub: true }) + row('模型', txt('v.sttModel', '', { ph: 'deepdml/faster-whisper-large-v3-turbo-ct2', w: 'wl', mono: true }), { sub: true }) +
                row('语言', txt('v.sttLang', '', { ph: '留空自动检测，例如 zh、en', w: 'ws' }), { sub: true }) +
                row('静音阈值', range('v.silence', -40, { min: -60, max: -20, step: 1, fmt: ' dB', label: '静音阈值' }), { sub: true, desc: '低于这个音量算作停顿。环境嘈杂时调高。' }) +
                row('停顿多久算说完', range('v.hold', 1200, { min: 500, max: 3000, step: 100, fmt: ' 毫秒', label: '停顿多久算说完' }), { sub: true })
              : row('主要说的语言', dd('v.lang', ['自动检测', '中文', 'English', '日本語'], '自动检测', { re: true }), { sub: true, desc: '下面的模型会按是否支持这种语言排序。' })) : ''),
        { after: '<div class="faint" style="font-size:12px;margin:8px 2px 0">保存在此设备</div>' }) +
        (K.get('v.in', true) && stt === 'local' ? sec('识别模型', `<div class="vms">${list.map(card).join('')}</div>`, { raw: true, desc: `已下载 ${installed.length} 个，共 ${installed.reduce((n, m) => n + m.mb, 0)} MB。模型保存在 Varin 服务 ${svc} 上，连接它的设备共用。` }) : '');
    },
  });

  page('shortcuts', {
    title: '快捷键', icon: 'keyboard', scope: 'device', keywords: '键盘 热键 绑定 快捷键',
    desc: '点一下快捷键就能重新录制。',
    render() {
      const f = (K.get('sc.q', '') || '').trim();
      return header(this, { acts: btn('全部恢复默认', { k: 'ghost', sm: true, act: 'toast', v: '已恢复全部默认快捷键' }) }) +
        `<div style="margin:-8px 0 18px">${K.txt('sc.q', '', { ph: '按名称或按键查找', w: 'wfull' })}</div>` +
        DATA.shortcuts.map(([g, list]) => { const rows = list.filter(([l, k]) => !f || l.includes(f) || k.toLowerCase().includes(f.toLowerCase())); return rows.length ? sec(g, rows.map(([l, k]) => `<div class="orow" data-item="${esc(l)}"><div class="grow ot">${esc(l)}</div><div class="oe"><button class="btn ghost sm hov" data-act="toast" data-v="已恢复默认">恢复默认</button><button class="hstack" data-act="toast" data-v="请按下新的组合键…" data-tip="点击后按下新的组合键" style="gap:4px">${kbd(k)}</button></div></div>`).join('')) : ''; }).join('');
    },
  });

  page('companion', {
    title: '桌宠', icon: 'smile', scope: 'device', desktopOnly: true, keywords: '桌宠 形象 唤醒 沉睡 下载',
    desc: '桌面上的陪伴形象。沉睡只收起形象，不影响正在进行的工作。',
    render() {
      const list = [['Varin', '默认形象', '已安装', true], ['Varin · 夏装', '换装', '38 MB'], ['研究助理', '另一个 Bot 的形象', '41 MB']];
      return header(this, { acts: btn('让它沉睡', { icon: 'moon', act: 'toast', v: '形象已收起，工作继续进行' }) }) +
        sec('形象', `<div class="cards" style="--n:3">${list.map(([n, d, s, on]) => `<div class="ocard" aria-checked="${!!on}"><div class="art" style="height:96px;display:grid;place-items:center;color:var(--faint)"><span style="width:40px;height:40px">${MARK}</span></div><div class="oh">${n}${on ? '<span class="radio"></span>' : ''}</div><div class="od">${d}</div><div>${on ? chip('使用中', 'primary') : btn('下载', { sm: true, icon: 'download', act: 'toast', v: '开始下载 ' + s })}</div></div>`).join('')}</div>`, { raw: true, desc: '基础安装只带轻量预览，完整形象按需下载。陪伴哪个 Bot 在桌宠菜单里选。' });
    },
  });
})();
