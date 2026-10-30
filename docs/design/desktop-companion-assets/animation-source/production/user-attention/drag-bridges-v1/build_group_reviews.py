from pathlib import Path
import json,shutil,subprocess
p=Path(__file__).parent;r=p.parents[1];t=r.parent/'varin-main-20261028/tools/desktop-companion-animation'
rows={
'query-nod':[(f'relocation/user-current-detach-v1/query-understand-v1/pose-{n:03}.png',ms) for n,ms in [(12,35),(13,40),(14,40)]],
'permission-low':[('relocation/user-current-detach-v1/permission-cycle-v2/pose-003.png',35)],
'wait-002':[('relocation/user-current-detach-v1/wait-relaxed-v1/pose-002.png',35)]}
for name,a in rows.items():
 family={"query-nod":"query","permission-low":"permission"}.get(name,name)
 a += [(f'relocation/family-midreach-v1/{family}-detach.png',45),(f'relocation/family-detach-v1/{family}-detach.png',70),('relocation/departure-bridge-v1/detach-protected-v2.png',80),('relocation/departure-bridge-v3/mid-protected.png',100),('relocation/rapid-pickup-v1/half.png',350)]
 out=p/f'review-v2-{name}';out.mkdir(exist_ok=True);fs=[]
 for i,(src,ms) in enumerate(a):
  dest=f'pose-{i:03}.png';shutil.copyfile(r/src,out/dest);fs.append(dict(source=dest,durationMs=ms,offset=[0,0],phase=src))
 d=dict(id=f'drag-contact-{name}-v1',family='USER_ATTENTION_RELOCATION',canvas=[512,512],stage='motion-candidate',loop=None,frames=fs,warning='Finite art bridge review only. Native root follows pointer immediately, stool stays separate. Current pose detach then actual hand contact/half-lid/leg gathering; no fabricated approval/cancel.')
 (out/'sequence.source.json').write_text(json.dumps(d,indent=2));subprocess.run(['python',str(t/'pack_sequence.py'),str(out/'sequence.source.json'),str(out/'export')],check=True,capture_output=True);subprocess.run(['python',str(t/'make_review.py'),str(out/'export/sequence.json'),str(out/'review.html'),'--stage','motion-candidate'],check=True,capture_output=True)
 h=(out/'review.html').read_text();(out/'autoplay-review.html').write_text(h.replace('images=v;draw();requestAnimationFrame(tick);',"images=v;running=true;document.querySelector('#repeat').checked=true;draw();requestAnimationFrame(tick);"))
 print(name,sum(x[1]for x in a))
