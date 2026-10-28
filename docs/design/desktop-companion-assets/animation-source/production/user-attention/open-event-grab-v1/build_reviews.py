from pathlib import Path
import json,shutil,subprocess
P=Path(__file__).resolve().parent;R=P.parents[1];T=R.parent/'varin-main-20261028/tools/desktop-companion-animation';rows=json.load(open(P/'source-map.json'))['frames'];routes=json.load(open(P/'routes.json'))
for family,n in [('completion-wave-v2',6),('completion-wave-v2',2),('attention-sequence-v2',4),('attention-sequence-v2',2)]:
 row=next(x for x in rows if x['source'].endswith(f'{family}/pose-{n:03}.png'));seq=routes[row['sourceSha256']]+[['relocation/departure-bridge-v1/detach-protected-v2.png',80],['relocation/departure-bridge-v3/mid-protected.png',100],['relocation/rapid-pickup-v1/half.png',350]];out=P/f'review-{family}-{n:03}';out.mkdir(exist_ok=True);frames=[]
 for i,(src,ms) in enumerate(seq):
  dest=f'pose-{i:03}.png';shutil.copyfile(R/src,out/dest);frames.append(dict(source=dest,durationMs=ms,offset=[0,0],phase=src))
 d=dict(id=out.name,family='USER_ATTENTION_CLOSED_GRAB',canvas=[512,512],frames=frames,loop=None,warning='Current-pose immediate detach, near hand supports before existing far-arm recovery. Native window follows pointer immediately. Candidate representative review only.');(out/'sequence.source.json').write_text(json.dumps(d,indent=2));subprocess.run(['python',str(T/'pack_sequence.py'),str(out/'sequence.source.json'),str(out/'export')],check=True,capture_output=True);subprocess.run(['python',str(T/'make_review.py'),str(out/'export/sequence.json'),str(out/'review.html'),'--stage','motion-candidate'],check=True,capture_output=True);s=(out/'review.html').read_text();(out/'autoplay-review.html').write_text(s.replace('images=v;draw();requestAnimationFrame(tick);',"images=v;running=true;document.querySelector('#repeat').checked=true;draw();requestAnimationFrame(tick);"))
 print(out.name)
