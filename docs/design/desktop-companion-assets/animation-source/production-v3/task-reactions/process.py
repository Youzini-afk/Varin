from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json
D=Path(__file__).parent;(D/'qa').mkdir(exist_ok=True);base=Image.open(D/'references/upright-open-neutral-v2.png').convert('RGBA');read=Image.open(D/'references/open-screen-read-v2.png').convert('RGBA')
names=['arrival-chest','thought-rise','thought-chin','explain-rise','explain-content','error-observe','error-locate'];report={}
for name in names:
 raw=Image.open(D/'raw'/f'{name}.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);m=Image.new('L',(512,512));dr=ImageDraw.Draw(m)
 if name.startswith('thought'):
  dr.polygon([(182,205),(210,164),(243,161),(253,187),(255,227),(237,240),(210,241),(190,225)],fill=255)
  dr.polygon([(190,80),(294,65),(334,116),(334,172),(306,196),(293,220),(227,216),(215,185),(195,158)],fill=255)
  dr.rectangle((232,275,252,302),fill=255)
 else:
  dr.polygon([(248,192),(304,188),(334,201),(362,239),(375,304),(378,359),(339,366),(306,346),(279,329),(246,321),(246,275),(229,253),(228,218)],fill=255)
  dr.polygon([(205,127),(223,116),(293,116),(316,134),(309,161),(288,179),(251,184),(222,171)],fill=255)
  if name.startswith('error'):
   dr.polygon([(116,269),(134,270),(144,291),(137,308),(118,306)],fill=255);dr.rectangle((232,273,253,308),fill=255)
  if name.startswith('explain'):dr.polygon([(213,220),(242,216),(279,241),(288,264),(250,271),(223,250)],fill=255)
 m=m.filter(ImageFilter.GaussianBlur(1));m.save(D/'masks'/f'{name}.png');out=Image.composite(raw,base,m)
 # Restore invariant screen panel except actual pointing tip region above it.
 screen=Image.new('L',(512,512));ImageDraw.Draw(screen).polygon([(111,231),(216,239),(238,308),(139,307)],fill=255)
 out=Image.composite(base,out,screen)
 if name=='error-locate':
  # The generated lowered hand is valid; its frowning expression is not.
  # Reuse approved calm reading face, truthfully recorded, not new acting art.
  f=Image.new('L',(512,512));ImageDraw.Draw(f).polygon([(205,124),(294,115),(315,134),(307,163),(287,179),(250,184),(222,171)],fill=255);f=f.filter(ImageFilter.GaussianBlur(1));out=Image.composite(read,out,f);f.save(D/'masks/error-locate-calm-face.png')
 out.save(D/'poses'/f'{name}.png');a=np.asarray(out);b=np.asarray(base);report[name]={'canvas':[512,512],'outsideEditMaskChangedPixels':int(np.any(a[np.asarray(m)==0]!=b[np.asarray(m)==0],axis=-1).sum())}
canvas=Image.new('RGB',(2048,1080),(235,238,242));draw=ImageDraw.Draw(canvas)
for i,n in enumerate(['neutral']+names):
 im=base if n=='neutral' else Image.open(D/'poses'/f'{n}.png');x=i%4*512;y=i//4*540;canvas.paste(im,(x,y+25),im);draw.text((x+10,y+5),n,fill='black')
canvas.save(D/'qa/direction.jpg');(D/'qa/pixel-verification.json').write_text(json.dumps(report,indent=2))
# Exclusive thoughtful-head blink, not neutral-head eye patches.
anchor=Image.open(D/'poses/thought-chin.png').convert('RGBA');raw=Image.open(D/'raw/thought-blink.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);eye=Image.new('L',(512,512));dr=ImageDraw.Draw(eye);dr.polygon([(198,117),(213,113),(232,118),(237,133),(230,143),(209,143),(199,133)],fill=255);dr.polygon([(263,122),(279,119),(300,126),(308,137),(297,146),(274,147),(264,137)],fill=255);eye=eye.filter(ImageFilter.GaussianBlur(.65));eye.save(D/'masks/thought-blink.png');out=Image.composite(raw,anchor,eye);out.save(D/'poses/thought-blink.png');a=np.asarray(out);b=np.asarray(anchor);report['thought-blink']={'canvas':[512,512],'exactBase':'poses/thought-chin.png','outsideEyeMaskChangedPixels':int(np.any(a[np.asarray(eye)==0]!=b[np.asarray(eye)==0],axis=-1).sum())};(D/'qa/pixel-verification.json').write_text(json.dumps(report,indent=2,sort_keys=True))
