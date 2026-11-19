// Composer: mentions, reply target and the live "发给" preview of who will receive the message.
const input = () => $('#input');
function draftMentions() { return [...new Set([...input().querySelectorAll('.mention[data-bot]')].map(n => n.dataset.bot))]; }
function draftEmpty() { return !input().textContent.trim() && !input().querySelector('.mention'); }

// Explicit mentions first, then the reply target, then members who listen; otherwise nobody.
function computeRoute() {
  const g = currentGroup();
  const ids = draftMentions();
  const gone = ids.filter(id => !isMember(g, id));
  const replyPost = S.reply ? findPost(S.reply) : null;
  if (ids.length) return { to: ids.filter(id => isMember(g, id)), kind: 'mention', gone, replyPost };
  if (replyPost && replyPost.author !== 'user' && isMember(g, replyPost.author)) return { to: [replyPost.author], kind: 'reply', gone: [], replyPost };
  const listeners = g.members.filter(m => m.listening).map(m => m.bot);
  return { to: listeners, kind: listeners.length ? 'listening' : 'none', gone: [], replyPost };
}

function routeChipHtml(r) {
  if (r.gone.length) return `<button class="route blocked" data-act="route" aria-expanded="${S.pop?.kind === 'route'}">${ic('alert', 's14')}<span class="names">${names(r.gone)} 不在群里</span></button>`;
  if (!r.to.length) return `<button class="route none" data-act="route" aria-expanded="${S.pop?.kind === 'route'}" data-tip="没有成员会收到。消息留在群里，之后被 @ 的成员可以翻到。">${ic('note', 's14')}<span class="names swap" data-k="none">仅记录</span>${ic('chevDown', 's12')}</button>`;
  const why = r.kind === 'reply' ? '· 回复' : r.kind === 'listening' ? '· 在听' : '';
  const key = r.to.join(',') + r.kind;
  return `<button class="route" data-act="route" aria-expanded="${S.pop?.kind === 'route'}"><span class="lbl">发给</span>${stack(r.to.slice(0, 3), 18)}<span class="names swap" data-k="${key}">${names(r.to)}</span>${why ? `<span class="why">${why}</span>` : ''}${ic('chevDown', 's12')}</button>`;
}

function renderComposerMeta() {
  const r = computeRoute(); const g = currentGroup();
  // Strips: reply or quote target, unreachable addresses, sleeping recipients.
  const strips = [];
  if (r.replyPost) {
    const p = r.replyPost; const quoting = p.author === 'user' || !r.to.includes(p.author);
    strips.push(`<div class="strip">${ic(quoting ? 'quote' : 'reply', 's14')}<span class="lbl swap" data-k="${quoting}">${quoting ? '引用' : '回复'} ${name(p.author)}</span><span class="txt">${esc(excerpt(p))}</span><button class="x" data-act="clear-reply" aria-label="取消">${ic('x', 's14')}</button></div>`);
  }
  if (r.gone.length) strips.push(`<div class="strip err">${ic('alert', 's14')}<span class="txt">${names(r.gone)} 已不在群里，这条发不出去。</span>${r.gone.map(id => `<button class="btn" data-act="drop-gone" data-bot="${id}">去掉 @${name(id)}</button>`).join('')}<button class="btn quiet" data-act="route">改发给…</button></div>`);
  const sleeping = r.to.filter(id => S.bots[id].asleep);
  if (sleeping.length) strips.push(`<div class="strip warn">${ic('moon', 's14')}<span class="txt">${names(sleeping)} 在休息：消息会留在群里，唤醒后才收得到。</span>${sleeping.map(id => `<button class="btn" data-act="wake" data-bot="${id}">现在唤醒</button>`).join('')}</div>`);
  const next = strips.join(''); const box = $('#stripsIn');
  if (box.dataset.key !== next) { box.innerHTML = next; box.dataset.key = next; }
  $('#strips').classList.toggle('on', strips.length > 0);
  // Recipient chip: keep the element when nothing changed so its swap animation runs only on change.
  const chip = routeChipHtml(r); const wrap = $('#routeWrap');
  if (wrap.dataset.html !== chip) { wrap.innerHTML = chip; wrap.dataset.html = chip; }
  // Tokens show whether their member can receive.
  input().querySelectorAll('.mention[data-bot]').forEach(n => { n.classList.toggle('gone', !isMember(g, n.dataset.bot)); n.classList.toggle('asleep', isMember(g, n.dataset.bot) && S.bots[n.dataset.bot].asleep); });
  input().dataset.placeholder = g.members.some(m => m.listening) ? '发消息' : '@ 成员可让它接话';
  $('#send').disabled = draftEmpty() || r.gone.length > 0;
  if (S.pop?.kind === 'route') renderPop();
}

