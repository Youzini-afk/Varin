from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
import numpy as np,json,hashlib
r=Path(__file__).resolve().parent.parent
base=Image.open(r/'frames/type-forward.png').convert('RGBA');raw=Image.open(r/'raw/type-forward-hands-b.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
m=Image.new('L',(512,512));d=ImageDraw.Draw(m)
d.polygon([(227,259),(243,259),(251,265),(253,281),(251,293),(234,293)],fill=255)
d.polygon([(254,270),(267,264),(283,264),(302,270),(310,282),(307,292),(289,294),(273,299),(253,297)],fill=255)
m=m.filter(ImageFilter.GaussianBlur(.5));ImageDraw.Draw(m).polygon([(109,228),(219,236),(242,313),(136,311)],fill=0)
out=Image.composite(raw,base,m);out.save(r/'frames/type-forward-hands-b.png');m.save(r/'masks/type-forward-hands-b.png')
b=np.array(base);o=np.array(out);mask=np.array(m)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
record={'pose':'type-forward-hands-b','rawSHA256':sha(r/'raw/type-forward-hands-b.png'),'reference':'frames/type-forward.png','referenceSHA256':sha(r/'frames/type-forward.png'),'sourceSHA256':sha(r/'frames/type-forward-hands-b.png'),'exactPrompt':'exactprompts/type-forward-hands-b.txt','outsideHandsMaskExact':bool(np.array_equal(b[mask==0],o[mask==0])),'entireHeadNeckShouldersTorsoAboveY259Exact':bool(np.array_equal(b[:258],o[:258])),'changedPixels':int(np.any(b!=o,axis=2).sum()),'status':'parent normal-speed review pending'}
(r/'typing-exposure-provenance.json').write_text(json.dumps(record,indent=2)+'\n');print(record)
qa=Image.new('RGB',(1024,512),'#263846')
for i,im in enumerate([base,out]):qa.paste(im,(i*512,0),im)
qa.save(r/'qa/typing-exposure-pair.jpg',quality=95)
