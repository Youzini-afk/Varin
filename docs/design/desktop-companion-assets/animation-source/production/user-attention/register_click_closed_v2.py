from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json
from scipy import ndimage as nd
r=Path(__file__).parent;shared=r.parent/'shared';out=r/'registered/click-closed-v2';out.mkdir(exist_ok=True)
base=Image.open(r/'sources/closed-shared-reference-v1.png').convert('RGB');shared_rgba=np.asarray(Image.open(r.parent/'seated-work/canonical-lid-v1/closed-canonical-candidate.png').convert('RGBA'))
head=Image.open(r/'registered/attention-lift-v1/edit-region-mask.png').convert('L')
full=Image.new('L',(512,512),0);d=ImageDraw.Draw(full)
d.polygon([(103,0),(415,0),(430,170),(385,220),(349,250),(260,250),(235,215),(160,217),(105,210)],fill=255)
full=full.filter(ImageFilter.GaussianBlur(.7));full.save(out/'whole-upper-redraw-mask.png');arm=full
eye=Image.open(r/'sources/attention-eye-lead-single-v1.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS)
# Entry drawings, actual settle and attentive expression, separately authored return (not reversed lift).
items=[('closed-shared-reference-v1',280,'base'),('attention-eye-lead-single-v1',70,'eye'),('click-closed-notice-single-v1',190,'full'),('click-closed-halfblink-single-v1',55,'full'),('click-closed-fullblink-single-v1',85,'full'),('click-closed-halfblink-single-v1',65,'full'),('click-closed-notice-single-v1',220,'full'),('attention-eye-lead-single-v1',90,'eye'),('closed-shared-reference-v1',450,'base')]
frames=[];ims=[];proof=[]
for i,(name,duration,kind) in enumerate(items):
 raw=Image.open(r/'sources'/f'{name}.png').convert('RGB');gen=raw.resize((512,512),Image.Resampling.LANCZOS)
 if 'blink' in name:
  held=Image.open(r/'sources/click-closed-notice-single-v1.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS)
  em=Image.new('L',(512,512),0);ed=ImageDraw.Draw(em);ed.polygon([(211,143),(249,136),(253,153),(221,169),(211,161)],fill=255);ed.polygon([(274,115),(314,103),(319,122),(282,137)],fill=255);gen=Image.composite(gen,held,em);em.save(out/'blink-eyes-mask.png')
 if kind=='base':im=base;m=Image.new('L',(512,512),0)
 elif kind=='eye':
  em=Image.open(r/'registered/attention-sequence-v2/blink-redraw-region.png').convert('L');im=Image.composite(gen,base,em);m=em
 elif kind=='head':im=Image.composite(gen,base,head);m=head
 elif kind=='arm':
  im=Image.composite(eye,base,head);im=Image.composite(gen,im,arm);m=Image.fromarray(np.maximum(np.array(arm),np.array(head)))
 else:im=Image.composite(gen,base,full);m=full
 rgb=np.array(im).astype(float);changed=np.array(m)>0
 if not changed.any():rgba=shared_rgba.copy()
 else:
  white=(rgb.min(2)>=248)&((rgb.max(2)-rgb.min(2))<=12);lab,c=nd.label(white,np.ones((3,3)));edge=np.unique(np.r_[lab[0],lab[-1],lab[:,0],lab[:,-1]]);bg=np.isin(lab,edge[edge!=0]);bg|=(shared_rgba[:,:,3]==0)&white
  dist=nd.distance_transform_edt(~bg);core=dist>2;_,near=nd.distance_transform_edt(~core,return_indices=True);ref=rgb[near[0],near[1]];alpha=(~bg).astype(float);boundary=(dist>0)&(dist<=1.5);den=((255-ref)**2).sum(2);est=np.divide(((255-rgb)*(255-ref)).sum(2),den,out=np.ones_like(den),where=den>25);alpha[boundary]=np.clip(est[boundary],0,1);soft=boundary&(alpha>0)&(alpha<1);rgb[soft]=np.clip((rgb[soft]-255*(1-alpha[soft,None]))/alpha[soft,None],0,255);rgba=np.dstack([np.round(rgb).astype('uint8'),np.round(alpha*255).astype('uint8')]);rgba[~changed]=shared_rgba[~changed]
 imalpha=Image.fromarray(rgba);imalpha.save(out/f'pose-{i:03}.png')
 assert np.array_equal(rgba[~changed],shared_rgba[~changed])
 frames.append({'source':f'pose-{i:03}.png','durationMs':duration,'offset':[0,0]});proof.append({'sourceDrawing':name+'.png','region':kind,'protectedRgbaPixelsExact':int((~changed).sum())})
 bgim=Image.new('RGBA',(512,512),(25,29,36,255));bgim.alpha_composite(imalpha);ims.append(bgim.convert('RGB'))
seq={'id':'click-closed-v2','family':'USER_ATTENTION','canvas':[512,512],'stage':'keyposes','loop':False,'entryPose':'seated-closed-neutral-hands-on-lid','exitPose':'seated-closed-neutral-hands-on-lid','warning':'Closed-laptop gentle click response candidate. Shared closed hands/laptop held; head and upper shoulders drawn newly, blink restricted to new eye regions. No work, approval or completion semantics. Normal-speed review pending.','frames':frames}
(out/'sequence.json').write_text(json.dumps(seq,indent=2));(out/'provenance.json').write_text(json.dumps({'sharedAlpha':'c8d2a1bddb1e5a3707e081ff4419aa8c1bb5fc8eb5c9ac1152d69127a5d664a7','normalization':'fixed full viewport only','frames':proof},indent=2))
ims[0].save(out/'timing-review.gif',save_all=True,append_images=ims[1:],duration=[f['durationMs'] for f in frames],loop=0,disposal=2)
c=Image.new('RGB',(512*4,512*4),(25,29,36))
for i,im in enumerate(ims):c.paste(im,((i%4)*512,(i//4)*512))
c.save(out/'drawings-dark-review.png');print(out)
