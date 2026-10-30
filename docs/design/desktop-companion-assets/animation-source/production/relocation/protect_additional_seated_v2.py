from PIL import Image
from scipy import ndimage as ndi
import numpy as np
from pathlib import Path
r=Path(__file__).parent;base=Image.open(r.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA');mask=Image.open(r/'canonical-static-v1/authored-edit-mask.png');out=r/'canonical-static-v2';out.mkdir(exist_ok=True)
for name in ['lap-release','close-gap']:
 src=Image.open(r/'canonical-v1'/f'{name}-white.png').convert('RGBA');z=np.array(src);w=(z[:,:,:3].min(2)>=248)&(z[:,:,:3].max(2)-z[:,:,:3].min(2)<=12);l,_=ndi.label(w,np.ones((3,3)));b=np.unique(np.r_[l[0],l[-1],l[:,0],l[:,-1]]);z[np.isin(l,b[b!=0])]=0;im=Image.composite(Image.fromarray(z),base,mask);im.save(out/f'{name}.png')
