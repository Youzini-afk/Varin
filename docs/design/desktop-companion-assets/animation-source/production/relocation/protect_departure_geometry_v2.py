from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
r=Path(__file__).parent;o=r/'departure-bridge-v1';base=Image.open(r/'canonical-static-v1/close-half.png').convert('RGBA');donor=Image.open(o/'detach.png').convert('RGBA')
m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([(330,330),(475,330),(511,511),(270,511),(270,458),(300,447),(310,398)],fill=255);ImageDraw.Draw(m).rectangle((186,425,216,482),fill=255);ImageDraw.Draw(m).rectangle((247,426,281,469),fill=255);m=m.filter(ImageFilter.GaussianBlur(.7));im=Image.composite(donor,base,m);im.save(o/'detach-protected-v2.png');m.save(o/'stool-replacement-mask-v2.png')
# Supply lower drawing in the shared viewport, never auto-fit bbox. Family arms/sleeves overlapping this region need their own occlusion masks.
l=Image.new('L',(512,512));ImageDraw.Draw(l).rectangle((0,332,511,511),fill=255);l.save(o/'lower-region-reference-mask.png');b=Image.new('RGBA',(512,512),(26,37,50,255));b.alpha_composite(im);b.convert('RGB').save(o/'detach-protected-v2-dark.jpg')
