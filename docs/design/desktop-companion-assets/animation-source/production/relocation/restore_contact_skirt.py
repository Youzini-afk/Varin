from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
import json
r=Path(__file__).parent
# Manually traced actual garment boundary from contact-skirt-original-detail.png.
points=[(330,347),(345,355),(356,378),(372,410),(387,436),(407,454),(396,465),(406,481),(357,476),(315,459),(310,430),(319,400)]
mask=Image.new('L',(512,512));ImageDraw.Draw(mask).polygon(points,fill=255);mask=mask.filter(ImageFilter.GaussianBlur(.45))
a=Image.open(r/'canonical-registered-v1/contact-no-stool-white-alpha.png').convert('RGBA');orig=Image.open(r/'canonical-v1/landing-contact-white.png').convert('RGBA')
out=Image.composite(orig,a,mask);out.save(r/'canonical-registered-v1/contact-skirt-restored-v3.png');mask.save(r/'reviews/contact-garment-preservation-mask.png')
b=Image.new('RGBA',(512,512),(26,37,50,255));b.alpha_composite(Image.open(r/'canonical-registered-v1/stool-world-candidate-v2.png'));b.alpha_composite(out);b.save(r/'reviews/contact-skirt-restored-world-v3.png')
(r/'reviews/contact-skirt-restoration.json').write_text(json.dumps({'source':'original authored contact drawing','mask':points,'method':'restore actual garment pixels selectively after model furniture removal erroneously removed skirt; no invented vector garment','status':'candidate trace requires review'},indent=2))
