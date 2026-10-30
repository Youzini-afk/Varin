from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
from scipy.spatial import ConvexHull
from scipy import ndimage as nd
import numpy as np,json,hashlib
r=Path(__file__).parent;master=Image.open(r.parent/'lid/frames/closed-rest-rigid-v2.png').convert('RGBA');raw=Image.open(r/'sources/lap-release-mid-v1-raw.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);m=Image.open(r/'frames/seated-secure-arms-mask.png');out=Image.composite(raw,master,m)
source=np.array([[191,281],[299,290],[245,316],[137,307]],float);target=np.array([[192,282],[300,292],[254,317],[146,306]],float)
A=[];b=[]
for (x,y),(u,v) in zip(target,source):A.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]);b.extend([u,v])
co=np.linalg.solve(A,b)
for n in ['base-original-visible.png','lid-angle-000.png']:out.alpha_composite(Image.open(r.parent/'lid/frames'/n).convert('RGBA').transform((512,512),Image.Transform.PERSPECTIVE,tuple(co),Image.Resampling.BICUBIC))
a=np.array(raw).astype('int16')
for box in [(166,271,215,309),(270,283,320,326)]:
 x0,y0,x1,y1=box;b=a[y0:y1,x0:x1];s=(b[:,:,0]>b[:,:,1]+8)&(b[:,:,0]>b[:,:,2]+9)&(b[:,:,0]>175)&(b[:,:,1]>110);lab,n=nd.label(s);sz=np.bincount(lab.ravel());sz[0]=0;ys,xs=np.where(nd.binary_dilation(lab==sz.argmax(),iterations=2));pts=np.column_stack([xs+x0,ys+y0]);h=ConvexHull(pts);m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([tuple(x) for x in pts[h.vertices]],fill=255);out=Image.composite(raw,out,m.filter(ImageFilter.GaussianBlur(.25)))
out.save(r/'frames/lap-release-mid-v1.png')
(r/'lap-release-provenance.json').write_text(json.dumps({'source':'sources/lap-release-mid-v1-raw.png','sourceSHA256':hashlib.sha256((r/'sources/lap-release-mid-v1-raw.png').read_bytes()).hexdigest(),'propSourceQuad':source.tolist(),'propTargetQuad':target.tolist(),'handMatte':'whole continuous hand contour'},indent=2)+'\n')
