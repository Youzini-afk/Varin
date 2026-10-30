from pathlib import Path
from PIL import Image
import json,hashlib
r=Path(__file__).parent;a=r.parent/'user-attention';o=r/'user-current-detach-v1';o.mkdir(exist_ok=True);mask=Image.open(r/'family-detach-v1/replacement-excluding-authored-arms.png');donor=Image.open(r/'departure-bridge-v1/detach-protected-v2.png').convert('RGBA');items=[]
for family in ['permission-cycle-v2','query-understand-v1','wait-relaxed-v1']:
 dest=o/family;dest.mkdir(exist_ok=True)
 for p in sorted((a/'registered'/family).glob('pose-*.png')):
  im=Image.composite(donor,Image.open(p).convert('RGBA'),mask);f=dest/p.name;im.save(f);items.append({'source':str(p.relative_to(r.parent)),'sourceSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'detachedSource':str(f.relative_to(r.parent)),'detachedSha256':hashlib.sha256(f.read_bytes()).hexdigest()})
(o/'current-pose-map.json').write_text(json.dumps({'stage':'same-exposure-no-stool-candidate','root':'varin-animation-production','purpose':'immediate pointerdown retains actually displayed gesture, not jump to representative pose','mask':'relocation/family-detach-v1/replacement-excluding-authored-arms.png','frames':items},indent=2));print(len(items))
