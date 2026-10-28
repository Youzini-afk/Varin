from pathlib import Path
from PIL import Image
import json
P=Path(__file__).resolve().parent
base=Image.open(P/'../canonical-eye-rub-v1/closed-reference.png').convert('RGBA');base.save(P/'neutral.png')
O=P/'../../observe-diagnose';m=Image.open(O/'canonical-settle-v1/upper-settle-mask.png')
for name in ['between','settle']:
 src=Image.open(O/f'canonical-settle-v1/{name}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 Image.composite(src,base,m).save(P/f'{name}.png')
eyes=Image.open(O/'canonical-gaze-v1/eyes-mask.png')
for name in ['half','closed']:
 src=Image.open(O/f'canonical-chin-v1/{name}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 Image.composite(src,base,eyes).save(P/f'{name}.png')
seq=[('neutral',2200),('half',45),('closed',90),('half',60),('neutral',1500),('between',180),('settle',3200),('between',190),('neutral',2400)]
spec={'id':'rest.quiet-settle-v1','family':'REST','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':'seated-closed-neutral','exitPose':'seated-closed-neutral','loop':None,'warning':'Sparse quiet companion candidate; no work-state meaning. Authored upper-body settle reused over exact closed-lap support; normal-speed and mask seam review pending.','frames':[{'source':n+'.png','durationMs':t,'offset':[0,0],'phase':'hold','contacts':{},'pose':'seated-closed-neutral' if n=='neutral' else 'rest-quiet-settle' if n=='settle' else 'rest-quiet-transition'}for n,t in seq]}
(P/'sequence.source.json').write_text(json.dumps(spec,indent=2))
(P/'provenance.json').write_text(json.dumps({'sources':['../canonical-eye-rub-v1/closed-reference.png','../../observe-diagnose/canonical-settle-v1','../../observe-diagnose/canonical-chin-v1'],'method':'Actual authored upper-body and eyelid changes; closed support pixels held. No transform rig or fullframe alpha fade.'},indent=2))
qa=Image.new('RGB',(640,320),'#293546')
for i,name in enumerate(['neutral','settle']):
 a=Image.open(P/f'{name}.png').resize((320,320));qa.paste(a,(i*320,0),a.getchannel('A'))
qa.save(P/'comparison-320.jpg')
