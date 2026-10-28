from pathlib import Path
from PIL import Image, ImageDraw,ImageFilter
import numpy as np,json
from scipy import ndimage
r=Path(__file__).parent; out=r/'registered/attention-sequence-v1';out.mkdir(exist_ok=True)
base=Image.open(r/'sources/click-open-single-master-v1.png').convert('RGB')
mask=Image.open(r/'registered/attention-lift-v1/edit-region-mask.png').convert('L')
names=['click-open-single-master-v1','attention-eye-lead-single-v1','attention-lift-single-01-v1','attention-halfblink-single-v1','attention-closedblink-single-v1']
ims=[];rows=[]
for i,n in enumerate(names):
 raw=Image.open(r/'sources'/f'{n}.png').convert('RGB'); norm=raw.resize((512,512),Image.Resampling.LANCZOS)
 im=Image.composite(norm,base,mask) if i else base
 a=np.array(im);white=(a.min(2)>238)&((a.max(2)-a.min(2))<14);lab,c=ndimage.label(white,np.ones((3,3)));edge=np.unique(np.r_[lab[0],lab[-1],lab[:,0],lab[:,-1]]);edge=edge[edge!=0];alpha=np.where(np.isin(lab,edge),0,255).astype('uint8')
 Image.fromarray(np.dstack([a,alpha])).save(out/f'pose-{i:03}.png')
 ims.append(im);rows.append({'source':n+'.png','sourceSize':list(raw.size),'normalization':'full declared square viewport to512, never subject-bbox normalization','heldRegionPixelMatch':bool(np.array_equal(np.array(base)[np.array(mask)==0],a[np.array(mask)==0]))})
# Exposures are authored discrete poses, NO tween/flow/crossfade; second-half blink and return reuse adjacent drawn cels.
order=[(0,500),(1,80),(2,600),(3,50),(4,70),(3,70),(2,500),(1,90),(0,500)]
seq={'id':'attention-sequence-v1','family':'USER_ATTENTION','canvas':[512,512],'stage':'keyposes','loop':False,'warning':'Authored attention+blink candidate. Full-body held areas exact; only 5 unique drawings. Not accepted smooth complete family.','entryPose':'seated-open-gaze-screen','exitPose':'seated-open-gaze-screen','frames':[{'source':f'pose-{i:03}.png','durationMs':ms,'offset':[0,0]} for i,ms in order]}
(out/'sequence.json').write_text(json.dumps(seq,indent=2));(out/'provenance.json').write_text(json.dumps(rows,indent=2))
ims[0].save(out/'timing-review.gif',save_all=True,append_images=[ims[i] for i,ms in order[1:]],duration=[ms for i,ms in order],loop=0,disposal=2)
contact=Image.new('RGB',(512*5,512),'#f2f3f5')
for i,im in enumerate(ims):contact.paste(im,(512*i,0))
contact.save(out/'drawings-review.png')
print(out)
