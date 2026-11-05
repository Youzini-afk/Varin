/* Varin · 总助手设计稿 · 服务弹层、设置（发送、连接）、添加设备 */
(function () {
  'use strict';
  const VC = window.VC, D = VC.data, S = VC.state, ic = VC.icon, esc = VC.esc, $ = VC.$;

  // ---------------------------------------------------------------- 标题栏服务弹层：谁连着谁，三种操作分别命名
  const svcPop = () => S.size === 'mobile' && VC.svcSheet ? VC.svcSheet() : `<div class="scrim" data-act="svc"></div><div class="pop svc-pop">
    <div class="pop-h">这里的连接</div>
    <div class="path">
      <div class="hop"><span class="env-ic">${ic('laptop', 'sm')}</span><span><b>此界面</b><small>${S.size === 'mobile' ? 'iPhone 16 · Varin 手机版' : 'MacBook Air · Varin 桌面版'}</small></span><span class="end"><span class="dot ok"></span>已连接</span></div>
      <div class="hop"><span class="env-ic">${ic('stack', 'sm')}</span><span><b>Varin 服务 · 家中主机</b><small>会话、记忆与 Agent 在这里运行</small></span><span class="end"><span class="dot ok"></span>正常</span></div>
      <div class="hops-res">
        <div class="hop"><span class="env-ic">${ic('server', 'sm')}</span><span><b>开发服务器</b><small>文件 · 执行环境 · 经 SSH</small></span><span class="end"><span class="dot ok"></span>可用</span></div>
        <div class="hop"><span class="env-ic">${ic('computer', 'sm')}</span><span><b>办公电脑</b><small>桌面 · 文件 · 经连接地址</small></span><span class="end"><span class="dot ok"></span>可用</span></div>
      </div>
    </div>
    <div class="pop-sep"></div>
    <button class="pop-item" data-act="add-device">${ic('plus')}<span>添加设备<small>让 Varin 使用另一台设备的文件、执行环境或桌面</small></span></button>
    <button class="pop-item" data-act="settings" data-page="conn">${ic('stack')}<span>切换 Varin 服务…<small>打开另一处的会话与设置；这里正在运行的工作留在原处</small></span></button>
    <button class="pop-item" data-act="settings" data-page="conn" data-anchor="pair">${ic('phone')}<span>让其他设备连接我<small>配对手机或另一台电脑来访问这个 Varin 服务</small></span></button>
    <div class="pop-sep"></div>
    <button class="pop-item" data-act="settings" data-page="conn">${ic('gear')}<span>连接设置</span></button>
  </div>`;

  // ---------------------------------------------------------------- 设置
  const NAV = [['常规', [['general', 'gear', '通用'], ['look', 'sun', '外观'], ['chat', 'memory', '聊天'], ['sessions', 'history', '会话'], ['notify', 'alert', '通知']]],
    ['Agent', [['models', 'globe', '模型渠道'], ['usage', 'sheet', '用量'], ['prompt', 'doc', '系统提示词'], ['agentmem', 'memory', '记忆'], ['external', 'terminal', '外部 Agent']]],
    ['连接', [['conn', 'stack', '连接'], ['mcp', 'plug', 'MCP'], ['skills', 'brain', '技能'], ['about', 'alert', '关于']]]];
  const seg = (key, opts) => `<span class="seg" role="group">${opts.map(([v, l]) => `<button data-act="pref" data-k="${key}" data-v="${v}" aria-pressed="${S.sendPref[key] === v}">${l}</button>`).join('')}</span>`;
  const chatPage = () => `
    <div class="sgroup"><h4>Varin 或 Agent 正在工作时发新消息</h4>
      <p>两种身份分别设置。按会话的真实身份判断：在工作台里打开 Varin 的会话，也按“与 Varin 交谈时”处理；Varin 交办出去的工作按 Agent 处理。</p>
      <div class="sfield"><div class="l"><b>与 Varin 交谈时</b><small>立即补充：Varin 在下一个可以接收的间隙读到它，正在进行的操作照常完成，不会被取消。</small><span class="who"><span class="mini" id="setFig" style="width:16px;height:16px;border-radius:5px;overflow:hidden;display:inline-block"></span>Varin 的直接会话</span></div>
        ${seg('varin', [['steer', '立即补充'], ['queue', '排在之后']])}</div>
      <div class="sfield"><div class="l"><b>Agent 执行任务时</b><small>普通 Agent 会话，以及 Varin 交办出去的工作。保留你原来的选择。</small></div>
        ${seg('agent', [['queue', '排在之后'], ['steer', '立即补充']])}</div>
      <div class="send-demo">
        <div class="sdemo${S.sendPref.varin === 'steer' ? ' on' : ''}"><b>立即补充</b>在当前回合的下一个间隙送达<div class="lane"><i></i><i class="r"></i><i></i><i></i></div>状态：已受理 → 已接收</div>
        <div class="sdemo${S.sendPref.varin === 'queue' ? ' on' : ''}"><b>排在之后</b>这一回合结束后作为新消息发送<div class="lane"><i></i><i></i><i></i><i class="m"></i></div>状态：排队中，可以改成现在发送</div>
      </div>
      <p style="margin-top:12px">单条消息可以临时选另一种：发送按钮旁的菜单，或 Alt+Enter。已经发出的消息不受这里的改动影响。</p>
    </div>
    <div class="sgroup"><h4>阅读</h4><div class="sfield"><div class="l"><b>正文宽度</b><small>（原有设置，不在本稿范围）</small></div><span class="tag">720</span></div></div>`;
  const devCard = (d) => `<div class="dev"><span class="env-ic">${ic(d.kind === 'server' ? 'server' : 'computer')}</span>
    <div class="grow"><div class="t">${esc(d.name)}<span class="faint" style="font-weight:400;font-size:12px">${esc(d.os)}</span></div><div class="via">${esc(d.via)}</div>
      <div class="caps">${d.caps.map(([n, st, why]) => `<span class="cap${st !== 'ok' ? ' off' : ''}"><span class="dot ${st === 'ok' ? 'ok' : st === 'off' ? 'warn' : ''}"></span>${esc(n)}${why ? ` <span class="why">· ${esc(why)}</span>` : ''}</span>`).join('')}</div></div>
    <div class="acts"><button class="btn sm ghost" title="从家中主机重新检查">${ic('retry', 'sm')}检查</button><button class="icon-btn" title="重命名、常用入口、移除">${ic('dots', 'sm')}</button></div></div>`;
  const qr = () => { let h = ''; for (let i = 0; i < 121; i++) { const x = i % 11, y = (i / 11) | 0, f = (x < 3 && y < 3) || (x > 7 && y < 3) || (x < 3 && y > 7); h += `<i class="${f || ((x * 7 + y * 13 + x * y) % 3 === 0) ? '' : 'o'}"></i>`; } return h; };
  const connPage = () => `
    <div class="topo">
      <div class="tnode"><span class="k">此界面</span><b>${S.size === 'mobile' ? 'iPhone 16' : 'MacBook Air'}</b><small>${S.size === 'mobile' ? 'Varin 手机版' : 'Varin 桌面版'} · 只负责显示和输入</small></div>
      <div class="tlink ok">${ic('check', 'xs')}</div>
      <div class="tnode cur"><span class="k">Varin 服务</span><b>家中主机</b><small>会话、记忆与 Agent 在这里运行</small></div>
      <div class="tlink ok">${ic('check', 'xs')}</div>
      <div class="tres"><div class="tnode"><span class="k">设备</span><b>开发服务器</b><small>文件 · 执行环境</small></div><div class="tnode"><b>办公电脑</b><small>桌面 · 文件</small></div></div>
    </div>
    <div class="sgroup"><h4>设备<button class="btn sm" data-act="add-device">${ic('plus', 'sm')}添加设备</button></h4>
      <p>Varin 可以使用这些设备的文件、执行环境和桌面。每项能力单独检查；检查从家中主机发起，因为真正访问它们的是 Varin 服务。</p>
      ${D.devices.map(devCard).join('')}</div>
    <div class="sgroup"><h4>Varin 服务<button class="btn sm">切换…</button></h4>
      <p>你现在打开的是家中主机上的 Varin。切换后会打开另一处的会话与设置，草稿和视图按原有方式保存；这里正在运行的工作继续在原处运行。</p>
      ${D.services.map((x) => `<div class="svc${x.cur ? ' cur' : ''}"><span class="env-ic">${ic('stack', 'sm')}</span><span class="grow"><span class="t" style="display:block">${esc(x.name)}</span><span class="m">${esc(x.m)}</span></span>${x.cur ? '<span class="tag ok">当前</span>' : '<button class="btn sm">打开</button>'}</div>`).join('')}</div>
    <div class="sgroup" id="pair"><h4>让其他设备连接我</h4>
      <p>允许手机或另一台电脑上的 Varin 访问这个服务。方向是对方 → 这里；配对不会让 Varin 获得操作那台设备的能力，要用它的资源请“添加设备”。</p>
      <div class="pair"><div class="qr" aria-label="配对二维码（示意）">${qr()}</div><div><div class="faint" style="font-size:12px">配对码 · 10 分钟内有效</div><div class="code">K7Q-4M2</div><p>在手机上的 Varin 里扫码，或输入配对码。配对后可以查看会话、发送消息、处理授权和问题。</p></div></div>
      <div style="margin-top:10px">${D.clients.map((c) => `<div class="client">${ic(c.ic, 'sm')}<span class="grow">${esc(c.name)}<span class="m" style="display:block">${esc(c.m)}</span></span><button class="btn sm ghost">取消配对</button></div>`).join('')}</div></div>
    <div class="sgroup"><h4>高级</h4><p>具体地址、SSH 转发、隧道和身份验证仍然在这里，日常使用不需要先懂这些。</p>
      <div class="adv"><button class="btn sm">${ic('key', 'sm')}SSH 主机</button><button class="btn sm">${ic('globe', 'sm')}外部隧道</button><button class="btn sm">${ic('wifi', 'sm')}出站网络</button><button class="btn sm">${ic('shield', 'sm')}访问密码</button></div></div>`;
  const PAGES = { chat: ['聊天', '阅读、输入与发送'], conn: ['连接', '设备、Varin 服务与访问这个服务的客户端'] };
  const settings = () => {
    const p = S.settings, meta = PAGES[p] || ['设置', ''];
    return `<div class="settings" data-act="settings-bg"><div class="sd" data-stop="1">
      <nav class="sd-nav">${NAV.map(([g, items]) => `<h6>${g}</h6>${items.map(([k, i, n]) => `<button data-act="settings" data-page="${k}" aria-current="${p === k}">${ic(i, 'sm')}${n}</button>`).join('')}`).join('')}</nav>
      <div class="sd-main"><div class="sd-top"><h3>${meta[0]}</h3><button class="icon-btn" data-act="settings-close" title="关闭">${ic('x')}</button></div>
        <div class="sd-desc">${meta[1]}</div>
        <div class="sd-body">${p === 'chat' ? chatPage() : p === 'conn' ? connPage() : '<p class="muted">示意：本稿只调整「聊天 · 发送」与「连接」。</p>'}</div></div>
    </div></div>`;
  };

  // ---------------------------------------------------------------- 添加设备
  const STEPS = ['方式', '连接', '检查能力', '完成'];
  const way = (k, i, t, d) => `<button class="way" data-act="way" data-v="${k}" aria-pressed="${S.wizard.way === k}"><span class="env-ic">${ic(i, 'sm')}</span><span><b>${t}</b><small>${d}</small></span></button>`;
  const wizBody = () => {
    const w = S.wizard;
    if (w.step === 1) return `<p>选择 Varin 服务怎样到达那台设备。连接由家中主机发起，和此界面能不能访问它无关。</p>
      ${way('ssh', 'server', '通过 SSH', '适合服务器和没有桌面的机器；可以复用已保存的密钥。')}
      ${way('addr', 'link', '输入连接地址', '那台设备已运行 Varin 资源服务时使用，例如 https://office.lan:7456。')}
      ${way('saved', 'key', '已保存的 SSH 主机', '从之前用过的主机里选：lab-gpu、nas。')}`;
    if (w.step === 2) return `<p>填写家中主机连接开发服务器所需的信息。凭据保存在家中主机上。</p>
      <div class="fld-row"><label class="fld"><span>主机</span><input class="inp" value="10.0.0.12"></label><label class="fld"><span>端口</span><input class="inp" value="22"></label></div>
      <label class="fld"><span>用户</span><input class="inp" value="youzi"></label>
      <label class="fld"><span>身份验证</span><input class="inp" value="已保存的密钥 · ~/.ssh/id_ed25519"></label>
      <button class="btn sm ghost">${ic('chev', 'xs')}跳板机与端口转发</button>`;
    if (w.step === 3) {
      const err = w.probe === 'err';
      return `<div class="probe"><div class="probe-h">${err ? ic('alert', 'sm') : '<span class="dot ok"></span>'}从 家中主机 检查 10.0.0.12</div>
        ${err ? `<div class="pr err">${ic('alert', 'sm')}<span><b>网络与登录</b><small>家中主机连不上 10.0.0.12:22（12 秒超时）。此界面能否打开那台机器不影响这里的结果。</small></span><span class="end">失败</span></div>
          <div class="pr no">${ic('folder', 'sm')}<span><b>文件</b><small>需要先连上</small></span><span class="end">未检查</span></div>`
        : `<div class="pr ok">${ic('key', 'sm')}<span><b>网络与登录</b><small>SSH 登录成功 · 38 ms</small></span><span class="end">可用</span></div>
          <div class="pr ok">${ic('folder', 'sm')}<span><b>文件</b><small>/home/youzi、/srv 可读写</small></span><span class="end">可用</span></div>
          <div class="pr ok">${ic('terminal', 'sm')}<span><b>执行环境</b><small>bash 5.2 · Node 24.1 · 4 核</small></span><span class="end">可用</span></div>
          <div class="pr no">${ic('computer', 'sm')}<span><b>桌面</b><small>没有发现图形会话；需要时可以安装桌面服务</small></span><span class="end">不可用</span></div>`}
      </div>
      ${err ? `<div style="display:flex;gap:8px"><button class="btn sm" data-act="probe" data-v="ok">${ic('retry', 'sm')}重试</button><button class="btn sm ghost">查看诊断</button></div>` : `
      <label class="fld"><span>名称</span><input class="inp" value="开发服务器"></label>
      <div class="check on" data-act="noop"><i>${ic('check', 'xs')}</i><span>在 Varin 的环境里显示为常用文件入口</span></div>
      <div class="check" data-act="noop"><i></i><span>作为新工作的默认位置</span></div>
      <div class="note" style="margin-top:8px">${ic('alert', 'sm')}<span>接入不会迁移已有工作，也不会自动改变新工作的默认位置。</span></div>`}`;
    }
    return `<div class="dev"><span class="env-ic">${ic('server')}</span><div class="grow"><div class="t">开发服务器<span class="tag ok">已接入</span></div><div class="via">SSH · youzi@10.0.0.12 · 由家中主机连接</div>
      <div class="caps"><span class="cap"><span class="dot ok"></span>文件</span><span class="cap"><span class="dot ok"></span>执行环境</span><span class="cap off"><span class="dot"></span>桌面 <span class="why">· 不可用</span></span></div></div></div>
      <p>可以在文件里打开它，或在对话里说“在开发服务器上……”。</p>`;
  };
  const wizard = () => {
    const w = S.wizard;
    return `<div class="wiz-wrap"><div class="wiz" role="dialog" aria-label="添加设备">
      <div class="wiz-h"><h3>添加设备</h3><button class="icon-btn" data-act="wiz-close" title="关闭">${ic('x')}</button></div>
      <div class="steps">${STEPS.map((n, i) => `<span class="${i + 1 === w.step ? 'on' : i + 1 < w.step ? 'done' : ''}">${i + 1 < w.step ? ic('check', 'xs') : `${i + 1}.`} ${n}</span>`).join('')}</div>
      <div class="wiz-b">${wizBody()}</div>
      <div class="wiz-f">${w.step > 1 && w.step < 4 ? '<button class="btn ghost" data-act="wiz" data-d="-1">上一步</button>' : ''}<div class="grow">
        ${w.step < 4 ? '<button class="btn ghost" data-act="wiz-close">取消</button>' : ''}
        ${w.step === 4 ? `<button class="btn" data-act="open-files" data-loc="dev">打开文件</button><button class="btn primary" data-act="wiz-close">完成</button>`
          : `<button class="btn primary" data-act="wiz" data-d="1" ${w.step === 3 && w.probe === 'err' ? 'disabled' : ''}>${w.step === 2 ? '连接并检查' : w.step === 3 ? '接入' : '下一步'}</button>`}
      </div></div></div></div>`;
  };

  VC.parts.over = () => {
    $('#over').innerHTML = `${S.svcPop ? svcPop() : ''}${S.settings ? settings() : ''}${S.wizard ? wizard() : ''}`;
    if (S.settings === 'chat') VC.figHead($('#setFig'), 16);
    if (S.settingsAnchor) { $('#' + S.settingsAnchor)?.scrollIntoView({ block: 'start' }); S.settingsAnchor = null; }
  };

  VC.on('svc', () => { S.svcPop = !S.svcPop; VC.render('over', 'title'); });
  VC.on('settings', (el) => { S.svcPop = false; S.settings = el.dataset.page || 'chat'; S.settingsAnchor = el.dataset.anchor || null; VC.render('over', 'title'); });
  VC.on('settings-close', () => { S.settings = null; VC.render('over'); });
  VC.on('settings-bg', (el, e) => { if (!e.target.closest('[data-stop]')) { S.settings = null; VC.render('over'); } });
  VC.on('pref', (el) => { S.sendPref[el.dataset.k] = el.dataset.v; VC.render('over'); });
  VC.on('add-device', () => { S.svcPop = false; S.wizard = { step: 1, way: 'ssh', probe: 'ok' }; VC.render('over', 'title'); });
  VC.on('way', (el) => { S.wizard.way = el.dataset.v; VC.render('over'); });
  VC.on('wiz', (el) => { S.wizard.step = Math.max(1, Math.min(4, S.wizard.step + +el.dataset.d)); VC.render('over'); });
  VC.on('probe', (el) => { S.wizard.probe = el.dataset.v; VC.render('over'); });
  VC.on('wiz-close', () => { S.wizard = null; VC.render('over'); });
  VC.on('noop', (el) => { el.classList.toggle('on'); el.querySelector('i').innerHTML = el.classList.contains('on') ? ic('check', 'xs') : ''; });
})();
