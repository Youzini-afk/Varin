from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np
r=Path(__file__).parent;reference=Image.open(r.parent/'shared/upright-open-neutral-v2.png').convert('RGBA');a=np.array(reference).astype('int16');poly=Image.new('L',(512,512));ImageDraw.Draw(poly).polygon([(357,325),(404,326),(432,355),(432,372),(385,372),(352,350)],fill=255)
# Locate the known visible brown seat wedge, not a generic background deletion.
# Replacement is a real image-generated same-pose clean plate including hidden hair/clothing.
visible=(np.array(poly)>0)&(a[:,:,0]<115)&(a[:,:,1]<108)&(a[:,:,2]<110)&(a[:,:,0]>=a[:,:,2]-5)&(a[:,:,3]>100)
extra=Image.fromarray((visible*255).astype('uint8')).filter(ImageFilter.MaxFilter(3));extra.save(r/'frames/stool-top-wedge-mask-v1.png');base=Image.open(r/'frames/canonical-stool-removal-mask-v4.png');m=Image.fromarray(np.maximum(np.array(base),np.array(extra)));m.save(r/'frames/canonical-stool-removal-mask-v5.png');donor=Image.open(r/'frames/secure-no-stool-clean-donor-v1.png')
for name,src in [('closed-rest','../lid/frames/closed-rest-rigid-v2.png'),('lap-release-mid','frames/lap-release-mid-v1.png'),('secure','frames/seated-secure-v2.png')]:
 Image.composite(donor,Image.open(r/src).convert('RGBA'),m).save(r/f'frames/{name}-no-stool-v4.png')
# Add only the revealed top seat wedge to airborne lid masks; retain actual cuffs/arms.
lower=Image.open(r/'frames/lid-airborne-lower-mask-v1.png');lower=Image.fromarray(np.maximum(np.array(lower),np.array(extra)));lower.save(r/'frames/lid-airborne-lower-mask-v2.png')

Image.composite(donor,Image.open(r/'frames/contact-no-stool-v2.png'),extra).save(r/'frames/contact-no-stool-v3.png')
