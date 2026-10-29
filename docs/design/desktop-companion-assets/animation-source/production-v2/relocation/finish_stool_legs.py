from pathlib import Path
from PIL import Image,ImageDraw
import json,hashlib
r=Path(__file__).parent;base=Image.open(r/'frames/world-stool-aligned-v3.png').convert('RGBA');raw=Image.open(r/'sources/stool-ground-plane-v4-raw.png').convert('RGBA').resize((250,212),Image.Resampling.LANCZOS)
# Register only the two newly drawn, previously hidden legs to a consistent projected ground plane.
# Preserve the approved cushion and visible right-front leg byte-for-byte.
regions=[((18,96,47,132),(218,396,247,448)),((72,107,94,123),(272,407,294,440))]
for src,dst in regions:
 x0,y0,x1,y1=dst;ImageDraw.Draw(base).rectangle((x0,y0,x1-1,y1-1),fill=(0,0,0,0));base.alpha_composite(raw.crop(src).resize((x1-x0,y1-y0),Image.Resampling.LANCZOS),(x0,y0))
base.save(r/'frames/world-stool-grounded-v4.png')
qa=Image.new('RGB',(1024,512),'#263846')
for i,im in enumerate([Image.open(r/'frames/world-stool-aligned-v3.png'),base]):
 bg=Image.new('RGBA',(512,512),'#263846');bg.alpha_composite(im);qa.paste(bg.convert('RGB'),(i*512,0))
qa.save(r/'world-stool-ground-review-v4.jpg',quality=97)
(r/'world-stool-ground-v4.json').write_text(json.dumps({'stage':'hidden-leg perspective repair candidate','source':'sources/stool-ground-plane-v4-raw.png','sourceSHA256':hashlib.sha256((r/'sources/stool-ground-plane-v4-raw.png').read_bytes()).hexdigest(),'base':'frames/world-stool-aligned-v3.png','sourceCropAndWorldPlacement':regions,'preserved':'all cushion and original visible right leg; character untouched','footContacts':[[231,448],[283,440],[404,473]]},indent=2)+'\n')
