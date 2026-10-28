from pathlib import Path
from PIL import Image
import numpy as np,json,hashlib
r=Path(__file__).parent;a=r.parent/'user-attention/drag-bridges-v1';o=r/'family-detach-v1';o.mkdir(exist_ok=True)
donor=Image.open(r/'departure-bridge-v1/detach-protected-v2.png').convert('RGBA');m=np.array(Image.open(r/'departure-bridge-v1/stool-replacement-mask-v2.png')).astype(float)/255;protect=np.array(Image.open(a/'authored-arms-mask.png')).astype(float)/255;m=Image.fromarray((m*(1-protect)*255).astype('uint8'));m.save(o/'replacement-excluding-authored-arms.png')
items=[]
for n in ['permission','query','wait-000','wait-001','wait-002','wait-005']:
 p=a/f'{n}-support-registered.png';base=Image.open(p).convert('RGBA');im=Image.composite(donor,base,m);im.save(o/f'{n}-detach.png');b=Image.new('RGBA',(512,512),(26,37,50,255));b.alpha_composite(im);b.convert('RGB').save(o/f'{n}-dark.jpg');items.append({'name':n,'upperSource':str(p.relative_to(r.parent)),'upperSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'output':f'{n}-detach.png'})
(o/'sources.json').write_text(json.dumps({'stage':'candidate-no-stool-contact','method':'canonical original legs retained; authored stool replacement region, subtract new arm occlusion mask; no geometry warp','frames':items},indent=2))
