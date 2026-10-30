from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json
P=Path(__file__).resolve().parent
base=Image.open(P/'closed-reference.png').convert('RGBA')
mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask)
d.polygon([(155,288),(153,238),(170,197),(188,168),(212,151),(234,152),(245,170),(243,197),(254,217),(251,248),(251,279),(244,297),(199,298)],fill=255)
mask=mask.filter(ImageFilter.GaussianBlur(.7));mask.save(P/'arm-mask.png')
eye=Image.open(P/'../../observe-diagnose/canonical-chin-v1/editable-eyes-mask.png')
# Mouth is authored separately, no generic scaling or recolouring.
mouth=Image.new('L',(512,512));ImageDraw.Draw(mouth).ellipse((266,167,288,184),fill=255);mouth=mouth.filter(ImageFilter.GaussianBlur(.7));mouth.save(P/'mouth-mask.png')
base.save(P/'pose-000.png')
for i,name in enumerate(['low','middle','near','rub'],1):
 src=Image.open(P/f'closed-{name}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 out=Image.composite(src,base,mask)
 out=Image.composite(src,out,eye)
 out=Image.composite(src,out,mouth);out.save(P/f'pose-{i:03}.png')
qa=Image.new('RGB',(320*5,320),'#eee6dc')
for i in range(5):
 a=Image.open(P/f'pose-{i:03}.png').resize((320,320),Image.Resampling.LANCZOS);qa.paste(a,(i*320,0),a.getchannel('A'))
qa.save(P/'strip-320.jpg')
seq=[(0,1000),(1,90),(2,95),(3,90),(4,420),(3,85),(2,100),(1,100),(0,1800)]
spec={'id':'rest.closed-eye-rub-v1','family':'REST','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':'seated-closed-neutral','exitPose':'seated-closed-neutral','loop':None,'warning':'Authored reach/contact/release first candidate. Not final L06/L07. No repeated eye rubbing loop; quiet hold and shoulder motion are separate continuing production.','frames':[{'source':f'pose-{i:03}.png','durationMs':t,'offset':[0,0],'contacts':{},'phase':'hold' if i==4 else 'transition','pose':'seated-closed-neutral' if i==0 else 'rest-eye-contact' if i==4 else 'rest-eye-approach'}for i,t in seq]}
(P/'sequence.source.json').write_text(json.dumps(spec,indent=2))
