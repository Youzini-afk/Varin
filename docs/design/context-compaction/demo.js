/* Standalone interaction study. Timers below simulate demo states only. */
const $ = id => document.getElementById(id);
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const state = { scene: 'background', mode: 'dialogue', detail: true, overview: 'full', history: null, category: null, filter: 'all', replacement: null, playback: false, toolsOpen: false, queued: '', messages: [], timers: [], toastTimer: null };
const scenes = {
  normal: { header: '', percent: 42.8, tokens: '54,784', title: '尚未触发准备', description: '达到准备刻度后会在后台生成压缩结果，消息与工具继续执行。', badge: '自动', main: '正在处理文件操作', note: '占用条同时展示内容构成、准备线与替换／预留线。' },
  background: { header: '准备中', percent: 78.0, tokens: '99,840', title: '上下文压缩正在准备', description: '已触发后台准备，消息与工具操作照常进行。', badge: '后台', busy: true, main: '正在处理文件操作', note: '触发后，聊天中出现一行准备状态；后续消息和工具照常推进。' },
  ready: { header: '已就绪', percent: 79.2, tokens: '101,376', title: '压缩已准备好', description: '尚未到替换线。继续使用当前上下文，到线后自动替换。', badge: '待替换', main: '正在处理文件操作', note: '准备完毕不暂停任务，也不提前宣告替换完成。到线后直接使用已准备好的结果。' },
  waiting: { header: '等待压缩', percent: 86.1, tokens: '110,208', title: '正在压缩上下文，请稍等', description: '已到替换线，压缩结果尚未准备好。完成后立即替换，继续当前任务。', badge: '到线等待', busy: true, blocking: true, main: '等待上下文压缩', note: '只有到替换线仍未准备好才等待；可继续编辑输入，消息等待本任务恢复后处理。' },
  manual: { header: '准备中', percent: 56.3, tokens: '72,064', title: '上下文压缩正在准备', description: '你发起了这次准备。消息与工具照常执行，结果就绪后可替换。', badge: '手动', busy: true, main: '正在处理文件操作', note: '手动准备也有聊天状态反馈，准备期间不阻塞当前任务。' },
  applying: { header: '正在替换', percent: 85.0, tokens: '108,800', title: '正在替换上下文', description: '已到替换线，压缩结果已就绪，直接切换到新的上下文。', badge: '直接替换', main: '正在处理文件操作', note: '到线时已有压缩结果，直接替换，不增加“请稍等”的压缩等待阶段。' },
  applied: { header: '已替换', percent: 85.0, tokens: '108,800', title: '上下文压缩已完成替换', description: '当前任务已接着执行。新请求返回后更新总占用及内容构成。', badge: '已替换', pending: true, main: '正在处理文件操作', note: '聊天记录更新为“上下文压缩已完成替换”。此时展示上次计量，等待新请求的数据。' },
  continued: { header: '', percent: 28.4, tokens: '36,352', title: '上下文压缩已完成替换', description: '压缩结果已用于后续请求，当前占用及内容构成已更新。', badge: '已替换', main: '本轮已完成', note: '新请求到达后，彩色占用条更新；历史消息、摘要及用量仍可查看。' },
  softFailure: { header: '准备失败', percent: 78.0, tokens: '99,840', title: '压缩准备失败', description: '辅助模型请求失败，主任务仍在继续。可以重新准备。', badge: '后台', tone: 'warning', main: '正在处理文件操作', note: '未到替换线时，准备失败也不暂停主任务；保留状态和重试入口。' },
  failure: { header: '需要处理', percent: 86.1, tokens: '110,208', title: '上下文压缩失败', description: '已到替换线且压缩失败。重新准备成功后，替换上下文并继续。', badge: '已暂停', tone: 'error', blocking: true, main: '等待处理上下文', note: '到线后无法完成压缩时，明确显示当前请求暂停的原因与重试入口。' },
  stopped: { header: '已停止', percent: 86.1, tokens: '110,208', title: '整理已停止', description: '这次整理已取消。当前任务仍需新的上下文才能继续，可以重新整理。', badge: '已停止', blocking: true, main: '等待重新整理', note: '取消整理后保留真实的主任务状态，不把“取消成功”误写成“任务已继续”。' },
};
const windowTokens = 128000;
const composition = [
  { id: 'system', label: '系统提示词', value: 8704, description: '本次请求实际包含的平台指令、项目指令及行为约定。工具 schema 计入相应工具项。', parts: [['平台指令', .2353], ['项目与目录指令', .3971], ['Agent 指令', .3676]] },
  { id: 'user', label: '用户消息', value: 9984, description: '仍在上下文中的用户文本及其引用说明；已被摘要替代的旧消息不重复计算。', parts: [['消息正文', .9231], ['引用说明', .0769]] },
  { id: 'assistant', label: '助手消息', value: 24832, description: '本次请求保留的助手回复及可计量的思考内容；调用参数单独归入工具项。', parts: [['助手回复', .8247], ['可计量的思考', .1753]] },
  { id: 'tools', label: '工具调用', value: 28672, description: '内置工具的定义、调用参数与返回内容。MCP 在独立分类中统计。', parts: [['工具定义', .2857], ['调用参数', .1429], ['工具返回', .5714]] },
  { id: 'mcp', label: 'MCP', value: 12672, description: '本次请求包含的 MCP 工具定义、调用与结果，只计入这一分类。', parts: [['MCP 工具定义', .2828], ['调用参数', .1111], ['返回与资源内容', .6061]] },
  { id: 'summary', label: '历史摘要', value: 8960, description: '当前实际生效的摘要。尚未替换的候选摘要不计入这次请求。', parts: [['已生效摘要', 1]] },
  { id: 'other', label: '附件与其他', value: 6016, description: '附件、协议包装与暂未归类的内容。实际产品中无法计量的部分会标为未计量。', parts: [['附件内容', .8511], ['协议及其他内容', .1489]] },
];
const continuedValues = [8704, 2048, 3584, 8448, 4096, 8960, 512];
const format = number => number.toLocaleString('en-US');
function currentScene() { return state.scene === 'applied' && state.replacement ? { ...scenes.applied, ...state.replacement } : scenes[state.scene]; }
function currentComposition() {
  const total = Number(currentScene().tokens.replaceAll(',', ''));
  let remainder = total;
  return composition.map((item, index) => {
    const fixed = item.id === 'system' || item.id === 'summary';
    const value = state.scene === 'continued' ? continuedValues[index] : index === composition.length - 1 ? remainder
      : fixed ? item.value : Math.round(item.value / (99840 - 17664) * (total - 17664));
    remainder -= value;
    return { ...item, value, percent: value / windowTokens * 100 };
  });
}
const historyMessages = [
  { id: 'msg-112', role: 'tools', label: '工具', time: '10:34', preview: 'file_read · ChatFileMenu.tsx', text: '读取文件成功，返回第 1–83 行。', raw: { name: 'file_read', arguments: { path: 'packages/ui/src/components/conversation/ChatFileMenu.tsx' }, outcome: 'succeeded' } },
  { id: 'msg-111', role: 'assistant', label: '助手', time: '10:34', preview: '文件入口的来源已经确认。', text: '工具结果会保留原任务的目录，正文中的链接沿用它解析出的路径。', raw: { role: 'assistant', content: '文件入口的来源已经确认。工具结果会保留原任务的目录。' } },
  { id: 'msg-110', role: 'mcp', label: 'MCP', time: '10:33', preview: 'GitHub · 读取文件服务相关讨论', text: '返回与文件菜单和远程 Host 来源处理相关的讨论记录。', raw: { server: 'github', tool: 'get_issue', result: { title: 'Preserve source identity for file actions', state: 'open' } } },
  { id: 'msg-109', role: 'user', label: '用户', time: '10:31', preview: '把聊天里的文件右键菜单补齐…', text: '把聊天里的文件右键菜单补齐，远程 Host 下也要处理好。', raw: { role: 'user', content: '把聊天里的文件右键菜单补齐，远程 Host 下也要处理好。' } },
];
const summaries = {
  current: `<h4>任务与约定</h4><p>补齐聊天中文件的右键菜单，沿用现有菜单样式、应用图标和展开动效。正文链接与工具结果都应保留各自的文件来源。</p><h4>已确认</h4><ul><li>正文链接已有解析后的文件路径；工具结果通过所属会话的 <code>fileTarget</code> 取得来源。</li><li>现有桌面应用列表可以提供编辑器和图标，选择一次打开方式不修改默认偏好。</li></ul><h4>接下来</h4><p>接入另存为、复制文件内容和系统文件管理器定位。注意任务隔离副本以及远程 Host 的路径归属。</p>`,
  next: `<h4>用户目标</h4><p>聊天文件右键菜单提供：打开文件、在常用编辑器打开、打开方式、另存为、复制路径、复制文件内容、在文件管理器中显示。</p><h4>已完成的工作</h4><ul><li>正文与工具文件入口已对齐。<code>ToolFileLink</code> 保留所属任务的来源解析器，嵌套检索也使用自己的来源。</li><li>编辑器列表、图标和首选应用沿用已有桌面服务。“打开方式”仅影响这一次操作。</li><li>菜单已有分组、悬浮反馈和子菜单，保持现有主题及动效。</li></ul><h4>当前实现位置</h4><p><code>ChatContextMenu.tsx</code> 负责捕获目标，<code>ChatFileMenu.tsx</code> 负责操作；文件下载经 Files，文本读取经 Documents。</p><h4>继续执行</h4><ul><li>补齐原始文件下载与完整文本复制。</li><li>确认操作保留文件原来的目录，Host 切换后不执行过期结果。</li><li>对菜单行为和下载字节做必要检查，完成后提交并推送。</li></ul><h4>保留的约束</h4><p>不覆盖用户草稿，不修改默认打开应用；远程路径不交给本机编辑器。当前没有要求打包 EXE。</p>`,
  older: `<h4>本次讨论的范围</h4><p>用户希望聊天中的文件菜单接近桌面应用体验，补充编辑器打开方式、另存为和文件内容复制。</p><h4>设计偏好</h4><p>沿用现有控件与动效，菜单保持紧凑。文件相关操作应直接可达，打开方式使用子菜单。</p><h4>尚待确认</h4><p>定位正文文件链接和工具结果的打开入口，确认可以复用哪些桌面应用与文件服务。</p>`,
};
const tools = [ ['file', '读取 ChatContextMenu.tsx'], ['file', '读取 MarkdownRendererImpl.tsx'], ['search', '搜索 fileTarget'], ['file', '读取 ChatResourceTools.tsx'], ['search', '搜索 openDesktopFileInApp'], ['file', '读取 OpenInAppButton.tsx'] ];
const toolList = () => tools.map(([name, text]) => `<div class="tool-line">${icon(name)}<span>${text}</span><small>已完成</small></div>`).join('');
function activityGroup(label, open = state.toolsOpen) {
  return `<div class="chat-activity"><button class="activity-toggle" data-action="tools" aria-expanded="${open}" aria-controls="tools-fold">${icon('arrow', 'chevron')}<span>${label}</span></button><div class="fold ${open ? 'open' : ''}" id="tools-fold" ${open ? '' : 'inert'}><div><div class="activity-list">${state.mode === 'sorted' ? '<p class="sorted-thought">文件打开的关键是保留每个入口的来源，再复用现有文件服务。</p>' : ''}${toolList()}</div></div></div></div>`;
}
function eventLine(scene) {
  if (state.scene === 'normal') return '';
  if (['applied', 'continued'].includes(state.scene)) return `<div class="context-event applied"><button class="context-line" data-action="open-context">${icon('stack')}<span>上下文压缩已完成替换</span>${icon('arrow', 'trailing-arrow')}</button></div>`;
  const text = state.scene === 'failure' ? '上下文压缩失败，等待处理' : state.scene === 'softFailure' ? '上下文压缩准备失败'
    : state.scene === 'stopped' ? '上下文压缩已停止' : state.scene === 'applying' ? '压缩已就绪，正在替换上下文'
      : state.scene === 'ready' ? '上下文压缩已准备好，等待替换' : scene.blocking ? '正在压缩上下文，请稍等…' : '上下文压缩正在准备';
  return `<div class="context-event ${scene.blocking ? 'blocking' : 'background-event'}" data-tone="${scene.tone || ''}"><button class="context-line" data-action="open-context">${scene.busy ? '<span class="spinner"></span>' : icon(scene.tone ? 'warning' : state.scene === 'ready' ? 'check' : 'stack')}<span>${text}</span>${icon('arrow', 'trailing-arrow')}</button>${scene.blocking ? '<p class="context-subtext">已到替换线，压缩完成后替换并继续。</p>' : ''}${['failure', 'stopped'].includes(state.scene) ? `<div class="event-actions"><button class="button" data-action="retry">重新准备</button><button class="text-button" data-action="open-context">查看详情</button></div>` : ''}</div>`;
}
function renderChat() {
  const scene = currentScene();
  const first = '<p class="assistant-text">我先把正文和工具结果中的文件入口对齐，再接现有的文件操作。</p>';
  const second = '<p class="assistant-text">文件入口的来源已经确认。工具结果会保留原任务的目录，正文中的链接沿用它解析出的路径。</p>';
  const activity = state.mode === 'live' ? `<div class="live-tools">${toolList()}</div>` : activityGroup(state.mode === 'sorted' ? '过程 · 6 次工具调用' : '读取了 4 个文件 · 搜索了 2 次');
  let html = '<div class="user-message">把聊天里的文件右键菜单补齐，远程 Host 下也要处理好。</div>';
  html += state.mode === 'sorted' ? first + second + activity : first + activity + second;
  if (scene.blocking) html += eventLine(scene);
  else {
    // The preparation notice sits before subsequent assistant work, showing concurrency.
    html = html.replace(second, eventLine(scene) + second);
  }
  if (['applied', 'continued'].includes(state.scene)) html += '<p class="assistant-text">接下来补上另存为和复制内容，并检查切换 Host 后的行为。</p>';
  if (!scene.blocking && state.scene !== 'continued') html += '<div class="activity-current"><span class="spinner"></span><span>正在读取 <span class="muted">ChatFileMenu.tsx</span></span></div>';
  if (state.scene === 'continued') html += `<p class="assistant-text">文件菜单已补齐。正文与工具结果共用相同操作，复制读取完整文本，另存为保留原始文件。</p><div class="turn-footer"><div class="turn-actions">${icon('copy')}${icon('history')}${icon('more')}</div><div class="turn-usage"><span>↓ 36,352</span><span>↑ 1,486</span><span>缓存率 82.4%</span></div></div>`;
  html += state.messages.map(message => `<div class="user-message bubble-reply">${escape(message)}</div>`).join('');
  const viewport = $('chat-scroll'); const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 36;
  $('transcript').innerHTML = html;
  if (atBottom) requestAnimationFrame(() => viewport.scrollTop = viewport.scrollHeight);
  if ($('transcript').animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const line = $('transcript').querySelector('.context-event') || $('transcript').querySelector('.activity-current');
    line?.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
function action(label, name, primary = false) { return `<button class="button ${primary ? 'primary' : 'subtle'}" data-action="${name}">${label}</button>`; }
function highlightCategory(id, tooltip = false) {
  $('budget').dataset.highlight = id || '';
  document.querySelectorAll('[data-category]').forEach(button => {
    button.dataset.highlighted = String(button.dataset.category === id);
  });
  $('bar-tooltip').hidden = !id || !tooltip;
  if (id && tooltip) {
    const items = currentComposition(), index = items.findIndex(item => item.id === id), item = items[index];
    const left = items.slice(0, index).reduce((sum, part) => sum + part.percent, 0) + item.percent / 2;
    $('bar-tooltip').style.left = `${Math.max(25, Math.min(75, left))}%`;
    $('bar-tooltip').textContent = `${item.label} · ${format(item.value)} · ${item.percent.toFixed(1)}%`;
  }
}
function renderComposition() {
  if (!$('budget-segments').children.length) {
    $('budget-segments').innerHTML = composition.map(item => `<button type="button" class="budget-segment" data-category="${item.id}" style="--category-color:var(--category-${item.id})" aria-controls="category-fold"></button>`).join('');
    $('composition-legend').innerHTML = composition.map(item => `<button type="button" class="legend-item" data-category="${item.id}" style="--category-color:var(--category-${item.id})" aria-controls="category-fold"><i></i><span>${item.label}</span><b></b></button>`).join('');
    for (const button of document.querySelectorAll('[data-category]')) {
      const highlight = () => highlightCategory(button.dataset.category, button.classList.contains('budget-segment'));
      button.addEventListener('pointerenter', highlight); button.addEventListener('focus', highlight);
      button.addEventListener('pointerleave', () => highlightCategory(state.category)); button.addEventListener('blur', () => highlightCategory(state.category));
    }
  }
  for (const item of currentComposition()) {
    const label = `${item.label}：${format(item.value)} token，占窗口 ${item.percent.toFixed(1)}%`;
    for (const button of document.querySelectorAll(`[data-category="${item.id}"]`)) {
      button.setAttribute('aria-label', label); button.setAttribute('aria-expanded', String(item.id === state.category));
      if (button.classList.contains('budget-segment')) button.style.width = item.percent + '%';
      else { button.querySelector('b').textContent = item.percent.toFixed(1) + '%'; button.title = label; }
    }
  }
  const selected = currentComposition().find(item => item.id === state.category);
  $('category-fold').classList.toggle('open', !!selected); $('category-fold').inert = !selected;
  if (selected) {
    $('category-title').textContent = `${selected.label} · ${format(selected.value)} token`;
    $('category-description').textContent = selected.description;
    let rest = selected.value;
    $('category-parts').innerHTML = selected.parts.map(([label, ratio], index) => {
      const value = index === selected.parts.length - 1 ? rest : Math.round(selected.value * ratio); rest -= value;
      return `<div><span>${label}</span><b>${format(value)}</b></div>`;
    }).join('');
  }
  highlightCategory(state.category);
}
function renderRequestUsage() {
  const total = Number(currentScene().tokens.replaceAll(',', ''));
  const output = state.scene === 'continued' ? 1486 : 4096, input = total - output;
  const metrics = [['输入', input], ['输出', output], ['缓存读取', Math.round(input * .824)], ['缓存创建', 1536]];
  $('request-usage').innerHTML = metrics.map(([label, value]) => `<div><span>${label}</span><b>${format(value)}</b></div>`).join('');
}
function renderMessages() {
  const items = historyMessages.filter(message => state.filter === 'all' || message.role === state.filter);
  $('message-list').innerHTML = items.map(message => `<article class="message-item"><button class="message-trigger" data-message="${message.id}" aria-expanded="false" aria-controls="${message.id}"><span class="message-role" style="--category-color:var(--category-${message.role})">${message.label}</span><span>${escape(message.preview)}</span><small>${message.time}</small>${icon('arrow', 'chevron')}</button><div class="fold" id="${message.id}" inert><div><div class="message-body"><p>${escape(message.text)}</p><details><summary>原始数据</summary><pre>${escape(JSON.stringify(message.raw, null, 2))}</pre></details></div></div></div></article>`).join('');
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)));
}
function renderPanel() {
  const scene = currentScene(), history = state.history;
  const completed = ['applied', 'continued'].includes(state.scene);
  const candidate = state.scene === 'ready';
  $('history-back').hidden = !history; $('return-current').hidden = !history;
  $('panel-title').textContent = history ? '整理记录' : '上下文';
  $('detail-kicker').textContent = history ? `今天 · ${history === 'older' ? '09:32' : '10:08'}` : '上下文压缩';
  $('detail-badge').textContent = history ? '已替换' : scene.badge;
  $('detail-title').firstChild.textContent = history ? '已应用的摘要' : scene.title;
  $('detail-description').textContent = history ? '这次整理已用于当时的后续请求。当前任务使用更新后的上下文。' : scene.description;
  $('state-motion').hidden = !!history || !scene.busy;
  document.querySelector('.current-state').dataset.tone = history ? '' : scene.tone || '';
  $('state-actions').innerHTML = history ? '' : candidate ? action('提前替换', 'apply')
    : ['softFailure', 'failure', 'stopped'].includes(state.scene) ? action('重新准备', 'retry', true)
    : scene.busy && state.scene !== 'applying' ? action('停止准备', 'stop') : state.scene === 'normal' ? action('手动准备', 'manual') : '';
  $('context-session').hidden = !!history; $('request-section').hidden = !!history; $('messages-section').hidden = !!history;
  $('budget').hidden = !!history;
  $('budget').dataset.pending = String(!!scene.pending);
  $('budget-label').textContent = scene.pending ? '替换前的上下文' : '当前上下文占用';
  $('budget-tokens').textContent = scene.tokens;
  $('budget-percent').innerHTML = scene.pending ? '待计量' : scene.percent.toFixed(1) + '<small>%</small>';
  $('budget-distance').textContent = scene.pending ? `上次占用 ${scene.percent.toFixed(1)}%` : scene.percent >= 85 ? '已到替换线' : `距替换线还有 ${(85 - scene.percent).toFixed(1)}%`;
  $('budget-distance').classList.toggle('at-boundary', !scene.pending && scene.percent >= 85);
  $('budget-note').hidden = !scene.pending;
  renderComposition(); renderRequestUsage();
  $('summary-title').textContent = history ? '本次摘要' : candidate ? '准备好的新摘要' : '当前生效的摘要';
  $('summary-meta').textContent = history ? '历史版本' : candidate ? '尚未应用 · 当前任务仍使用上次摘要' : completed ? '本次整理 · 已应用' : '上次整理 · 10:08';
  const key = history === 'older' ? 'older' : history === 'recent' ? 'current' : completed || candidate ? 'next' : 'current';
  if ($('summary-body').dataset.key !== key) { $('summary-body').innerHTML = summaries[key]; $('summary-body').dataset.key = key; }
  $('process-status').textContent = history ? '已完成' : scene.busy ? state.scene === 'applying' ? '等待应用' : '生成摘要中' : scene.tone ? '请求失败' : state.scene === 'stopped' ? '已停止' : '已完成';
  $('process-time').textContent = history ? '已完成' : scene.busy ? '正在生成' : scene.tone ? '服务暂时不可用' : '已结束';
  $('thinking-trigger').hidden = !history && !!scene.tone;
  $('thinking-fold').hidden = !history && !!scene.tone;
  document.querySelector('.output-label').textContent = !history && scene.tone ? '错误详情' : '摘要输出';
  $('stream-caret').hidden = !!history || !scene.busy || state.scene === 'applying';
  $('process-output').textContent = history ? '已完成对该段历史的整理，生成的摘要见上方。' : scene.tone ? '请求失败：辅助模型服务返回 503，未产生新的完整摘要。' : '目标：补齐聊天文件菜单。已确认 ToolFileLink 持有所属任务的来源；正文文件链接已有解析路径。接下来接入原始文件下载与文本复制。';
  document.querySelector('.process-section').hidden = state.scene === 'normal' && !history;
  document.querySelector('.history-section').hidden = !!history;
}
function render() {
  const scene = currentScene();
  if ([...$('scene').options].some(option => option.value === state.scene)) $('scene').value = state.scene;
  $('header-usage').textContent = scene.pending ? '上下文' : scene.percent.toFixed(1) + '%';
  $('header-status').textContent = scene.header; $('header-status').hidden = !scene.header;
  document.querySelector('.entry-separator').hidden = !scene.header;
  $('usage-ring').className = `usage-ring${scene.busy ? ' busy' : ''}${scene.tone ? ' failed' : ''}`;
  $('overview-status').textContent = scene.main;
  $('overview-dot').style.background = scene.blocking && scene.tone ? 'var(--warning)' : state.scene === 'continued' ? 'var(--green)' : 'var(--accent)';
  $('overview-context-status').textContent = scene.header || scene.percent.toFixed(1) + '%';
  $('composer-caption').textContent = scene.blocking ? '可以继续输入，消息将在任务恢复后处理' : '';
  $('scene-note').textContent = scene.note;
  renderChat(); renderPanel();
}
function stopPlayback() {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers = []; state.playback = false;
  $('play').innerHTML = icon('play') + '<span>播放一次</span>';
}
function changeScene(scene, stop = true) {
  if (stop) stopPlayback();
  if (scene === 'applied' && state.scene !== 'applied') {
    const before = currentScene().percent >= 85 ? currentScene() : scenes.applying;
    state.replacement ??= { tokens: before.tokens, percent: before.percent };
  } else if (scene !== 'applied') state.replacement = null;
  if (state.queued && ['applied', 'continued'].includes(scene)) {
    state.messages.push(state.queued); state.queued = ''; $('queued').hidden = true;
  }
  state.scene = scene; render();
}
function panel(open, history = null) {
  state.detail = open; state.history = history;
  $('app').dataset.detail = String(open); $('context-entry').setAttribute('aria-expanded', String(open));
  $('context-slot').inert = !open; $('context-slot').setAttribute('aria-hidden', String(!open));
  document.querySelector('.resource-rail [data-action="open-context"]').classList.toggle('active', open);
  $('overview-slot').inert = open || state.overview === 'closed';
  renderPanel();
  if (!open) $('context-entry').focus({ preventScroll: true });
}
function setOverview(view) {
  if (state.detail) panel(false);
  state.overview = view; $('app').dataset.overview = view;
  $('overview-slot').inert = view === 'closed';
}
function fold(id, trigger) {
  const element = $(id), open = !element.classList.contains('open');
  element.classList.toggle('open', open); element.inert = !open;
  trigger.setAttribute('aria-expanded', String(open));
}
function toast(message) {
  clearTimeout(state.toastTimer); $('toast').textContent = message; $('toast').classList.add('visible');
  state.toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 2300);
}
async function copySummary() {
  const text = $('summary-body').innerText || $('summary-body').textContent;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text); toast('摘要已复制');
  } catch { toast('当前预览环境不支持剪贴板，可以选中摘要复制'); }
}
function apply() {
  stopPlayback(); const before = currentScene(); state.replacement = { tokens: before.tokens, percent: before.percent };
  changeScene('applied', false);
}
function retry() {
  const blocking = scenes[state.scene].blocking; stopPlayback();
  changeScene(blocking ? 'waiting' : 'background', false);
  state.timers.push(setTimeout(() => changeScene(blocking ? 'applied' : 'ready', false), 3000));
}
$('scene').addEventListener('change', event => changeScene(event.target.value));
$('play-path').addEventListener('change', stopPlayback);
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { toast('可以放大预览窗口，查看聊天与上下文详情的并排布局'); }
});
document.addEventListener('fullscreenchange', () => { $('fullscreen').textContent = document.fullscreenElement ? '退出全屏' : '全屏预览'; });
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark'; document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  $('theme').innerHTML = icon(dark ? 'moon' : 'sun') + `<span>${dark ? '暗色' : '亮色'}</span>`;
});
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  state.mode = button.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  renderChat();
}));
$('design-notes').addEventListener('click', event => fold('notes', event.currentTarget));
$('context-entry').addEventListener('click', () => panel(!state.detail));
$('play').addEventListener('click', () => {
  if (state.playback) { stopPlayback(); return; }
  stopPlayback(); state.playback = true; state.history = null;
  $('play').innerHTML = icon('stop') + '<span>停止播放</span>';
  changeScene('background', false);
  const steps = $('play-path').value === 'late'
    ? [[3200, 'waiting'], [7200, 'applied'], [10200, 'continued']]
    : [[3200, 'ready'], [6400, 'applied'], [9400, 'continued']];
  for (const [delay, scene] of steps) {
    state.timers.push(setTimeout(() => { changeScene(scene, false); if (scene === 'continued') stopPlayback(); }, delay));
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.category) {
    state.category = state.category === button.dataset.category ? null : button.dataset.category;
    renderComposition(); return;
  }
  if (button.dataset.filter) { state.filter = button.dataset.filter; renderMessages(); return; }
  if (button.dataset.message) { fold(button.dataset.message, button); return; }
  if (button.dataset.history) { panel(true, button.dataset.history); $('panel-scroll').scrollTop = 0; $('history-back').focus({ preventScroll: true }); return; }
  switch (button.dataset.action) {
    case 'open-context': panel(true); break;
    case 'close-context': panel(false); break;
    case 'overview-full': setOverview('full'); break;
    case 'overview-compact': setOverview(state.overview === 'compact' && !state.detail ? 'full' : 'compact'); break;
    case 'overview-close': setOverview('closed'); break;
    case 'history-back': state.history = null; renderPanel(); $('panel-scroll').scrollTop = 0; $('history-trigger').focus({ preventScroll: true }); break;
    case 'expand-summary': {
      const expanded = !$('summary-preview').classList.contains('expanded');
      $('summary-preview').classList.toggle('expanded', expanded); button.setAttribute('aria-expanded', String(expanded));
      button.innerHTML = (expanded ? '收起摘要' : '展开摘要') + icon('down'); break;
    }
    case 'process': fold('process-fold', button); break;
    case 'thinking': fold('thinking-fold', button); break;
    case 'history': fold('history-fold', button); break;
    case 'close-category': {
      const previous = state.category; state.category = null; renderComposition();
      document.querySelector(`.legend-item[data-category="${previous}"]`)?.focus({ preventScroll: true }); break;
    }
    case 'request-usage': fold('request-usage-fold', button); break;
    case 'messages': fold('messages-fold', button); break;
    case 'tools': fold('tools-fold', button); state.toolsOpen = button.getAttribute('aria-expanded') === 'true'; break;
    case 'copy-summary': void copySummary(); break;
    case 'apply': apply(); break;
    case 'retry': retry(); break;
    case 'manual': changeScene('manual'); break;
    case 'stop': {
      const blocking = scenes[state.scene].blocking; changeScene(blocking ? 'stopped' : 'normal');
      if (!blocking) toast('后台整理已停止，当前任务继续'); break;
    }
    case 'remove-queue': $('draft').value = state.queued; state.queued = ''; $('queued').hidden = true; $('draft').focus(); break;
  }
});
$('composer').addEventListener('submit', event => {
  event.preventDefault(); const value = $('draft').value.trim(); if (!value) return;
  if (scenes[state.scene].blocking) {
    state.queued = state.queued ? `${state.queued}\n${value}` : value; $('queued-text').textContent = `等待发送：${state.queued}`; $('queued').hidden = false;
  } else { state.messages.push(value); renderChat(); toast('消息已发送（设计演示）'); }
  $('draft').value = '';
});
$('draft').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.detail && event.target !== $('draft')) { event.preventDefault(); panel(false); }
});
render(); renderMessages(); $('overview-slot').inert = true;
