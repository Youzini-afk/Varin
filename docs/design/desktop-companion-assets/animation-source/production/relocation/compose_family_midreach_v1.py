from pathlib import Path
from PIL import Image
import json,hashlib
r=Path(__file__).parent;a=r.parent/'user-attention/drag-bridges-v1';o=r/'family-midreach-v1';o.mkdir(exist_ok=True);mask=Image.open(r/'family-detach-v1/replacement-excluding-authored-arms.png');donor=Image.open(r/'departure-bridge-v1/detach-protected-v2.png').convert('RGBA');items=[]
for n in ['permission','query','wait-000','wait-001','wait-002','wait-005']:
 p=a/f'{n}-mid-reach.png';im=Image.composite(donor,Image.open(p).convert('RGBA'),mask);out=o/f'{n}-detach.png';im.save(out);b=Image.new('RGBA',(512,512),(26,37,50,255));b.alpha_composite(im);b.convert('RGB').save(o/f'{n}-dark.jpg');items.append({'source':str(p.relative_to(r.parent)),'sourceSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'detachedSource':str(out.relative_to(r.parent)),'sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'durationMs':45})
(o/'sources.json').write_text(json.dumps(items,indent=2))
