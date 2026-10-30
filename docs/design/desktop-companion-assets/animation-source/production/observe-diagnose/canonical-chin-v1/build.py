from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json,hashlib,numpy as np
P=Path(__file__).resolve().parent
base=Image.open(P/'../../shared/seated-open-canonical-alpha-v1.png').convert('RGBA')
mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask)
d.polygon([(176,227),(185,212),(202,201),(217,184),(231,180),(245,184),(259,198),(259,212),(249,229),(249,252),(252,280),(246,291),(231,291),(227,267),(217,238),(211,233)],fill=255)
# Held computer is always in front of the changing far arm.
d.polygon([(99,222),(215,231),(244,315),(130,311)],fill=0)
mask=mask.filter(ImageFilter.GaussianBlur(.6));mask.save(P/'editable-arm-mask.png')
base.save(P/'pose-000.png')
for i,name in enumerate(['lowest','low','middle','near','chin'],1):
 src=Image.open(P/f'{name}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 out=Image.composite(src,base,mask);out.save(P/f'pose-{i:03}.png')
count=int((np.array(mask)==0).sum()); print('exact held pixels',count)
qa=Image.new('RGB',(512*6,512),'white')
for i in range(6):qa.paste(Image.open(P/f'pose-{i:03}.png'),(i*512,0))
qa.save(P/'strip.jpg')
json.dump({'method':'fixed full-canvas isotropic 1254-to-512 generation normalization; no bounding-box registration; generated arm/sleeve through explicit mask, all other pixels canonical','protectedPixelCount':count,'geometryReference':hashlib.sha256((P/'../../shared/seated-open-canonical-v1.png').read_bytes()).hexdigest(),'status':'motion construction, face holds unchanged; no full-animation acceptance'},open(P/'provenance.json','w'),indent=2)
eyemask=Image.new('L',(512,512));ed=ImageDraw.Draw(eyemask)
ed.polygon([(210,157),(241,148),(256,156),(250,176),(224,179),(213,169)],fill=255)
ed.polygon([(272,129),(312,114),(318,125),(308,146),(285,153),(274,144)],fill=255)
eyemask=eyemask.filter(ImageFilter.GaussianBlur(.8));eyemask.save(P/'editable-eyes-mask.png')
for name in ['half','closed']:
 src=Image.open(P/f'{name}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 out=Image.composite(src,Image.open(P/'pose-005.png'),eyemask);out.save(P/f'hold-{name}.png')
frames=[]
for i,t in [(0,650),(1,70),(2,85),(3,85),(4,90),(5,1550)]:frames.append((f'pose-{i:03}.png',t,'enter' if i<5 else 'hold'))
frames += [('hold-half.png',45,'hold'),('hold-closed.png',85,'hold'),('hold-half.png',55,'hold'),('pose-005.png',2600,'hold')]
for i,t in [(4,65),(3,70),(2,70),(1,70),(0,1000)]:frames.append((f'pose-{i:03}.png',t,'exit'))
spec={'id':'observe.chin-enter-hold-release-v1','family':'OBSERVE_DIAGNOSE','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':'seated-open-gaze-screen','exitPose':'seated-open-gaze-screen','loop':None,'warning':'First continuous chin/eyelid candidate; timing, shoulder response and face-contact still need normal-speed visual review. Not full waiting/error coverage.','frames':[{'source':f,'durationMs':t,'offset':[0,0],'phase':ph,'pose':('seated-open-gaze-screen' if f=='pose-000.png' else 'observe-chin-contact' if f.startswith('hold') or f=='pose-005.png' else 'observe-arm-transition'),'contacts':{},'exitTo':(['seated-open-gaze-screen'] if f=='pose-000.png' else [])} for f,t,ph in frames]}
json.dump(spec,open(P/'sequence.source.json','w'),indent=2)
