from pathlib import Path
from PIL import Image
import hashlib,json
r=Path(__file__).parent;raw=Image.open(r/'sources/stool-repair-v2-raw.png').convert('RGBA').resize((250,212),Image.Resampling.LANCZOS);plate=Image.new('RGBA',(512,512));plate.alpha_composite(raw,(200,300));plate.save(r/'frames/world-stool-candidate-v2.png')
qa=Image.new('RGB',(1536,512),'#263846')
for i,im in enumerate([plate,Image.alpha_composite(plate,Image.open(r/'frames/detach-first-v2.png').convert('RGBA')),Image.open(r/'frames/seated-secure-v2.png').convert('RGBA')]):
 b=Image.new('RGBA',(512,512),'#263846');b.alpha_composite(im);qa.paste(b.convert('RGB'),(512*i,0))
qa.save(r/'world-stool-review-v2.jpg',quality=96)
(r/'world-stool-v2-provenance.json').write_text(json.dumps({'stage':'clean plate candidate; needs contact geometry review','source':'sources/stool-repair-v2-raw.png','sourceSHA256':hashlib.sha256((r/'sources/stool-repair-v2-raw.png').read_bytes()).hexdigest(),'canvas':[512,512],'registration':'fixed full crop to250x212 at200,300; not bbox rescale','worldFixed':True,'seatContactApprox':[280,349]},indent=2)+'\n')
