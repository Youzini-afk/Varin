// Rendering. State lives in S; regions re-render independently so the composer keeps its caret.
const S = {
  theme: 'light', device: 'desktop', scene: 'release', step: 0, running: false,
  bots: {}, groups: {}, group: 'release',
  navOpen: true, panelOpen: true, tab: 'members', sub: null,
  reply: null, pop: null, dialog: null, sheet: null, drawer: false, clock: 0,
};
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const name = (id) => id === 'user' ? '你' : BOTS[id]?.name ?? id;
const names = (ids, max = 2) => ids.length <= max ? ids.map(name).join('、') : `${ids.slice(0, max).map(name).join('、')} 等 ${ids.length} 位`;
const currentGroup = () => S.groups[S.group];
const findPost = (id) => { for (const g of Object.values(S.groups)) { const p = g.posts.find(x => x.id === id); if (p) return p; } return null; };
const groupOf = (id) => Object.values(S.groups).find(g => g.posts.some(p => p.id === id));
const isMember = (g, id) => g.members.some(m => m.bot === id);
const textOf = (html) => html.replace(/<\/(p|li|pre)>/g, '\n').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{2,}/g, '\n').trim();
const excerpt = (p) => { const t = textOf(p.html).replace(/\s+/g, ' '); return t || (p.att ? p.att.name : p.work ? p.work.title : ''); };

function av(id, size = 30, cls = '') {
  const b = BOTS[id], asleep = S.bots[id]?.asleep;
  return `<span class="av ${asleep ? 'asleep' : ''} ${cls}" style="--s:${size}px;--id:${b.color}"><img src="${asleep && b.figAsleep ? b.figAsleep : b.fig}" alt=""></span>`;
}
const cluster = (ids, lg = false) => `<span class="av-cluster ${lg ? 'lg' : ''}">${ids.slice(0, 2).map(id => av(id, lg ? 22 : 17)).join('')}</span>`;
const stack = (ids, size) => `<span class="av-stack">${ids.map(id => av(id, size)).join('')}</span>`;

function activityLabel(id, g) {
  const b = S.bots[id];
  if (g && g.posts.some(p => p.ask?.state === 'pending' && p.ask.who === id)) return { text: '等你批准', tone: 'warn' };
  if (b.asleep) return { text: b.waking ? '正在唤醒…' : '休息中', tone: '' };
  if (b.activity === 'thinking') return { text: '正在想…', tone: 'live' };
  if (b.activity === 'replying') return { text: '正在回复', tone: 'live' };
  if (b.activity === 'working') return { text: `处理中 · ${b.activityText || '任务'}`, tone: '' };
  return { text: '空闲', tone: '' };
}

/* ── Skeleton ─────────────────────────────────────────────────────────────────── */
function mount() {
  const draft = $('#input')?.innerHTML ?? '';
  const wrap = $('#stagewrap');
  wrap.className = `stagewrap ${S.device === 'phone' ? 'phone' : ''}`;
  wrap.innerHTML = `<div class="app ${S.theme === 'dark' ? 'dark' : ''} ${S.device === 'phone' ? 'phone' : ''}" id="app">
    <div class="titlebar" id="titlebar"></div>
    <div class="body" id="body">
      <nav class="sidebar" id="sidebar" aria-label="Bot"></nav>
      <main class="canvas">
        <div class="timeline" id="timeline"></div>
        <div class="dock" id="dock">
          <div class="dock-above" id="dockAbove"></div>
          <div class="composer" id="composer">
            <div class="strips" id="strips"><div id="stripsIn"></div></div>
            <div class="input" id="input" contenteditable="true" role="textbox" aria-multiline="true" spellcheck="false"></div>
            <div class="cbar">
              <button class="cbtn" data-tip="添加文件或图片">${ic('plus')}</button>
              <button class="cbtn" data-act="at" data-tip="提及成员、文件或任务">${ic('at')}</button>
              <span class="spacer"></span>
              <span id="routeWrap" style="min-width:0;display:flex"></span>
              <button class="cbtn" data-tip="语音输入">${ic('mic')}</button>
              <button class="send" id="send" data-act="send" aria-label="发送">${ic('arrowUp', 's18')}</button>
            </div>
          </div>
        </div>
      </main>
      <aside class="panel" id="panel" aria-label="群聊"></aside>
    </div>
    <div id="overlay"></div>
    <div class="tip" id="tip" hidden></div>
  </div>`;
  $('#input').innerHTML = draft;
  bindInput();
  if (S.groups[S.group]) renderAll();
}
function renderAll() { renderTitlebar(); renderSidebar(); renderTimeline(true); renderComposerMeta(); renderDockAbove(); renderPanel(); renderOverlay(); renderProto(); }

