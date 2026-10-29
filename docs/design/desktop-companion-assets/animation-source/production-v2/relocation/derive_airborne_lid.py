from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json,hashlib
r=Path(__file__).parent;donor=Image.open(r/'frames/detach-first-v2.png').convert('RGBA');m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([(181,329),(269,329),(295,339),(296,367),(512,367),(512,512),(0,512),(0,355),(170,355),(170,337)],fill=255);m=m.filter(ImageFilter.GaussianBlur(.8));m.save(r/'frames/lid-airborne-lower-mask-v1.png');entries=[];qa=Image.new('RGB',(1536,512),'#263846')
for angle in [0,15,30,45,55,70,100]:
 src=r.parent/f'lid/frames/contact-{angle:03}-registered-v3.png';orig=Image.open(src).convert('RGBA');out=Image.composite(donor,orig,m);p=r/f'frames/lid-{angle:03}-airborne-v1.png';out.save(p);entries.append({'angle':angle,'originalSeatedSource':f'../lid/frames/{src.name}','originalSeatedSHA256':hashlib.sha256(src.read_bytes()).hexdigest(),'source':str(p.relative_to(r)),'sourceSHA256':hashlib.sha256(p.read_bytes()).hexdigest(),'embeddedStool':False,'stage':'new same-family lower compositing candidate; support and cuff boundary peer pending'})
 if angle in [0,45,100]:
  i=[0,45,100].index(angle);bg=Image.new('RGBA',out.size,'#263846');bg.alpha_composite(out);qa.paste(bg.convert('RGB'),(512*i,0))
qa.save(r/'lid-airborne-review-v1.jpg',quality=96);(r/'lid-airborne-sources-v1.json').write_text(json.dumps({'mask':'frames/lid-airborne-lower-mask-v1.png','donor':'frames/detach-first-v2.png','method':'actual authored lower body, no bone rotation or root-only substitution; upper actual grip/lid angle unchanged','frames':entries},indent=2)+'\n')
