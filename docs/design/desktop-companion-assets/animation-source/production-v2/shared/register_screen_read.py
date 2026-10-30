from pathlib import Path
from PIL import Image,ImageDraw
import numpy as np,json,hashlib
r=Path(__file__).parent;base=Image.open(r/'upright-open-neutral-v2.png').convert('RGBA');raw=Image.open(r/'open-screen-read-v2-raw.png').convert('RGBA');mask=Image.open(r/'open-screen-gaze-edit-mask.png');out=Image.composite(raw.resize((512,512),Image.Resampling.LANCZOS),base,mask);out.save(r/'open-screen-read-v2.png');m=np.array(mask);assert np.array_equal(np.array(out)[m==0],np.array(base)[m==0])
qa=Image.new('RGB',(1536,512),'#263846')
for i,name in enumerate(['upright-open-neutral-v2.png','open-screen-read-v2.png','closed-neutral-v1.png']):
 b=Image.new('RGBA',(512,512),'#263846');b.alpha_composite(Image.open(r/name));qa.paste(b.convert('RGB'),(i*512,0))
qa.save(r/'three-anchor-consistency-v2.jpg',quality=95)
(r/'screen-read-provenance.json').write_text(json.dumps({'rawSha256':hashlib.sha256((r/'open-screen-read-v2-raw.png').read_bytes()).hexdigest(),'sha256':hashlib.sha256((r/'open-screen-read-v2.png').read_bytes()).hexdigest(),'mask':'open-screen-gaze-edit-mask.png','outsideMaskExact':True,'changedPixels':int(np.any(np.array(out)!=np.array(base),axis=2).sum()),'classification':'active down-left reading gaze; parent review pending','previousGaze':'open-screen-gaze-v1.png classified as side-glance only'},indent=2)+'\n')
