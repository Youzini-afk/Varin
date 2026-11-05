// The feedback comparison is an HTML work, using the same renderer as the app.
export function feedbackChartHtml(zh) {
  const t = (en, cn) => zh ? cn : en;
  const labels = [t('Getting started', '如何开始'), t('Working examples', '实际使用场景'), t('Model support', '模型支持'), t('Deployment', '部署方式')];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;color:var(--foreground);font-family:inherit}
  .chart{border:1px solid var(--border);border-radius:10px;padding:22px 25px 15px}
  header{display:flex;align-items:start;justify-content:space-between;gap:20px;font-size:14px;margin-bottom:20px}
  h3{font-size:14px;margin:0;font-weight:600}header p{color:var(--muted-foreground);font-size:11px;margin:6px 0 0}
  select{background:var(--background);border:1px solid var(--border);border-radius:5px;padding:6px 9px;color:var(--foreground);font:inherit;font-size:11px}
  select:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
  .row{display:grid;grid-template-columns:132px minmax(0,1fr) 30px;align-items:center;gap:20px;font-size:12px;margin:14px 0}
  .row i{display:block;height:13px;border-radius:3px;background:var(--primary);transition:width 180ms ease}
  .row output{font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;text-align:right}
  footer{border-top:1px solid var(--border);padding-top:12px;margin-top:18px;color:var(--muted-foreground);font-size:10px}
  @media(max-width:480px){.chart{padding:18px}.row{grid-template-columns:100px minmax(0,1fr) 30px;gap:12px}}
  @media(prefers-reduced-motion:reduce){.row i{transition:none}}
  </style></head><body><section class="chart">
  <header><div><h3>${t('What people want to find first', '大家希望先看到什么')}</h3><p>${t('Grouped feedback · share of mentions', '反馈归类 · 提及占比')}</p></div>
  <select id="audience" aria-label="${t('Feedback audience', '反馈人群')}"><option value="all">${t('All feedback', '全部反馈')}</option><option value="new">${t('New users', '新用户')}</option></select></header>
  ${labels.map((label, i) => `<div class="row"><span>${label}</span><div><i id="bar-${i}" style="opacity:${1 - i * .17}"></i></div><output id="value-${i}"></output></div>`).join('')}
  <footer>feedback.csv · ${t('Group by topic', '按主题归类')}</footer></section><script>
  const audience=document.getElementById('audience'), series={all:[38,26,22,14],new:[44,29,18,9]};
  const saved=window.varinUI.state;
  if(saved && Object.hasOwn(series,saved.audience))audience.value=saved.audience;
  function render(){const values=series[audience.value];values.forEach((value,i)=>{
    document.getElementById('bar-'+i).style.width=value*2+'%';document.getElementById('value-'+i).textContent=value+'%';
  });window.varinUI.setContext({audience:audience.value,topics:${JSON.stringify(labels)},percentages:values});}
  audience.addEventListener('change',()=>{render();window.varinUI.saveState({audience:audience.value});});
  render();document.body.dataset.chartReady='true';
  </script></body></html>`;
}
