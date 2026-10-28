from PIL import Image
import numpy as np,json
from scipy import ndimage as ndi
from pathlib import Path
D=Path(__file__).parent; src=np.array(Image.open(D/'props-atlas-original.png').convert('RGBA'));h,w=src.shape[:2]
regions={'chair':(0,150,650,670),'laptopBase':(650,280,1254,650),'laptopLid':(550,660,1230,1170)}
# Chair/lid use uniform scale; laptop base uses perspective registration.
# Draft placements; runtime must validate palms/hinges/seat.
trans={'chair':(.66,600-.66*25,790-.66*205),'laptopBase':(.53,440-.53*670,700-.53*320),'laptopLid':(.40,480-.40*660,755-.40*1028)}
outdir=D/'props';outdir.mkdir(exist_ok=True);assets=[]
for n,(x0,y0,x1,y1) in regions.items():
 p=np.zeros_like(src);p[y0:y1,x0:x1]=src[y0:y1,x0:x1];a=p[:,:,3];lab,_=ndi.label(a>20);cnt=np.bincount(lab.ravel());keep=cnt>100;keep[0]=False;a[~keep[lab]]=0
 distance=ndi.distance_transform_edt(a>20);rgb=p[:,:,:3].astype(float);mx=rgb.max(2);mn=rgb.min(2);sat=(mx-mn)/np.maximum(mx,1);a[(distance<3)&(sat>.5)]=0;p[:,:,3]=a;p[a==0,:3]=0
 Image.fromarray(p).save(outdir/f'{n}-atlas.png')
 s,tx,ty=trans[n];im=Image.fromarray(p).transform((1382,1382),Image.Transform.AFFINE,(1/s,0,-tx/s,0,1/s,-ty/s),Image.Resampling.BICUBIC);
 if n=='laptopBase':
  target=[(480,755),(690,795),(570,700),(780,740)]; original=[(850,325),(1220,402),(670,460),(1085,615)]; A=[];b=[]
  for (x,y),(u,v) in zip(target,original):
   A.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]);b.extend([u,v])
  coef=np.linalg.solve(np.array(A,float),np.array(b,float));im=Image.fromarray(p).transform((1382,1382),Image.Transform.PERSPECTIVE,tuple(coef),Image.Resampling.BICUBIC)

 im.save(outdir/f'{n}.png')
 assets.append({'node':n,'path':f'props/{n}.png','atlasMask':f'props/{n}-atlas.png','atlasRegion':[x0,y0,x1,y1],'uniformScale':s if n!='laptopBase' else None,'translate':[tx,ty] if n!='laptopBase' else None,'perspectiveCoefficients':list(coef) if n=='laptopBase' else None,'status':'draft-placement-needs-contact-qa'})
scene=Image.new('RGBA',(1382,1382));scene.alpha_composite(Image.open(D.parent/'stage1'/'layers-partition-v1'/'hairBack.png'));scene.alpha_composite(Image.open(outdir/'chair.png'))
for part in ['lowerBody','torso','upperArmL','upperArmR','forearmL','forearmR','handL','handR','head']:scene.alpha_composite(Image.open(D.parent/'stage1'/'layers-partition-v1'/f'{part}.png'))
scene.alpha_composite(Image.open(outdir/'laptopBase.png'));
for hand in ['handL','handR']:scene.alpha_composite(Image.open(D.parent/'stage1'/'layers-partition-v1'/f'{hand}.png'))
scene.alpha_composite(Image.open(outdir/'laptopLid.png'));scene.save(D/'props-placement-qa.png')
(D/'props-manifest.json').write_text(json.dumps({'canvas':[1382,1382],'atlasSize':[w,h],'original':'props-atlas-original.png','assets':assets,'hingeDraft':[[480,755],[690,795]],'warning':'Draft mapping only. Screen can occlude wrists; base/lid contact and seat depth require runtime director QA.'},indent=2))
