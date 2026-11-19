// Behaviour: delivery simulation, scripted steps, events. Prototype only; the product resolves all of this on the Host.
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const CLOCKS = { release: 14 * 60 + 1, review: 10 * 60 + 20, create: 14 * 60 + 6, edges: 9 * 60 + 31 };
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
function now() { return fmt(S.clock); }
function tick() { S.clock += 1; return now(); }
const RETRY_REPLIES = {
  design: '看了改版稿：深色主题下分组标题的对比度只有 3.1:1，建议提到 4.5:1 以上。其他没问题。',
  ops: '还剩 212 GB，占用 61%。',
};
const FOLLOWUPS = {
  async 'qa-e2e'(p) {
    const work = { title: 'e2e · 设置页', owner: 'qa', status: 'running', step: 1, steps: ['准备浏览器', '桌面布局 · 24 项', '窄屏布局 · 14 项', '汇总结果'] };
    await botPost('qa', '开始跑了，结果会发在这里。', { work, think: 500 });
    setActivity('qa', 'working', 'e2e 测试');
    for (let i = 2; i <= 4; i += 1) { await wait(850); work.step = i; refreshWork(work); }
    work.status = 'done'; work.summary = '38 项全部通过'; work.doneAt = now(); refreshWork(work); setActivity('qa', 'idle');
    await botPost('qa', '跑完了：38 项全部通过，窄屏布局正常。从测试角度可以合并。', { think: 600, replyTo: p.replyTo });
  },
};

/* ── State changes ────────────────────────────────────────────────────────────── */
function addPost(p, gid = S.group) {
  const g = S.groups[gid]; p.arrive = true; g.posts.push(p);
  if (gid === S.group) { const stick = nearBottom(); renderTimeline(); if (!stick && p.author !== 'user') S.unseen = (S.unseen || 0) + 1; }
  else g.unread = (g.unread || 0) + 1;
  renderSidebar(); renderPanel(); renderDockAbove(); if (S.device === 'phone') renderTitlebar();
  return p;
}
function setActivity(id, activity, text = '', gid = S.group) {
  Object.assign(S.bots[id], { activity, activityText: text, group: gid });
  renderDockAbove(); renderPanel(); renderSidebar(); if (S.device === 'phone') renderTitlebar();
}
function setListening(gid, bot, on, by) {
  const m = S.groups[gid].members.find(x => x.bot === bot); m.listening = on; m.by = on ? by : null;
  renderPanel(); renderComposerMeta(); renderTitlebar();
}
function flashMember(bot) { const el = $(`#mrow-${bot}`); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }
async function stream(p, speed = 30) {
  const text = textOf(p.html); let n = 0;
  while (n < text.length) { n = Math.min(text.length, n + 1 + Math.floor(Math.random() * 3)); p.shown = text.slice(0, n); updateStream(p); await wait(speed); }
  p.streaming = false; refreshPost(p);
}
async function botAnswer(id, to, html, o = {}) {
  const g = groupOf(to.id) || currentGroup();
  if (to.rc && id in to.rc) { to.rc[id] = 'working'; refreshPost(to); }
  setActivity(id, 'thinking', '', g.id);
  await wait(o.think ?? 900);
  const p = botMsg(id, html, { time: now(), replyTo: to.id, streaming: true, shown: '', work: o.work, ask: o.ask, fold: o.fold });
  setActivity(id, 'replying', '', g.id); addPost(p, g.id);
  await stream(p, o.speed);
  if (to.rc && id in to.rc) { to.rc[id] = 'replied'; refreshPost(to); }
  setActivity(id, 'idle', '', g.id);
  return p;
}
async function botPost(id, html, o = {}) {
  const g = currentGroup();
  if (o.think) { setActivity(id, 'thinking', '', g.id); await wait(o.think); }
  const p = botMsg(id, html, { id: o.id, time: now(), replyTo: o.replyTo || null, streaming: true, shown: '', work: o.work, ask: o.ask, to: o.to, handoff: o.handoff, rc: o.rc || {} });
  setActivity(id, 'replying', '', g.id); addPost(p, g.id);
  await stream(p, o.speed);
  setActivity(id, 'idle', '', g.id);
  return p;
}
function refreshWork(work) {
  for (const g of Object.values(S.groups)) g.posts.filter(p => p.work === work).forEach(refreshPost);
  renderPanel();
}
const findWork = (title) => { for (const g of Object.values(S.groups)) { const p = g.posts.find(x => x.work?.title === title); if (p) return p.work; } return null; };
const findAsk = (state) => currentGroup().posts.find(p => p.ask?.state === state);
async function resolveAsk(id, v) {
  const p = findPost(id); if (!p || p.ask.state !== 'pending') return;
  p.ask.state = v; p.ask.at = now(); refreshPost(p); renderPanel(); renderTitlebar(); renderSidebar(); renderDockAbove();
  if (v !== 'denied' && p.ask.follow && FOLLOWUPS[p.ask.follow]) await FOLLOWUPS[p.ask.follow](p);
}
function addSchedule(gid, s) {
  const g = S.groups[gid]; (g.schedules ||= []).push(s); S.flashSched = s.id;
  renderPanel(); if (S.sheet === 'panel') renderOverlay();
}
function jumpTo(id) {
  const g = groupOf(id); if (g && g.id !== S.group) switchGroup(g.id);
  const el = $(`#p-${id}`); if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const b = el.querySelector('.bubble'); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
}
async function wakeAndRetry(postId, bot) {
  const p = findPost(postId); const b = S.bots[bot];
  b.waking = true; p.rc[bot] = 'working'; refreshPost(p); renderPanel(); renderComposerMeta();
  await wait(1100); b.asleep = false; b.waking = false; renderAll();
  await botAnswer(bot, p, RETRY_REPLIES[bot] || FREE_REPLIES[bot], { think: 900 });
}
async function wakeOnly(bot) { const b = S.bots[bot]; b.waking = true; renderPanel(); await wait(1000); b.asleep = false; b.waking = false; renderAll(); }
async function retryDelivery(postId, bot) { const p = findPost(postId); p.rc[bot] = 'working'; refreshPost(p); await botAnswer(bot, p, RETRY_REPLIES[bot] || FREE_REPLIES[bot], { think: 900 }); }

