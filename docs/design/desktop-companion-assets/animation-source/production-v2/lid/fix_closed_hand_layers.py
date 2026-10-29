from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import hashlib,json
r=Path(__file__).parent
source=Image.open(r.parent/'shared/closed-neutral-v1.png').convert('RGBA');base=Image.open(r/'frames/closed-rest-rigid-v1.png').convert('RGBA')
# Whole authored hand silhouettes including outlines, nails and shadows. Never a skin-color key.
polys=[[(177,286),(179,280),(186,275),(193,271),(202,271),(208,275),(214,279),(221,282),(222,285),(218,287),(213,285),(214,290),(212,294),(208,296),(205,294),(204,297),(200,297),(198,295),(195,297),(191,294),(189,296),(185,295),(181,291)],[(260,300),(261,292),(266,285),(274,281),(286,281),(294,284),(301,289),(306,299),(306,301),(298,301),(291,299),(286,299),(279,304),(274,305),(272,302),(269,305),(265,304),(263,302),(260,302)]]
m=Image.new('L',(2048,2048));d=ImageDraw.Draw(m)
for poly in polys:d.polygon([(x*4,y*4) for x,y in poly],fill=255)
m=m.resize((512,512),Image.Resampling.LANCZOS);out=Image.composite(source,base,m);out.save(r/'frames/closed-rest-rigid-v2.png');m.save(r/'frames/closed-rest-hand-silhouette-mask-v2.png')
qa=Image.new('RGB',(1024,896),'#263846')
for i,im in enumerate([base,out]):
 b=Image.new('RGBA',(512,512),'#263846');b.alpha_composite(im);c=b.crop((165,255,325,325)).resize((1024,448));qa.paste(c.convert('RGB'),(0,i*448))
qa.save(r/'closed-hand-layer-fix-review.jpg',quality=98)
(r/'closed-rest-v2-provenance.json').write_text(json.dumps({'source':'../shared/closed-neutral-v1.png','previous':'frames/closed-rest-rigid-v1.png','output':'frames/closed-rest-rigid-v2.png','sha256':hashlib.sha256((r/'frames/closed-rest-rigid-v2.png').read_bytes()).hexdigest(),'method':'whole authored hand contour mattes preserving all outline/shadow pixels; no skin-color key','mask':'frames/closed-rest-hand-silhouette-mask-v2.png'},indent=2)+'\n')
