from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json,hashlib
r=Path(__file__).parent;donor=Image.open(r/'frames/detach-first-v2.png').convert('RGBA');m=Image.open(r/'frames/lid-airborne-lower-mask-v2.png');entries=[];qa=Image.new('RGB',(1536,512),'#263846')
for angle in [0,15,30,45,55,70,100]:
 src=r.parent/f'lid/frames/contact-{angle:03}-registered-v3.png';orig=Image.open(src).convert('RGBA');out=Image.composite(donor,orig,m);p=r/f'frames/lid-{angle:03}-airborne-v2.png';out.save(p);entries.append({'angle':angle,'originalSeatedSource':f'../lid/frames/{src.name}','originalSeatedSHA256':hashlib.sha256(src.read_bytes()).hexdigest(),'source':str(p.relative_to(r)),'sourceSHA256':hashlib.sha256(p.read_bytes()).hexdigest(),'embeddedStool':False,'stage':'new same-family lower compositing candidate; support and cuff boundary peer pending'})
 if angle in [0,45,100]:
  i=[0,45,100].index(angle);bg=Image.new('RGBA',out.size,'#263846');bg.alpha_composite(out);qa.paste(bg.convert('RGB'),(512*i,0))
qa.save(r/'lid-airborne-review-v2.jpg',quality=96);(r/'lid-airborne-sources-v2.json').write_text(json.dumps({'mask':'frames/lid-airborne-lower-mask-v2.png','donor':'frames/detach-first-v2.png','method':'actual authored lower body, no bone rotation or root-only substitution; upper actual grip/lid angle unchanged','frames':entries},indent=2)+'\n')
