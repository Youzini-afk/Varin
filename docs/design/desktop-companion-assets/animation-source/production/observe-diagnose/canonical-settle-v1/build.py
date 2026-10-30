from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
import json,numpy as np
P=Path(__file__).resolve().parent
base=Image.open(P/'../canonical-gaze-v1/read-screen.png').convert('RGBA')
mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask)
d.polygon([(0,0),(512,0),(512,205),(413,230),(388,260),(327,276),(250,278),(229,251),(169,215),(0,215)],fill=255)
d.polygon([(99,222),(215,231),(244,315),(130,311)],fill=0)
mask=mask.filter(ImageFilter.GaussianBlur(.65));mask.save(P/'upper-settle-mask.png')
src=Image.open(P/'settle-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
out=Image.composite(src,base,mask);out.save(P/'settled.png');base.save(P/'read-neutral.png')
qa=Image.new('RGB',(960,320),'#293546')
for i,a in enumerate([base,out,base]):
 a=a.resize((320,320),Image.Resampling.LANCZOS);qa.paste(a,(320*i,0),a.getchannel('A'))
qa.save(P/'body-comparison-320.jpg')
json.dump({'method':'New whole upper-body settle drawing; protected exact laptop/hands/pelvis/legs/stool. No rig rotations, interpolation or wholebody scaling; fixed source viewport normalization.','status':'Two drawn endpoints awaiting additional settle timing/inbetween refinement and normal-speed review','exactProtectedPixels':int((np.array(mask)==0).sum())},open(P/'provenance.json','w'),indent=2)
src=Image.open(P/'between-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
Image.composite(src,base,mask).save(P/'between.png')
for name in ['half','closed']:
 Image.open(P/f'../canonical-gaze-v1/{name}.png').save(P/f'{name}.png')
seq=[('read-neutral',1800),('between',160),('settled',2600),('between',170),('read-neutral',1800),('half',45),('closed',80),('half',55),('read-neutral',1800)]
spec={'id':'observe.attentive-settle-v1','family':'OBSERVE_DIAGNOSE','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':'seated-open-read-screen','exitPose':'seated-open-read-screen','loop':None,'warning':'Sparse attentive hold with newly drawn upper-body settle and inbetween. Not rhythmic wiggle; normal-speed motion/edges need review.','frames':[{'source':n+'.png','durationMs':t,'offset':[0,0],'phase':'hold','contacts':{},'pose':'seated-open-read-screen' if n=='read-neutral' else 'observe-settled' if n=='settled' else 'observe-hold-transition'} for n,t in seq]}
(P/'sequence.source.json').write_text(json.dumps(spec,indent=2))
