from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
import json,numpy as np
p=Path(__file__).parent; canonical=Image.open(p.parent.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA');source=Image.open(p/'closed-edit-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
mask=Image.new('L',(512,512));ImageDraw.Draw(mask).polygon([(95,215),(221,222),(248,273),(317,271),(348,298),(352,354),(280,343),(137,334),(122,313)],fill=255);mask=mask.filter(ImageFilter.GaussianBlur(.65));mask.save(p/'closed-redraw-mask.png');out=Image.composite(source,canonical,mask);out.save(p/'closed-canonical-candidate.png')
sh=Image.new('RGBA',(1024,512),(218,234,221,255));sh.alpha_composite(canonical,(0,0));sh.alpha_composite(out,(512,0));sh.convert('RGB').save(p/'closed-comparison.jpg')
a=np.array(out);b=np.array(canonical);m=np.array(mask);json.dump({'stage':'closed-endpoint-candidate','outsideMaskChangedPixels':int(np.any(a[m==0]!=b[m==0],axis=1).sum()),'unresolved':['Fixed hinge/base registration','Resting hand contact after exact prop registration','Boundary seam and native-size review'],'technique':'Newly generated concealed torso, sleeve, hands and lid; protected canonical face/body outside explicit edit mask'},open(p/'closed-qa.json','w'),indent=2)
