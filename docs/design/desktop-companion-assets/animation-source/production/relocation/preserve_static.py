"""Restore unchanged canonical head; targeted chroma and alpha-fringe cleanup.
Not motion synthesis. Original authored frames retained under canonical-v1.
"""
from PIL import Image
import numpy as np
from scipy.ndimage import distance_transform_edt, grey_closing, gaussian_filter
from pathlib import Path
root=Path(__file__).parent
base=np.array(Image.open(root.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA'))
out=root/'canonical-registered-v1';out.mkdir(exist_ok=True)
for src in (root/'canonical-v1').glob('*.png'):
 a=np.array(Image.open(src).convert('RGBA'));rgb=a[:,:,:3].astype(float);alpha=a[:,:,3]
 # Remove isolated magenta fringing without changing normal warm skin or blue clothes.
 fringe=(rgb[:,:,0]>rgb[:,:,1]*1.35)&(rgb[:,:,2]>rgb[:,:,1]*1.35)&((rgb.max(2)-rgb.min(2))>60)
 bad=fringe|((alpha>0)&(alpha<230))
 good=(alpha>=230)&~fringe
 _,ind=distance_transform_edt(~good,return_indices=True)
 rgb[bad]=rgb[ind[0][bad],ind[1][bad]]
 if src.stem in ['airborne','lift-mid']:
  # Only highly saturated costume-blue pixels below the head are corrected.
  blue=(rgb[:,:,2]>rgb[:,:,0]*1.2)&(rgb[:,:,2]>rgb[:,:,1]*1.08)&((rgb[:,:,2]-rgb[:,:,0])>65)
  blue[:190]=False
  mean=rgb.mean(2,keepdims=True);muted=(mean+(rgb-mean)*.68)*.96
  rgb[blue]=muted[blue]
 a[:,:,:3]=np.clip(rgb,0,255).astype('uint8');a[alpha<=5]=0
 # Preserve alpha shape/fine strands; replace contaminated boundary colors with interior colors.
 dist=distance_transform_edt(a[:,:,3]>128)
 yy2,xx=np.indices((512,512))
 hair=(yy2>190)&((xx<205)|(xx>345))
 edge=hair&(dist<2.5)&(a[:,:,3]>0)
 inside=(dist>=3)&(a[:,:,3]>230)
 _,near=distance_transform_edt(~inside,return_indices=True)
 a[edge,:3]=a[near[0][edge],near[1][edge],:3]
 # Fill only subpixel matte pinholes and anti-alias edge; no alpha erosion.
 healed=gaussian_filter(grey_closing(a[:,:,3],size=(3,3)).astype(float),.4)
 a[hair,3]=np.round(healed[hair]).astype('uint8')
 # Head camera and angle unchanged across these closure/lift studies.
 # Exact replacement, not an animated dissolve or a head rotation.
 # Feather only the static patch boundary in premultiplied alpha; never across animation frames.
 yy=np.arange(512)[:,None,None];m=np.clip((190-yy)/6,0,1)
 af=a.astype(float)/255;bf=base.astype(float)/255
 aa=af[:,:,3:4];ba=bf[:,:,3:4];oa=ba*m+aa*(1-m)
 orgb=np.divide(bf[:,:,:3]*ba*m+af[:,:,:3]*aa*(1-m),oa,out=np.zeros_like(af[:,:,:3]),where=oa>0)
 a=np.round(np.concatenate([orgb,oa],axis=2)*255).astype('uint8')
 Image.fromarray(a).save(out/src.name)
