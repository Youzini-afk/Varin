"""Fullframe static pixel protection for authored seated arm/laptop changes.
No skeleton, pose interpolation or animation crossfade. Mask is edit support only.
"""
from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
import numpy as np,json
from scipy import ndimage as ndi
r=Path(__file__).parent
base=Image.open(r.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA')
# Hand/sleeve/laptop region, manually inspected against source frames.
points=[(90,207),(210,188),(319,190),(370,224),(389,292),(375,367),(320,371),(286,335),(90,345),(90,287)]
mask=Image.new('L',(512,512));ImageDraw.Draw(mask).polygon(points,fill=255);mask=mask.filter(ImageFilter.GaussianBlur(1.2))
out=r/'canonical-static-v1';out.mkdir(exist_ok=True);mask.save(out/'authored-edit-mask.png')
names=['close-start','close70-white','close-half','closed','grip-lift-white','turn','hug']
for name in names:
 src=Image.open(r/'canonical-v1'/f'{name}.png').convert('RGBA')
 if 'white' in name:
  z=np.array(src);white=(z[:,:,:3].min(2)>=248)&(z[:,:,:3].max(2)-z[:,:,:3].min(2)<=12);lab,_=ndi.label(white,np.ones((3,3)));bord=np.unique(np.r_[lab[0],lab[-1],lab[:,0],lab[:,-1]]);bg=np.isin(lab,bord[bord!=0]);z[bg]=0;src=Image.fromarray(z)
 # The polygon lies inside the common body/sleeve envelope. Exterior alpha remains canonical.
 mixed=Image.composite(src,base,mask);mixed.save(out/f'{name}.png')
qa=Image.new('RGB',(512*4,512*2),(26,37,50))
for i,name in enumerate(names):
 b=Image.new('RGBA',(512,512),(26,37,50,255));b.alpha_composite(Image.open(out/f'{name}.png'));qa.paste(b.convert('RGB'),((i%4)*512,(i//4)*512))
qa.save(r/'reviews/seated-static-contact-sheet.png')
(out/'provenance.json').write_text(json.dumps({'source':'shared canonical geometry/alpha plus genuine authored action regions','points':points,'edgeFeatherPx':1.2,'notAnimationInterpolation':True,'status':'candidate; inspect mask boundaries and all moving sleeve coverage'},indent=2))
