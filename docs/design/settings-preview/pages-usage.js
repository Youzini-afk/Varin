/* Varin · 设置设计稿 · 用量（概览骨架） */
(() => {
  const { ic, esc, seg, sec, header, chip, btn, logo, tabs, note } = K;
  /* 30 天示例：每日 Token（万）。null 表示这天没有可靠的完成日期。 */
  const days = Array.from({ length: 30 }, (_, i) => { const d = new Date(2026, 9, 20 + i); const v = i < 12 ? null : Math.round((Math.sin(i * 1.7) * 0.5 + 0.6) * (i % 7 === 5 || i % 7 === 6 ? 3 : 14) * 10) / 10; return { d, v: v && v < 0.4 ? 0 : v, req: v ? Math.max(1, Math.round(v / 3)) : 0 }; });
  const rows = [
    { m: 'claude-sonnet-5-5', s: 'Anthropic', logo: 'anthropic', req: 41, inp: '182.4 万', cache: '160.1 万', out: '2.1 万', cost: 'US$3.92' },
    { m: 'deepseek-v4.1-flash', s: 'DeepSeek', logo: 'deepseek', req: 36, inp: '88.6 万', cache: '78.2 万', out: '1.4 万', cost: 'US$0.31' },
    { m: 'jev-1.14', s: 'OpenRouter', logo: 'openrouter', req: 5, inp: '—', cache: '—', out: '38', cost: null, note: '4 次请求没有上报用量' },
    { m: 'qwen3-embedding-0.6b', s: 'OpenRouter', logo: 'openrouter', req: 6, inp: '166', cache: '—', out: '0', cost: null },
  ];
  function chart() {
    const W = 680, H = 150, pad = 26, bw = (W - pad) / days.length, max = Math.max(...days.map(x => x.v || 0));
    const bars = days.map((x, i) => {
      const xx = pad + i * bw + 1, w = bw - 2;
      if (x.v == null) return `<rect x="${xx}" y="${H - 6}" width="${w}" height="2" rx="1" fill="var(--line)"><title>${x.d.getMonth() + 1}/${x.d.getDate()}：没有可靠日期的记录</title></rect>`;
      const h = Math.max(2, (x.v / max) * (H - 24));
      return `<g class="bar" data-tip="${x.d.getMonth() + 1} 月 ${x.d.getDate()} 日 · ${x.v} 万 Token · ${x.req} 次请求"><rect x="${xx - 1}" y="0" width="${bw}" height="${H}" fill="transparent"/><path d="M${xx} ${H - 4} v${-(h - 4)} a4 4 0 0 1 4 -4 h${w - 8} a4 4 0 0 1 4 4 v${h - 4} z" fill="var(--series)"/></g>`;
    }).join('');
    const ticks = [0, max / 2, max].map(v => `<text x="${pad - 6}" y="${H - 4 - (v / max) * (H - 24) + 3}" text-anchor="end" font-size="10" fill="var(--faint)">${Math.round(v)}</text><line x1="${pad}" x2="${W}" y1="${H - 4 - (v / max) * (H - 24)}" y2="${H - 4 - (v / max) * (H - 24)}" stroke="var(--line-soft)" stroke-dasharray="${v ? '2 3' : ''}"/>`).join('');
    return `<svg viewBox="0 0 ${W} ${H + 16}" width="100%" style="display:block;--series:var(--primary)" role="img" aria-label="每日 Token 用量柱状图">${ticks}${bars}<text x="${pad}" y="${H + 13}" font-size="10.5" fill="var(--faint)">10/20</text><text x="${W}" y="${H + 13}" font-size="10.5" fill="var(--faint)" text-anchor="end">11/18</text></svg>`;
  }
  page('usage', {
    title: '用量', icon: 'chart', scope: 'host', wide: false, keywords: '用量 费用 Token 缓存 价格 导出 CSV',
    desc: '这台 Varin 服务上的 Token 用量和估算费用。',
    render() {
      const [tb, t] = tabs('usage', [{ v: 'model', l: '按模型' }, { v: 'svc', l: '按服务' }, { v: 'use', l: '按用途' }, { v: 'conv', l: '按对话' }]);
      return header(this, { acts: btn('导出 CSV', { sm: true, icon: 'download', act: 'toast', v: '已导出所选时间范围的明细' }) }) +
        `<div style="margin:-6px 0 16px">${seg('u.range', ['7 天', '30 天', '本月', '上月', '90 天'], '30 天')}</div>` +
        `<div class="tiles"><div class="tile"><div class="k">估算费用</div><div class="v">US$4.23</div><div class="s">有 11 次请求缺少价格，未计入 · <span class="linkish" data-act="toast" data-v="跳到下方「价格」">补充价格</span></div></div><div class="tile"><div class="k">Token</div><div class="v">274.5 万</div><div class="s">缓存命中 87.9% · 18 次请求未上报</div></div><div class="tile"><div class="k">请求</div><div class="v">88 次</div><div class="s">其中后台工作 33.7 万 Token</div></div></div>` +
        sec('每日 Token（万）', `<div style="padding:16px 16px 10px">${chart()}</div>`, { desc: '按你的本机时区划分日期。11 月 1 日以前的记录没有可靠的完成日期，显示为空。' }) +
        sec('明细', `${tb}<table class="utable"><thead><tr><th>${t === 'svc' ? '服务' : t === 'use' ? '用途' : t === 'conv' ? '对话' : '模型'}</th><th>请求</th><th>输入</th><th>缓存读取</th><th>输出</th><th>估算费用</th></tr></thead><tbody>${rows.map(r => `<tr><td><span class="hstack">${logo(r.logo)}<span><span>${esc(r.m)}</span><small>${esc(r.s)}${r.note ? ' · ' + esc(r.note) : ''}</small></span></span></td><td>${r.req}</td><td>${r.inp}</td><td>${r.cache}</td><td>${r.out}</td><td>${r.cost || '<span class="faint">未定价</span>'}</td></tr>`).join('')}</tbody></table>`, { raw: true }) +
        sec('价格', `<div class="orow"><div class="grow"><div class="ot">公开价格目录</div><div class="od">models.dev · 今天 10:57 更新</div></div><div class="oe">${btn('刷新', { sm: true, icon: 'refresh', act: 'toast', v: '价格目录已刷新' })}</div></div>` + ['jev-1.14', 'qwen3-embedding-0.6b'].map(m => `<div class="orow"><div class="grow"><div class="ot">${m}</div><div class="od">目录里没有这个模型的价格</div></div><div class="oe">${btn('设置价格', { sm: true, go: 'models', sel: 'openrouter' })}</div></div>`).join(''), { desc: '按美元 / 百万 Token 估算，不含折扣、中转加价和税费，以服务商账单为准。每条记录保留当时的价格。' }) +
        sec('外部 Agent', DATA.externalAgents.slice(0, 3).map(a => `<div class="orow"><img class="logo md keep" src="${a.logo}" alt=""><div class="grow"><div class="ot">${a.name}</div><div class="od">本期 0 轮</div></div><div class="oe faint" style="font-size:12.5px">未上报</div></div>`).join(''), { desc: '外部 Agent 用它们自己的账号计费，用量由它们自己上报，不计入上面的合计。' }) +
        `<p class="faint" style="font-size:12px;margin:18px 2px 0">删除对话后，仍会保留不含内容的用量合计。没有上报的数据不按 0 计算。</p>`;
    },
  });
})();
