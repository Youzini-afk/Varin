from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
import json
P=Path(__file__).resolve().parent
base=Image.open(P/'../canonical-chin-v2/pose-005.png').convert('RGBA');base.save(P/'chin.png')
mask=Image.new('L',(512,512));ImageDraw.Draw(mask).polygon([(250,277),(278,276),(304,279),(319,292),(320,315),(306,324),(269,324),(251,307)],fill=255);mask=mask.filter(ImageFilter.GaussianBlur(.6));mask.save(P/'hand-mask.png')
for name in ['approach','rest','lift']:
 src=Image.open(P/f'{name}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 Image.composite(src,base,mask).save(P/f'{name}.png')
qa=Image.new('RGB',(1280,320),'#eeeeee')
for i,n in enumerate(['chin','approach','rest','lift']):
 a=Image.open(P/f'{n}.png').resize((320,320));qa.paste(a,(i*320,0),a.getchannel('A'))
qa.save(P/'comparison-320.jpg')
seq=[('chin',800),('approach',90),('rest',2200),('lift',80),('rest',120),('rest',1800),('approach',90),('chin',900)]
spec={'id':'observe.rim-hand-rest-v1','family':'OBSERVE_DIAGNOSE','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':'observe-chin-contact','exitPose':'observe-chin-contact','loop':None,'warning':'Near hand actually moves off keys to casing rim and relaxes. Small index lift/contact needs close-up surface QA; not yet approved as W05 palm-rest-tap. No key activation intended.','frames':[{'source':n+'.png','durationMs':t,'offset':[0,0],'contacts':{},'phase':'hold','pose':'observe-chin-contact' if n=='chin' else 'observe-chin-rim-hand'}for n,t in seq]}
(P/'sequence.source.json').write_text(json.dumps(spec,indent=2))
