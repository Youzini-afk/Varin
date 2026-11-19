// Group panel (members, shared work, files), overlays and the prototype bar.
// A group is not a Bot, so its panel has no stage: a header, then the members as rows that scale to any count.
// A figure appears only when one member is opened (memberView), as on that Bot's own panel.
function groupHeadHtml(g) {
  const listening = g.members.filter(m => m.listening).map(m => m.bot);
  return `<div class="ghead">${cluster(g.members.map(m => m.bot), true)}
    <div class="gt"><h2><span>${esc(g.name)}</span><button data-tip="重命名">${ic('pencil', 's12')}</button></h2><p>${g.members.length} 位成员 · ${listening.length ? `${names(listening)} 在听` : '没有成员在听'}</p></div>
    <button class="tb-btn" data-act="gmenu" data-tip="群聊设置" aria-expanded="${S.pop?.kind === 'gmenu'}">${ic('more')}</button>
    ${S.pop?.kind === 'gmenu' ? `<div class="pop gmenu"><button class="opt" data-act="add-member">${ic('plus', 's14')}<span class="name">添加成员</span></button><button class="opt" data-act="files">${ic('file', 's14')}<span class="name">群文件</span><span class="kbd">${groupFiles(g).length || ''}</span></button><button class="opt">${ic('search', 's14')}<span class="name">搜索群消息</span></button><div class="sep"></div><button class="opt danger">${ic('trash', 's14')}<span class="name">删除群聊</span></button></div>` : ''}</div>`;
}
const figSrc = (id) => S.bots[id].asleep && BOTS[id].figAsleep ? BOTS[id].figAsleep : BOTS[id].fig;
function groupWork(g) { return g.posts.filter(p => p.work).map(p => p.work).filter((w, i, a) => a.indexOf(w) === i); }
function groupFiles(g) { return g.posts.filter(p => p.att).map(p => ({ ...p.att, author: p.author, time: p.time })); }
function membersTab(g) {
  const rows = g.members.map(m => {
    const st = activityLabel(m.bot, g);
    const by = m.listening && m.by ? `<span class="by">${m.by.who === 'self' ? `${name(m.bot)} 自己打开` : '你打开'} · ${m.by.time}</span>` : '';
    return `<div class="prow" data-act="member" data-bot="${m.bot}" id="mrow-${m.bot}">${av(m.bot, 32)}<span class="t"><b>${name(m.bot)}</b><small class="${st.tone}">${st.text}</small>${by}</span>
      <button class="sw" role="switch" aria-checked="${m.listening}" aria-label="${name(m.bot)} 接收未指定对象的用户消息" data-act="listen" data-bot="${m.bot}"></button></div>`;
  }).join('');
  return `<div class="psec"><div class="psh"><span>成员</span><span class="colh" data-tip="接收未指定对象的用户消息：你没有 @ 谁、也没有回复谁时，消息发给打开它的成员。">${ic('ear', 's12')}在听</span></div>${rows}
    <button class="prow add" data-act="add-member"><span class="ic">${ic('plus', 's14')}</span><span class="t"><b style="font-weight:400">添加成员</b></span></button></div>
    <p class="pnote">没有 @、也没有回复对象的消息会发给「在听」的成员。可以有几位，也可以一位都没有，那样消息只记在群里。成员也能自己打开或关掉。</p>`;
}
/* ── 动态: what members did behind the bubbles, derived from the group's own records ── */
const EV_ICON_KIND = { ear: 'listen', users: 'member', calendar: 'schedule' };
function groupNeeds(g) {
  const out = [];
  g.posts.forEach(p => {
    if (p.ask?.state === 'pending') out.push({ id: p.id, who: p.ask.who, html: `<b>${name(p.ask.who)}</b> ${esc(p.ask.title)}`, sub: p.ask.cmd, status: `${ic('shield', 's12')}等你批准` });
    Object.entries(p.rc || {}).forEach(([id, st]) => {
      if (st === 'asleep') out.push({ id: p.id, who: id, html: `<b>${name(id)}</b> 在休息，没收到`, sub: `${name(p.author)}：${excerpt(p)}`, status: `${ic('moon', 's12')}可唤醒重发` });
      if (st === 'failed') out.push({ id: p.id, who: id, html: `<b>${name(id)}</b> 没收到：连接中断`, sub: `${name(p.author)}：${excerpt(p)}`, status: `${ic('alert', 's12')}可重新发送` });
    });
  });
  return out;
}
function groupEvents(g) {
  const days = []; let cur = null;
  const push = (e) => { if (!cur) { cur = { day: '', events: [] }; days.push(cur); } cur.events.push(e); };
  g.posts.forEach(p => {
    if (p.type === 'day') { cur = { day: p.html, events: [] }; days.push(cur); return; }
    const jump = `data-act="jump" data-id="${p.id}"`;
    if (p.type === 'event') { push({ time: p.time, kind: EV_ICON_KIND[p.icon] || 'fact', html: p.html, act: p.icon === 'calendar' ? 'data-act="tab" data-v="schedule"' : '' }); return; }
    if (p.type !== 'msg') return;
    if (p.sched) push({ time: p.time, kind: 'schedule', html: `日程「${esc(p.sched)}」到点了 · <b>${name(p.author)}</b>`, sub: excerpt(p), act: jump });
    if (p.handoff) push({ time: p.time, kind: 'dispatch', html: `<b>${name(p.author)}</b> ${p.handoff === 'inform' ? '告知' : '把工作交给'} <b>${names(p.to)}</b>`, sub: excerpt(p), act: jump });
    if (p.work) {
      const open = `data-act="open-work" data-title="${esc(p.work.title)}"`;
      push({ time: p.time, kind: 'work', html: `<b>${name(p.work.owner)}</b> 开始任务「${esc(p.work.title)}」`, act: open });
      if (p.work.status === 'done') push({ time: p.work.doneAt || p.time, kind: 'work', html: `<b>${name(p.work.owner)}</b> 完成了「${esc(p.work.title)}」`, sub: p.work.summary || `${p.work.steps.length} 步`, act: open });
    }
    if (p.ask && p.ask.state !== 'pending') {
      const verdict = { once: '允许了', always: '总是允许', denied: '拒绝了' }[p.ask.state];
      push({ time: p.ask.at || p.time, kind: 'you', html: `你${verdict} <b>${name(p.ask.who)}</b> ${esc(p.ask.title.replace(/^想/, ''))}`, sub: p.ask.cmd, act: jump });
    }
    Object.entries(p.rc || {}).forEach(([id, st]) => {
      if (st === 'silent') push({ time: p.time, kind: 'quiet', html: `<b>${name(id)}</b> 收到了，没有回复`, sub: `${name(p.author)}：${excerpt(p)}`, act: jump });
    });
  });
  const mins = (t) => { const m = /^(\d+):(\d+)$/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : -1; };
  // Newest first, like the Bot panel's 动态.
  return days.filter(d => d.events.length).reverse()
    .map(d => ({ day: d.day, events: d.events.map((e, i) => ({ ...e, i })).sort((a, b) => mins(b.time) - mins(a.time) || b.i - a.i) }));
}
const eventCount = (g) => groupEvents(g).reduce((n, d) => n + d.events.length, 0);
function activityTab(g) {
  const needs = groupNeeds(g);
  const running = groupWork(g).filter(w => w.status !== 'done');
  const days = groupEvents(g);
  const needRows = needs.map(n => `<button class="prow" data-act="jump" data-id="${n.id}">${av(n.who, 24)}<span class="t"><span class="tl">${n.html}</span><small>${esc(n.sub)}</small></span><span class="rstat"><span class="now warn">${n.status}</span><span class="go">去处理${ic('chevRight', 's12')}</span></span></button>`).join('');
  const runRows = running.map(w => `<button class="prow" data-act="open-work" data-title="${esc(w.title)}">${av(w.owner, 24)}<span class="t"><b>${esc(w.title)}</b><small>${name(w.owner)} · ${esc(w.steps[w.step - 1])} · ${w.step}/${w.steps.length}</small></span><span class="rstat"><span class="now"><span class="ring"></span>正在工作</span><span class="go">打开任务${ic('external', 's12')}</span></span></button>`).join('');
  const evHtml = (e) => { const tag = e.act ? 'button' : 'div'; return `<${tag} class="ev" data-kind="${e.kind}" ${e.act || ''}><time>${e.time}</time><span class="et">${e.html}${e.sub ? `<small>${esc(e.sub)}</small>` : ''}</span></${tag}>`; };
  const dayHtml = days.map(d => `<div class="psec"><div class="psh"><span>${d.day || '更早'}</span></div><div class="evline">${d.events.map(evHtml).join('')}</div></div>`).join('');
  return `${needs.length ? `<div class="psec"><div class="psh"><span>需要你</span></div>${needRows}</div>` : ''}
    ${running.length ? `<div class="psec"><div class="psh"><span>进行中</span></div>${runRows}</div>` : ''}
    ${dayHtml || '<p class="pempty">这里还没有动态。</p>'}
    <p class="pnote">对话之外成员做了什么都记在这里：交接、任务、没出声的轮次、送达问题。任务的过程和工具记录留在任务里。</p>`;
}