/* ── Titlebar ─────────────────────────────────────────────────────────────────── */
function attention(g) { return g.posts.some(p => p.ask?.state === 'pending'); }
function renderTitlebar() {
  const g = currentGroup(); const ids = g.members.map(m => m.bot);
  const body = $('#body');
  body.classList.toggle('nav-closed', !S.navOpen);
  body.classList.toggle('panel-open', S.panelOpen);
  if (S.device === 'phone') {
    const live = ids.find(id => ['replying', 'thinking'].includes(S.bots[id].activity));
    const pending = g.posts.find(p => p.ask?.state === 'pending');
    const sub = pending ? `<small class="warn">${name(pending.ask.who)} 等你批准</small>` : live ? `<small>${name(live)} ${S.bots[live].activity === 'replying' ? '正在回复' : '正在想…'}</small>` : `<small>${names(ids, 3)}</small>`;
    $('#titlebar').innerHTML = `<button class="tb-btn" data-act="drawer" aria-label="会话">${ic('menu', 's18')}</button>
      <button class="m-title" data-act="sheet" ${S.sheet === 'panel' ? 'data-open' : ''}>${cluster(ids, true)}<span class="tx"><b>${esc(g.name)}</b>${sub}</span>${ic('chevDown', 'cv s14')}</button>
      <button class="tb-btn" data-tip="在群里搜索">${ic('search')}</button>`;
    return;
  }
  $('#titlebar').innerHTML = `<button class="tb-btn" data-act="nav" aria-pressed="${S.navOpen}" data-tip="${S.navOpen ? '收起侧栏' : '打开侧栏'}">${ic('sidebar')}</button>
    <button class="profile">${LOGO}Varin${ic('chevDown', 's12')}</button>
    <div class="tb-title"><b>${esc(g.name)}</b><small>${names(ids, 4)}</small></div>
    <span class="tb-spacer"></span>
    <button class="tb-btn" data-tip="在群里搜索">${ic('search')}</button>
    <button class="tb-members" data-act="panel" aria-pressed="${S.panelOpen}" data-tip="${S.panelOpen ? '收起成员' : '成员'}">${stack(ids.slice(0, 3), 20)}<span class="count">${ids.length}</span>${attention(g) && !S.panelOpen ? '<span class="attn-dot"></span>' : ''}</button>`;
}

/* ── Sidebar ──────────────────────────────────────────────────────────────────── */
function groupPreview(g) {
  const last = [...g.posts].reverse().find(p => p.type === 'msg');
  if (g.posts.some(p => p.ask?.state === 'pending')) { const p = g.posts.find(x => x.ask?.state === 'pending'); return { text: `${name(p.ask.who)} 等你批准`, tone: 'warn' }; }
  if (!last) return { text: g.preview || '还没有消息', tone: '' };
  return { text: `${name(last.author)}：${excerpt(last)}`, tone: '' };
}
function sidebarHtml() {
  const groups = Object.values(S.groups);
  const rows = groups.map(g => {
    const ids = g.members.map(m => m.bot); const pv = groupPreview(g);
    const live = ids.some(id => ['replying', 'thinking'].includes(S.bots[id].activity) && S.bots[id].group === g.id);
    const mark = attention(g) ? '<span class="mark-dot warn"></span>' : live ? '<span class="mark-ring"></span>' : g.unread && g.id !== S.group ? '<span class="mark-dot"></span>' : '';
    return `<button class="nav-row group" data-act="group" data-id="${g.id}" ${g.id === S.group ? 'aria-current="page"' : ''}>${cluster(ids)}<span class="txt"><span class="name">${esc(g.name)}</span><span class="sub ${pv.tone}">${esc(pv.text)}</span></span>${mark}</button>`;
  }).join('');
  const bots = Object.values(BOTS).map(b => `<button class="nav-row bot" data-act="bot" data-id="${b.id}">${ic('chevDown', 'chev s12')}${av(b.id, 22)}<span class="name">${b.name}</span><span class="state">${S.bots[b.id].asleep ? '休息中' : ''}</span></button>`).join('');
  return `<div class="nav-toolbar">
      <div class="nav-new" ${S.pop?.kind === 'new' ? 'data-open' : ''}><button data-act="new-menu">${ic('chatNew')}<span>新建会话</span></button><button class="nav-caret" data-act="new-menu" aria-label="更多新建方式">${ic('chevDown', 's14')}</button></div>
      <button class="nav-icon" data-tip="搜索">${ic('search')}</button><button class="nav-icon" data-tip="刷新">${ic('refresh')}</button><button class="nav-icon" data-tip="新建分组">${ic('folderAdd')}</button>
      ${S.pop?.kind === 'new' ? newMenuHtml() : ''}
    </div>
    <div class="nav-list">
      <div class="nav-head"><span>群聊</span><button data-act="new-group" data-tip="新建群聊">${ic('plus', 's14')}</button></div>${rows}
      <div class="nav-head"><span>助手</span><button data-tip="分组">${ic('folder', 's14')}</button></div>${bots}
    </div>
    <div class="nav-foot"><button>${ic('plus')}新建 Bot</button><button>${ic('archive')}已归档 Bot</button><button>${ic('settings')}设置</button></div>`;
}
function renderSidebar() { if (S.device !== 'phone') $('#sidebar').innerHTML = sidebarHtml(); else if (S.drawer) renderOverlay(); }
function newMenuHtml() {
  return `<div class="pop" style="left:10px;top:46px;width:236px">
    <button class="opt">${ic('chatNew')}<span class="name">和 Varin 新会话</span><span class="kbd">Ctrl N</span></button>
    <button class="opt" data-act="new-group">${ic('users')}<span class="name">新建群聊…</span></button>
    <div class="sep"></div>
    <button class="opt">${ic('plus')}<span class="name">新建 Bot…</span></button>
  </div>`;
}
