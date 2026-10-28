from pathlib import Path
from PIL import Image
import json
P=Path(__file__).resolve().parent;G=P/'../canonical-gaze-v1'
base=Image.open(G/'read-screen.png');mask=Image.open(G/'eyes-mask.png');src=Image.open(P/'glance-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
Image.composite(src,base,mask).save(P/'side-glance.png')
# Optional painted-eye overlay, ONLY valid at the identical unmoved canonical head.
patch=src.copy();patch.putalpha(mask);patch.save(P/'eyes-overlay.png');mask.save(P/'eyes-mask.png')
for n in ['read-screen','half','closed']:Image.open(G/f'{n}.png').save(P/f'{n}.png')
seq=[('read-screen',800),('half',40),('side-glance',460),('half',45),('closed',65),('read-screen',800)]
spec={'id':'observe.side-glance-v1','family':'OBSERVE_DIAGNOSE','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':'seated-open-read-screen','exitPose':'seated-open-read-screen','loop':None,'warning':'Brief peripheral queue awareness candidate, not a fake wait or progress event. Eyes overlay is only compatible with exact fixed canonical head, never arbitrary angles. Fullframe does not model concurrent typing.','frames':[{'source':n+'.png','durationMs':t,'offset':[0,0],'contacts':{},'phase':'glance','pose':'seated-open-read-screen'if n=='read-screen'else'observe-side-glance'}for n,t in seq]}
(P/'sequence.source.json').write_text(json.dumps(spec,indent=2))
qa=Image.new('RGB',(640,320),'#eeeeee')
for i,n in enumerate(['read-screen','side-glance']):
 a=Image.open(P/f'{n}.png').resize((320,320));qa.paste(a,(i*320,0),a.getchannel('A'))
qa.save(P/'comparison-320.jpg')
