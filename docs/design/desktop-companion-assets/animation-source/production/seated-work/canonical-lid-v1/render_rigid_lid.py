"""Project the original canonical screen-back texture around a fixed hinge.
This generates a hard-surface prop drawing aid, not complete character animation.
"""
from pathlib import Path
from PIL import Image,ImageDraw
import numpy as np,math,json
p=Path(__file__).parent;source=Image.open(p.parent.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA');q=np.array([[101,224],[214,233],[239,319],[130,312]],float);h0=q[3];h1=q[2];closed=np.array([72.,-17.]);op=math.radians(100);vertical=(q[0]-h0-closed*math.cos(op))/math.sin(op)
def quad(angle):
 t=math.radians(angle);v=closed*math.cos(t)+vertical*math.sin(t);far=(q[1]-q[0]-(h1-h0))*math.sin(t)/math.sin(op);return np.array([h0+v,h1+v+far,h1,h0])
def project(target):
 A=[];b=[]
 for (x,y),(u,v) in zip(target,q):
  A.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]);b.extend([u,v])
 coeff=np.linalg.solve(np.array(A),np.array(b));out=source.transform((512,512),Image.Transform.PERSPECTIVE,tuple(coeff),Image.Resampling.BICUBIC);m=Image.new('L',(1024,1024));ImageDraw.Draw(m).polygon([tuple(v*2)for v in target],fill=255);m=m.resize((512,512),Image.Resampling.LANCZOS);out.putalpha(m);return out
outdir=p/'rigid-lid';outdir.mkdir(exist_ok=True);records=[];sheet=Image.new('RGBA',(2048,1024),(215,232,220,255))
for i,a in enumerate([0,15,30,45,60,75,90,100]):
 target=quad(a);im=project(target);im.save(outdir/f'angle-{a:03}.png');records.append({'angleDegrees':a,'quad':target.tolist(),'hinge':[h0.tolist(),h1.tolist()]});bg=Image.open(p/'closed-canonical-candidate.png').convert('RGBA');bg.alpha_composite(im);sheet.alpha_composite(bg,((i%4)*512,(i//4)*512))
sheet.convert('RGB').save(p/'rigid-lid-fixture-review.jpg');json.dump({'status':'prop-only-fixture-not-character-animation','textureSource':'../../shared/seated-open-canonical-alpha-v1.png','sourceQuad':q.tolist(),'method':'Perspective texture projection with fixed hinge and continuous angle; no body deformation or implicit grip motion','records':records},open(outdir/'geometry.json','w'),indent=2)
