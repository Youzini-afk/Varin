from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json
P=Path(__file__).resolve().parent;S=P/'../canonical-stop-v1';G=P/'../canonical-gaze-v1';C=P/'../canonical-chin-v2'
mask=Image.open(G/'eyes-mask.png');read=Image.open(G/'read-screen.png')
read.save(P/'read.png');Image.open(G/'neutral.png').save(P/'neutral.png')
for pose in ['rest','middle','raised']:
 for face in ['serious','surprise']:
  src=Image.open(S/f'{pose}-{face}.png');src.save(P/f'{pose}-{face}.png')
  if face=='serious':Image.composite(read,src,mask).save(P/f'{pose}-focused.png')
for pose in ['raised','rest']:
 for eyes in ['half','closed']:
  Image.composite(Image.open(G/f'{eyes}.png'),Image.open(P/f'{pose}-focused.png'),mask).save(P/f'{pose}-{eyes}.png')
# The uncertainty check has a genuinely distinct hand-supported and neutral-mouth pose.
face=Image.open(S/'rest-serious.png');mouth=Image.new('L',(512,512));ImageDraw.Draw(mouth).ellipse((263,166,289,184),fill=255);mouth=mouth.filter(ImageFilter.GaussianBlur(.8))
for i in range(6):
 Image.composite(face,Image.open(C/f'pose-{i:03}.png'),mouth).save(P/f'check-{i:03}.png')
contracts={
 'cancel-entry':('seated-open-read-screen','observe-raised-focused',[('read',80),('middle-focused',60),('raised-focused',200)]),
 'cancel-hold':('observe-raised-focused','observe-raised-focused',[('raised-focused',2100),('raised-half',45),('raised-closed',80),('raised-half',55),('raised-focused',2800)]),
 'stopped-release':('observe-raised-focused','seated-open-read-screen',[('raised-focused',100),('middle-focused',90),('rest-focused',160),('rest-half',55),('rest-closed',100),('rest-half',70),('rest-focused',220),('read',600)]),
 'failure-entry':('seated-open-read-screen','observe-raised-focused',[('read',70),('middle-surprise',60),('raised-surprise',220),('raised-focused',500)]),
 'unknown-entry':('seated-open-read-screen','observe-unknown',[('read',70),('middle-surprise',60),('raised-surprise',300),('raised-serious',1600)]),
 'unknown-hold':('observe-unknown','observe-unknown',[('raised-serious',2400),('raised-half',45),('raised-closed',80),('raised-half',55),('raised-serious',2600)]),
 'sync-attention':('observe-unknown','seated-open-read-screen',[('raised-serious',80),('raised-focused',180),('middle-focused',90),('rest-focused',250),('read',500)]),
 'uncertain-check':('seated-open-read-screen','observe-check-chin',[('read',100),('check-000',100),('check-001',70),('check-002',85),('check-003',85),('check-004',90),('check-005',1800)]),
 'uncertain-release':('observe-check-chin','seated-open-read-screen',[('check-005',150),('check-004',70),('check-003',80),('check-002',80),('check-001',75),('check-000',200),('read',350)])}
for name,(entry,exit,seq) in contracts.items():
 spec={'id':'observe.'+name+'-v1','family':'OBSERVE_DIAGNOSE','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':entry,'exitPose':exit,'loop':None,'warning':'Art-only candidate. Semantic transitions require real Host facts; stopped-release never plays from cancel intent alone; sync does not imply completion. Normal-speed review pending.','frames':[{'source':n+'.png','durationMs':t,'offset':[0,0],'contacts':{},'phase':'hold' if 'hold' in name else 'transition','pose':entry if i==0 else exit if i==len(seq)-1 else 'observe-recovery-transition'} for i,(n,t) in enumerate(seq)]}
 (P/f'{name}.source.json').write_text(json.dumps(spec,indent=2))
(P/'provenance.json').write_text(json.dumps({'sources':['../canonical-stop-v1','../canonical-gaze-v1','../canonical-chin-v2'],'composition':'New same-geometry face/eyes/hand drawings composed through explicit local masks. No fullframe fade, no altered operational state, no synthetic success.'},indent=2))
