from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json
from scipy import ndimage
r=Path(__file__).parent;out=r/'registered/permission-lift-v1';out.mkdir(exist_ok=True)
base=Image.open(r/'sources/click-open-single-master-v1.png').convert('RGB')
mask=Image.new('L',(512,512),0)
# Whole moving arm+shoulder+sweater/keyboard occlusion region. No masking beneath changing sleeve.
ImageDraw.Draw(mask).polygon([(309,181),(368,180),(399,225),(421,260),(421,367),(371,371),(307,347),(249,326),(239,285),(238,258),(274,237)],fill=255)
mask=mask.filter(ImageFilter.GaussianBlur(1.0));mask.save(out/'arm-occlusion-redraw-mask.png')
names=['click-open-single-master-v1','permission-lift10-single-v1','permission-lift30-single-v1','permission-lift60-single-v1','permission-lift80-single-v1','permission-endpoint-single-v1']
frames=[];ims=[];report=[]
headmask=Image.open(r/'registered/attention-lift-v1/edit-region-mask.png')
eyelead=Image.open(r/'sources/attention-eye-lead-single-v1.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS)
for i,n in enumerate(names):
 raw=Image.open(r/'sources'/f'{n}.png').convert('RGB');gen=raw.resize((512,512),Image.Resampling.LANCZOS)
 im=Image.composite(eyelead,base,headmask) if i else base
 if i>0:im=Image.composite(gen,im,mask)
 a=np.array(im);wh=(a.min(2)>238)&((a.max(2)-a.min(2))<14);lab,c=ndimage.label(wh,np.ones((3,3)));e=np.unique(np.r_[lab[0],lab[-1],lab[:,0],lab[:,-1]]);e=e[e!=0];alpha=np.where(np.isin(lab,e),0,255).astype('uint8');Image.fromarray(np.dstack([a,alpha])).save(out/f'pose-{i:03}.png');ims.append(im)
 frames.append({'source':f'pose-{i:03}.png','durationMs':[350,80,70,70,90,650][i],'offset':[0,0]})
 fixed=(np.array(mask)==0)&(np.array(headmask)==0)
 report.append({'source':n+'.png','sourceSize':list(raw.size),'fixedPixels':int(fixed.sum()),'fixedPixelsExact':bool(np.array_equal(a[fixed],np.array(base)[fixed]))})
seq={'id':'permission-lift-v1','family':'USER_ATTENTION','canvas':[512,512],'stage':'keyposes','loop':False,'entryPose':'seated-open-keyboard-contact','exitPose':'permission-palm-up','warning':'Authored hand lift + held whole character candidate; discrete drawings not accepted smooth final. Reprojection/occlusion edges require review. No grant semantics.','frames':frames}
(out/'sequence.json').write_text(json.dumps(seq,indent=2));(out/'provenance.json').write_text(json.dumps(report,indent=2))
ims[0].save(out/'timing-review.gif',save_all=True,append_images=ims[1:],duration=[f['durationMs'] for f in frames],loop=0,disposal=2)
c=Image.new('RGB',(1536,1024),'white')
for i,im in enumerate(ims):c.paste(im,((i%3)*512,(i//3)*512))
c.save(out/'drawings-review.png')
