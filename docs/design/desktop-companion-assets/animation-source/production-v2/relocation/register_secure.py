from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,hashlib
r=Path(__file__).parent;r.joinpath('frames').mkdir(exist_ok=True)
master=Image.open(r/'closed-reference.png').convert('RGBA');raw=Image.open(r/'sources/seated-secure-v1-raw.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([(132,265),(181,256),(214,275),(276,270),(330,253),(362,287),(370,356),(309,358),(290,335),(178,333),(133,340)],fill=255);m=m.filter(ImageFilter.GaussianBlur(.8));out=Image.composite(raw,master,m)
source=np.array([[191,281],[299,290],[245,316],[137,307]],float);target=np.array([[193,283],[301,294],[263,318],[155,306]],float)
def warp(im):
 A=[];b=[]
 for (x,y),(u,v) in zip(target,source):A.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]);b.extend([u,v])
 return im.transform((512,512),Image.Transform.PERSPECTIVE,tuple(np.linalg.solve(A,b)),Image.Resampling.BICUBIC)
for n in ['base-original-visible.png','lid-angle-000.png']:out.alpha_composite(warp(Image.open(r.parent/'lid/frames'/n).convert('RGBA')))
a=np.array(raw);skin=(a[:,:,0]>a[:,:,1]+8)&(a[:,:,0]>a[:,:,2]+9)&(a[:,:,0]>175)&(a[:,:,1]>110);region=Image.new('L',(512,512));d=ImageDraw.Draw(region);d.rectangle((140,278,182,330),fill=255);d.rectangle((272,289,323,332),fill=255);skin&=np.array(region)>0;out=Image.composite(raw,out,Image.fromarray((skin*255).astype('uint8')).filter(ImageFilter.GaussianBlur(.25)))
out.save(r/'frames/seated-secure-v1.png');m.save(r/'frames/seated-secure-arms-mask.png')
bg=Image.new('RGBA',(512,512),'#263846');bg.alpha_composite(out);bg.convert('RGB').save(r/'seated-secure-review.jpg',quality=96)
(r/'secure-provenance.json').write_text(json.dumps({'stage':'candidate hand-contact drawing, not complete pickup','source':'sources/seated-secure-v1-raw.png','sourceSHA256':hashlib.sha256((r/'sources/seated-secure-v1-raw.png').read_bytes()).hexdigest(),'identity':'../shared/upright-open-neutral-v2.png','mask':'frames/seated-secure-arms-mask.png','prop':'same raster texture perspective registration','sourceQuad':source.tolist(),'targetQuad':target.tolist()},indent=2)+'\n')
