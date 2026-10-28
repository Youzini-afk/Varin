from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,hashlib
from scipy import ndimage as nd
r=Path(__file__).parent;obs=r.parent/'observe-diagnose/canonical-chin-v1';out=r/'registered/query-understand-v1';out.mkdir(exist_ok=True)
base=Image.open(r.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA');arm=Image.open(obs/'editable-arm-mask.png').convert('L');head=Image.open(r/'registered/attention-lift-v1/edit-region-mask.png')
face=Image.new('L',(512,512),0);d=ImageDraw.Draw(face);d.polygon([(200,135),(274,101),(320,104),(329,143),(313,170),(277,190),(250,189),(228,177)],fill=255);face=face.filter(ImageFilter.GaussianBlur(1.0));face.save(out/'question-expression-region.png')
question=Image.open(r/'sources/query-attentive-face-single-v1.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS)
def white(im):
 b=Image.new('RGBA',im.size,'white');b.alpha_composite(im);return b.convert('RGB')
def matte_local(rgb,mask):
 a=np.array(rgb).astype(float);old=np.array(base);changed=np.array(mask)>0;wh=(a.min(2)>=248)&((a.max(2)-a.min(2))<=12);lab,c=nd.label(wh,np.ones((3,3)));edge=np.unique(np.r_[lab[0],lab[-1],lab[:,0],lab[:,-1]]);bg=np.isin(lab,edge[edge!=0]);bg|=(old[:,:,3]==0)&wh;alpha=(~bg).astype(float);dist=nd.distance_transform_edt(~bg);core=dist>2;_,near=nd.distance_transform_edt(~core,return_indices=True);ref=a[near[0],near[1]];den=((255-ref)**2).sum(2);v=np.divide(((255-a)*(255-ref)).sum(2),den,out=np.ones_like(den),where=den>25);border=(dist>0)&(dist<=1.5);alpha[border]=np.clip(v[border],0,1);soft=border&(alpha>0)&(alpha<1);a[soft]=np.clip((a[soft]-255*(1-alpha[soft,None]))/alpha[soft,None],0,255);res=np.dstack([np.round(a).astype('uint8'),np.round(alpha*255).astype('uint8')]);res[~changed]=old[~changed];return Image.fromarray(res)
# The shared source drawings were authored as hand release; entry traversal has separate exposures.
plan=[(0,300,False),(1,70,False),(2,75,True),(3,80,True),(4,90,True),(5,700,True),(4,80,True),(3,70,False),(2,70,False),(1,80,False),(0,120,False)]
frames=[];ims=[];inputs=[]
for i,(n,ms,asking) in enumerate(plan):
 path=obs/f'pose-{n:03}.png';p=Image.open(path).convert('RGBA');im=Image.composite(p,base,arm)
 if asking:
  rgb=Image.composite(question,white(im),face);a=np.array(im);q=np.array(rgb);sel=np.array(face)>0;a[sel,:3]=q[sel];im=Image.fromarray(a)
 im.save(out/f'pose-{i:03}.png');ims.append(im);frames.append({'source':f'pose-{i:03}.png','durationMs':ms,'offset':[0,0]});inputs.append({'source':str(path.relative_to(r.parent)),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
for name,ms in [('understand-nod-middle-single-v1',80),('understand-nod-bottom-single-v1',100),('understand-nod-middle-single-v1',100)]:
 gen=Image.open(r/'sources'/f'{name}.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS);rgb=Image.composite(gen,white(base),head);im=matte_local(rgb,head);i=len(ims);im.save(out/f'pose-{i:03}.png');ims.append(im);frames.append({'source':f'pose-{i:03}.png','durationMs':ms,'offset':[0,0]})
i=len(ims);base.save(out/f'pose-{i:03}.png');ims.append(base);frames.append({'source':f'pose-{i:03}.png','durationMs':400,'offset':[0,0]})
seq={'id':'query-understand-v1','family':'USER_ATTENTION','canvas':[512,512],'stage':'keyposes','loop':False,'entryPose':'seated-open-neutral-keyboard','exitPose':'seated-open-neutral-keyboard','warning':'Art candidate. Review displays answer arriving after question; runtime must wait for actual user answer. Reuses authored arm drawings with different entry/exit exposures, not claims of unique independent arms. Head nod only after arm leaves chin, no approval semantics.','frames':frames};(out/'sequence.json').write_text(json.dumps(seq,indent=2));(out/'dependencies.json').write_text(json.dumps({'sharedArmInputs':inputs,'owner':'produce_observation_rest_animation','frozenUpstreamDirectory':'observe-diagnose/canonical-chin-v1','newAuthoredFace':'sources/query-attentive-face-single-v1.png','newAuthoredNods':['sources/understand-nod-middle-single-v1.png','sources/understand-nod-bottom-single-v1.png']},indent=2))
views=[]
for im in ims:
 bg=Image.new('RGBA',(512,512),(25,29,36,255));bg.alpha_composite(im);views.append(bg.convert('RGB'))
views[0].save(out/'timing-review.gif',save_all=True,append_images=views[1:],duration=[f['durationMs'] for f in frames],loop=0,disposal=2)
c=Image.new('RGB',(2048,2048),(25,29,36))
for i,v in enumerate(views):c.paste(v,((i%4)*512,(i//4)*512))
c.save(out/'drawings-dark-review.png');print(out)
