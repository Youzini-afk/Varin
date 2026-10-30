from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,hashlib
r=Path(__file__).parent;master=Image.open(r.parent/'shared/upright-open-neutral-v2.png').convert('RGBA');arm=Image.open(r/'frames/arms-motion-mask.png');manifest=[]
def place(n):
 im=Image.open(r/'sources'/n).convert('RGBA');out=master.copy();out.paste(im.resize((260,260),Image.Resampling.LANCZOS),(90,190));return out
for name,src in [('release-near','release-near-cleanup-v2-raw.png'),('release-low','release-low-crop-v2-raw.png')]:
 draw=place(src);out=Image.composite(draw,master,arm)
 # Protect prop geometry, then retain only actual generated left hand in foreground.
 out.alpha_composite(Image.open(r/'frames/base-original-visible.png'));out.alpha_composite(Image.open(r/'frames/lid-angle-100.png'))
 a=np.array(draw);skin=(a[:,:,0]>a[:,:,1]+8)&(a[:,:,0]>a[:,:,2]+9)&(a[:,:,0]>175)&(a[:,:,1]>110);reg=Image.new('L',(512,512));ImageDraw.Draw(reg).rectangle((150,201,254,314),fill=255);skin&=np.array(reg)>0;out=Image.composite(draw,out,Image.fromarray((skin*255).astype('uint8')).filter(ImageFilter.GaussianBlur(.25)))
 # Right arm is one unchanged supporting drawing, never two generated hands layered together.
 rm=Image.new('L',(512,512));ImageDraw.Draw(rm).polygon([(255,267),(331,248),(373,283),(374,365),(296,355),(254,324)],fill=255);out=Image.composite(master,out,rm)
 out.save(r/f'frames/{name}-registered-v1.png')
# Rest endpoint shares the actual fixed prop footprint; hands retain authored resting anatomy.
rest=Image.open(r.parent/'shared/closed-neutral-v1.png').convert('RGBA');out=Image.composite(rest,Image.open(r/'frames/fixture-000.png').convert('RGBA'),arm);out.alpha_composite(Image.open(r/'frames/base-original-visible.png'));out.alpha_composite(Image.open(r/'frames/lid-angle-000.png'));a=np.array(rest);skin=(a[:,:,0]>a[:,:,1]+8)&(a[:,:,0]>a[:,:,2]+9)&(a[:,:,0]>175)&(a[:,:,1]>110);m=Image.new('L',(512,512));ImageDraw.Draw(m).rectangle((170,266,316,311),fill=255);skin&=np.array(m)>0;out=Image.composite(rest,out,Image.fromarray((skin*255).astype('uint8')).filter(ImageFilter.GaussianBlur(.25)));out.save(r/'frames/closed-rest-rigid-v1.png');master.save(r/'frames/open-rest-v1.png')
seq=[('closed-rest-rigid-v1',650),('contact-000-registered-v2',100),('contact-015-registered-v2',80),('contact-030-registered-v2',75),('contact-045-registered-v2',70),('contact-055-registered-v2',65),('contact-070-registered-v2',65),('contact-100-registered-v2',120),('release-near-registered-v1',90),('release-low-registered-v1',90),('open-rest-v1',850)]
imgs=[]
for n,d in seq:
 p=r/f'frames/{n}.png';im=Image.open(p).convert('RGBA');bg=Image.new('RGBA',(512,512),'#263846');bg.alpha_composite(im);imgs.append(bg.convert('RGB'));manifest.append({'source':f'frames/{n}.png','durationMs':d,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
imgs[0].save(r/'opening-normal-speed-v1.webp',save_all=True,append_images=imgs[1:],duration=[d for _,d in seq],loop=0,lossless=True)
rev=imgs[::-1];rev[0].save(r/'closing-normal-speed-v1.webp',save_all=True,append_images=rev[1:],duration=[d for _,d in seq][::-1],loop=0,lossless=True)
sheet=Image.new('RGB',(2048,1536),'#263846')
for i,im in enumerate(imgs):sheet.paste(im,(i%4*512,i//4*512))
sheet.save(r/'opening-sequence-review-v1.jpg',quality=95)
(r/'sequence-source-v1.json').write_text(json.dumps({'stage':'motion candidate awaiting parent review; not accepted','canvas':[512,512],'method':'fixed-hinge original prop texture + actual authored hand/cuff drawings; unchanged identity regions protected','opening':manifest,'closing':manifest[::-1],'knownReviewFocus':['0-degree hand/lid occlusion','release-near to release-low hand travel','closed rest geometry compared to static initial anchor'],'rawRejected':['half-open-v1-raw.png: hinge moved','half-fixedhinge-v2-raw.png: residual hinge movement; hand reference only','contact-015-v1-raw.png: lid/hand raised too far, use crop-v2','release-low-v1-raw.png: wrong hand moved, use crop-v2']},indent=2)+'\n')
