/* Varin · 总助手设计稿 · 标题栏、侧栏、会话正文与输入框 */
(function () {
  'use strict';
  const VC = window.VC, D = VC.data, S = VC.state, ic = VC.icon, esc = VC.esc, $ = VC.$;

  // ---------------------------------------------------------------- Varin 此刻的状态：一句话，取能确认的事实
  VC.botLine = () => {
    if (S.busy === 'reading') return { dot: 'live', text: '正在读取 Researcher 的回报', fig: 'working' };
    if (S.busy === 'waiting') return { dot: 'info', text: '在等 Reviewer 检查「发布页面」', fig: 'listening' };
    if (S.busy === 'thinking') return { dot: 'live', text: S.now === 'woke' ? '读取你的消息' : '思考中', fig: 'thinking' };
    const need = VC.needs().length;
    if (need) return { dot: 'warn', text: `${need} 件事等你决定`, fig: 'waiting' };
    return { dot: 'ok', text: '3 项工作在进行，没有要你处理的', fig: 'idle' };
  };
  VC.needs = () => D.works.filter((w) => w.state.kind === 'need' && !(w.id === 'w2' && S.answered));

  // ---------------------------------------------------------------- 标题栏
  // 手机状态栏是系统的区域（时间、电量、摄像头开孔）；应用内容从安全区下方开始，这里只为评审画出不同机型
  const DEVICES = { island: '灵动岛', notch: '刘海', punch: '居中打孔', 'punch-left': '左上打孔' };
  VC.DEVICES = DEVICES;
  const statusBar = () => `<span class="sb-time">9:41</span><span class="cutout" aria-hidden="true"></span>
    <span class="sb-sys"><svg viewBox="0 0 18 12" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
      <svg viewBox="0 0 26 12" aria-hidden="true"><rect x=".5" y=".5" width="22" height="11" rx="3.2" fill="none" stroke="currentColor" opacity=".45"/><rect x="2.2" y="2.2" width="16" height="7.6" rx="1.8"/><rect x="23.6" y="4" width="1.8" height="4" rx=".9" opacity=".45"/></svg></span>`;

  VC.parts.title = () => {
    const sbar = $('#sbar');
    if (sbar) { sbar.dataset.device = S.device || 'island'; sbar.innerHTML = S.size === 'mobile' ? statusBar() : ''; }
    // 手机：左侧会话列表，中间状态胶囊（会话名 / 当前动作 / 等你），右侧打开 Varin 面板
    if (S.size === 'mobile') {
      const warn = VC.needs().length && !S.drawer;
      $('#tb').innerHTML = `<div class="tb-left"><button class="tb-btn" data-act="sidebar" aria-label="会话">${ic('side')}</button></div><div class="island-slot" id="islandSlot"></div>
        <div class="tb-right"><button class="tb-btn" data-act="panel" aria-label="Varin 面板" aria-pressed="${Boolean(S.drawer)}">${ic('panel')}${warn ? '<span class="tb-badge"></span>' : ''}</button></div>`;
      VC.mountIsland?.($('#islandSlot'));
      return;
    }
    const panelHidden = S.size !== 'desktop' ? !S.drawer : Boolean(S.panelHidden);
    const warn = VC.needs().length && (panelHidden || (S.views.length && S.active));
    $('#tb').innerHTML = `
      <div class="tb-left">
        <button class="tb-btn no-mobile" data-act="sidebar" aria-label="侧栏" aria-pressed="${S.sidebar}" title="侧栏 · Ctrl B">${ic('side')}</button>
        <button class="pill no-mobile" type="button" aria-label="模式：Bot">${ic('bot', 'sm')}<span>Bot</span><span class="chev">${ic('chev', 'xs')}</span></button>
        <button class="tb-btn mobile-only" data-act="sidebar" aria-label="会话">${ic('side')}</button>
      </div>
      <div class="tb-title"><div class="tb-main trunc">发布季准备</div><div class="tb-sub">Varin</div></div>
      <div class="tb-right">
        <button class="pill svc-pill no-mobile" data-act="svc" aria-expanded="${S.svcPop}" title="Varin 服务与设备"><span class="dot ok"></span><span>家中主机</span><span class="chev">${ic('chev', 'xs')}</span></button>
        <button class="tb-btn" data-act="panel" aria-label="Varin 面板" aria-pressed="${!panelHidden}" title="面板">${ic('panel')}${warn ? '<span class="tb-badge"></span>' : ''}</button>
      </div>`;
  };

  // ---------------------------------------------------------------- 侧栏：Bot → 会话
  VC.parts.side = () => {
    const icon = (st) => st === 'run' ? '<span class="spin"></span>' : st === 'live' ? '<span class="dot warn"></span>' : '';
    $('#sb').innerHTML = `<div class="sb-in">
      <button class="sb-new">${ic('new')}<span>新建会话</span><kbd>Ctrl N</kbd></button>
      <div class="sb-group"><div class="sb-bot"><span class="fig-host" id="sbFig"></span>Varin</div>
        ${D.sessions.map((x) => `<button class="sb-row" aria-current="${x.id === 's1'}"><span class="grow trunc">${esc(x.title)}</span>${icon(x.state)}</button>`).join('')}</div>
      <div class="sb-foot"><button class="sb-new">${ic('plus')}<span>新建 Bot</span></button><button class="icon-btn" data-act="settings" data-page="chat" title="设置">${ic('gear')}</button></div>
    </div>`;
    VC.figHead($('#sbFig'), 22);
    VC.decorateSidebar?.($('#sb .sb-in'));
  };

  // ---------------------------------------------------------------- 正文
  const workRef = (id) => {
    const w = D.works.find((x) => x.id === id);
    const need = w.state.kind === 'need' && !S.answered;
    const s = need ? `${ic('alert', 'xs')}等你决定` : w.state.kind === 'run' ? '<span class="spin"></span>进行中' : w.state.text;
    return `<button class="wref${need ? ' need' : ''}" data-act="open-work" data-id="${id}">${VC.avs(w.team, 22, w.lead)}
      <span class="grow"><span class="t trunc" style="display:block">${esc(w.name)}</span><span class="s">${s}</span></span>${ic('right', 'sm')}</button>`;
  };
  VC.questionCard = (where) => {
    const q = D.question, a = D.agents[q.from];
    if (S.answered) {
      return `<div class="req done"><div class="req-h">${VC.av(q.from, 16)}<span><b>${a.name}</b> 的问题 · 整理汇报材料</span></div>
        <div class="req-q">${esc(q.q)}</div><div class="req-f" style="color:var(--muted)">${ic('check', 'sm')}你选了「${esc(q.opts[S.answer][0])}」· 已交给 Writer，它继续写</div></div>`;
    }
    // Varin 代为回答：用户把决定告诉 Varin，Varin 用原请求回答 Writer；卡片记下是谁答的、依据是哪句话
    if (S.answeredBy === 'varin') {
      return `<div class="req done"><div class="req-h">${VC.av(q.from, 16)}<span><b>${a.name}</b> 的问题 · 整理汇报材料</span></div>
        <div class="req-q">${esc(q.q)}</div><div class="req-f" style="color:var(--muted)">${ic('check', 'sm')}Varin 按你的话回答了「${esc(q.opts[S.answer][0])}」· Writer 继续写</div></div>`;
    }
    return `<div class="req" data-where="${where}"><div class="req-h">${VC.av(q.from, 16)}<span><b>${a.name}</b> 的问题 · 整理汇报材料</span></div>
      <div class="req-q">${esc(q.q)}</div>
      ${q.opts.map(([t, d], i) => `<button class="opt" data-act="pick" data-i="${i}" aria-pressed="${S.answer === i}"><span class="r"></span><span><b>${esc(t)}</b><small>${esc(d)}</small></span></button>`).join('')}
      <div class="req-f"><span>可以直接选，也可以在下面告诉 Varin，让它替你回答</span><button class="btn sm primary" data-act="answer" ${S.answer === null ? 'disabled' : ''}>提交</button></div></div>`;
  };
  // 折叠过程行：沿用现有 ChatDialogueActivity 的形式（箭头、动作图标、主要活动，其余种类 +N，完整计数在提示里）
  const actRecord = (m) => {
    const open = S.actOpen[m.id], a = m.act;
    return `<button class="act" data-act="act" data-id="${m.id}" aria-expanded="${Boolean(open)}" title="${esc(a.title || a.label)}"><span class="chev">${ic('right', 'xs')}</span>
      <span class="act-icons">${(a.icons || []).map((n) => ic(n, 'xs')).join('')}</span><span>${esc(a.label)}</span>${a.more ? `<span class="act-more">+${a.more}</span>` : ''}</button>
      ${open ? `<div class="act-list">${a.items.map(([k, v]) => `<div><span class="k">${k}</span>${esc(v)}</div>`).join('')}</div>` : ''}`;
  };
  // 子 Agent 的回报：沿用现有 ChatAgentMessageBubble（头像、发送者 → 接收者、默认折叠两行）
  const report = (m) => {
    const a = D.agents[m.from], open = S.actOpen[m.id];
    return `<article class="amsg"><span class="amsg-av">${VC.av(m.from, 26)}</span><div class="amsg-col">
      <div class="amsg-route"><button data-act="open-work" data-id="${m.work}">${esc(a.name)}</button>${ic('right', 'xs')}<span class="amsg-to">Varin</span><span class="amsg-kind">回报 · ${m.time}</span></div>
      <button class="amsg-bubble" data-act="act" data-id="${m.id}" aria-expanded="${Boolean(open)}"><span class="amsg-text${open ? ' open' : ''}">${esc(m.text)}</span><span class="amsg-tog">${ic(open ? 'up' : 'chev', 'xs')}</span></button>
    </div></article>`;
  };
  const item = (m) => {
    if (m.t === 'day') return `<div class="day">${m.text}</div>`;
    if (m.t === 'report') return report(m);
    if (m.t === 'u') return `<div class="u"><div class="bubble">${esc(m.text)}</div><div class="meta">${m.note ? `<span>${m.note}</span>·` : ''}<span>${m.time}</span></div></div>`;
    if (m.t === 'evt') return `<div class="evt">${VC.av(m.who, 16)}<span>${m.html}</span><button class="link" data-act="open-work" data-id="${m.work}">${m.link}</button><span class="line"></span></div>`;
    return `<div class="a">${m.act ? actRecord(m) : ''}${m.html}${m.wrefs ? `<div class="wrefs">${m.wrefs.map(workRef).join('')}</div>` : ''}${m.req ? VC.questionCard('chat') : ''}</div>
      <div class="turn-tools"><button class="icon-btn" title="复制">${ic('copy', 'sm')}</button><button class="icon-btn" title="分支">${ic('branch', 'sm')}</button><button class="icon-btn" title="重试">${ic('retry', 'sm')}</button></div>`;
  };
  const nowLine = () => {
    const n = S.now; if (!n) return '';
    if (n === 'reading') return `<div class="now"><span class="spin"></span><span class="shimmer">正在读取 Researcher 的回报</span><span class="sub">· 竞品价格调研</span></div>`;
    if (n === 'waiting') return `<div class="now">${ic('clock', 'sm')}<span>在等 <span class="who">Reviewer</span> 检查</span><span class="sub">· 发布页面 · 可以继续跟 Varin 说话</span></div>`;
    if (n === 'woke') return `<div class="now"><span class="spin"></span><span class="shimmer">读取你的消息</span><span class="sub">· 已停止等待，Reviewer 继续检查</span></div>`;
    return `<div class="now"><span class="spin"></span><span class="shimmer">思考中</span></div>`;
  };

  // ---------------------------------------------------------------- 输入框：Varin 默认立即补充；显式“排在之后”
  const pendRow = (p, i) => {
    if (p.kind === 'later') {
      return `<div class="pend"><span class="kind">${ic('clock', 'xs')}稍后</span><span class="txt">${esc(p.text)}</span><span class="state">本轮结束后发送</span>
        <button class="btn sm ghost" data-act="pend-now" data-i="${i}">现在发送</button><button class="icon-btn" data-act="pend-drop" data-i="${i}" title="移除">${ic('x', 'sm')}</button></div>`;
    }
    const got = p.state === 'received';
    return `<div class="pend${got ? ' got' : ''}"><span class="kind">${ic('reply', 'xs')}补充</span><span class="txt">${esc(p.text)}</span>
      <span class="state">${got ? `${ic('check', 'xs')}Varin 已接收` : `<span class="spin"></span>已受理 · 等 Varin 在下一个间隙接收`}</span></div>`;
  };
  const composer = () => {
    const busy = Boolean(S.busy), draft = S.draft || '';
    const sendIcon = busy && !draft.trim() ? 'stop' : 'up';
    return `<div class="dock"><div class="dock-in">
      ${S.pending.length ? `<div class="pending">${S.pending.map((p, i) => [p, i]).sort((a, b) => (a[0].kind === 'later') - (b[0].kind === 'later')).map(([p, i]) => pendRow(p, i)).join('')}</div>` : ''}
      <div class="composer">
        <textarea id="input" rows="1" aria-label="消息" placeholder="${busy ? '补充给 Varin，或者说另一件事…' : '和 Varin 说…'}">${esc(draft)}</textarea>
        <div class="cf">
          <button class="icon-btn" title="附件">${ic('plus')}</button>
          <button class="icon-btn" title="引用工作、文件、电脑或记忆">${ic('at')}</button>
          <span class="cf-gap"></span>
          <button class="cf-chip" title="思考程度">${ic('brain', 'sm')}<span>中</span></button>
          <button class="cf-chip" title="档案里的模型"><span>主力模型</span>${ic('chev', 'xs')}</button>
          <span class="send-group">
            ${busy ? `<button class="send-more" data-act="send-menu" aria-expanded="${S.sendMenu}" title="发送方式">${ic('chev', 'xs')}</button>` : ''}
            <button class="send${sendIcon === 'stop' ? ' stop' : ''}" data-act="${sendIcon === 'stop' ? 'stop' : 'send'}" ${!busy && !draft.trim() ? 'disabled' : ''} title="${sendIcon === 'stop' ? '停止当前回应' : busy ? '立即补充 · Enter' : '发送'}">${ic(sendIcon)}</button>
          </span>
        </div>
      </div>
      ${S.sendMenu ? `<div class="pop" style="right:0;bottom:calc(100% + 6px);width:250px">
        <button class="pop-item" data-act="send" data-mode="steer">${ic('reply')}<span>立即补充<small>Varin 在下一个间隙读到它 · Enter</small></span></button>
        <button class="pop-item" data-act="send" data-mode="later">${ic('clock')}<span>排在本轮之后<small>这一轮做完再发送 · Alt Enter</small></span></button></div>` : ''}
      <div class="dock-hint">${busy ? 'Varin 正在工作 · <kbd>Enter</kbd> 立即补充 · <kbd>Alt</kbd>+<kbd>Enter</kbd> 排在之后 · 输入框为空时可停止当前回应' : ''}</div>
    </div></div>`;
  };

  VC.parts.chat = () => {
    // 阅读位置：在底部时跟随新内容；正在看旧消息时保持原位，不强制滚到底
    if (S.stick === undefined) S.stick = true;
    const items = [...D.chat, ...S.extra];
    $('#chat').innerHTML = `<div class="scroller" id="scroller"><div class="col">${items.map(item).join('')}${nowLine()}</div></div>${composer()}`;
    const next = $('#scroller');
    const place = () => { next.scrollTop = S.stick ? next.scrollHeight : (S.readAt || 0); };
    place(); requestAnimationFrame(place);
    next.addEventListener('scroll', () => { if (!next.clientHeight) return; S.stick = next.scrollHeight - next.scrollTop - next.clientHeight < 40; S.readAt = next.scrollTop; }, { passive: true });
    const ta = $('#input');
    ta.addEventListener('input', () => { S.draft = ta.value; const b = $('.send'); if (!S.busy) b.toggleAttribute('disabled', !ta.value.trim()); else VC.syncSend(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); VC.send(e.altKey ? 'later' : 'steer'); }
    });
  };
  VC.syncSend = () => {
    const b = $('.send'), empty = !S.draft.trim();
    if (!b) return;
    b.className = `send${S.busy && empty ? ' stop' : ''}`;
    b.dataset.act = S.busy && empty ? 'stop' : 'send';
    b.innerHTML = ic(S.busy && empty ? 'stop' : 'up');
    b.title = S.busy && empty ? '停止当前回应' : '立即补充 · Enter';
  };

  // ---------------------------------------------------------------- 发送：受理、待接收、已接收分别呈现
  const clock = () => { const d = new Date(); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  VC.send = (mode = 'steer') => {
    const text = (S.draft || '').trim(); S.sendMenu = false;
    if (!text) { VC.render('chat'); return; }
    S.draft = '';
    if (!S.busy) {
      S.extra.push({ t: 'u', time: clock(), text });
      S.busy = 'thinking'; S.now = 'thinking'; VC.render('chat', 'panel', 'title');
      // 用户把子 Agent 问题的答案告诉 Varin：Varin 用原请求回答，问题随之解除
      const pick = !S.answered ? D.question.opts.findIndex(([t]) => text.includes(t.replace('按', '')) || text.includes(t)) : -1;
      setTimeout(() => {
        if (pick >= 0) {
          S.answer = pick; S.answeredBy = 'varin'; VC.resolveQuestion();
          S.extra.push({ t: 'a', id: `x${S.extra.length}`, act: { icons: ['reply'], label: '回答问题', items: [['回答', `Writer · 汇报按什么组织？ → ${D.question.opts[pick][0]}`]] },
            html: `<p>好，我已经替你回复 Writer：汇报<b>${esc(D.question.opts[pick][0])}</b>组织，它在继续写大纲。</p>` });
        } else {
          S.extra.push({ t: 'a', id: `x${S.extra.length}`, html: '<p>好的，这件事不需要单独交办，我直接处理，结果接在这里。</p>' });
        }
        S.busy = null; S.now = null; VC.render();
      }, 1700);
      return;
    }
    if (mode === 'later') { S.pending.push({ kind: 'later', text }); VC.render('chat'); return; }
    const p = { kind: 'steer', text, state: 'accepted' }; S.pending.push(p); VC.render('chat');
    const wasWaiting = S.busy === 'waiting';
    setTimeout(() => {
      p.state = 'received'; VC.render('chat'); VC.islandEvent?.('received', text);
      setTimeout(() => {
        S.pending = S.pending.filter((x) => x !== p);
        S.extra.push({ t: 'u', time: clock(), text, note: '补充' });
        S.busy = 'thinking'; S.now = wasWaiting ? 'woke' : 'thinking';
        VC.render('chat', 'panel', 'title');
      }, 900);
    }, wasWaiting ? 900 : 2200);
  };

  VC.on('send', (el) => VC.send(el.dataset.mode || 'steer'));
  VC.on('send-menu', () => { S.sendMenu = !S.sendMenu; VC.render('chat'); });
  VC.on('stop', () => { S.busy = null; S.now = null; S.extra.push({ t: 'evt', who: '', html: '已停止 Varin 当前的回应 · 交办出去的工作继续进行', link: '查看正在跟进', work: 'w1' }); VC.render('chat', 'panel', 'title'); });
  VC.on('pend-now', (el) => { const p = S.pending[+el.dataset.i]; p.kind = 'steer'; p.state = 'accepted'; S.pending.splice(+el.dataset.i, 1); S.draft = p.text; VC.send('steer'); });
  VC.on('pend-drop', (el) => { S.pending.splice(+el.dataset.i, 1); VC.render('chat'); });
  VC.on('act', (el) => { S.actOpen[el.dataset.id] = !S.actOpen[el.dataset.id]; VC.render('chat'); });
  VC.on('pick', (el) => { S.answer = +el.dataset.i; VC.render('chat', 'views'); });
  // 回答落到同一个原请求：用户直接选，或 Varin 按用户的话回答；两种都在原工作记录里留下回答者
  VC.resolveQuestion = () => {
    S.answered = true;
    const opt = D.question.opts[S.answer][0], by = S.answeredBy === 'varin' ? 'Varin 按你的话回答' : '收到你的回答';
    const w = D.works.find((x) => x.id === 'w2'); w.state = { kind: 'run', text: `Writer 正在${opt}写大纲` }; w.links = [['results', '成果 1']];
    D.detail.w2.tag = ['进行中', '']; D.detail.w2.now = { spin: true, text: `Writer 正在${opt}写大纲`, sub: '刚刚' };
    D.detail.w2.feed.unshift([clock(), 'writer', `${by}：<b>${opt}</b>`, true]);
    D.detail.w2.team[0].state = '正在写';
  };
  VC.on('answer', () => { if (S.answer === null) return; S.answeredBy = 'user'; VC.resolveQuestion(); VC.render(); });
  VC.on('sidebar', () => { S.sidebar = !S.sidebar; VC.render('title'); VC.$('#frame').dataset.sidebar = S.sidebar ? 'open' : 'closed'; });
})();
