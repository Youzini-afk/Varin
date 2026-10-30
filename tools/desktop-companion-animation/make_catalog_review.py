#!/usr/bin/env python3
"""Build a full-coverage review from explicitly associated real sequence packages."""
import argparse
import base64
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--asset', action='append', default=[], help='required-action=path/to/packed/sequence.json')
    parser.add_argument('--inventory', type=Path, help='JSON list of {action, package}, paths relative to this inventory')
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    catalog = json.loads((here / 'coverage.json').read_text())
    assets = []
    associations = [a.split('=', 1) for a in args.asset]
    if args.inventory:
        associations += [(row['action'], str(args.inventory.parent / row['package'])) for row in json.loads(args.inventory.read_text())]
    for action, file in associations:
        path = Path(file).resolve()
        data = json.loads(path.read_text())
        data['action'] = action
        for page in data['pages']:
            image = (path.parent / page['file']).resolve()
            if not image.is_relative_to(path.parent):
                raise ValueError('Atlas path escapes package directory')
            page['image'] = 'data:image/png;base64,' + base64.b64encode(image.read_bytes()).decode()
        assets.append(data)
    ids = [a['id'] for a in assets]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate asset IDs: one real package must have one identity')
    source = (here.parent.parent / 'packages/ui/src/components/companion/playback.mjs').read_text().replace('export { CompanionPlayback as ReviewPlayback };', 'const ReviewPlayback = CompanionPlayback;').replace('export ', '')
    js_data = json.dumps({'catalog': catalog, 'assets': assets}, ensure_ascii=False).replace('<', '\\u003c')
    html = r'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Varin 完整动画资源评审</title>
<style>body{background:#20242b;color:#edf0f6;font:15px system-ui;margin:0}main{padding:20px;max-width:1150px;margin:auto}button,select,input{padding:7px;margin:4px}canvas{max-width:100%;width:600px;height:auto;background:repeating-conic-gradient(#dde1e8 0% 25%,#f2f3f6 0% 50%) 0/24px 24px}table{border-collapse:collapse;width:100%}td,th{padding:7px;border-bottom:1px solid #46505e;text-align:left}pre{white-space:pre-wrap}p{line-height:1.6}.missing{color:#e5ac91}.candidate{color:#e4cf8c}.accepted{color:#8fddb6}</style>
<main><h1>Varin 全32类动画资源评审</h1><p>本页是完整生产覆盖与原画审阅，不是已接入应用的桌宠。关键姿态不具备正式连续动画或自动转场资格；缺少的资源直接显示缺口。</p><div><select id="states"></select><select id="assets"></select><button id="play">播放原画审阅</button><button id="previous">上一原画</button><button id="next">下一原画</button></div><canvas width="512" height="512"></canvas><pre id="detail"></pre><h2>完整覆盖</h2><table><thead><tr><th>表现</th><th>动作资源</th></tr></thead><tbody id="coverage"></tbody></table><h2>必需连接（不是已存在素材）</h2><pre id="bridges"></pre></main><script>
__GRAPH__
const {catalog,assets}=__DATA__;const rows=coverage(catalog,assets);const states=document.querySelector('#states'),select=document.querySelector('#assets'),canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');
let current=null,prior=null,time=0,running=false,last=null,images=[],loading=false;const loaded=new Map();
for(const state of rows){const opt=new Option(state.id+' '+state.label,state.id);states.add(opt);const tr=document.createElement('tr'),name=document.createElement('td'),detail=document.createElement('td');name.textContent=state.id+' '+state.label;for(const action of state.actions){const div=document.createElement('div');div.className=action.status;div.textContent=action.action+': '+({accepted:'视觉通过',candidate:'仅候选/关键姿态',missing:'缺少资源'}[action.status]);detail.append(div);}tr.append(name,detail);document.querySelector('#coverage').append(tr);}
document.querySelector('#bridges').textContent=catalog.requiredBridges.map(b=>b.fromFamily+' → '+b.toFamily+' : '+b.action+' — '+(assets.some(a=>a.action===b.action)?'已有候选，仍需匹配姿态检查':'缺少已登记连接')).join('\n');
function render(){ctx.clearRect(0,0,canvas.width,canvas.height);if(loading){document.querySelector('#detail').textContent='正在载入实际图集';return;}if(!current){document.querySelector('#detail').textContent='此表现暂无原画资源。没有用无关动作填充。';return;}const f=frameAt(current,time),[x,y,w,h]=f.rect;ctx.drawImage(images[f.page],x,y,w,h,...f.offset,w,h);const transition=prior?route(prior,current,assets):null;document.querySelector('#detail').textContent=current.id+' | '+(current.stage||'未标制作阶段')+' | '+Math.round(time)+' / '+current.durationMs+' ms\n'+(current.warning||'')+'\n当前原画: '+f.source+'\n'+(transition?'上个审阅资源到此资源的正式连接: '+transition.status+' — '+(transition.reason||transition.clips.join(' → ')):'尚未请求正式连接');document.querySelector('#play').textContent=running?'暂停':'播放原画审阅';}
async function choose(){running=false;loading=false;prior=current;current=assets.find(a=>a.id===select.value)||null;time=0;if(!current){render();return;}const requested=current;loading=true;render();if(!loaded.has(current.id)){const ims=await Promise.all(current.pages.map(p=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=p.image;})));loaded.set(requested.id,ims);}if(current!==requested)return;images=loaded.get(current.id);loading=false;[canvas.width,canvas.height]=current.canvas;render();}
function stateChange(){const row=rows.find(s=>s.id===states.value);select.replaceChildren();const ids=row.actions.flatMap(a=>a.candidates);for(const id of ids)select.add(new Option(id,id));choose();}states.onchange=stateChange;select.onchange=choose;
document.querySelector('#play').onclick=()=>{if(!current||loading)return;if(time>=current.durationMs)time=0;running=!running;render();};for(const [id,delta]of[['previous',-1],['next',1]])document.querySelector('#'+id).onclick=()=>{if(!current||loading)return;running=false;const i=current.frames.indexOf(frameAt(current,time));time=current.frames[Math.max(0,Math.min(current.frames.length-1,i+delta))].startMs;render();};
function tick(now){if(last!==null&&running&&current){time=Math.min(current.durationMs,time+now-last);if(time===current.durationMs)running=false;render();}last=now;requestAnimationFrame(tick);}stateChange();requestAnimationFrame(tick);
</script></html>'''.replace('__GRAPH__', source).replace('__DATA__', js_data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html)
    print(f'Wrote full 32-state review with {len(assets)} real candidate packages: {args.output}')


if __name__ == '__main__':
    main()
