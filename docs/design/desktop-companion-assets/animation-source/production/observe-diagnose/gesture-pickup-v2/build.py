from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter,ImageChops
import numpy as np
from scipy.ndimage import label
P=Path(__file__).resolve().parent;R=P.parent.parent
import shutil
S=P/'../gesture-pickup-v1'
for n in ['near-support-source.png','far-screen-grip-source.png','far-pregrip-source.png','far-early-source.png','closed-near-support-source.png','near-support-mask.png']:shutil.copyfile(S/n,P/n)
base=Image.open(P/'../canonical-chin-v2/pose-005.png').convert('RGBA')
nearMask=Image.new('L',(512,512));ImageDraw.Draw(nearMask).polygon([(254,277),(308,273),(330,285),(339,303),(335,324),(307,330),(263,325),(247,312)],fill=255);nearMask=nearMask.filter(ImageFilter.GaussianBlur(.7));nearMask.save(P/'near-support-mask.png')
near=Image.open(P/'near-support-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
def rgba(path):
 im=Image.open(path)
 if im.mode=='RGB':
  a=np.array(im);white=np.min(a,axis=2)>246;labs,n=label(white);border=set(labs[0])|set(labs[-1])|set(labs[:,0])|set(labs[:,-1]);border.discard(0);alpha=np.where(np.isin(labs,list(border)),0,255).astype('uint8');im=im.convert('RGBA');im.putalpha(Image.fromarray(alpha))
 return im.convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
farMask=Image.new('L',(512,512));ImageDraw.Draw(farMask).polygon([(103,180),(178,177),(223,181),(254,190),(258,221),(249,245),(249,283),(228,284),(209,257),(199,234),(101,227)],fill=255);farMask=farMask.filter(ImageFilter.GaussianBlur(.5));farMask.save(P/'far-arm-mask.png')
# Preserve original screen face except a narrow bezel contact band.
screen=Image.new('L',(512,512));ImageDraw.Draw(screen).polygon([(102,229),(210,235),(235,309),(133,304)],fill=255)
for name in ['chin','early','pregrip','grip']:
 out=Image.composite(near,base,nearMask)
 if name!='chin':
  far=rgba(P/('far-'+name+'-source.png'if name in ['early','pregrip']else'far-screen-grip-source.png'));out=Image.composite(far,out,farMask);out=Image.composite(base,out,screen)
 out.save(P/(name+'-supported.png'))
 # Same initial legs and exact existing garment redraw for the occluded stool area.
 detach=Image.open(R/'relocation/departure-bridge-v1/detach-protected-v2.png').convert('RGBA');mask=Image.open(R/'relocation/departure-bridge-v1/stool-replacement-mask-v2.png').convert('L')
 mask=ImageChops.subtract(mask,nearMask);lifted=Image.composite(detach,out,mask);lifted.save(P/(name+'-detached.png'))
 bg=Image.new('RGBA',(512,512),'#1a2836');bg.alpha_composite(lifted);bg.convert('RGB').save(P/(name+'-detached-dark.jpg'))
closedNear=rgba(P/'closed-near-support-source.png')
for family,count in [('stretch',9),('eye-rub',5)]:
 for i in range(count):
  src=Image.open(R/f'rest/canonical-{family}-v1/pose-{i:03}.png').convert('RGBA')
  out=Image.composite(closedNear,src,nearMask)
  detach=Image.open(R/'relocation/departure-bridge-v1/detach-protected-v2.png').convert('RGBA');mask=Image.open(R/'relocation/departure-bridge-v1/stool-replacement-mask-v2.png').convert('L');mask=ImageChops.subtract(mask,nearMask);out=Image.composite(detach,out,mask)
  out.save(P/f'{family}-{i:03}-supported.png')
  if i in [0,count-1]:
   bg=Image.new('RGBA',(512,512),'#1a2836');bg.alpha_composite(out);bg.convert('RGB').save(P/f'{family}-{i:03}-supported-dark.jpg')
