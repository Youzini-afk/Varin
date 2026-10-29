from pathlib import Path
from PIL import Image
import json,hashlib
r=Path(__file__).parent;donor=Image.open(r/'frames/contact-no-stool-v3.png').convert('RGBA');mask=Image.open(r/'frames/lid-airborne-lower-mask-v2.png');j=json.loads((r/'lid-airborne-sources-v2.json').read_text())
for f in j['frames']:
 src=r/f['originalSeatedSource'];out=Image.composite(donor,Image.open(src).convert('RGBA'),mask);p=r/f"frames/lid-{f['angle']:03}-contact-no-stool-v1.png";out.save(p);f['contactNoStoolSource']=str(p.relative_to(r));f['contactNoStoolSHA256']=hashlib.sha256(p.read_bytes()).hexdigest();f['contactEmbeddedStool']=False;f['releaseSupport']='world stool fades in during descent; contactNoStoolSource then atomically originalSeatedSource with world hidden; preserve current lid angle'
j['stage']='airborne and landing contact lower composites; finite peer pending; no runtime route compiler here';(r/'lid-airborne-contact-sources-v3.json').write_text(json.dumps(j,indent=2)+'\n')
qa=Image.new('RGB',(1536,512),'#263846')
for i,a in enumerate([0,45,100]):
 im=Image.open(r/f'frames/lid-{a:03}-contact-no-stool-v1.png');bg=Image.new('RGBA',im.size,'#263846');bg.alpha_composite(im);qa.paste(bg.convert('RGB'),(i*512,0))
qa.save(r/'lid-contact-no-stool-review-v1.jpg',quality=96)
