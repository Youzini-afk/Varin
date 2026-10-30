from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json
from scipy import ndimage as nd
r=Path(__file__).parent;shared=r.parent/'shared';out=r/'registered/completion-wave-v1';out.mkdir(exist_ok=True)
base=Image.open(r/'sources/click-open-single-master-v1.png').convert('RGB');shared_rgba=np.asarray(Image.open(shared/'seated-open-canonical-alpha-v1.png').convert('RGBA'))
head=Image.open(r/'registered/attention-lift-v1/edit-region-mask.png').convert('L')
full=Image.new('L',(512,512),0);d=ImageDraw.Draw(full)
d.polygon([(103,0),(415,0),(430,170),(385,220),(311,251),(263,285),(230,290),(174,236),(105,220)],fill=255)
# Laptop lid is a held occluder, arm changes remain behind it; not a pasted moving cutout.
d.polygon([(101,225),(214,235),(242,309),(132,308)],fill=0)
full=full.filter(ImageFilter.GaussianBlur(.7));full.save(out/'whole-upper-redraw-mask.png');arm=full
eye=Image.open(r/'sources/attention-eye-lead-single-v1.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS)
# Entry drawings, actual settle and attentive expression, separately authored return (not reversed lift).
items=[('click-open-single-master-v1',300,'base'),('attention-eye-lead-single-v1',70,'head'),('wave-rise20-single-v1',70,'full'),('wave-rise50-single-v1',80,'full'),('wave-rise80-single-v1',85,'full'),('wave-endpoint-single-v1',170,'full'),('wave-sweep-single-v1',150,'full'),('wave-endpoint-single-v1',130,'full'),('wave-return-single-v1',110,'full'),('wave-rise20-single-v1',80,'full'),('click-open-single-master-v1',400,'base')]
frames=[];ims=[];proof=[]
for i,(name,duration,kind) in enumerate(items):
 raw=Image.open(r/'sources'/f'{name}.png').convert('RGB');gen=raw.resize((512,512),Image.Resampling.LANCZOS)
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
seq={'id':'completion-wave-v1','family':'USER_ATTENTION','canvas':[512,512],'stage':'keyposes','loop':False,'entryPose':'seated-open-neutral','exitPose':'seated-open-neutral','warning':'Authored completion wave candidate, not smooth-final approved. Completion performance only after actual success; never infer completion from animation. Neutral baseline gaze is not confirmed reading-screen.','frames':frames}
(out/'sequence.json').write_text(json.dumps(seq,indent=2));(out/'provenance.json').write_text(json.dumps({'sharedAlpha':'25eead33dd408600be423882ce7921a561b8fdb006642fe6f07b2f8580f65721','normalization':'fixed full viewport only','frames':proof},indent=2))
ims[0].save(out/'timing-review.gif',save_all=True,append_images=ims[1:],duration=[f['durationMs'] for f in frames],loop=0,disposal=2)
c=Image.new('RGB',(512*4,512*4),(25,29,36))
for i,im in enumerate(ims):c.paste(im,((i%4)*512,(i//4)*512))
c.save(out/'drawings-dark-review.png');print(out)
