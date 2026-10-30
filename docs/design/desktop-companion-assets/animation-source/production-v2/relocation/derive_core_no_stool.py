from pathlib import Path
from PIL import Image
import numpy as np
r=Path(__file__).parent
Image.composite(Image.open(r/'frames/airborne-response-v1.png'),Image.open(r/'frames/detach-first-v2.png'),Image.open(r/'frames/airborne-response-mask.png')).save(r/'frames/airborne-response-v3.png')
mask=Image.open(r/'frames/stool-removal-mask-v3.png').convert('L');a=np.array(mask);a[:366,:385]=0;mask=Image.fromarray(a);mask.save(r/'frames/canonical-stool-removal-mask-v4.png');donor=Image.open(r/'frames/secure-no-stool-v3.png').convert('RGBA')
for name,path in [('closed-rest','../lid/frames/closed-rest-rigid-v2.png'),('lap-release-mid','frames/lap-release-mid-v1.png')]:
 out=Image.composite(donor,Image.open(r/path).convert('RGBA'),mask);out.save(r/f'frames/{name}-no-stool-v1.png')
