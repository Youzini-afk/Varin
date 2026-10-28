from pathlib import Path
from PIL import Image,ImageChops
import json,hashlib
P=Path(__file__).resolve().parent.parent/'open-event-grab-v1';P.mkdir(exist_ok=True);R=P.parents[1];O=R/'observe-diagnose/gesture-pickup-v2';near=Image.open(O/'near-support-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);nm=Image.open(O/'near-support-mask.png').convert('L');dm=Image.open(R/'relocation/departure-bridge-v1/stool-replacement-mask-v2.png').convert('L');lower=Image.open(R/'relocation/departure-bridge-v1/detach-protected-v2.png').convert('RGBA');arms=ImageChops.lighter(Image.open(R/'user-attention/drag-bridges-v1/authored-arms-mask.png').convert('L'),Image.open(O/'far-arm-mask.png').convert('L'));mid=Image.open(R/'user-attention/drag-bridges-v1/query-mid-reach.png').convert('RGBA');support=Image.open(R/'user-attention/drag-bridges-v1/query-support-registered.png').convert('RGBA');rows=[];routes={}
for family,count in [('completion-wave-v2',11),('attention-sequence-v2',5)]:
 out=P/family;out.mkdir(exist_ok=True)
 for i in range(count):
  srcpath=R/f'user-attention/registered/{family}/pose-{i:03}.png';src=Image.open(srcpath).convert('RGBA');dest={}
  for name,img in [('current',src),('near',Image.composite(near,src,nm)),('midreach',Image.composite(mid,src,arms)),('support',Image.composite(support,src,arms))]:
   mask=dm if name=='current' else ImageChops.subtract(dm,nm if name=='near' else arms);img=Image.composite(lower,img,mask);f=out/f'{name}-{i:03}.png';img.save(f);dest[name]=str(f.relative_to(R))
  sha=hashlib.sha256(srcpath.read_bytes()).hexdigest();row={'source':str(srcpath.relative_to(R)),'sourceSha256':sha,**dest};rows.append(row)
  seq=[(dest['current'],35)]
  if family=='completion-wave-v2' and i in range(2,10):
   seq.append((dest['near'],45));indices=[8,9] if i in range(3,8) else [9] if i==8 else []
   seq.extend((f'user-attention/open-event-grab-v1/{family}/near-{j:03}.png',45)for j in indices)
  end=9 if family=='completion-wave-v2' and i in range(3,9) else i
  seq += [(f'user-attention/open-event-grab-v1/{family}/midreach-{end:03}.png',45),(f'user-attention/open-event-grab-v1/{family}/support-{end:03}.png',70)];routes[sha]=seq
(P/'source-map.json').write_text(json.dumps({'stage':'candidate group QA pending','frames':rows},indent=2));(P/'routes.json').write_text(json.dumps(routes,indent=2));print(len(rows))
