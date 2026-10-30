from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np
from scipy import ndimage as nd
p=Path(__file__).parent
m=Image.new('L',(512,512));d=ImageDraw.Draw(m);d.polygon([(88,202),(185,199),(212,204),(259,193),(261,264),(250,293),(218,303),(193,284),(150,282),(126,285),(94,280),(85,260)],fill=255);m=m.filter(ImageFilter.GaussianBlur(.5));m.save(p/'mid-reach-edit-mask.png')
pr=Image.new('L',(512,512));ImageDraw.Draw(pr).polygon([(108,238),(217,245),(237,310),(132,303)],fill=255)
gen=Image.open(p/'mid-reach-raw-v1.png').convert('RGB').resize((512,512),Image.Resampling.LANCZOS);a=np.array(gen);wh=(a.min(2)>248)&((a.max(2)-a.min(2))<10);lab,n=nd.label(wh);ed=np.unique(np.r_[lab[0],lab[-1],lab[:,0],lab[:,-1]]);bg=np.isin(lab,ed[ed>0])
for name in ['permission','query','wait-000','wait-001','wait-002','wait-005']:
 base=Image.open(p/f'{name}-support-registered.png').convert('RGBA');b=bg|((np.array(base)[:,:,3]==0)&wh);g=Image.fromarray(np.dstack([a,(~b).astype('uint8')*255]));out=Image.composite(g,base,m);out=Image.composite(base,out,pr);out.save(p/f'{name}-mid-reach.png')
 bgim=Image.new('RGBA',(512,512),(25,29,36));bgim.alpha_composite(out);bgim.convert('RGB').save(p/f'{name}-mid-reach-dark.jpg')