/* ── Input behaviour ──────────────────────────────────────────────────────────── */
function bindInput() {
  const el = input();
  el.addEventListener('input', onDraftInput);
  el.addEventListener('keydown', (e) => {
    if (S.pop?.kind === 'mention') {
      const items = mentionItems();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); S.pop.index = (S.pop.index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; renderPop(); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && items.length) { e.preventDefault(); pickMention(items[S.pop.index]); return; }
      if (e.key === 'Escape') { e.preventDefault(); closePop(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!$('#send').disabled) sendDraft(); }
    if (e.key === 'Escape' && S.reply) { S.reply = null; renderComposerMeta(); }
  });
  // Pasted text stays content: a name in pasted code never becomes an address.
  el.addEventListener('paste', (e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
}
function mentionQuery() {
  const sel = getSelection(); if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0); const node = r.startContainer;
  if (node.nodeType !== 3 || !input().contains(node)) return null;
  const before = node.textContent.slice(0, r.startOffset);
  const m = /@([^\s@]{0,12})$/.exec(before);
  return m ? { node, start: r.startOffset - m[0].length, end: r.startOffset, q: m[1] } : null;
}
function onDraftInput() {
  if (input().innerHTML === '<br>') input().innerHTML = '';
  const mq = mentionQuery();
  if (mq) { S.pop = { kind: 'mention', q: mq.q, index: 0 }; renderPop(); }
  else if (S.pop?.kind === 'mention') closePop();
  renderComposerMeta();
}
function mentionItems() {
  const g = currentGroup(); const q = (S.pop?.q || '').toLowerCase();
  const bots = g.members.map(m => m.bot).filter(id => !q || name(id).toLowerCase().includes(q)).map(id => ({ kind: 'bot', id }));
  const files = [{ kind: 'file', id: 'release-notes.md', label: 'release-notes.md' }, { kind: 'task', id: 'build', label: '构建 Windows 镜像' }].filter(x => !q || x.label.toLowerCase().includes(q));
  return [...bots, ...files];
}
function mentionPopHtml() {
  const g = currentGroup(); const items = mentionItems();
  let html = '', section = '';
  items.forEach((it, i) => {
    const sec = it.kind === 'bot' ? '群成员' : it.kind === 'file' ? '文件' : '任务';
    if (sec !== section) { html += `${section ? '<div class="sep"></div>' : ''}<div class="ph">${sec}</div>`; section = sec; }
    if (it.kind === 'bot') {
      const m = g.members.find(x => x.bot === it.id); const st = activityLabel(it.id, g);
      const tag = S.bots[it.id].asleep ? '<small class="warn">休息中</small>' : m.listening ? `<small>${ic('ear', 's12')} 在听</small>` : st.tone === 'live' ? `<small>${st.text}</small>` : '';
      html += `<button class="opt ${i === S.pop.index ? 'kb' : ''}" data-act="pick-mention" data-i="${i}">${av(it.id, 24)}<span class="name">${name(it.id)}</span>${tag}</button>`;
    } else html += `<button class="opt ${i === S.pop.index ? 'kb' : ''}" data-act="pick-mention" data-i="${i}"><span class="ic">${ic(it.kind === 'file' ? 'file' : 'task', 's14')}</span><span class="name">${it.label}</span></button>`;
  });
  if (!items.length) html = '<div class="foot">没有匹配的成员、文件或任务</div>';
  return `<div class="pop" style="left:8px;bottom:calc(100% + 8px);width:268px">${html}</div>`;
}
function tokenHtml(id) { return `<span class="mention" contenteditable="false" data-bot="${id}">@${name(id)}</span>`; }
function pickMention(it) {
  const mq = mentionQuery();
  if (it.kind !== 'bot') { if (mq) { mq.node.textContent = mq.node.textContent.slice(0, mq.start) + it.label + ' ' + mq.node.textContent.slice(mq.end); } closePop(); renderComposerMeta(); return; }
  insertToken(it.id, mq); closePop(); renderComposerMeta();
}
function insertToken(id, mq) {
  const el = input(); el.focus();
  const tmp = document.createElement('span'); tmp.innerHTML = tokenHtml(id); const token = tmp.firstChild; const space = document.createTextNode(' ');
  if (mq) {
    const after = mq.node.splitText(mq.start); after.textContent = after.textContent.slice(mq.end - mq.start);
    after.parentNode.insertBefore(token, after); after.parentNode.insertBefore(space, after);
  } else { el.append(token, space); }
  const sel = getSelection(); const r = document.createRange(); r.setStartAfter(space); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
}
function toggleMention(id) {
  const tokens = input().querySelectorAll(`.mention[data-bot="${id}"]`);
  if (tokens.length) tokens.forEach(n => { const s = n.nextSibling; if (s && s.nodeType === 3 && s.textContent.startsWith(' ')) s.textContent = s.textContent.slice(1); n.remove(); });
  else { const tmp = document.createElement('span'); tmp.innerHTML = tokenHtml(id); input().prepend(tmp.firstChild, document.createTextNode(' ')); }
  renderComposerMeta();
}
// Checking a member in the recipient list is additive: implicit recipients become explicit @ first.
function routeToggle(id) {
  const r = computeRoute();
  if (r.kind === 'mention' || r.kind === 'none') { toggleMention(id); return; }
  const next = r.to.includes(id) ? r.to.filter(x => x !== id) : [...r.to, id];
  if (!next.length) { toast(r.kind === 'reply' ? '回复对象会收到这条。取消回复后就不发给它。' : '关掉它的「在听」，或 @ 其他成员。'); return; }
  [...next].reverse().forEach(x => { if (!input().querySelector(`.mention[data-bot="${x}"]`)) { const tmp = document.createElement('span'); tmp.innerHTML = tokenHtml(x); input().prepend(tmp.firstChild, document.createTextNode(' ')); } });
  renderComposerMeta();
}
function draftToPost() {
  const clone = input().cloneNode(true);
  let quoteOf = null;
  clone.querySelectorAll('.quote-tok').forEach(n => { quoteOf = quoteOf || n.dataset.quote; n.remove(); });
  clone.querySelectorAll('.mention').forEach(n => n.removeAttribute('contenteditable'));
  return { html: clone.innerHTML.replace(/&nbsp;/g, ' ').trim(), quoteOf };
}
function clearDraft() { input().innerHTML = ''; renderComposerMeta(); }

/* ── Route popover: who gets it and why; choosing a member edits the @ in the draft ── */
function routePopHtml() {
  const g = currentGroup(); const r = computeRoute(); const ids = draftMentions();
  const rows = g.members.map(m => {
    const on = r.to.includes(m.bot);
    const quoted = r.replyPost && r.replyPost.author === m.bot && !on;
    let why = ids.includes(m.bot) ? '被 @' : r.kind === 'reply' && on ? '回复对象' : r.kind === 'listening' && on ? '在听' : quoted ? '被引用 · 这条不发给它' : m.listening ? '在听 · 这条不发给它' : '';
    if (S.bots[m.bot].asleep) why = why ? `${why} · 休息中` : '休息中';
    return `<button class="opt" data-act="route-toggle" data-bot="${m.bot}"><span class="chk ${on ? 'on' : ''}">${on ? ic('check') : ''}</span>${av(m.bot, 24)}<span class="name">${name(m.bot)}</span><small class="${S.bots[m.bot].asleep ? 'warn' : ''}">${why}</small></button>`;
  }).join('');
  const gone = r.gone.map(id => `<button class="opt" data-act="route-toggle" data-bot="${id}"><span class="chk on">${ic('check')}</span>${av(id, 24)}<span class="name">${name(id)}</span><small class="warn">已不在群里</small></button>`).join('');
  return `<div class="pop route-pop" style="right:8px;bottom:calc(100% + 8px)"><div class="ph">这条消息发给</div>${rows}${gone}<div class="sep"></div>
    <div class="foot">先看 @，其次是回复对象；都没有时，发给在听的成员。勾选会改动消息里的 @。</div></div>`;
}

function renderPop() {
  document.querySelectorAll('#composer > .pop').forEach(n => n.remove());
  if (S.pop?.kind === 'mention') $('#composer').insertAdjacentHTML('beforeend', mentionPopHtml());
  if (S.pop?.kind === 'route') $('#composer').insertAdjacentHTML('beforeend', routePopHtml());
  if (S.pop?.kind === 'more') { const el = $(`#p-${S.pop.id} .bwrap`); if (el) el.insertAdjacentHTML('beforeend', morePopHtml(S.pop.id)); }
}
function morePopHtml(id) {
  const p = findPost(id); const side = p.author === 'user' ? 'left:-8px' : 'right:-8px';
  return `<div class="pop" style="${side};top:16px;width:210px">
    ${p.author !== 'user' ? `<button class="opt">${ic('chat', 's14')}<span class="name">在和 ${name(p.author)} 的私聊里继续</span></button>` : ''}
    ${p.work ? `<button class="opt" data-act="open-work" data-title="${esc(p.work.title)}">${ic('task', 's14')}<span class="name">打开任务</span></button>` : ''}
    <button class="opt">${ic('external', 's14')}<span class="name">复制消息链接</span></button></div>`;
}
function closePop() { const had = S.pop; S.pop = null; document.querySelectorAll('.pop').forEach(n => n.remove()); if (had?.kind === 'new') renderSidebar(); if (had?.kind === 'route') renderComposerMeta(); if (had?.kind === 'gmenu') { renderPanel(); if (S.sheet === 'panel') renderOverlay(); } }
