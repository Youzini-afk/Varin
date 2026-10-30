from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,shutil
from scipy import ndimage
r=Path(__file__).parent;old=r/'registered/attention-sequence-v1';out=r/'registered/attention-sequence-v2';out.mkdir(exist_ok=True)
for i in range(3):shutil.copy2(old/f'pose-{i:03}.png',out/f'pose-{i:03}.png')
head=Image.open(old/'pose-002.png').convert('RGBA');white=Image.new('RGBA',(512,512),'white');white.alpha_composite(head);head=white.convert('RGB')
mask=Image.new('L',(512,512),0);d=ImageDraw.Draw(mask)
d.polygon([(206,145),(238,132),(265,142),(265,163),(229,177),(202,165)],fill=255)
d.polygon([(274,116),(305,101),(326,109),(325,133),(298,145),(272,133)],fill=255)
mask=mask.filter(ImageFilter.GaussianBlur(1.0));mask.save(out/'blink-redraw-region.png')
for i,name in [(3,'attention-halfblink-single-v1'),(4,'attention-closedblink-single-v1')]:
 gen=Image.open(r/'sources'/f'{name}.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS)
 im=Image.composite(gen,head,mask);a=np.array(im);white=(a.min(2)>238)&((a.max(2)-a.min(2))<14);lab,c=ndimage.label(white,np.ones((3,3)));e=np.unique(np.r_[lab[0],lab[-1],lab[:,0],lab[:,-1]]);e=e[e!=0];alpha=np.where(np.isin(lab,e),0,255).astype('uint8');Image.fromarray(np.dstack([a,alpha])).save(out/f'pose-{i:03}.png')
seq=json.loads((old/'sequence.json').read_text());seq['id']='attention-sequence-v2';seq['warning']='Authored attention+blink candidate; v2 preserves lifted head outside authored eyelid redraw regions. Not accepted smooth fullfamily animation.';(out/'sequence.json').write_text(json.dumps(seq,indent=2))
ims=[]
for i in range(5):
 p=Image.open(out/f'pose-{i:03}.png');b=Image.new('RGBA',(512,512),'white');b.alpha_composite(p);ims.append(b.convert('RGB'))
ims[0].save(out/'timing-review.gif',save_all=True,append_images=[ims[int(f['source'][5:8])] for f in seq['frames'][1:]],duration=[f['durationMs'] for f in seq['frames']],loop=0,disposal=2)
c=Image.new('RGB',(2560,512),'white')
for i,im in enumerate(ims):c.paste(im,(512*i,0))
c.save(out/'drawings-review.png')
(out/'provenance.json').write_text(json.dumps({'technique':'hand-authored/generated eyelid cels assembled into full raster frames; no geometric transform animation','parent':'attention-sequence-v1','purpose':'eliminate unintended wholehead redraw shimmer duringblink','mask':'blink-redraw-region.png','status':'visual-review-candidate'},indent=2))