/* ── 日程: what members will do in this group later ──────────────────────────────── */
function schedRow(s, rule) {
  const key = rule ? `rule:${s.id}` : s.id; const open = S.openSched === key;
  const flash = !rule && S.flashSched === s.id ? 'flash' : '';
  const head = rule
    ? `<span class="when muted">${ic('history', 's14')}</span><span class="t"><b>${esc(s.name)}</b><small>${av(s.owner, 14)}${name(s.owner)} · ${esc(s.rule)}</small></span>`
    : `<span class="when"><b>${s.when}</b><small>${esc(s.day)}</small></span><span class="t"><b>${esc(s.name)}</b><small>${av(s.owner, 14)}${name(s.owner)} · 在本群</small></span>`;
  return `<div class="sched ${flash}" data-open="${open}"><button class="sh" data-act="sched" data-id="${key}" aria-expanded="${open}">${head}</button>
    <div class="sfold"><div><dl><dt>规则</dt><dd>${esc(s.rule)}</dd><dt>负责</dt><dd>${name(s.owner)}</dd><dt>到点时</dt><dd>${name(s.owner)} 在群里接着做，它 @ 的成员才会收到</dd><dt>错过时</dt><dd>${esc(s.missed)}</dd>
      <dd class="full"><button class="btn sm" data-act="new-sched">${ic('pencil', 's12')}编辑</button></dd></dl></div></div></div>`;
}
function scheduleTab(g) {
  const items = g.schedules || []; const watches = g.watches || [];
  const upcoming = items.filter(s => s.when && !s.paused);
  const rules = items.filter(s => s.repeat);
  const watchRows = watches.map(w => `<div class="sched"><div class="sh static"><span class="when muted">${ic('bell', 's14')}</span><span class="t"><b>${esc(w.name)}</b><small>${av(w.owner, 14)}${name(w.owner)} · ${esc(w.state)}</small><small class="sub">${esc(w.source)} · ${esc(w.note)}</small></span></div></div>`).join('');
  const html = `${watches.length ? `<div class="psec"><div class="psh"><span>安排与关注</span></div>${watchRows}</div>` : ''}
    ${upcoming.length ? `<div class="psec"><div class="psh"><span>接下来</span></div>${upcoming.map(s => schedRow(s, false)).join('')}</div>` : ''}
    ${rules.length ? `<div class="psec"><div class="psh"><span>重复规则</span></div>${rules.map(s => schedRow(s, true)).join('')}</div>` : ''}
    ${!items.length && !watches.length ? `<p class="pempty">还没有日程。也可以在群里直接说<br>“@${name(g.members[0].bot)} 每周一 9 点汇总进展”。</p>` : ''}
    <button class="pnew" data-act="new-sched">${ic('plus', 's14')}新建日程</button>
    <p class="pnote">日程属于设它的成员，到点时由它在群里接着做，只有它 @ 的成员才会收到。成员的其他日程在各自的面板里。</p>`;
  S.flashSched = null;
  return html;
}
function filesView(g) {
  const files = groupFiles(g);
  return `<div class="sub-view"><button class="back" data-act="back">${ic('chevLeft', 's14')}返回</button>
    <div class="mhead"><div><b>群文件</b><small>分享到群里的文件，成员都能打开，包括之后才加入的成员</small></div></div>
    ${files.length ? files.map(f => `<div class="prow"><span class="att" style="padding:0;background:none"><span class="ft">${f.type}</span></span><span class="t"><b>${esc(f.name)}</b><small>${name(f.author)} · ${f.time} · ${f.size}</small></span></div>`).join('') : '<p class="pempty">还没有分享的文件。</p>'}</div>`;
}
function memberView(g, id) {
  const m = g.members.find(x => x.bot === id); const st = activityLabel(id, g); const b = S.bots[id];
  return `<div class="sub-view">
    <div class="mstage"><div class="stage-floor"></div><button class="back" data-act="back">${ic('chevLeft', 's14')}成员</button><img src="${figSrc(id)}" alt="${name(id)}" class="${b.asleep ? 'asleep' : ''}"></div>
    <div class="mname"><b>${name(id)}${m.listening ? `<span class="ear" data-tip="在听：接收未指定对象的用户消息">${ic('ear', 's14')}</span>` : ''}</b><small>${BOTS[id].role} · <span class="${st.tone}">${st.text}</span></small></div>
    ${b.asleep ? `<div class="card"><div class="crow"><span class="t"><b>在休息</b><small>发给它的消息会留在群里，唤醒后可以重新发送。</small></span><button class="btn sm" data-act="wake" data-bot="${id}">唤醒</button></div></div>` : ''}
    <div class="card"><div class="crow"><span class="t"><b>接收未指定对象的用户消息</b><small>你没有 @ 谁、也没有回复谁时，${name(id)} 会收到这条消息，可以回复、去做，或者不出声。改动只影响之后的消息。</small>${m.listening && m.by ? `<span class="by">${m.by.who === 'self' ? `${name(id)} 在 ${m.by.time} 自己打开` : `你在 ${m.by.time} 打开`}</span>` : ''}</span>
      <button class="sw" role="switch" aria-checked="${m.listening}" data-act="listen" data-bot="${id}" aria-label="接收未指定对象的用户消息"></button></div></div>
    <div class="card"><div class="crow link">${ic('chat')}<span class="t"><b>和 ${name(id)} 私聊</b></span>${ic('chevRight', 's14')}</div><div class="crow link">${ic('user')}<span class="t"><b>查看资料</b><small>模型、记忆和日程都是 ${name(id)} 自己的，群里不另设</small></span>${ic('chevRight', 's14')}</div></div>
    <div class="card"><div class="crow link danger" data-act="remove-member" data-bot="${id}"><span class="t"><b>移出群聊</b><small>移出后它不能再读取或在这里发言，还没送达的消息会丢弃；已经开始的工作照常进行，之前的发言保留署名。</small></span></div></div></div>`;
}
function workView(w) {
  const done = w.status === 'done';
  const steps = w.steps.map((s, i) => { const n = i + 1; const cls = done || n < w.step ? '' : n === w.step ? 'cur' : 'todo'; return `<li class="${cls}">${ic(cls === '' ? 'check' : cls === 'cur' ? 'spinner' : 'circle', 's14')}${esc(s)}</li>`; }).join('');
  return `<div class="sub-view"><button class="back" data-act="back">${ic('chevLeft', 's14')}动态</button>
    <div class="mhead"><span class="work" style="width:auto;padding:0;background:none;box-shadow:none;cursor:default"><span class="wi" style="width:44px;height:44px;border-radius:12px">${ic('task', 's18')}</span></span><div><b>${esc(w.title)}</b><small>${name(w.owner)} 负责 · ${done ? '已完成' : '进行中'}</small></div></div>
    <div class="card"><ul class="steps">${steps}</ul></div>
    <div class="card"><div class="crow link">${ic('external')}<span class="t"><b>打开任务</b><small>完整的过程和工具记录在这里，不进群</small></span>${ic('chevRight', 's14')}</div>
      <div class="crow link" data-act="jump-work" data-title="${esc(w.title)}">${ic('reply')}<span class="t"><b>回到群里的消息</b></span>${ic('chevRight', 's14')}</div></div></div>`;
}
function panelInnerHtml() {
  const g = currentGroup();
  if (S.sub?.kind === 'member') return `<div class="pbody">${memberView(g, S.sub.bot)}</div>`;
  if (S.sub?.kind === 'work') { const w = groupWork(g).find(x => x.title === S.sub.title); if (w) return `<div class="pbody" style="padding-top:12px">${workView(w)}</div>`; }
  if (S.sub?.kind === 'files') return `<div class="pbody" style="padding-top:12px">${filesView(g)}</div>`;
  // Same icon tabs as the Bot panel (概览 / 动态 / 记忆 / 日程). A group has no memory of its own: each member keeps its own.
  const count = eventCount(g); S.seen ||= {}; if (S.seen[g.id] === undefined || S.tab === 'activity') S.seen[g.id] = count;
  const dot = { activity: S.tab === 'activity' ? '' : groupNeeds(g).length ? 'warn' : count > S.seen[g.id] ? 'info' : '' };
  const tab = S.tab === 'activity' ? activityTab(g) : S.tab === 'schedule' ? scheduleTab(g) : membersTab(g);
  const tabBtn = (v, icon, label) => `<button role="tab" class="ptab" data-act="tab" data-v="${v}" aria-selected="${S.tab === v}" aria-label="${label}" data-tip="${label}">${icf(icon)}${dot[v] ? `<span class="pdot ${dot[v]}"></span>` : ''}</button>`;
  return `${groupHeadHtml(g)}
    <div class="ptabs-frame"><div class="ptabs" role="tablist"><span class="knob"></span>${tabBtn('members', 'group', '成员')}${tabBtn('activity', 'history', '动态')}${tabBtn('schedule', 'calendar', '日程')}</div></div>
    <div class="pbody">${tab}</div>`;
}
function placeKnob(root) {
  const tabs = root?.querySelector('.ptabs'); if (!tabs) return;
  const sel = tabs.querySelector('[aria-selected="true"]'); const knob = tabs.querySelector('.knob');
  knob.style.left = `${sel.offsetLeft}px`; knob.style.width = `${sel.offsetWidth}px`;
}
function renderPanel() {
  if (S.device === 'phone') { if (S.sheet === 'panel') renderOverlay(); return; }
  const el = $('#panel'); const scroll = el.querySelector('.pbody')?.scrollTop ?? 0;
  el.innerHTML = `<div class="panel-in">${panelInnerHtml()}</div>`;
  const body = el.querySelector('.pbody'); if (body) body.scrollTop = scroll;
  placeKnob(el);
}

