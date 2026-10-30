from pathlib import Path
from PIL import Image
from scipy import ndimage as ndi
import numpy as np,json
r=Path(__file__).parent;o=r/'rapid-pickup-v4';o.mkdir(exist_ok=True)
base=Image.open(r.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA')
for name in ['turn70']:
 rgb=np.array(Image.open(r/'source'/f'canonical-rapid-pickup-{name}-v1.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS)).astype(float)
 white=(rgb.min(2)>=248)&(rgb.max(2)-rgb.min(2)<=12);lab,n=ndi.label(white,np.ones((3,3)));border=np.unique(np.r_[lab[0],lab[-1],lab[:,0],lab[:,-1]])
 # Interior hair holes are retained for manual review, never erase white costume by color alone.
 bg=np.isin(lab,border[border!=0]);fg=~bg;dist=ndi.distance_transform_edt(fg);core=dist>2;_,near=ndi.distance_transform_edt(~core,return_indices=True);ref=rgb[near[0],near[1]]
 a=fg.astype(float);edge=(dist>0)&(dist<=1.5);den=((255-ref)**2).sum(2);est=np.divide(((255-rgb)*(255-ref)).sum(2),den,out=np.ones_like(den),where=den>25);a[edge]=np.clip(est[edge],0,1);soft=edge&(a>0)&(a<1);rgb[soft]=np.clip((rgb[soft]-255*(1-a[soft,None]))/a[soft,None],0,255)
 z=np.dstack([rgb.astype('uint8'),(a*255).astype('uint8')]);z[a==0]=0;im=Image.fromarray(z)
 # Restore exact unchanged head/eyes from canonical; lower motion art stays authored.
 yy=np.indices((512,512))[0];mask=Image.fromarray((np.clip((185-yy)/5,0,1)*255).astype('uint8'));im=Image.composite(base,im,mask);im.save(o/f'{name}.png')
 qa=Image.new('RGBA',(512,512),(26,37,50,255));qa.alpha_composite(im);qa.convert('RGB').save(o/f'{name}-dark.jpg')
(o/'provenance.json').write_text(json.dumps({'stage':'motion-candidate','method':'whole viewport 512 normalization; border matte and boundary unmatting; exact static canonical head restoration','interiorHairHoles':'pending manual QA','noBodyWarp':True},indent=2))
