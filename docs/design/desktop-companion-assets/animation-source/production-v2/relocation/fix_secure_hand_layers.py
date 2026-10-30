from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
from scipy.spatial import ConvexHull
from scipy import ndimage as nd
import numpy as np
r=Path(__file__).parent;raw=Image.open(r/'sources/seated-secure-v1-raw.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);out=Image.open(r/'frames/seated-secure-v1.png').convert('RGBA');a=np.array(raw).astype('int16')
for box in [(141,278,184,331),(270,286,323,333)]:
 x0,y0,x1,y1=box;b=a[y0:y1,x0:x1];s=(b[:,:,0]>b[:,:,1]+8)&(b[:,:,0]>b[:,:,2]+9)&(b[:,:,0]>175)&(b[:,:,1]>110);lab,n=nd.label(s);sz=np.bincount(lab.ravel());sz[0]=0;ys,xs=np.where(nd.binary_dilation(lab==sz.argmax(),iterations=2));pts=np.column_stack([xs+x0,ys+y0]);h=ConvexHull(pts);m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([tuple(x) for x in pts[h.vertices]],fill=255);out=Image.composite(raw,out,m.filter(ImageFilter.GaussianBlur(.25)))
out.save(r/'frames/seated-secure-v2.png')
for n,mask in [('detach-first','detach-first-mask'),('airborne-response','airborne-response-mask')]:
 old=Image.open(r/f'frames/{n}-v1.png').convert('RGBA');m=Image.open(r/f'frames/{mask}.png');frame=Image.composite(old,out,m);frame.save(r/f'frames/{n}-v2.png')