/* ── Above the composer: who is thinking, what waits for you, new messages ──────── */
function renderDockAbove() {
  const g = currentGroup();
  const thinking = g.members.map(m => m.bot).filter(id => S.bots[id].activity === 'thinking' && S.bots[id].group === g.id);
  const left = thinking.length ? `<div class="presence">${stack(thinking.slice(0, 3), 18)}<span>${names(thinking)} 正在想</span><span class="dots"><i></i><i></i><i></i></span></div>` : '<div class="presence"></div>';
  const pending = g.posts.find(p => p.ask?.state === 'pending');
  let right = '';
  if (pending && !inView(`#ask-${pending.id}`)) right = `<button class="pill warn" data-act="jump" data-id="${pending.id}">${ic('shield', 's14')}${name(pending.ask.who)} 等你批准</button>`;
  else if (S.unseen > 0) right = `<button class="pill" data-act="to-bottom">${ic('arrowDown', 's14')}${S.unseen} 条新消息</button>`;
  $('#dockAbove').innerHTML = `${left}<span class="spacer"></span>${right}`;
}
function inView(sel) {
  const el = $(sel); const t = $('#timeline'); if (!el || !t) return false;
  const a = el.getBoundingClientRect(), b = t.getBoundingClientRect();
  return a.bottom > b.top + 20 && a.top < b.bottom - 20;
}

