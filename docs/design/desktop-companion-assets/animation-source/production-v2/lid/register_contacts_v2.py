from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,hashlib
r=Path(__file__).parent
sources={0:'contact-000-v2-raw.png',15:'contact-015-crop-placed.png',30:'contact-020-v1-raw.png',45:'contact-045-v1-raw.png',55:'contact-055-v1-raw.png',70:'contact-070-v1-raw.png',100:'contact-100-v1-raw.png'}
mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask);d.polygon([(222,210),(237,242),(235,324),(190,337),(136,348),(118,290),(130,250),(174,229)],fill=255);d.polygon([(286,255),(328,248),(369,284),(377,355),(341,367),(290,344),(247,314),(247,283)],fill=255);d.rectangle((226,273,259,319),fill=255);mask=mask.filter(ImageFilter.GaussianBlur(1));ma=np.array(mask);ma[ma<3]=0;mask=Image.fromarray(ma);mask.save(r/'frames/arms-motion-mask.png');meta=[];sheet=Image.new('RGB',(3584,512),'#263846')
for i,(angle,raw) in enumerate(sources.items()):
 original=Image.open(r/f'frames/fixture-{angle:03}.png').convert('RGBA');im=Image.open(r/'sources'/raw).convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);prop=Image.new('L',(512,512));pd=ImageDraw.Draw(prop)
 generated_quads={15:[(184,259),(289,269),(245,318),(138,309)],55:[(153,226),(260,234),(243,317),(139,310)],0:[(192,278),(298,288),(249,322),(142,310)],30:[(161,242),(273,256),(283,311),(174,313)],45:[(155,232),(271,239),(244,318),(136,310)],70:[(142,223),(248,230),(248,317),(144,309)],100:[(110,230),(219,237),(246,317),(137,308)]}
 pd.polygon(generated_quads[angle],fill=255);prop=prop.filter(ImageFilter.MaxFilter(3));local=np.minimum(np.array(mask),255-np.array(prop));out=Image.composite(im,original,Image.fromarray(local))
 # Right hand remains a common stabilizing contact from the original master; do not blend competing generated hands.
 master=Image.open(r.parent/'shared/upright-open-neutral-v2.png').convert('RGBA');rm=Image.new('L',(512,512));ImageDraw.Draw(rm).polygon([(252,264),(330,247),(376,285),(376,367),(297,358),(252,324)],fill=255);out=Image.composite(master,out,rm)
 # Recover fixed rigid prop pixels. Only drawn flesh may occlude its surface at actual contact.
 out.alpha_composite(Image.open(r/'frames/base-original-visible.png'));out.alpha_composite(Image.open(r/f'frames/lid-angle-{angle:03}.png'))
 arr=np.array(im);flesh=(arr[:,:,0]>arr[:,:,1]+8)&(arr[:,:,0]>arr[:,:,2]+9)&(arr[:,:,0]>175)&(arr[:,:,1]>110)
 region=Image.new('L',(512,512));dd=ImageDraw.Draw(region)
 box={15:(158,243,204,287),55:(140,207,181,258),0:(140,264,188,309),30:(145,225,197,275),45:(145,211,188,262),70:(128,204,176,258),100:(102,211,149,258)}[angle];dd.rectangle(box,fill=255);dd.rectangle((250,281,317,322),fill=255)
 foreground=flesh&(np.array(region)>0);foreground[:,250:]=False;fm=Image.fromarray((foreground*255).astype('uint8')).filter(ImageFilter.GaussianBlur(.35));out=Image.composite(im,out,fm)
 mr=np.array(master);rf=(mr[:,:,0]>mr[:,:,1]+8)&(mr[:,:,0]>mr[:,:,2]+9)&(mr[:,:,0]>175)&(mr[:,:,1]>110);rr=Image.new('L',(512,512));ImageDraw.Draw(rr).rectangle((255,281,313,316),fill=255);rf&=np.array(rr)>0;out=Image.composite(master,out,Image.fromarray((rf*255).astype('uint8')).filter(ImageFilter.GaussianBlur(.25)));out.save(r/f'frames/contact-{angle:03}-registered-v2.png')
 bg=Image.new('RGBA',(512,512),'#263846');bg.alpha_composite(out);sheet.paste(bg.convert('RGB'),(i*512,0));meta.append({'angleDegrees':angle,'raw':f'sources/{raw}','sourceSHA256':hashlib.sha256((r/'sources'/raw).read_bytes()).hexdigest(),'frame':f'frames/contact-{angle:03}-registered-v2.png','stage':'contact candidate needs visual review; rigid prop conserved except flesh occlusion'})
sheet.save(r/'registered-contact-review-v2.jpg',quality=95);(r/'contact-provenance-v2.json').write_text(json.dumps(meta,indent=2)+'\n')
