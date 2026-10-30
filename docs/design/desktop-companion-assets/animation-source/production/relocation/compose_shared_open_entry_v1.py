from pathlib import Path
from PIL import Image
r=Path(__file__).parent;o=r/'shared-entry-v1';o.mkdir(exist_ok=True);a=r.parent/'user-attention/drag-bridges-v1';base=Image.open(r.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA');support=Image.open(a/'permission-support-registered.png').convert('RGBA');arms=Image.open(a/'authored-arms-mask.png');donor=Image.open(r/'departure-bridge-v1/detach-protected-v2.png').convert('RGBA');mask=Image.open(r/'family-detach-v1/replacement-excluding-authored-arms.png')
for n,im in [('open-current',base),('open-supported',Image.composite(support,base,arms)),('closed-detached',Image.open(r/'canonical-static-v1/closed.png').convert('RGBA'))]:
 im=Image.composite(donor,im,mask);im.save(o/f'{n}.png');b=Image.new('RGBA',(512,512),(26,37,50,255));b.alpha_composite(im);b.convert('RGB').save(o/f'{n}-dark.jpg')