/* ── Composer helpers for scripted steps ──────────────────────────────────────── */
function caretToEnd(node) { const r = document.createRange(); r.setStart(node, node.textContent.length); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
function appendText(ch) { const el = input(); let last = el.lastChild; if (!last || last.nodeType !== 3) { last = document.createTextNode(''); el.appendChild(last); } last.textContent += ch; caretToEnd(last); }
async function typeDraft(parts) {
  input().focus();
  for (const part of parts) {
    if (Array.isArray(part)) {
      appendText('@'); onDraftInput(); await wait(420);
      const items = mentionItems(); const i = items.findIndex(x => x.kind === 'bot' && x.id === part[1]);
      if (S.pop) { S.pop.index = Math.max(0, i); renderPop(); } await wait(300);
      pickMention(items[Math.max(0, i)]); await wait(120);
    } else for (const ch of part) { appendText(ch); onDraftInput(); await wait(ch === ' ' ? 20 : 34 + Math.random() * 30); }
  }
}
function setDraft(parts) { input().innerHTML = parts.map(p => Array.isArray(p) ? tokenHtml(p[1]) : esc(p)).join(''); renderComposerMeta(); }
function sendDraft() {
  const r = computeRoute(); if (draftEmpty() || r.gone.length) return null;
  const { html, quoteOf } = draftToPost();
  const post = user(html, { time: tick(), to: r.to, kind: r.kind, replyTo: r.replyPost ? r.replyPost.id : quoteOf, rc: {} });
  r.to.forEach(id => { post.rc[id] = S.bots[id].asleep ? 'asleep' : 'working'; });
  S.reply = null; input().innerHTML = ''; closePop();
  S.unseen = 0; addPost(post); renderComposerMeta(); $('#timeline').scrollTop = 1e9;
  if (!S.running) freeReplies(post, r);
  return post;
}
// Free typing: addressed members answer; listeners answer questions and stay quiet otherwise.
function freeReplies(post, r) {
  const text = textOf(post.html);
  const asked = /[?？吗呢帮请看]/.test(text);
  if (r.kind === 'mention' && /没.?@|没指定|你来接/.test(text)) {
    const id = r.to.find(x => !S.bots[x].asleep); if (!id) return;
    const gid = S.group;
    botAnswer(id, post, '好。之后这里没指定对象的消息由我来接，需要别人做的我会点名。', { think: 900 }).then(() => {
      setListening(gid, id, true, { who: 'self', time: now() }); addPost(event(`${name(id)} 开始接收未指定对象的消息`, { icon: 'ear', time: now() }), gid); flashMember(id);
    });
    r.to.filter(x => x !== id && !S.bots[x].asleep).forEach(x => botAnswer(x, post, FREE_REPLIES[x], { think: 1500 }));
    return;
  }
  r.to.filter(id => !S.bots[id].asleep).forEach((id, i) => {
    if (r.kind === 'listening' && !asked) { setActivity(id, 'thinking'); setTimeout(() => { post.rc[id] = 'silent'; refreshPost(post); setActivity(id, 'idle'); }, 1400 + i * 300); return; }
    botAnswer(id, post, FREE_REPLIES[id], { think: 900 + i * 500 });
  });
}
function actOnMessage(id, act) {
  const el = $(`#p-${id}`);
  if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el.classList.add('show-acts'); el.querySelector(`.acts [data-act="${act}"]`)?.classList.add('hl'); setTimeout(() => { el.classList.remove('show-acts'); el.querySelector('.acts .hl')?.classList.remove('hl'); }, 900); }
  setTimeout(() => doMessageAction(id, act), el ? 380 : 0);
}
function doMessageAction(id, act) {
  const p = findPost(id); if (!p) return;
  if (act === 'reply') { S.reply = id; renderComposerMeta(); input().focus(); if (input().lastChild) caretToEnd(input().lastChild); }
  if (act === 'quote') { const tmp = document.createElement('span'); tmp.innerHTML = `<span class="mention quote-tok" contenteditable="false" data-quote="${id}">❝ ${name(p.author)}</span>`; input().append(tmp.firstChild, document.createTextNode(' ')); input().focus(); caretToEnd(input().lastChild); renderComposerMeta(); }
  if (act === 'copy') toast('已复制');
  if (S.sheet?.kind === 'acts') { S.sheet = null; renderOverlay(); }
}
function openRoutePop() { S.pop = { kind: 'route' }; renderComposerMeta(); renderPop(); }
function openMenu() { S.pop = { kind: 'new' }; renderSidebar(); if (S.device === 'phone') { S.drawer = true; renderOverlay(); } }
function openDialog() { closePop(); S.drawer = false; S.dialog = { name: '', picks: [] }; renderOverlay(); setTimeout(() => $('#gname')?.focus(), 30); }
async function typeField(sel, text) { const f = $(sel); f.focus(); for (const ch of text) { f.value += ch; S.dialog.name = f.value; syncCreate(); await wait(90); } }
function syncCreate() { const b = $('[data-act="create"]'); if (b) b.disabled = !(S.dialog.name.trim() && S.dialog.picks.length); }
function togglePick(bot) { const d = S.dialog; d.picks = d.picks.includes(bot) ? d.picks.filter(x => x !== bot) : [...d.picks, bot]; renderOverlay(); }
function createGroup() {
  const d = S.dialog; if (!d || !d.name.trim() || !d.picks.length) return;
  const id = `g${++seq}`;
  S.groups = { [id]: { id, name: d.name.trim(), members: d.picks.map(b => member(b)), left: [], unread: 0, posts: [day('今天'), event(`你创建了群聊，邀请了 ${names(d.picks, 4)}`, { icon: 'users', time: now() })] }, ...S.groups };
  saveDraft(); S.dialog = null; S.group = id; S.sub = null; S.reply = null; S.tab = 'members'; input().innerHTML = ''; renderAll();
}
function saveDraft() { const g = currentGroup(); if (g && $('#input')) g.draft = input().innerHTML; }
function switchGroup(id) {
  if (id === S.group) return; saveDraft();
  S.group = id; S.reply = null; S.sub = null; S.unseen = 0; S.groups[id].unread = 0; S.drawer = false;
  input().innerHTML = S.groups[id].draft || ''; closePop(); renderAll();
}
function toast(text) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; $('#app').appendChild(t); setTimeout(() => t.remove(), 1600); }

