from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,hashlib
R=Path(__file__).parent;base=Image.open(R/'upright-open-neutral-v2.png').convert('RGBA');outinfo=[]
for name in ['closed-neutral','open-screen-gaze']:
 raw=Image.open(R/(name+'-v1-raw.png')).convert('RGBA');im=raw.resize((512,512),Image.Resampling.LANCZOS);mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask)
 if name=='closed-neutral':d.polygon([(105,222),(218,220),(242,234),(301,233),(356,253),(371,310),(338,332),(147,331),(106,264)],fill=255)
 else:
  d.ellipse((201,115,253,161),fill=255);d.ellipse((263,112,316,160),fill=255)
 mask=mask.filter(ImageFilter.GaussianBlur(1.1));a=np.array(mask);a[a<3]=0;mask=Image.fromarray(a)
 out=Image.composite(im,base,mask);out.save(R/(name+'-v1.png'));mask.save(R/(name+'-edit-mask.png'))
 unchanged=np.array_equal(np.array(out)[a==0],np.array(base)[a==0]);outinfo.append({'path':name+'-v1.png','raw':name+'-v1-raw.png','rawSha256':hashlib.sha256((R/(name+'-v1-raw.png')).read_bytes()).hexdigest(),'sha256':hashlib.sha256((R/(name+'-v1.png')).read_bytes()).hexdigest(),'mask':name+'-edit-mask.png','outsideMaskExact':unchanged,'changedPixels':int(np.any(np.array(out)!=np.array(base),axis=2).sum())})
qa=Image.new('RGB',(1536,1074),'#e9eef2');d=ImageDraw.Draw(qa)
for i,n in enumerate(['upright-open-neutral-v2.png','open-screen-gaze-v1.png','closed-neutral-v1.png']):
 im=Image.open(R/n)
 for j,col in enumerate(['#e9eef2','#263846']):
  bg=Image.new('RGBA',(512,512),col);bg.alpha_composite(im);qa.paste(bg.convert('RGB'),(i*512,j*537))
 d.text((i*512+12,516),n,fill='#304353')
qa.save(R/'three-anchor-consistency-v1.jpg',quality=95);(R/'derived-anchor-provenance.json').write_text(json.dumps(outinfo,indent=2)+'\n')
