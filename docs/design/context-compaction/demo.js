/* Standalone interaction study. Timers below simulate demo states only. */
const $ = id => document.getElementById(id);
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const state = { scene: 'waiting', mode: 'dialogue', detail: true, overview: 'full', history: null, playback: false, toolsOpen: false, queued: '', messages: [], timers: [], toastTimer: null };
const scenes = {
  normal: { header: '', percent: 42.8, tokens: '54,784', title: '上下文空间充足', description: '当前任务正常进行。达到准备水位后，会在后台整理较早的对话。', badge: '当前', main: '正在处理文件操作', note: '平时沿用上下文占用入口，不在聊天中持续展示管理信息。' },
  background: { header: '整理中', percent: 78.0, tokens: '99,840', title: '正在后台整理', description: '摘要准备好后，会在需要腾出空间时应用。Agent 正在继续当前任务。', badge: '后台', busy: true, main: '正在处理文件操作', note: '后台准备只在顶部和概览的上下文入口提示，主任务继续推进。' },
  ready: { header: '摘要就绪', percent: 79.2, tokens: '101,376', title: '新摘要已就绪', description: '需要腾出空间时会自动应用。你也可以现在应用，切换将在当前请求与工具结束后进行。', badge: '待应用', main: '正在处理文件操作', note: '生成完成与正式应用分开呈现。新摘要可以先阅读，不会被误标成当前已生效。' },
  waiting: { header: '整理中', percent: 86.1, tokens: '110,208', title: '正在整理上下文', description: '当前请求正在等待摘要。完成后，Agent 会接着当前任务继续。', badge: '等待', busy: true, blocking: true, main: '等待上下文整理', note: '主任务等待时，在当前执行位置明确说明原因。输入框仍可编辑，消息可排队。' },
  manual: { header: '整理中', percent: 56.3, tokens: '72,064', title: '正在整理上下文', description: '你发起了这次整理。原有摘要会保留到新摘要正式应用。', badge: '手动', busy: true, main: '正在整理上下文', note: '主动触发有即时反馈；聊天里的状态行和右侧详情指向同一次整理。' },
  applying: { header: '正在应用', percent: 86.1, tokens: '110,208', title: '正在应用新摘要', description: '等待当前请求与工具执行结束后，切换到新的上下文。', badge: '应用中', busy: true, main: '正在应用新摘要', note: '状态在原位置过渡；正式发布后才显示“已应用”。' },
  applied: { header: '已更新', percent: 86.1, tokens: '110,208', title: '上下文已更新', description: '新摘要已应用，Agent 已继续处理文件操作。下一次请求返回后更新占用。', badge: '已应用', pending: true, main: '正在处理文件操作', note: '完成后收成聊天里的轻量记录。新的完整占用尚未计量，不展示虚构的压缩比。' },
  continued: { header: '', percent: 28.4, tokens: '36,352', title: '上下文已更新', description: '新摘要已用于后续请求。下面显示该请求实际报告的上下文占用。', badge: '已应用', main: '本轮已完成', note: '后续请求返回实际用量后，再更新占用比例；完成记录仍可定位到本次摘要。' },
  softFailure: { header: '准备失败', percent: 78.0, tokens: '99,840', title: '后台整理未完成', description: '辅助模型请求暂时失败，当前任务仍在继续。可以重新准备摘要。', badge: '后台', tone: 'warning', main: '正在处理文件操作', note: '后台准备失败保持轻量提示，不把仍在进行的主任务显示为失败。' },
  failure: { header: '需要处理', percent: 86.1, tokens: '110,208', title: '上下文整理失败', description: '辅助模型请求失败，当前任务暂时停在这里。重新整理成功后可以继续。', badge: '已暂停', tone: 'error', blocking: true, main: '等待处理上下文', note: '影响继续执行时，失败留在聊天当前执行位置，并给出对应的恢复操作。' },
  stopped: { header: '已停止', percent: 86.1, tokens: '110,208', title: '整理已停止', description: '这次整理已取消。当前任务仍需新的上下文才能继续，可以重新整理。', badge: '已停止', blocking: true, main: '等待重新整理', note: '取消整理后保留真实的主任务状态，不把“取消成功”误写成“任务已继续”。' },
};
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
  if (['normal', 'background', 'ready', 'softFailure'].includes(state.scene)) return '';
  if (['applied', 'continued'].includes(state.scene)) return `<div class="context-event applied"><button class="context-line" data-action="open-context">${icon('stack')}<span>上下文已整理</span>${icon('arrow', 'trailing-arrow')}</button></div>`;
  let text = state.scene === 'failure' ? '上下文整理失败，任务暂时停止' : state.scene === 'stopped' ? '整理已停止，任务等待继续' : state.scene === 'applying' ? '正在应用摘要，等待当前执行结束' : '正在整理上下文，完成后继续';
  return `<div class="context-event" data-tone="${scene.tone || ''}"><button class="context-line" data-action="open-context">${scene.busy ? '<span class="spinner"></span>' : icon(scene.tone ? 'warning' : 'stack')}<span>${text}</span>${icon('arrow', 'trailing-arrow')}</button>${scene.tone ? '<p class="context-subtext">辅助模型服务暂时不可用。</p>' : ''}${['failure', 'stopped'].includes(state.scene) ? `<div class="event-actions"><button class="button" data-action="retry">重新整理</button><button class="text-button" data-action="open-context">查看详情</button></div>` : ''}</div>`;
}
function renderChat() {
  const scene = scenes[state.scene];
  const first = '<p class="assistant-text">我先把正文和工具结果中的文件入口对齐，再接现有的文件操作。</p>';
  const second = '<p class="assistant-text">文件入口的来源已经确认。工具结果会保留原任务的目录，正文中的链接沿用它解析出的路径。</p>';
  const activity = state.mode === 'live' ? `<div class="live-tools">${toolList()}</div>` : activityGroup(state.mode === 'sorted' ? '过程 · 6 次工具调用' : '读取了 4 个文件 · 搜索了 2 次');
  let html = '<div class="user-message">把聊天里的文件右键菜单补齐，远程 Host 下也要处理好。</div>';
  html += state.mode === 'sorted' ? first + second + activity : first + activity + second;
  html += eventLine(scene);
  if (['applied', 'continued'].includes(state.scene)) html += '<p class="assistant-text">接下来补上另存为和复制内容，并检查切换 Host 后的行为。</p>';
  if (!scene.blocking && !['manual', 'applying', 'continued'].includes(state.scene)) html += '<div class="activity-current"><span class="spinner"></span><span>正在读取 <span class="muted">ChatFileMenu.tsx</span></span></div>';
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
function renderPanel() {
  const scene = scenes[state.scene], history = state.history;
  const completed = ['applied', 'continued'].includes(state.scene);
  const candidate = state.scene === 'ready';
  $('history-back').hidden = !history; $('return-current').hidden = !history;
  $('panel-title').textContent = history ? '整理记录' : '上下文';
  $('detail-kicker').textContent = history ? `今天 · ${history === 'older' ? '09:32' : '10:08'}` : '本次上下文';
  $('detail-badge').textContent = history ? '已应用' : scene.badge;
  $('detail-title').firstChild.textContent = history ? '已应用的摘要' : scene.title;
  $('detail-description').textContent = history ? '这次整理已用于当时的后续请求。当前任务使用更新后的上下文。' : scene.description;
  $('state-motion').hidden = !!history || !scene.busy;
  document.querySelector('.current-state').dataset.tone = history ? '' : scene.tone || '';
  $('state-actions').innerHTML = history ? '' : candidate ? action('立即应用', 'apply', true)
    : ['softFailure', 'failure', 'stopped'].includes(state.scene) ? action('重新整理', 'retry', true)
    : scene.busy && state.scene !== 'applying' ? action('停止整理', 'stop') : state.scene === 'normal' ? action('现在整理', 'manual') : '';
  $('budget').hidden = !!history;
  $('budget').dataset.pending = String(!!scene.pending);
  $('budget-label').textContent = scene.pending ? '应用前的最近请求' : '最近一次请求';
  $('budget-tokens').textContent = scene.tokens;
  $('budget-percent').textContent = scene.percent.toFixed(1) + '%';
  $('budget-fill').style.transform = `scaleX(${scene.percent / 100})`;
  $('budget-note').textContent = scene.pending ? '新上下文待计量 · 下一次请求返回后更新' : '准备：可用输入的 75% · 预留：总窗口的 15%';
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
  const scene = scenes[state.scene];
  if ([...$('scene').options].some(option => option.value === state.scene)) $('scene').value = state.scene;
  $('header-usage').textContent = scene.pending ? '上下文' : scene.percent.toFixed(1) + '%';
  $('header-status').textContent = scene.header; $('header-status').hidden = !scene.header;
  document.querySelector('.entry-separator').hidden = !scene.header;
  $('usage-ring').className = `usage-ring${scene.busy ? ' busy' : ''}${scene.tone ? ' failed' : ''}`;
  $('overview-status').textContent = scene.main;
  $('overview-dot').style.background = scene.tone ? 'var(--warning)' : state.scene === 'continued' ? 'var(--green)' : 'var(--accent)';
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
function apply() { stopPlayback(); changeScene('applying', false); state.timers.push(setTimeout(() => changeScene('applied', false), 2200)); }
function retry() {
  const blocking = scenes[state.scene].blocking; stopPlayback();
  changeScene(blocking ? 'waiting' : 'background', false);
  state.timers.push(setTimeout(() => changeScene(blocking ? 'applied' : 'ready', false), 3000));
}
$('scene').addEventListener('change', event => changeScene(event.target.value));
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
  for (const [delay, scene] of [[3200, 'ready'], [6000, 'applying'], [8300, 'applied'], [11300, 'continued']]) {
    state.timers.push(setTimeout(() => { changeScene(scene, false); if (scene === 'continued') stopPlayback(); }, delay));
  }
});
document.addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.history) { panel(true, button.dataset.history); $('panel-scroll').scrollTop = 0; return; }
  switch (button.dataset.action) {
    case 'open-context': panel(true); break;
    case 'close-context': panel(false); break;
    case 'overview-full': setOverview('full'); break;
    case 'overview-compact': setOverview(state.overview === 'compact' && !state.detail ? 'full' : 'compact'); break;
    case 'overview-close': setOverview('closed'); break;
    case 'history-back': state.history = null; renderPanel(); $('panel-scroll').scrollTop = 0; break;
    case 'expand-summary': {
      const expanded = !$('summary-preview').classList.contains('expanded');
      $('summary-preview').classList.toggle('expanded', expanded); button.setAttribute('aria-expanded', String(expanded));
      button.innerHTML = (expanded ? '收起摘要' : '展开摘要') + icon('down'); break;
    }
    case 'process': fold('process-fold', button); break;
    case 'thinking': fold('thinking-fold', button); break;
    case 'history': fold('history-fold', button); break;
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
render(); $('overview-slot').inert = true;
