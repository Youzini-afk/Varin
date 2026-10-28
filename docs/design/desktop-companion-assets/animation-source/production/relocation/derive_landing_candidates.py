from pathlib import Path
from PIL import Image
from scipy import ndimage as ndi
import numpy as np,json
r=Path(__file__).parent;prior=np.array(Image.open(r/'canonical-registered-v1/airborne-clean-v2.png'))[:,:,3]
for name in ['preland-no-stool-white','contact-no-stool-white']:
 rgb=np.array(Image.open(r/'canonical-v1'/f'{name}.png').convert('RGB')).astype(float)
 w=(rgb.min(2)>=248)&(rgb.max(2)-rgb.min(2)<=12);l,c=ndi.label(w,np.ones((3,3)));b=np.unique(np.r_[l[0],l[-1],l[:,0],l[:,-1]]);bg=np.isin(l,b[b!=0]);holes=[]
 for k in range(1,c+1):
  y,x=np.where(l==k)
  if len(x)>3 and ((prior[l==k]<50).mean()>.3) and (x.mean()<190 or x.mean()>380):bg|=l==k;holes.append(k)
 d=ndi.distance_transform_edt(~bg);core=d>2;_,near=ndi.distance_transform_edt(~core,return_indices=True);ref=rgb[near[0],near[1]];alpha=(~bg).astype(float);edge=(d>0)&(d<=1.5);den=((255-ref)**2).sum(2);est=np.divide(((255-rgb)*(255-ref)).sum(2),den,out=np.ones_like(den),where=den>25);alpha[edge]=np.clip(est[edge],0,1);soft=edge&(alpha>0)&(alpha<1);un=rgb.copy();un[soft]=np.clip((rgb[soft]-255*(1-alpha[soft,None]))/alpha[soft,None],0,255);a=np.dstack([np.round(un).astype('uint8'),np.round(alpha*255).astype('uint8')]);a[alpha==0]=0
 out=r/'canonical-registered-v1'/f'{name}-alpha.png';Image.fromarray(a).save(out)
 (r/'reviews'/f'{name}-alpha-provisional.json').write_text(json.dumps({'holesSelectedByPrior':holes,'status':'provisional matte, inspect exact holes against actual image before acceptance'},indent=2))
 b=Image.new('RGBA',(512,512),(26,37,50,255));b.alpha_composite(Image.open(r/'canonical-registered-v1/stool-world-candidate-v2.png'));b.alpha_composite(Image.fromarray(a));b.save(r/'reviews'/f'{name}-world-composite.png')
