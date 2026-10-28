from pathlib import Path
from PIL import Image,ImageChops
import json,hashlib
P=Path(__file__).resolve().parent;R=P.parents[1];O=R/'observe-diagnose/gesture-pickup-v2'
near=Image.open(O/'closed-near-support-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);nm=Image.open(O/'near-support-mask.png').convert('L');dm=Image.open(R/'relocation/departure-bridge-v1/stool-replacement-mask-v2.png').convert('L');lower=Image.open(R/'relocation/departure-bridge-v1/detach-protected-v2.png').convert('RGBA');rows=[]
for family,count in [('welcome-closed-v2',10),('click-closed-v5',11)]:
 out=P/family;out.mkdir(exist_ok=True)
 for i in range(count):
  source=R/f'user-attention/registered/{family}/pose-{i:03}.png';src=Image.open(source).convert('RGBA');det=Image.composite(lower,src,dm);sup=Image.composite(near,src,nm);sup=Image.composite(lower,sup,ImageChops.subtract(dm,nm));dp=out/f'current-{i:03}.png';sp=out/f'supported-{i:03}.png';det.save(dp);sup.save(sp)
  rows.append(dict(source=str(source.relative_to(R)),sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),currentDetached=str(dp.relative_to(R)),supported=str(sp.relative_to(R))))
(P/'source-map.json').write_text(json.dumps({'stage':'candidate awaiting visual group acceptance','frames':rows},indent=2))
# Real existing far-arm return, no new neutral pose inserted.
paths={}
for row in rows:
 name=Path(row['source']).parent.name;i=int(Path(row['source']).stem[-3:]);seq=[(row['currentDetached'],35),(row['supported'],55)]
 if name=='welcome-closed-v2':
  indices=[7,8] if i in [3,4,5,6] else [8] if i in [2,7] else []
  seq += [(f'user-attention/closed-grab-v1/{name}/supported-{j:03}.png',55 if j==7 else 45) for j in indices]
 paths[row['sourceSha256']]=seq
(P/'routes.json').write_text(json.dumps(paths,indent=2))
