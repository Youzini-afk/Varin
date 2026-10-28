from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json
P=Path(__file__).resolve().parent;R=P/'../canonical-eye-rub-v1'
base=Image.open(R/'closed-reference.png').convert('RGBA')
mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask)
d.polygon([(35,35),(190,35),(220,148),(258,175),(320,195),(323,272),(255,279),(242,299),(192,299),(127,254),(109,172),(41,112)],fill=255)
# Keep closed lid except the former far-hand footprint; keep near hand/static supports.
d.polygon([(145,299),(194,289),(194,299),(246,299),(254,281),(315,290),(315,331),(143,329)],fill=0)
mask=mask.filter(ImageFilter.GaussianBlur(.65));mask.save(P/'stretch-redraw-mask.png')
eye=Image.open(P/'../../observe-diagnose/canonical-chin-v1/editable-eyes-mask.png')
for i in range(4):Image.open(R/f'pose-{i:03}.png').save(P/f'pose-{i:03}.png')
for i,name in enumerate(['bent','half','mid','extended','overshoot'],4):
 src=Image.open(P/f'{name}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 out=Image.composite(src,base,mask);out=Image.composite(src,out,eye);out.save(P/f'pose-{i:03}.png')
qa=Image.new('RGB',(320*5,320),'#e5e8ed')
for j,i in enumerate([0,3,4,6,8]):
 a=Image.open(P/f'pose-{i:03}.png').resize((320,320),Image.Resampling.LANCZOS);qa.paste(a,(j*320,0),a.getchannel('A'))
qa.save(P/'strip-320.jpg')
seq=[(0,900),(1,80),(2,80),(3,70),(4,80),(5,80),(6,85),(7,130),(8,220),(7,600),(6,100),(5,95),(4,85),(3,100),(2,90),(1,85),(0,1800)]
spec={'id':'rest.closed-stretch-v1','family':'REST','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':'seated-closed-neutral','exitPose':'seated-closed-neutral','loop':None,'warning':'Authored shoulder/arm/sleeve stretch candidate; needs normal-speed inspection and return sleeve lag polish. No continuous repeated stretch loop.','frames':[{'source':f'pose-{i:03}.png','durationMs':t,'offset':[0,0],'contacts':{},'phase':'hold' if i>=7 else 'transition','pose':'seated-closed-neutral' if i==0 else 'rest-stretched' if i>=7 else 'rest-stretch-transition'}for i,t in seq]}
(P/'sequence.source.json').write_text(json.dumps(spec,indent=2))
