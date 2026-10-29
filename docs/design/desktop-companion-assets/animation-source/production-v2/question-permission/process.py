from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path
import hashlib,json
D=Path(__file__).parent; S=D/'references'; base=Image.open(S/'upright-open-neutral-v2.png').convert('RGBA')
for name in ['ask','offer','attend-corrected','offer-mid','nod','nod-soft','listen-rest']:
 im=Image.open(D/'raw'/f'{name}.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 m=Image.new('L',(512,512));d=ImageDraw.Draw(m)
 # Actual redrawn arm, shoulder, uncovered keyboard and sleeve; not a rigid puppet transform.
 d.polygon([(291,190),(331,195),(370,232),(419,247),(421,294),(380,335),(375,364),(335,366),(302,344),(281,328),(247,319),(247,278),(280,262),(288,223)],fill=255)
 if name=='attend-corrected': d.polygon([(260,230),(315,230),(346,273),(347,326),(300,343),(266,299)],fill=255)
 if name=='listen-rest':
  d.rectangle((231,273,306,327),fill=255)
  d.polygon([(119,269),(140,275),(147,298),(136,311),(118,305)],fill=255)
 if name=='nod':
  m=Image.new('L',(512,512));d=ImageDraw.Draw(m)
  d.rectangle((125,0,396,201),fill=255)
  d.polygon([(200,180),(320,180),(315,219),(231,219)],fill=255)
 if name=='ask': d.polygon([(291,170),(326,169),(339,214),(340,269),(315,287),(288,255)],fill=255)
 # Inner face expression only; keep head/hair silhouette fixed.
 d.polygon([(208,130),(225,120),(294,120),(314,139),(307,165),(287,179),(251,183),(224,171)],fill=255)
 if name=='nod-soft':
  m=Image.new('L',(512,512));d=ImageDraw.Draw(m);d.polygon([(207,122),(291,119),(314,140),(307,166),(282,180),(249,182),(222,171)],fill=255)
 m=m.filter(ImageFilter.GaussianBlur(1.2));m.save(D/'masks'/f'{name}.png')
 out=Image.composite(im,Image.open(D/'poses'/'nod.png').convert('RGBA') if name=='nod-soft' else base,m);out.save(D/'poses'/f'{name}.png')
canvas=Image.new('RGBA',(4096,550),(235,238,242,255))
for i,n in enumerate(['neutral','attend-corrected','ask','offer-mid','offer','listen-rest','nod','nod-soft']):
 im=base if n=='neutral' else Image.open(D/'poses'/f'{n}.png');canvas.alpha_composite(im,(512*i,30));ImageDraw.Draw(canvas).text((512*i+15,10),n,fill='black')
canvas.convert('RGB').save(D/'qa'/'direction.jpg')
