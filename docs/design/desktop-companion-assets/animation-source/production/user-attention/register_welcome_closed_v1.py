from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json
from scipy import ndimage as nd
r=Path(__file__).parent;shared=r.parent/'shared';out=r/'registered/welcome-closed-v1';out.mkdir(exist_ok=True)
base=Image.open(r/'sources/closed-shared-reference-v1.png').convert('RGB');shared_rgba=np.asarray(Image.open(r.parent/'seated-work/canonical-lid-v1/closed-canonical-candidate.png').convert('RGBA'))
head=Image.open(r/'registered/attention-lift-v1/edit-region-mask.png').convert('L')
full=Image.new('L',(512,512),0);d=ImageDraw.Draw(full)
d.polygon([(103,0),(415,0),(430,170),(385,220),(326,270),(252,282),(245,296),(184,298),(170,280),(145,250),(130,210)],fill=255)
# Closed lid held except area newly uncovered by right hand: source redraw required there.
d.polygon([(144,303),(251,287),(307,302),(305,328),(145,334)],fill=0)
full=full.filter(ImageFilter.GaussianBlur(.7));full.save(out/'whole-upper-redraw-mask.png');arm=full
eye=Image.open(r/'sources/attention-eye-lead-single-v1.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS)
# Entry drawings, actual settle and attentive expression, separately authored return (not reversed lift).
items=[('closed-shared-reference-v1',320,'base'),('welcome-closed-peel-single-v1',75,'full'),('welcome-closed-rise10-single-v1',80,'full'),('welcome-closed-middle-single-v1',85,'full'),('welcome-closed-endpoint-single-v1',140,'full'),('welcome-closed-sweep-single-v1',170,'full'),('welcome-closed-endpoint-single-v1',130,'full'),('welcome-closed-return-single-v1',110,'full'),('welcome-closed-peel-single-v1',90,'full'),('closed-shared-reference-v1',450,'base')]
frames=[];ims=[];proof=[]
for i,(name,duration,kind) in enumerate(items):
 raw=Image.open(r/'sources'/f'{name}.png').convert('RGB');gen=raw.resize((512,512),Image.Resampling.LANCZOS)
 if 'return-single' in name:
  # Raw return drawing eyes drifted violet; hold approved blue-eye endpoint head, not raw face.
  kept=Image.open(r/'sources/welcome-closed-endpoint-single-v1.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS)
  face=Image.new('L',(512,512),0);ImageDraw.Draw(face).polygon([(211,133),(326,107),(342,164),(300,193),(237,193),(218,178)],fill=255);gen=Image.composite(kept,gen,face)
 if kind=='base':im=base;m=Image.new('L',(512,512),0)
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
seq={'id':'welcome-closed-v1','family':'USER_ATTENTION','canvas':[512,512],'stage':'keyposes','loop':False,'entryPose':'seated-closed-neutral-hands-on-lid','exitPose':'seated-closed-neutral-hands-on-lid','warning':'Authored closed-laptop welcome candidate, normal-speed quality pending. No success or approval semantics. Separate return hand drawing with retained blue-eye head cel because raw return eyes drifted.','frames':frames}
(out/'sequence.json').write_text(json.dumps(seq,indent=2));(out/'provenance.json').write_text(json.dumps({'sharedAlpha':'c8d2a1bddb1e5a3707e081ff4419aa8c1bb5fc8eb5c9ac1152d69127a5d664a7','normalization':'fixed full viewport only','frames':proof},indent=2))
ims[0].save(out/'timing-review.gif',save_all=True,append_images=ims[1:],duration=[f['durationMs'] for f in frames],loop=0,disposal=2)
c=Image.new('RGB',(512*4,512*4),(25,29,36))
for i,im in enumerate(ims):c.paste(im,((i%4)*512,(i//4)*512))
c.save(out/'drawings-dark-review.png');print(out)