/* ── Scenes and steps ─────────────────────────────────────────────────────────── */
function loadScene(k) {
  const sc = SCENES[k];
  S.scene = k; S.step = 0; S.running = false; S.reply = null; S.sub = null; S.tab = 'members'; S.pop = null; S.dialog = null; S.sheet = null; S.drawer = false; S.unseen = 0;
  S.bots = Object.fromEntries(Object.keys(BOTS).map(id => [id, { asleep: sc.asleep.includes(id), activity: 'idle', activityText: '', group: null, waking: false }]));
  S.groups = baseGroups(); S.clock = CLOCKS[k]; S.pendingDraft = null;
  SCENES.review.setup(S); SCENES.edges.setup(S);
  if (k !== 'review' && k !== 'edges') sc.setup(S);
  if (k !== 'edges') S.groups.daily.draft = ''; else S.groups.daily.draft = S.pendingDraft.map(p => Array.isArray(p) ? tokenHtml(p[1]) : esc(p)).join('');
  S.group = sc.group; S.groups[S.group].unread = 0;
  if ($('#input')) input().innerHTML = S.groups[S.group].draft || '';
  renderAll();
}
async function nextStep() {
  const sc = SCENES[S.scene]; const st = sc.steps[S.step]; if (!st || S.running) return;
  S.running = true; renderProto();
  try { await st.run(); } finally { S.step += 1; S.running = false; renderProto(); }
}

