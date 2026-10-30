from pathlib import Path
from PIL import Image
from scipy import ndimage as ndi
import numpy as np,json,hashlib
r=Path(__file__).parent;p=r/'canonical-v1/airborne-clean-white-v2.png';rgb=np.array(Image.open(p).convert('RGB')).astype(float)
white=(rgb.min(2)>=248)&(rgb.max(2)-rgb.min(2)<=12);labels,_=ndi.label(white,np.ones((3,3)));border=np.unique(np.r_[labels[0],labels[-1],labels[:,0],labels[:,-1]])
holes=[38,84,90,97,108,128,154,170,172,178,224,230,233,252,253,280,281,283,287,291]
bg=np.isin(labels,list(border[border!=0])+holes);fg=~bg;dist=ndi.distance_transform_edt(fg);core=dist>2;_,near=ndi.distance_transform_edt(~core,return_indices=True);ref=rgb[near[0],near[1]]
alpha=fg.astype(float);edge=(dist>0)&(dist<=1.5);den=((255-ref)**2).sum(2);est=np.divide(((255-rgb)*(255-ref)).sum(2),den,out=np.ones_like(den),where=den>25);alpha[edge]=np.clip(est[edge],0,1);un=rgb.copy();soft=edge&(alpha>0)&(alpha<1);un[soft]=np.clip((rgb[soft]-255*(1-alpha[soft,None]))/alpha[soft,None],0,255)
a=np.dstack([np.round(un).astype('uint8'),np.round(alpha*255).astype('uint8')]);a[alpha==0]=0
out=r/'canonical-registered-v1/airborne-clean-v2.png';Image.fromarray(a).save(out)
qa=Image.new('RGB',(1536,512))
for i,c in enumerate([(255,255,255),(26,37,50),(128,128,128)]):
 b=Image.new('RGBA',(512,512),(*c,255));b.alpha_composite(Image.fromarray(a));qa.paste(b.convert('RGB'),(i*512,0))
qa.save(r/'reviews/airborne-clean-v2-alpha-qa.png')
(r/'reviews/airborne-clean-v2-alpha-provenance.json').write_text(json.dumps({'sourceSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'reviewedHoleIds':holes,'source':'opaque authored edge cleanup, no pose warps','method':'border white extraction and boundary unmatting','status':'candidate pending parent visual review'},indent=2))
