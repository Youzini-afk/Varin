from pathlib import Path
from PIL import Image
from scipy import ndimage as nd
import numpy as np,json,hashlib
R=Path(__file__).parent;p=R/'sources/airborne-settle-v1-raw.png';a=np.array(Image.open(p).convert('RGBA'));rgb=a[:,:,:3].astype(float);alpha=a[:,:,3].astype(float)/255
labels,n=nd.label(alpha>0.02,np.ones((3,3)));sizes=np.bincount(labels.ravel());remove=(sizes[labels]<28)&(labels>0);alpha[remove]=0
# Only the 3px generated edge band; preserve all opaque interior drawing.
fg=alpha>0.02;dist=nd.distance_transform_edt(fg);core=(dist>3)&(alpha>.85);_,near=nd.distance_transform_edt(~core,return_indices=True);ref=rgb[near[0],near[1]]
band=fg&(dist<=3);chroma=rgb.max(2)-rgb.min(2);bad=band&(chroma>95);rgb[bad]=ref[bad];alpha[bad]*=.65
# White matte contamination, not the pearl hair interior.
white=band&(rgb.min(2)>225)&((rgb-ref).mean(2)>24);den=((255-ref)**2).sum(2);est=np.divide(((255-rgb)*(255-ref)).sum(2),den,out=np.ones_like(den),where=den>50);alpha[white]*=np.clip(est[white],0,1);rgb[white]=ref[white]
out=np.dstack([rgb.clip(0,255).astype('uint8'),(alpha*255).round().astype('uint8')]);out[out[:,:,3]==0]=0

im=Image.fromarray(out).resize((512,512),Image.Resampling.LANCZOS)
master=Image.open(R/'frames/detach-first-v1.png').convert('RGBA')
from PIL import ImageDraw,ImageFilter
mask=Image.new('L',(512,512));ImageDraw.Draw(mask).polygon([(143,327),(302,329),(347,350),(409,461),(369,483),(321,470),(292,512),(105,512),(97,421),(129,366)],fill=255);mask=mask.filter(ImageFilter.GaussianBlur(1.3))
final=Image.composite(im,master,mask);final.save(R/'frames/airborne-response-v1.png');mask.save(R/'frames/airborne-response-mask.png')
qa=Image.new('RGB',(1024,512),'#263846')
for i,x in enumerate([master,final]):
 b=Image.new('RGBA',(512,512),'#263846');b.alpha_composite(x);qa.paste(b.convert('RGB'),(i*512,0))
qa.save(R/'airborne-response-review.jpg',quality=96)
(R/'airborne-response-provenance.json').write_text(json.dumps({'stage':'loose-leg airborne response peak candidate','sourceSHA256':hashlib.sha256(p.read_bytes()).hexdigest(),'outsideLowerMaskExact':True,'lowerMotion':'actual new drawing; not rigid deformation','source':'sources/airborne-settle-v1-raw.png','mask':'frames/airborne-response-mask.png'},indent=2)+'\n')
