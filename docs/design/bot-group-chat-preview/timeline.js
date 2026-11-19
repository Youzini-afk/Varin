// Timeline: messages, receipts, quotes, shared work and approvals.
const RC_TIP = {
  queued: n => `${n} 正在忙，手头这轮结束后会收到`,
  working: n => `${n} 收到了，正在处理`,
  replied: n => `${n} 已回复`,
  silent: n => `${n} 收到了，没有回复`,
  asleep: n => `${n} 在休息，没收到`,
  failed: n => `${n} 没收到`,
};
function rcHtml(id, state) {
  const badge = state === 'asleep' ? `<span class="badge">${ic('moon')}</span>` : state === 'failed' ? `<span class="badge">${ic('alert')}</span>` : '';
  return `<span class="rc" data-state="${state}" data-tip="${RC_TIP[state](name(id))}">${av(id, 16)}${badge}</span>`;
}
function rcptHtml(p) {
  const ids = Object.keys(p.rc || {});
  const parts = [];
  if (p.author === 'user') parts.push(`<time>${p.time}</time>`);
  if (ids.length) parts.push(`<span class="arrow">${ic('arrowRight', 's12')}</span><span class="who-list">${ids.map(id => rcHtml(id, p.rc[id])).join('')}</span>`);
  else if (p.author === 'user') parts.push(`<span class="note" data-tip="没有成员收到这条消息。之后被 @ 的成员可以在群记录里翻到它。">· 仅记录</span>`);
  if (!parts.length) return '';
  return `<div class="rcpt">${parts.join('')}</div>`;
}
function troubleHtml(p) {
  return Object.entries(p.rc || {}).map(([id, st]) => {
    if (st === 'asleep') return `<div class="trouble">${ic('moon', 's14')}<span>${name(id)} 在休息，没收到这条</span><button class="btn" data-act="wake-retry" data-id="${p.id}" data-bot="${id}">唤醒并重新发送</button></div>`;
    if (st === 'failed') return `<div class="trouble err">${ic('alert', 's14')}<span>${name(id)} 没收到：连接中断</span><button class="btn" data-act="retry" data-id="${p.id}" data-bot="${id}">重新发送给 ${name(id)}</button></div>`;
    return '';
  }).join('');
}
function workHtml(w) {
  const done = w.status === 'done';
  const pct = Math.round(((done ? w.steps.length : w.step - 0.5) / w.steps.length) * 100);
  const status = done ? `<small class="ok">${ic('check', 's12')}${w.summary || `已完成 · ${w.steps.length} 步`}</small>` : `<small>${name(w.owner)} 负责 · ${esc(w.steps[w.step - 1])} · ${w.step}/${w.steps.length}</small>`;
  return `<button class="work" data-act="open-work" data-title="${esc(w.title)}"><span class="wi">${ic('task')}</span><span class="wt"><b>${esc(w.title)}</b>${status}${done ? '' : `<span class="bar"><i style="width:${pct}%"></i></span>`}</span>${ic('chevRight', 's14')}</button>`;
}
function askHtml(p) {
  const a = p.ask;
  if (a.state !== 'pending') {
    const verdict = { once: '你允许了一次', always: '你允许了，以后不再询问', denied: '你拒绝了' }[a.state];
    return `<div class="ask done"><div class="ah">${ic(a.state === 'denied' ? 'x' : 'check', 's14')}${verdict} · <code>${esc(a.cmd)}</code></div></div>`;
  }
  return `<div class="ask pending" id="ask-${p.id}"><div class="ah">${ic('shield', 's14')}需要你批准</div>
    <div class="ab">${name(a.who)} ${esc(a.title)}<small>在 ${esc(a.where)}</small><pre>${esc(a.cmd)}</pre></div>
    <div class="aa"><button class="btn primary sm" data-act="ask" data-v="once" data-id="${p.id}">允许一次</button><button class="btn sm" data-act="ask" data-v="always" data-id="${p.id}">总是允许</button><span style="flex:1"></span><button class="btn quiet sm" data-act="ask" data-v="denied" data-id="${p.id}">拒绝</button></div></div>`;
}
function attHtml(a) { return `<div class="att"><span class="ft">${a.type}</span><span style="min-width:0"><b>${esc(a.name)}</b><small>${a.size}</small></span></div>`; }

