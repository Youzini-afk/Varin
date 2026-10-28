from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,hashlib
from scipy import ndimage as nd
p=Path(__file__).parent;r=p.parent
m=Image.new('L',(512,512));d=ImageDraw.Draw(m)
d.polygon([(89,204),(163,199),(180,222),(215,223),(212,194),(257,193),(261,264),(250,293),(222,303),(193,284),(150,282),(126,285),(94,280),(85,260)],fill=255)
d.polygon([(254,247),(327,247),(372,276),(401,353),(384,367),(341,357),(312,337),(281,326),(253,316)],fill=255)
m=m.filter(ImageFilter.GaussianBlur(.6));m.save(p/'authored-arms-mask.png')
protect=Image.new('L',(512,512));d=ImageDraw.Draw(protect);d.polygon([(103,226),(214,235),(237,310),(132,303)],fill=255);protect.save(p/'original-screen-protect-mask.png')
for name,basepath,raw in [('permission','registered/permission-cycle-v2/pose-010.png','permission-raw-v2.png'),('query','registered/query-understand-v1/pose-007.png','query-raw-v1.png')]+[(f'wait-{i:03}',f'registered/wait-relaxed-v1/pose-{i:03}.png','permission-raw-v2.png')for i in [0,1,2,5]]:
 base=Image.open(r/basepath).convert('RGBA');gen=Image.open(p/raw).convert('RGB').resize((512,512),Image.Resampling.LANCZOS)
 a=np.array(gen);white=(a.min(2)>248)&((a.max(2)-a.min(2))<10);labels,n=nd.label(white);edge=np.unique(np.r_[labels[0],labels[-1],labels[:,0],labels[:,-1]]);bg=np.isin(labels,edge[edge>0]);bg|=(np.array(base)[:,:,3]==0)&white
 rgba=Image.fromarray(np.dstack([a,(~bg).astype('uint8')*255]));out=Image.composite(rgba,base,m);out=Image.composite(base,out,protect);out.save(p/f'{name}-support-registered.png')
 bgim=Image.new('RGBA',(512,512),(30,34,42,255));bgim.alpha_composite(out);bgim.convert('RGB').save(p/f'{name}-support-dark.jpg')
 (p/f'{name}-registration.json').write_text(json.dumps({'raw':raw,'editTarget':basepath,'operation':'fixed full viewport resize to512, preserve outside authored arm mask; preserve original screen interior, no bbox normalization','rawSha256':hashlib.sha256((p/raw).read_bytes()).hexdigest(),'mask':'authored-arms-mask.png','protected':'original-screen-protect-mask.png','stage':'candidate-upper-contact; lower/no-stool still relocation owner'},indent=2))
