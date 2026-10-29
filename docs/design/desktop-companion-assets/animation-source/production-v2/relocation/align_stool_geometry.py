from pathlib import Path
from PIL import Image
import numpy as np,json
r=Path(__file__).parent;im=Image.open(r/'frames/world-stool-candidate-v2.png').convert('RGBA');out=Image.new('RGBA',(512,512))
# Align the source drawing's cushion/leg junction to the original visible seat face.
# Whole prop strips only; no character pixels are transformed.
source=[0,335,359,411,473,512];target=[0,335,357,400,473,512]
for a,b,c,d in zip(source,source[1:],target,target[1:]):out.paste(im.crop((0,a,512,b)).resize((512,d-c),Image.Resampling.BICUBIC),(0,c))
out.save(r/'frames/world-stool-aligned-v3.png')
qa=Image.new('RGB',(1024,512),'#263846')
for i,x in enumerate([Image.alpha_composite(out,Image.open(r/'frames/detach-first-v2.png').convert('RGBA')),Image.open(r/'frames/seated-secure-v2.png').convert('RGBA')]):
 b=Image.new('RGBA',(512,512),'#263846');b.alpha_composite(x);qa.paste(b.convert('RGB'),(i*512,0))
qa.save(r/'world-stool-aligned-review-v3.jpg',quality=96)
(r/'world-stool-alignment-v3.json').write_text(json.dumps({'source':'frames/world-stool-candidate-v2.png','output':'frames/world-stool-aligned-v3.png','sourceYAnchors':source,'targetYAnchors':target,'characterTransformed':False,'stage':'geometry candidate; parent review pending'},indent=2)+'\n')
