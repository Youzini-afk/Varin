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
arm=[(246,274),(273,267),(297,248),(306,206),(337,221),(353,264),(374,316),(354,356),(310,350),(292,335),(257,340),(246,324)]
if __name__=='__main__':register('rest-settled-v2','references/closed-rest-rigid-v2.png',[arm],erase=[[(291,342),(320,342),(320,387),(291,387)]])
head=[(105,0),(405,0),(419,192),(390,225),(350,240),(312,221),(285,205),(225,209),(190,225),(118,226)]
if __name__=='__main__':
 register('rest-middle-v1','references/closed-rest-rigid-v2.png',[arm],erase=[[(291,342),(320,342),(320,387),(291,387)]])
 register('drowsy-middle-v1','frames/rest-settled-v2.png',[head])
 qa=Image.new('RGB',(1600,430),'#e9eef2');d=ImageDraw.Draw(qa)
 for i,(folder,n) in enumerate([('references','closed-rest-rigid-v2'),('frames','rest-middle-v1'),('frames','rest-settled-v2'),('frames','drowsy-middle-v1')]):
  im=Image.open(R/folder/(n+'.png'));b=Image.new('RGBA',(512,512),'#e9eef2');b.alpha_composite(im);qa.paste(b.convert('RGB').resize((400,400)),(i*400,0));d.text((i*400+5,408),n,fill='#34495e')
 qa.save(R/'qa/first-rest-chain.jpg',quality=95)
upper=[(105,0),(405,0),(420,220),(380,265),(344,280),(304,267),(222,271),(174,260),(118,226)]
if __name__=='__main__':
 register('doze-v1','frames/rest-settled-v2.png',[head])
 register('hover-attend-v1','references/closed-rest-rigid-v2.png',[upper])
yawn_arm=[(166,178),(228,172),(269,157),(277,193),(248,226),(241,274),(228,296),(173,296),(160,253)]
if __name__=='__main__':
 register('hover-middle-v1','references/closed-rest-rigid-v2.png',[upper])
 register('wake-middle-v1','frames/rest-settled-v2.png',[head])
 register('yawn-cover-v1','references/closed-rest-rigid-v2.png',[head,yawn_arm])
if __name__=='__main__':
 register('yawn-lift-v1','references/closed-rest-rigid-v2.png',[head,yawn_arm])
 register('yawn-near-v1','references/closed-rest-rigid-v2.png',[head,yawn_arm])
 register('wake-alert-v1','frames/rest-settled-v2.png',[upper])
 register('yawn-hand-release-v1','references/closed-rest-rigid-v2.png',[[(136,239),(201,237),(229,255),(228,296),(174,308),(139,306)]])
 register('tap-response-v1','frames/hover-attend-v1.png',[[(198,108),(322,106),(325,174),(288,191),(231,188),(201,166)]])
