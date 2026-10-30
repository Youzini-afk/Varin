from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,math,json,hashlib
r=Path(__file__).parent;s=Image.open(r.parent/'shared/upright-open-neutral-v2.png').convert('RGBA');plate=Image.open(r/'sources/no-laptop-cleanplate-v1-raw.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([(103,222),(222,220),(251,260),(320,270),(368,319),(320,341),(139,338),(98,272)],fill=255);m=m.filter(ImageFilter.GaussianBlur(.8));clean=Image.composite(plate,s,m);clean.save(r/'frames/no-laptop-cleanplate.png')
q=np.array([[110,229],[218,238],[245,316],[137,307]],float);h0=q[3];h1=q[2];closed=np.array([54.,-26.]);op=math.radians(100);vertical=(q[0]-h0-closed*math.cos(op))/math.sin(op)
def quad(deg):
 a=math.radians(deg);v=closed*math.cos(a)+vertical*math.sin(a);far=(q[1]-q[0]-(h1-h0))*math.sin(a)/math.sin(op);return np.array([h0+v,h1+v+far,h1,h0])
def project(target):
 A=[];b=[]
 for (x,y),(u,v) in zip(target,q):A.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]);b.extend([u,v])
 co=np.linalg.solve(np.array(A),np.array(b));im=s.transform((512,512),Image.Transform.PERSPECTIVE,tuple(co),Image.Resampling.BICUBIC);m=Image.new('L',(1536,1536));ImageDraw.Draw(m).polygon([tuple(x*3) for x in target],fill=255);im.putalpha(m.resize((512,512),Image.Resampling.LANCZOS));return im
# Original visible keyboard/base pixels, not a reimagined base in each generated frame.
bm=Image.new('L',(1536,1536));poly=[(137,307),(245,316),(298,301),(300,309),(246,325),(137,315)];ImageDraw.Draw(bm).polygon([(x*3,y*3) for x,y in poly],fill=255);base=s.copy();base.putalpha(bm.resize((512,512),Image.Resampling.LANCZOS));base.save(r/'frames/base-original-visible.png')
record=[];sheet=Image.new('RGB',(2048,1024),'#263846')
for i,a in enumerate([0,15,30,45,55,70,85,100]):
 lid=project(quad(a));lid.save(r/f'frames/lid-angle-{a:03}.png');im=clean.copy();im.alpha_composite(base);im.alpha_composite(lid);im.save(r/f'frames/fixture-{a:03}.png');bg=Image.new('RGBA',(512,512),'#263846');bg.alpha_composite(im);sheet.paste(bg.convert('RGB'),(i%4*512,i//4*512));record.append({'angleDegrees':a,'quad':quad(a).tolist(),'hinge':[h0.tolist(),h1.tolist()]})
sheet.save(r/'rigid-prop-fixture-review.jpg',quality=95);(r/'prop-geometry.json').write_text(json.dumps({'stage':'rigid-prop fixture only; hands not yet matched; not animation acceptance','sourceTexture':'../shared/upright-open-neutral-v2.png','sourceSHA256':hashlib.sha256((r.parent/'shared/upright-open-neutral-v2.png').read_bytes()).hexdigest(),'sourceQuad':q.tolist(),'baseFootprintSource':'same original source pixels','frames':record},indent=2)+'\n')
