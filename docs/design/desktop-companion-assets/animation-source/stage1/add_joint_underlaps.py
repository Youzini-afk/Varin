from PIL import Image
from pathlib import Path
import numpy as np,json
from scipy import ndimage as ndi
D=Path(__file__).parent; src=np.array(Image.open(D/'canonical-seated-clean-v3.png'))
order=['hairBack','lowerBody','torso','upperArmL','upperArmR','forearmL','forearmR','handL','handR','head']
parts={n:np.array(Image.open(D/'layers-partition-v1'/f'{n}.png')) for n in order}; masks={n:p[:,:,3]>0 for n,p in parts.items()}
outdir=D/'layers-underlap-v1';outdir.mkdir(exist_ok=True); report=[]
for i,n in enumerate(order):
 p=parts[n].copy();m=masks[n]; higher=np.zeros(m.shape,bool)
 for q in order[i+1:]:higher|=masks[q]
 # Only add beneath frontward parts. No painted silhouette expansion.
 distance,idx=ndi.distance_transform_edt(~m,return_indices=True)
 extension=(distance<=24)&(~m)&higher&(src[:,:,3]>=250)
 # Sample from 3px inside semantic region to avoid its old occlusion contour ink.
 core=ndi.binary_erosion(m,iterations=3)
 if core.any():_,ci=ndi.distance_transform_edt(~core,return_indices=True)
 else:ci=idx
 p[extension,:3]=parts[n][ci[0][extension],ci[1][extension],:3];p[extension,3]=255
 Image.fromarray(p).save(outdir/f'{n}.png'); report.append({'node':n,'path':f'layers-underlap-v1/{n}.png','addedUnderlapPixels':int(extension.sum()),'underlapPx':24,'method':'nearest interior edge color extension under occluders only','fullHiddenSurfacePainting':False})
comp=Image.new('RGBA',(src.shape[1],src.shape[0]))
for n in order:comp.alpha_composite(Image.open(outdir/f'{n}.png'))
comp.save(D/'underlap-neutral-reconstruction.png');arr=np.array(comp); delta=np.abs(arr.astype(int)-src.astype(int));visible=src[:,:,3]>250
(D/'underlap-manifest.json').write_text(json.dumps({'status':'LIMITED_MOTION_UNDERLAP_DRAFT','canvas':[1382,1382],'source':'canonical-seated-clean-v3.png','zOrder':order,'assets':report,'opaqueNeutralMaxError':int(delta[visible].max()),'allNeutralMaxError':int(delta.max()),'limitations':['24px edge extensions are local hidden overlap only, not full newly painted limbs','No large motion approval; measure seam visibility in runtime','hairBack semantic remainder still needs detail refinement','Face layers separate pending QA']},indent=2)); print('opaque error',delta[visible].max(),'all',delta.max())
