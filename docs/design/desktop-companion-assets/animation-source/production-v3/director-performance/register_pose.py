from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,hashlib
from scipy import ndimage as nd
R=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def clean(raw):
 a=np.array(raw);rgb=a[:,:,:3].astype(float);alpha=a[:,:,3].astype(float)/255;labels,n=nd.label(alpha>.02,np.ones((3,3)));sz=np.bincount(labels.ravel());alpha[(sz[labels]<28)&(labels>0)]=0;fg=alpha>.02;dst=nd.distance_transform_edt(fg);core=(dst>3)&(alpha>.85);_,near=nd.distance_transform_edt(~core,return_indices=True);ref=rgb[near[0],near[1]];band=fg&(dst<=3);bad=band&((rgb.max(2)-rgb.min(2))>95);rgb[bad]=ref[bad];alpha[bad]*=.65;white=band&(rgb.min(2)>225)&((rgb-ref).mean(2)>24);den=((255-ref)**2).sum(2);est=np.divide(((255-rgb)*(255-ref)).sum(2),den,out=np.ones_like(den),where=den>50);alpha[white]*=np.clip(est[white],0,1);rgb[white]=ref[white];o=np.dstack([rgb.clip(0,255).astype('uint8'),(alpha*255).round().astype('uint8')]);o[o[:,:,3]==0]=0;return Image.fromarray(o)
def register(name,source,polygons,erase=[]):
 base=Image.open(R/source).convert('RGBA');raw=Image.open(R/'raw'/f'{name}.png').convert('RGBA');im=clean(raw).resize((512,512),Image.Resampling.LANCZOS);m=Image.new('L',(512,512));d=ImageDraw.Draw(m)
 for poly in polygons:d.polygon(poly,fill=255)
 for poly in erase:d.polygon(poly,fill=0)
 m=m.filter(ImageFilter.GaussianBlur(1.1));a=np.array(m);a[a<3]=0;m=Image.fromarray(a);out=Image.composite(im,base,m);out.save(R/'frames'/f'{name}.png');m.save(R/'masks'/f'{name}.png');im.save(R/'frames'/f'{name}-normalized-reference.png')
 info={'status':'candidate','source':source,'sourceSHA256':sha(R/source),'raw':f'raw/{name}.png','rawSHA256':sha(R/'raw'/f'{name}.png'),'prompt':f'prompts/{name}.txt','output':f'frames/{name}.png','sha256':sha(R/'frames'/f'{name}.png'),'mask':f'masks/{name}.png','canvas':[512,512],'method':'full square viewport resize; generated edge cleanup; authored movement-region registration only, no head rotation, no body rig','outsideMaskExact':bool(np.array_equal(np.array(out)[a==0],np.array(base)[a==0]))}
 (R/'frames'/f'{name}-provenance.json').write_text(json.dumps(info,indent=2)+'\n');return out

head_chest=[(105,0),(420,0),(425,220),(392,265),(344,280),(310,270),(238,270),(220,230),(115,230)]
gather_arm=[(309,200),(365,202),(388,215),(455,213),(467,264),(427,285),(408,354),(352,369),(311,334),(246,323),(244,277),(286,270)]
if __name__=='__main__':
 register('listen-lean-v2','references/listen-rest.png',[head_chest])
 register('gather-out-v2','references/open-user.png',[head_chest,gather_arm])
if __name__=='__main__':
 register('gather-in-v1','frames/gather-out-v2.png',[gather_arm,[(244,235),(320,229),(350,267),(321,325),(244,323)]])
 # Reuse an already genuinely authored intermediate yaw, not synthetic rotation.
 base=Image.open(R/'references/listen-rest.png').convert('RGBA'); donor=Image.open(R/'references/search-right-middle.png').convert('RGBA')
 m=Image.new('L',(512,512));d=ImageDraw.Draw(m);d.polygon([(105,0),(405,0),(415,194),(355,231),(309,217),(283,199),(225,209),(190,225),(118,226)],fill=255);m=m.filter(ImageFilter.GaussianBlur(1.1));a=np.array(m);a[a<3]=0;m=Image.fromarray(a);out=Image.composite(donor,base,m);out.save(R/'frames/listen-turn-reuse-v2.png');m.save(R/'masks/listen-turn-reuse-v2.png')
 (R/'frames/listen-turn-reuse-v2-provenance.json').write_text(json.dumps({'source':'references/search-right-middle.png','sourceSHA256':sha(R/'references/search-right-middle.png'),'base':'references/listen-rest.png','baseSHA256':sha(R/'references/listen-rest.png'),'output':'frames/listen-turn-reuse-v2.png','sha256':sha(R/'frames/listen-turn-reuse-v2.png'),'mask':'masks/listen-turn-reuse-v2.png','method':'same 512 canvas actual authored intermediate head/neck registered; no scaling or rotation; not new generated head','outsideMaskExact':bool(np.array_equal(np.array(out)[a==0],np.array(base)[a==0]))},indent=2)+'\n')

if __name__=='__main__':
 register('listen-left-lean-v1','references/listen-rest.png',[head_chest])
 register('gather-user-v1','frames/gather-in-v1.png',[head_chest])
 base=Image.open(R/'references/listen-rest.png').convert('RGBA');donor=Image.open(R/'references/search-left-middle.png').convert('RGBA')
 m=Image.open(R/'masks/listen-turn-reuse-v2.png');a=np.array(m);out=Image.composite(donor,base,m);out.save(R/'frames/listen-left-turn-reuse-v1.png');m.save(R/'masks/listen-left-turn-reuse-v1.png')
 (R/'frames/listen-left-turn-reuse-v1-provenance.json').write_text(json.dumps({'source':'references/search-left-middle.png','sourceSHA256':sha(R/'references/search-left-middle.png'),'base':'references/listen-rest.png','baseSHA256':sha(R/'references/listen-rest.png'),'output':'frames/listen-left-turn-reuse-v1.png','sha256':sha(R/'frames/listen-left-turn-reuse-v1.png'),'mask':'masks/listen-left-turn-reuse-v1.png','method':'same 512 canvas actual authored intermediate head/neck registered; no scaling or rotation; not new generated head','outsideMaskExact':bool(np.array_equal(np.array(out)[a==0],np.array(base)[a==0]))},indent=2)+'\n')
if __name__=='__main__':
 register('gather-sweep-mid-v2','frames/gather-out-v2.png',[gather_arm,[(244,235),(320,229),(350,267),(321,325),(244,323)]])
 register('gather-release-v1','references/open-user.png',[[(244,239),(320,233),(356,262),(367,326),(353,364),(310,351),(270,330),(244,323)]])
