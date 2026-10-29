from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json
r=Path(__file__).parent
raw=Image.open(r/'sources/stool-plate-v1-raw.png').convert('RGBA').resize((250,212),Image.Resampling.LANCZOS)
plate=Image.new('RGBA',(512,512));plate.alpha_composite(raw,(200,280))
original=Image.open(r/'closed-reference.png').convert('RGBA');mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask)
# Explicit visible original stool surfaces, exclude foreground sleeve, skirt, ribbon and hair.
d.polygon([(384,354),(402,354),(418,359),(425,367),(425,386),(420,397),(382,405),(373,391),(364,369),(383,364)],fill=255)
d.polygon([(383,409),(412,404),(413,466),(407,473),(393,474),(395,463)],fill=255)
mask=mask.filter(ImageFilter.GaussianBlur(.5));plate=Image.composite(original,plate,mask);plate.save(r/'frames/world-stool-candidate-v1.png');mask.save(r/'frames/world-stool-preserve-mask.png')
qa=Image.new('RGB',(1024,512),'#263846')
for i,im in enumerate([plate,Image.alpha_composite(plate,Image.open(r/'frames/detach-first-v1.png').convert('RGBA'))]):
 b=Image.new('RGBA',(512,512),'#263846');b.alpha_composite(im);qa.paste(b.convert('RGB'),(512*i,0))
qa.save(r/'world-stool-review-v1.jpg',quality=95)
(r/'world-stool-candidate.json').write_text(json.dumps({'stage':'candidate fill plate, needs seam and contact review','source':'sources/stool-plate-v1-raw.png','registration':'full source viewport to250x212 then place200,280; original visible seat/leg surfaces protected','preservedOriginal':'closed-reference.png','worldPosition':'same 512 viewport; never body-follow on drag','seatContactApprox':[280,349]},indent=2)+'\n')