/* ── Events ───────────────────────────────────────────────────────────────────── */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (S.pop && !e.target.closest('.pop') && !(t && ['route', 'new-menu', 'more', 'at', 'gmenu'].includes(t.dataset.act))) closePop();
  if (!t) return;
  const { act, id, bot, v } = t.dataset;
  switch (act) {
    case 'scene': loadScene(v); break;
    case 'next': nextStep(); break;
    case 'restart': loadScene(S.scene); break;
    case 'device': saveDraft(); S.device = v; S.sheet = null; S.drawer = false; mount(); break;
    case 'theme': S.theme = v; $('#app').classList.toggle('dark', v === 'dark'); renderProto(); break;
    case 'nav': S.navOpen = !S.navOpen; renderTitlebar(); break;
    case 'panel': S.panelOpen = !S.panelOpen; if (S.panelOpen) { S.sub = null; } renderTitlebar(); renderPanel(); break;
    case 'drawer': S.drawer = true; renderOverlay(); break;
    case 'close-drawer': S.drawer = false; closePop(); renderOverlay(); break;
    case 'sheet': S.sheet = S.sheet === 'panel' ? null : 'panel'; renderOverlay(); renderTitlebar(); break;
    case 'close-sheet': S.sheet = null; renderOverlay(); renderTitlebar(); break;
    case 'group': switchGroup(id); break;
    case 'bot': toast('这个原型只演示群聊'); break;
    case 'new-menu': if (S.pop?.kind === 'new') closePop(); else openMenu(); break;
    case 'new-group': openDialog(); break;
    case 'close-dialog': S.dialog = null; renderOverlay(); break;
    case 'scrim': if (e.target === t) { S.dialog = null; renderOverlay(); } break;
    case 'pick': togglePick(bot); break;
    case 'create': createGroup(); break;
    case 'tab': S.tab = v; S.sub = null;
      if (t.closest('.timeline')) { if (S.device === 'phone') { S.sheet = 'panel'; renderOverlay(); } else if (!S.panelOpen) { S.panelOpen = true; renderTitlebar(); } }
      renderPanel(); if (S.sheet === 'panel') renderOverlay(); break;
    case 'sched': S.openSched = S.openSched === id ? null : id; renderPanel(); if (S.sheet === 'panel') renderOverlay(); break;
    case 'new-sched': toast('打开日历，发到本群已经选好'); break;
    case 'gmenu': S.pop = S.pop?.kind === 'gmenu' ? null : { kind: 'gmenu' }; renderPanel(); if (S.sheet === 'panel') renderOverlay(); break;
    case 'files': S.pop = null; S.sub = { kind: 'files' }; renderPanel(); if (S.sheet === 'panel') renderOverlay(); break;
    case 'member': if (e.target.closest('.sw')) break; S.sub = { kind: 'member', bot }; if (S.device === 'phone') { S.sheet = 'panel'; renderOverlay(); } else { S.panelOpen = true; renderTitlebar(); renderPanel(); } break;
    case 'back': S.sub = null; renderPanel(); if (S.sheet === 'panel') renderOverlay(); break;
    case 'listen': { const g = currentGroup(); const m = g.members.find(x => x.bot === bot); const on = !m.listening;
      setListening(g.id, bot, on, { who: 'user', time: now() }); addPost(event(`你让 ${name(bot)} ${on ? '开始' : '停止'}接收未指定对象的消息`, { icon: 'ear', time: now() })); if (S.sheet === 'panel') renderOverlay(); break; }
    case 'remove-member': { const g = currentGroup(); g.members = g.members.filter(m => m.bot !== bot); g.left.push(bot); S.sub = null; addPost(event(`你把 ${name(bot)} 移出了群聊，之前的发言保留署名`, { icon: 'users', time: now() })); renderAll(); break; }
    case 'add-member': toast('从 Bot 列表里选择要加入的成员'); break;
    case 'open-work': S.sub = { kind: 'work', title: t.dataset.title }; S.tab = 'activity'; closePop(); if (S.device === 'phone') { S.sheet = 'panel'; renderOverlay(); } else { S.panelOpen = true; renderTitlebar(); renderPanel(); } break;
    case 'jump-work': { const g = currentGroup(); const p = g.posts.find(x => x.work?.title === t.dataset.title); if (p) jumpTo(p.id); break; }
    case 'jump': if (S.sheet) { S.sheet = null; renderOverlay(); renderTitlebar(); } jumpTo(id); break;
    case 'ask': resolveAsk(id, v); break;
    case 'unfold': { const p = findPost(id); p.expanded = !p.expanded; refreshPost(p); break; }
    case 'reply': case 'quote': case 'copy': doMessageAction(id, act); break;
    case 'more': S.pop = S.pop?.kind === 'more' && S.pop.id === id ? null : { kind: 'more', id }; document.querySelectorAll('.pop').forEach(n => n.remove()); if (S.pop) renderPop(); break;
    case 'clear-reply': S.reply = null; renderComposerMeta(); input().focus(); break;
    case 'route': if (S.pop?.kind === 'route') closePop(); else openRoutePop(); break;
    case 'route-toggle': routeToggle(bot); break;
    case 'drop-gone': { const ids = bot ? [bot] : computeRoute().gone; ids.forEach(toggleMention); input().focus(); if (input().lastChild) caretToEnd(input().lastChild); break; }
    case 'at': input().focus(); if (input().lastChild) caretToEnd(input().lastChild); appendText(input().textContent && !/\s$/.test(input().textContent) ? ' @' : '@'); onDraftInput(); break;
    case 'pick-mention': pickMention(mentionItems()[Number(t.dataset.i)]); break;
    case 'send': sendDraft(); break;
    case 'wake-retry': wakeAndRetry(id, bot); break;
    case 'wake': wakeOnly(bot); break;
    case 'retry': retryDelivery(id, bot); break;
    case 'starter': input().innerHTML = ''; setDraft([['at', bot], ' 这里没 @ 人的消息，你来接。']); input().focus(); caretToEnd(input().lastChild); break;
    case 'starter-intro': { const ids = currentGroup().members.map(m => m.bot); input().innerHTML = ''; setDraft([...ids.flatMap(i => [['at', i], ' ']), '简单介绍一下你们各自能做什么？']); input().focus(); caretToEnd(input().lastChild); break; }
    case 'to-bottom': $('#timeline').scrollTo({ top: 1e9, behavior: 'smooth' }); S.unseen = 0; renderDockAbove(); break;
  }
});
document.addEventListener('input', (e) => { if (e.target.id === 'gname' && S.dialog) { S.dialog.name = e.target.value; syncCreate(); } });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (S.dialog) { S.dialog = null; renderOverlay(); } else if (S.sheet || S.drawer) { S.sheet = null; S.drawer = false; renderOverlay(); renderTitlebar(); } else if (S.pop) closePop(); }
  if (e.key === 'Enter' && e.target.id === 'gname') createGroup();
});
// Tooltips.
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]'); const tip = $('#tip'); if (!tip) return;
  if (!t || S.device === 'phone') { tip.hidden = true; return; }
  const app = $('#app').getBoundingClientRect(); const r = t.getBoundingClientRect();
  tip.textContent = t.dataset.tip; tip.hidden = false;
  const w = tip.offsetWidth; let left = r.left + r.width / 2 - w / 2 - app.left; left = Math.max(8, Math.min(left, app.width - w - 8));
  const above = r.top - app.top - tip.offsetHeight - 8;
  tip.style.left = `${left}px`; tip.style.top = `${above > 4 ? above : r.bottom - app.top + 8}px`;
});
// Phone: long-press a message for its actions.
let pressTimer = null;
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.phone .msg .bubble'); if (!b) return;
  const id = b.closest('.msg').dataset.id;
  pressTimer = setTimeout(() => { S.sheet = { kind: 'acts', id }; renderOverlay(); }, 450);
});
['pointerup', 'pointermove', 'pointercancel'].forEach(t => document.addEventListener(t, (e) => { if (e.type !== 'pointermove' || Math.abs(e.movementY) > 3) clearTimeout(pressTimer); }));
document.addEventListener('scroll', (e) => { if (e.target.id === 'timeline') { if (nearBottom()) S.unseen = 0; requestAnimationFrame(renderDockAbove); } }, true);

mount();
loadScene('release');
