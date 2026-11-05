// A self-contained HTML work, rendered by Varin's actual UiWorkView.
export function workEstimateHtml(zh) {
  const t = (en, cn) => zh ? cn : en;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;color:var(--foreground);font-family:inherit}
  .estimate{padding:22px 0 20px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:26px}
  h3{margin:0;font-size:15px;font-weight:600}header span,.caption,.note{color:var(--muted-foreground);font-size:12px;line-height:1.6}
  .result{display:grid;grid-template-columns:.9fr 1.3fr;gap:40px;align-items:center}
  .amount{font-size:48px;line-height:1.15;letter-spacing:-.035em;font-weight:500;font-variant-numeric:tabular-nums}
  .amount small{font-size:16px;letter-spacing:0;margin-left:7px;font-weight:400;color:var(--muted-foreground)}
  .metric-label{font-size:13px;margin-bottom:9px}.caption{margin-top:10px}
  .bar-heading{display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px;gap:16px}
  .bar-heading output{font-variant-numeric:tabular-nums}.bar{height:12px;background:color-mix(in srgb,var(--foreground) 5%,transparent);border-radius:2px;overflow:hidden;margin-bottom:20px}
  .bar>span{display:block;height:100%;transition:width 200ms ease;background:var(--primary);border-radius:2px}.bar.before>span{width:100%;background:color-mix(in srgb,var(--foreground) 24%,transparent)}
  .controls{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:30px;padding-top:22px;border-top:1px solid var(--border)}
  .control-heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:13px}.control-heading output{font-variant-numeric:tabular-nums;font-weight:500}
  input{display:block;appearance:none;width:100%;height:28px;background:transparent;cursor:pointer;margin:8px 0}
  input::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:linear-gradient(to right,var(--primary) var(--progress),var(--border) var(--progress))}
  input::-webkit-slider-thumb{appearance:none;width:14px;height:14px;margin-top:-5.5px;border:2px solid var(--background);border-radius:50%;background:var(--primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--primary) 40%,transparent)}
  input:focus-visible{outline:2px solid var(--primary);outline-offset:3px;border-radius:3px}
  .ends{display:flex;justify-content:space-between;font-size:11px;color:var(--muted-foreground)}.note{margin-top:20px}
  @media(max-width:520px){header{display:block}header span{display:block;margin-top:5px}.result,.controls{grid-template-columns:1fr;gap:22px}.amount{font-size:40px}}
  @media(prefers-reduced-motion:reduce){.bar>span{transition:none}}
  </style></head><body><section class="estimate">
  <header><h3>${t('Weekly document work', '每周材料整理')}</h3><span>${t('6 people · 15 documents each · 30 minutes per document', '6 人 · 每人 15 份 · 每份 30 分钟')}</span></header>
  <div class="result"><div><div class="metric-label">${t('Human time freed up', '每周可腾出的人工时间')}</div><div class="amount"><span id="saved">22.5</span><small>${t('hours', '小时')}</small></div><div class="caption" id="caption"></div></div>
  <div><div class="bar-heading"><span>${t('All done manually', '全部人工处理')}</span><output>45 ${t('h / week', '小时 / 周')}</output></div><div class="bar before"><span></span></div>
  <div class="bar-heading"><span>${t('With Agent help, including review', '交办后，含人工检查')}</span><output id="remaining"></output></div><div class="bar"><span id="after"></span></div></div></div>
  <div class="controls"><div><div class="control-heading"><label for="share">${t('Share handed to Agents', '交给 Agent 的比例')}</label><output id="share-value" for="share"></output></div><input id="share" type="range" min="0" max="100" step="5" value="60"><div class="ends"><span>0%</span><span>100%</span></div></div>
  <div><div class="control-heading"><label for="review">${t('Review time per delegated document', '每份交办材料的检查时间')}</label><output id="review-value" for="review"></output></div><input id="review" type="range" min="0" max="30" step="1" value="5"><div class="ends"><span>0 ${t('min', '分钟')}</span><span>30 ${t('min', '分钟')}</span></div></div></div>
  <div class="note" id="note"></div></section><script>
  const zh=${JSON.stringify(zh)}, byId=id=>document.getElementById(id), share=byId('share'), review=byId('review');
  const restored=window.varinUI.state;
  if(restored && typeof restored==='object'){if(Number.isFinite(restored.share))share.value=restored.share;if(Number.isFinite(restored.review))review.value=restored.review;}
  const fmt=value=>Number(value.toFixed(1)).toLocaleString(zh?'zh-CN':'en-US');
  function render(){
    const fraction=Number(share.value)/100, minutes=Number(review.value), documents=90*fraction;
    const hours=documents*(30-minutes)/60, remaining=45-hours;
    byId('saved').textContent=fmt(hours);byId('remaining').textContent=fmt(remaining)+(zh?' 小时 / 周':' h / week');
    byId('after').style.width=remaining/45*100+'%';
    byId('share-value').textContent=share.value+'%';byId('review-value').textContent=review.value+(zh?' 分钟':' min');
    byId('caption').textContent=zh?'人工投入比原来减少 '+fmt(hours/45*100)+'%':fmt(hours/45*100)+'% less human time than before';
    byId('note').textContent=zh?'每周交办 '+fmt(documents)+' 份，人工检查约 '+fmt(documents*minutes/60)+' 小时。':'Hand over '+fmt(documents)+' documents a week; allow '+fmt(documents*minutes/60)+' hours for review.';
    for(const input of [share,review])input.style.setProperty('--progress',(input.value-input.min)/(input.max-input.min)*100+'%');
    window.varinUI.setContext({documentsPerWeek:90,minutesPerDocument:30,delegatedPercent:Number(share.value),reviewMinutes:minutes,hoursSaved:hours});
  }
  for(const input of [share,review]){input.addEventListener('input',render);input.addEventListener('change',()=>window.varinUI.saveState({share:Number(share.value),review:Number(review.value)}));}
  render(); document.body.dataset.estimateReady='true';
  </script></body></html>`;
}
