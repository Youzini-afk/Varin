from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np
r=Path(__file__).parent;o=r/'closed-handoff-v1';o.mkdir(exist_ok=True)
base=Image.open(r.parent/'seated-work/canonical-lid-v1/closed-canonical-candidate.png').convert('RGBA')
src=Image.open(r/'source/canonical-closed-handoff-mid-v1.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
# Only actually drawn forearms/hands/computer area changes, preserve shared seated support and identity.
m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([(167,258),(231,254),(254,267),(310,264),(350,281),(358,342),(322,359),(296,331),(137,335),(137,299)],fill=255);m=m.filter(ImageFilter.GaussianBlur(.8));im=Image.composite(src,base,m);im.save(o/'near-settled.png');base.save(o/'shared-closed.png');b=Image.new('RGBA',(512,512),(26,37,50,255));b.alpha_composite(im);b.convert('RGB').save(o/'near-settled-dark.jpg')
