/* Varin · 总助手设计稿 · Bot 面板：形象与状态、正在跟进、最近成果、环境入口 */
(function () {
  'use strict';
  const VC = window.VC, D = VC.data, S = VC.state, ic = VC.icon, esc = VC.esc, $ = VC.$;
  const TABS = [['overview', 'list', '概览'], ['activity', 'history', '动态'], ['memory', 'memory', '记忆'], ['schedule', 'cal', '日程']];
  const sessionTitle = (id) => D.sessions.find((x) => x.id === id)?.title ?? '';

  // 工作的当前状态：只写原工作能确认的事实；需要你时说明在等什么
  const stateLine = (w) => {
    const k = w.state.kind;
    const lead = k === 'run' ? '<span class="spin"></span>' : k === 'need' ? ic('alert', 'xs') : k === 'result' ? '<span class="dot info"></span>' : ic('clock', 'xs');
    return `<div class="w-state">${lead}<span class="trunc">${esc(w.state.text)}</span></div>`;
  };
  const linkBtn = (w, [k, label]) => {
    const act = k === 'computer' ? 'open-computer' : k === 'files' ? 'open-files' : k === 'need' ? 'open-work' : 'open-work';
    return `<button class="w-link${k === 'need' ? ' warn' : ''}" data-act="${act}" data-id="${w.id}">${ic(k === 'computer' ? 'computer' : k === 'files' ? 'folder' : k === 'need' ? 'alert' : k === 'report' ? 'doc' : 'image', 'xs')}${esc(label)}</button>`;
  };
  const workRow = (w) => {
    const need = w.state.kind === 'need';
    const cur = S.active && S.active.kind === 'work' && S.active.id === w.id;
    const other = w.session !== 's1';
    return `<div class="work${need ? ' need' : ''}${S.flash === w.id ? ' flash' : ''}" role="button" tabindex="0" data-act="open-work" data-id="${w.id}" aria-current="${Boolean(cur)}">
      <div class="w-top"><span class="w-name trunc">${esc(w.name)}</span>${other ? `<span class="w-src">来自「${esc(sessionTitle(w.session))}」</span>` : ''}${VC.avs(w.team, 18, w.lead)}</div>
      ${stateLine(w)}
      ${w.links.length ? `<div class="w-links">${w.links.map((l) => linkBtn(w, l)).join('')}</div>` : ''}
    </div>`;
  };

  const overview = () => {
    const list = D.works.filter((w) => S.scope === 'all' || w.session === 's1');
    const needs = VC.needs();
    return `
      ${needs.map((w) => `<button class="attn" data-act="open-work" data-id="${w.id}">${ic('alert', 'sm')}<span><b>${esc(w.name)}</b> · ${esc(w.state.text)}</span>${ic('right', 'sm')}</button>`).join('')}
      <div class="sec"><div class="sec-h"><span class="t">正在跟进</span><span class="faint">${list.length}</span>
        <span class="seg" role="group" aria-label="范围"><button data-act="scope" data-v="session" aria-pressed="${S.scope === 'session'}">本会话</button><button data-act="scope" data-v="all" aria-pressed="${S.scope === 'all'}">全部</button></span></div>
        ${list.map(workRow).join('')}
        ${S.scope === 'session' ? `<button class="sec-more" data-act="scope" data-v="all">其他会话还有 2 项${ic('right', 'xs')}</button>` : ''}
      </div>
      <div class="sec"><div class="sec-h"><span class="t">最近成果</span></div>
        ${D.recent.map((r) => `<button class="row">${ic('doc')}<span class="grow"><span class="trunc" style="display:block">${esc(r.name)}</span><span class="meta">${esc(r.meta)}</span></span><span class="end">${r.unread ? '<span class="unread" title="未读"></span>' : ''}</span></button>`).join('')}
      </div>
      <div class="sec"><div class="sec-h"><span class="t">环境</span></div>
        ${D.env.computers.map((c) => `<button class="row" data-act="open-computer" data-id="${c.id}"><span class="env-ic">${ic('computer', 'sm')}</span><span class="grow"><span style="display:block">电脑 · ${esc(c.name)}</span><span class="meta">${esc(c.meta)}</span></span><span class="end"><span class="dot live"></span></span></button>`).join('')}
        ${D.env.files.map((f) => `<button class="row" data-act="open-files" data-loc="dev"><span class="env-ic">${ic('folder', 'sm')}</span><span class="grow"><span style="display:block">文件 · ${esc(f.name)}</span><span class="meta">${esc(f.meta)}</span></span><span class="end"></span></button>`).join('')}
        <button class="row add" data-act="add-device">${ic('plus', 'sm')}<span>添加设备</span></button>
      </div>`;
  };
  const activity = () => `<div class="tl-day">今天</div>${D.timeline.map(([t, h]) => `<div class="tl"><span class="num">${t}</span><span>${h}</span></div>`).join('')}`;
  const memory = () => D.memory.map(([t, m]) => `<div class="mem">${esc(t)}<small>${esc(m)}</small></div>`).join('');
  const schedule = () => `<div class="tl"><span class="num">09:00</span><span>每天检查一次机票价格 · 回到「旅行安排」</span></div><div class="tl"><span class="num">周五</span><span>提醒发送汇报材料 · 回到「发布季准备」</span></div>`;

  VC.parts.panel = () => {
    const line = VC.botLine();
    $('#botid').innerHTML = `<div class="bot-id"><span class="bot-name">Varin</span><button class="icon-btn" title="档案">${ic('edit', 'sm')}</button><span class="grow"></span>
        ${S.size !== 'desktop' ? `<button class="icon-btn" data-act="panel" title="收起">${ic('x', 'sm')}</button>` : `<button class="icon-btn" title="更多">${ic('dots', 'sm')}</button>`}</div>
      <div class="bot-state"><span class="dot ${line.dot}"></span><span>${esc(line.text)}</span></div>`;
    const idx = TABS.findIndex(([k]) => k === S.tab);
    $('#tabs').innerHTML = `<span class="ink" style="transform:translateX(${idx * 100}%)"></span>${TABS.map(([k, i, n]) => `<button role="tab" data-act="tab" data-v="${k}" aria-selected="${S.tab === k}" title="${n}" aria-label="${n}">${ic(i)}${k === 'overview' && S.tab !== 'overview' && VC.needs().length ? '<span class="tab-dot"></span>' : ''}</button>`).join('')}`;
    $('#pane').innerHTML = S.tab === 'overview' ? overview() : S.tab === 'activity' ? activity() : S.tab === 'memory' ? memory() : schedule();
    // 窗沿上的团队：只画正在工作的真实执行者
    const busyIds = D.works.filter((w) => w.session === 's1' && w.state.kind === 'run').flatMap((w) => w.team);
    $('#sillL').innerHTML = busyIds.slice(0, 2).map((id) => VC.av(id, 22)).join('');
    $('#sillR').innerHTML = D.works.filter((w) => w.session === 's1' && w.state.kind !== 'run').flatMap((w) => w.team).slice(0, 2).map((id) => VC.av(id, 22)).join('');
    VC.fig?.setState?.(line.fig);
  };

  VC.on('tab', (el) => { S.tab = el.dataset.v; VC.render('panel'); });
  VC.on('scope', (el) => { S.scope = el.dataset.v; VC.render('panel'); });
  VC.on('panel', () => {
    if (S.size === 'desktop') { if (S.active) { S.active = null; S.expanded = false; S.panelHidden = false; } else S.panelHidden = !S.panelHidden; VC.render(); return; }
    if (S.active) S.active = null;
    S.drawer = !S.drawer; VC.render();
  });
})();
