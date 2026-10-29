from pathlib import Path
from PIL import Image,ImageDraw
import numpy as np
D=Path(__file__).parent;R=D.parent;donor=Image.open(R/'relocation/frames/secure-no-stool-clean-donor-v1.png').convert('RGBA');common=np.asarray(Image.open(R/'relocation/frames/canonical-stool-removal-mask-v5.png').convert('L')).astype(float);sheet=Image.new('RGB',(1500,360),'white');draw=ImageDraw.Draw(sheet)
for i,n in enumerate(['ask','offer','offer-mid','attend-corrected','listen-rest']):
 orig=Image.open(R/'question-permission/poses'/f'{n}.png').convert('RGBA');protect=np.asarray(Image.open(D/f'{n}-stool-exclusion.png')).astype(float);im=Image.composite(donor,orig,Image.fromarray((common*(1-protect/255)).astype('uint8')));im=Image.composite(Image.open(D/f'{n}-tail-clean-patch.png'),im,Image.open(D/f'{n}-tail-patch-mask.png'));im=im.crop((330,310,405,390)).resize((300,320));sheet.paste(im,(i*300,30),im);draw.text((i*300+5,5),n,fill='black')
sheet.save(D/'tail-final-composite-review.png')
