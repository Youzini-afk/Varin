#!/usr/bin/env python3
"""Make a self-contained visual review of an authored atlas sequence."""
import argparse
import base64
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path, help='Exported sequence.json')
    parser.add_argument('output', type=Path, help='Self-contained HTML review')
    parser.add_argument('--stage', choices=['keyposes', 'motion-candidate'], required=True,
                        help='Key poses are not evidence of finished motion')
    args = parser.parse_args()
    data = json.loads(args.package.read_text())
    if data.get('stage') == 'keyposes' and args.stage != 'keyposes':
        parser.error('A keypose source cannot be relabeled as a motion candidate')
    for page in data['pages']:
        file = (args.package.parent / page['file']).resolve()
        if not file.is_relative_to(args.package.parent.resolve()):
            raise ValueError('Atlas path escapes package directory')
        page['image'] = 'data:image/png;base64,' + base64.b64encode(file.read_bytes()).decode()
    payload = json.dumps(data, ensure_ascii=False).replace('<', '\\u003c')
    label = '关键姿态时序审阅 · 不是流畅动画成品' if args.stage == 'keyposes' else '连续动作候选 · 尚待视觉验收'
    html = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Varin 原画序列审阅</title>
<style>body{margin:0;background:#20242b;color:#edf0f6;font:15px system-ui}main{max-width:1000px;margin:auto;padding:20px}canvas{display:block;width:min(100%,320px);height:auto;margin:12px auto;background:repeating-conic-gradient(#dce0e6 0% 25%,#f1f3f6 0% 50%) 0/24px 24px}button,select,input{margin:6px;padding:8px}input[type=range]{width:min(75%,680px)}pre{white-space:pre-wrap;color:#b8c4d6}p{line-height:1.6}</style>
<main><h1>Varin 原画序列审阅</h1><p id="stage"></p><p>保持作者指定时长；没有自动补帧、骨骼或全身淡化。请检查身份、接触、轮廓、中间运动与停顿，不能以导出成功代替动画质量。</p><canvas></canvas><div><button id="play">播放</button><button id="restart">从头</button><button id="prev">上一原画</button><button id="next">下一原画</button><label>显示尺寸<select id="size"><option>320</option><option>512</option><option>720</option></select>px</label><select id="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option></select><label><input id="repeat" type="checkbox">重复整段审阅（不宣称首尾可循环）</label></div><input id="time" type="range" min="0" step="1" value="0"><pre id="info"></pre></main>
<script>const data=__DATA__;document.querySelector('#stage').textContent=__LABEL__+(data.warning?' — '+data.warning:'');
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');[canvas.width,canvas.height]=data.canvas;
document.querySelector('#size').onchange=e=>canvas.style.width=`min(100%,${e.target.value}px)`;
const slider=document.querySelector('#time'),play=document.querySelector('#play');slider.max=data.durationMs;
let time=0,running=false,last=null,images=[];const frames=data.frames;
function frameIndex(){let i=frames.findIndex(f=>time<f.startMs+f.durationMs);return i<0?frames.length-1:i;}
function draw(){const i=frameIndex(),f=frames[i];ctx.clearRect(0,0,canvas.width,canvas.height);const [x,y,w,h]=f.rect;ctx.drawImage(images[f.page],x,y,w,h,f.offset[0],f.offset[1],w,h);slider.value=time;document.querySelector('#info').textContent=`${data.id} | ${i+1}/${frames.length} 曝光段（${data.uniqueImages??"未计"}张独立图） | ${Math.round(time)}/${data.durationMs} ms\n${f.source} | ${f.phase||'未标阶段'} | 当前原画 ${f.durationMs} ms\n接触: ${JSON.stringify(f.contacts)}\n${data.loop?'已登记循环原画区间: '+JSON.stringify(data.loop):'未登记可循环区间'}`;play.textContent=running?'暂停':'播放';}
function tick(now){if(last!==null&&running){time+=(now-last)*Number(document.querySelector('#speed').value);if(time>=data.durationMs){if(document.querySelector('#repeat').checked)time%=data.durationMs;else{time=data.durationMs;running=false;}}draw();}last=now;requestAnimationFrame(tick);}
play.onclick=()=>{if(time>=data.durationMs)time=0;running=!running;draw();};document.querySelector('#restart').onclick=()=>{time=0;draw();};slider.oninput=()=>{running=false;time=Number(slider.value);draw();};
for(const [id,delta] of [['prev',-1],['next',1]])document.querySelector('#'+id).onclick=()=>{running=false;time=frames[Math.max(0,Math.min(frames.length-1,frameIndex()+delta))].startMs;draw();};
Promise.all(data.pages.map(p=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=reject;i.src=p.image;}))).then(v=>{images=v;draw();requestAnimationFrame(tick);}).catch(()=>document.querySelector('#info').textContent='图集加载失败；此预览不可验收。');
</script></html>'''
    html = html.replace('__DATA__', payload).replace('__LABEL__', json.dumps(label, ensure_ascii=False))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html)
    print(f'Wrote {args.stage} review: {args.output}')


if __name__ == '__main__':
    main()