// A Bot's answer right below the post it answers needs no quote; later or after other traffic it does.
function shouldQuote(p, i, posts) {
  if (!p.replyTo) return false;
  if (p.author === 'user') return true;
  for (let j = i - 1; j >= 0; j -= 1) {
    const q = posts[j];
    if (q.id === p.replyTo) return false;
    if (q.type !== 'msg') continue;
    if (q.author === 'user' || q.replyTo !== p.replyTo) return true;
  }
  return true;
}
function contentHtml(p) {
  if (p.streaming) return `<div class="content" style="white-space:pre-wrap">${esc(p.shown || '')}<span class="caret"></span></div>`;
  let body = /^\s*</.test(p.html) ? p.html : p.html ? `<p>${p.html}</p>` : '';
  if (p.fold && !p.expanded) body = `<div class="fold">${body}</div><button class="unfold" data-act="unfold" data-id="${p.id}">${ic('chevDown', 's12')}展开全文</button>`;
  else if (p.fold) body += `<button class="unfold" data-act="unfold" data-id="${p.id}">${ic('chevDown', 's12')}收起</button>`;
  return `<div class="content">${body}${p.att ? attHtml(p.att) : ''}${p.work ? workHtml(p.work) : ''}${p.ask ? askHtml(p) : ''}</div>`;
}
function actsHtml(p) {
  return `<div class="acts" role="toolbar"><button data-act="reply" data-id="${p.id}">${ic('reply', 's14')}回复</button><button class="icon" data-act="quote" data-id="${p.id}" data-tip="引用到输入框">${ic('quote', 's14')}</button><button class="icon" data-act="copy" data-id="${p.id}" data-tip="复制">${ic('copy', 's14')}</button><button class="icon" data-act="more" data-id="${p.id}" data-tip="更多">${ic('more', 's14')}</button></div>`;
}
function postHtml(p, i, posts) {
  const arrive = p.arrive ? 'data-arrive' : '';
  if (p.type === 'day') return `<div class="day">${p.html}</div>`;
  if (p.type === 'event') return `<div class="event" ${arrive}>${p.icon ? ic(p.icon, 's14') : ''}<span>${p.html}</span>${p.time ? `<time>${p.time}</time>` : ''}</div>`;
  const quote = shouldQuote(p, i, posts);
  const q = quote ? findPost(p.replyTo) : null;
  const quoteHtml = q ? `<button class="quote" data-act="jump" data-id="${q.id}">${ic('reply', 's12')}<b>${name(q.author)}</b><span>${esc(excerpt(q))}</span></button>` : '';
  let prev = null; for (let j = i - 1; j >= 0; j -= 1) { if (posts[j].type !== 'day') { prev = posts[j]; break; } }
  const minutes = (t) => { const m = /^(\d+):(\d+)$/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const close = prev && minutes(prev.time) !== null && minutes(p.time) !== null ? Math.abs(minutes(p.time) - minutes(prev.time)) <= 5 : true;
  const cont = Boolean(prev && prev.type === 'msg' && prev.author === p.author && !quote && !p.handoff && close);
  const wide = p.wide || /<pre|<table/.test(p.html || '') ? 'wide' : '';
  if (p.author === 'user') {
    return `<div class="msg user ${cont ? 'cont' : ''}" id="p-${p.id}" data-id="${p.id}" ${arrive}><div class="col">
      <div class="bwrap"><div class="bubble ${q ? 'has-quote' : ''}">${quoteHtml}${contentHtml(p)}</div>${actsHtml(p)}</div>${rcptHtml(p)}${troubleHtml(p)}</div></div>`;
  }
  const route = p.handoff ? `<span class="to">${ic('arrowRight', 's12')}<b>${names(p.to)}</b></span>${p.handoff === 'inform' ? '<span class="kind">· 告知</span>' : ''}`
    : p.sched ? `<span class="kind sched" data-act="tab" data-v="schedule" data-tip="到点时由 ${name(p.author)} 发起，打开日程">${ic('calendar', 's12')}日程「${esc(p.sched)}」</span>` : '';
  return `<div class="msg bot ${cont ? 'cont' : ''} ${wide}" id="p-${p.id}" data-id="${p.id}" ${arrive}>
    <div class="gutter">${cont ? '' : av(p.author, 30)}</div>
    <div class="col">${cont ? '' : `<div class="who"><b>${name(p.author)}</b>${route}<time>${p.time}</time></div>`}
      <div class="bwrap"><div class="bubble ${q ? 'has-quote' : ''}">${quoteHtml}${contentHtml(p)}</div>${actsHtml(p)}</div>
      ${p.handoff ? rcptHtml(p) : ''}${troubleHtml(p)}</div></div>`;
}
function emptyHtml(g) {
  const ids = g.members.map(m => m.bot);
  const first = ids[0];
  const shown = ids.length > 6 ? ids.slice(0, 5) : ids;
  return `<div class="empty"><div class="faces">${shown.map(id => av(id, 44)).join('')}${ids.length > shown.length ? `<span class="more">+${ids.length - shown.length}</span>` : ''}</div>
    <h1>${esc(g.name)}</h1><div class="who-line">${names(ids, 4)}</div>
    <p>群里的消息大家都能翻到。被 @ 或被回复的成员会接话；<br>也可以请一位成员接收没指定对象的消息。</p>
    <div class="starters"><button data-act="starter" data-bot="${first}">${ic('ear', 's14')}请 ${name(first)} 接没 @ 人的消息</button>${ids[1] ? `<button data-act="starter-intro">${ic('users', 's14')}请大家各自介绍能做什么</button>` : ''}</div></div>`;
}
function nearBottom() { const t = $('#timeline'); return !t || t.scrollHeight - t.scrollTop - t.clientHeight < 80; }
function renderTimeline(force = false) {
  const t = $('#timeline'); if (!t) return;
  const g = currentGroup(); const stick = force || nearBottom();
  const hasMsg = g.posts.some(p => p.type === 'msg');
  t.innerHTML = `<div class="tl-inner">${hasMsg ? g.posts.map((p, i) => postHtml(p, i, g.posts)).join('') : emptyHtml(g)}</div>`;
  g.posts.forEach(p => { p.arrive = false; });
  if (stick) t.scrollTop = t.scrollHeight;
}
function refreshPost(p) {
  const g = groupOf(p.id); if (!g || g.id !== S.group) { renderSidebar(); return; }
  const el = $(`#p-${p.id}`); const stick = nearBottom();
  if (!el) { renderTimeline(); return; }
  const i = g.posts.indexOf(p); const tmp = document.createElement('div'); tmp.innerHTML = postHtml(p, i, g.posts).trim();
  const next = tmp.firstElementChild; next.removeAttribute('data-arrive'); el.replaceWith(next);
  if (stick) $('#timeline').scrollTop = $('#timeline').scrollHeight;
}
function updateStream(p) {
  const el = $(`#p-${p.id} .content`); if (!el) return;
  const stick = nearBottom();
  el.innerHTML = `${esc(p.shown)}<span class="caret"></span>`;
  if (stick) $('#timeline').scrollTop = $('#timeline').scrollHeight;
}