/* ── Overlays: dialog, phone sheet and drawer ─────────────────────────────────── */
function dialogHtml() {
  const d = S.dialog;
  const opts = Object.values(BOTS).map(b => { const on = d.picks.includes(b.id); const asleep = S.bots[b.id].asleep;
    return `<button class="opt" data-act="pick" data-bot="${b.id}">${av(b.id, 32)}<span class="t">${b.name}<small>${b.role}${asleep ? ' · 休息中，唤醒后才会接话' : ''}</small></span><span class="chk ${on ? 'on' : ''}">${on ? ic('check') : ''}</span></button>`; }).join('');
  return `<div class="scrim" data-act="scrim"><div class="dialog" role="dialog" aria-label="新建群聊">
    <h3>新建群聊</h3><p class="dd">选几位 Bot 一起聊。群里的话大家都能翻到，被 @ 或被回复的成员才会接话。</p>
    <label class="fl" for="gname">名称</label><input class="field" id="gname" placeholder="比如：发布" value="${esc(d.name)}" autocomplete="off">
    <label class="fl">成员${d.picks.length ? ` · 已选 ${d.picks.length}` : ''}</label><div class="mlist">${opts}</div>
    <div class="hint">${ic('ear', 's14')}<span>想让某位成员接住没 @ 人的消息，建好后在群里跟它说一声，或在成员里打开「在听」。不用设群主或发言顺序。</span></div>
    <div class="df"><button class="btn quiet" data-act="close-dialog">取消</button><button class="btn primary" data-act="create" ${d.name.trim() && d.picks.length ? '' : 'disabled'}>创建</button></div></div></div>`;
}
function actionSheetHtml(id) {
  const p = findPost(id);
  return `<div class="sheet-scrim" data-act="close-sheet"></div><div class="sheet"><div class="grab"></div><div class="acts-sheet">
    <div class="preview"><b style="color:var(--fg)">${name(p.author)}</b>：${esc(excerpt(p))}</div>
    <button data-act="reply" data-id="${id}">${ic('reply', 's18')}回复</button><button data-act="quote" data-id="${id}">${ic('quote', 's18')}引用</button><button data-act="copy" data-id="${id}">${ic('copy', 's18')}复制</button>
    ${p.work ? `<button data-act="open-work" data-title="${esc(p.work.title)}">${ic('task', 's18')}打开任务</button>` : ''}</div></div>`;
}
function renderOverlay() {
  const o = $('#overlay'); if (!o) return;
  let html = '';
  if (S.device === 'phone' && S.drawer) html += `<div class="sheet-scrim" data-act="close-drawer"></div><nav class="sidebar drawer">${sidebarHtml()}</nav>`;
  if (S.device === 'phone' && S.sheet === 'panel') html += `<div class="sheet-scrim" data-act="close-sheet"></div><div class="sheet"><div class="grab"></div><div class="panel-in">${panelInnerHtml()}</div></div>`;
  if (S.device === 'phone' && S.sheet?.kind === 'acts') html += actionSheetHtml(S.sheet.id);
  if (S.dialog) html += dialogHtml();
  const focused = document.activeElement?.id;
  o.innerHTML = html; placeKnob(o.querySelector('.sheet'));
  if (focused === 'gname' && $('#gname')) { const f = $('#gname'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
}

/* ── Prototype bar ────────────────────────────────────────────────────────────── */
function renderProto() {
  const sc = SCENES[S.scene]; const total = sc.steps.length; const next = sc.steps[S.step];
  $('#scenes').innerHTML = Object.entries(SCENES).map(([k, v]) => `<button data-act="scene" data-v="${k}" aria-pressed="${k === S.scene}">${v.label}</button>`).join('');
  $('#stepLabel').innerHTML = next ? `${S.step + 1}/${total} · <em>${next.label}</em>` : '演示完了，可以自己试：@ 成员、回复、切换在听、唤醒';
  $('#next').disabled = !next || S.running;
  $('#device').innerHTML = ['desktop', 'phone'].map(v => `<button data-act="device" data-v="${v}" aria-pressed="${S.device === v}">${v === 'desktop' ? '桌面' : '手机'}</button>`).join('');
  $('#theme').innerHTML = ['light', 'dark'].map(v => `<button data-act="theme" data-v="${v}" aria-pressed="${S.theme === v}">${v === 'light' ? '浅色' : '深色'}</button>`).join('');
}
