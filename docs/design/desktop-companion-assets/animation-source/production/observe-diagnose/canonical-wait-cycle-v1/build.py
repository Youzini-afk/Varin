from pathlib import Path
from PIL import Image
import json
P=Path(__file__).resolve().parent;C=P/'../canonical-chin-v2';G=P/'../canonical-gaze-v1';R=P/'../canonical-rim-rest-v1'
for i in range(6):Image.open(C/f'pose-{i:03}.png').save(P/f'pose-{i:03}.png')
base=Image.open(C/'pose-005.png');mask=Image.open(P/'../canonical-settle-v1/upper-settle-mask.png')
src=Image.open(P/'chin-settle-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
Image.composite(src,base,mask).save(P/'chin-settled.png')
for n in ['hold-half','hold-closed']:Image.open(C/f'{n}.png').save(P/f'{n}.png')
for n in ['approach','rest']:Image.open(R/f'{n}.png').save(P/f'rim-{n}.png')
# Eye contact shift preserves head/hand contact exactly; it does not trigger an interaction.
eye=Image.open(G/'eyes-mask.png');user=Image.open(G/'neutral.png');Image.composite(user,base,eye).save(P/'chin-glance-user.png')
actions={
'enter':('seated-open-read-screen','observe-chin-contact',[(f'pose-{i:03}',t)for i,t in [(0,100),(1,70),(2,85),(3,85),(4,90),(5,180)]]),
'exit':('observe-chin-contact','seated-open-read-screen',[(f'pose-{i:03}',t)for i,t in [(5,120),(4,65),(3,70),(2,70),(1,70),(0,180)]]),
'hold':('observe-chin-contact','observe-chin-contact',[('pose-005',2200),('hold-half',45),('hold-closed',80),('hold-half',55),('pose-005',1900),('chin-settled',2400),('pose-005',1500),('rim-approach',90),('rim-rest',2300),('rim-approach',90),('pose-005',1700),('hold-half',45),('hold-closed',85),('chin-glance-user',700),('hold-half',45),('hold-closed',75),('pose-005',1600)])}
for name,(entry,exit,seq)in actions.items():
 spec={'id':'observe.wait-'+name+'-v1','family':'OBSERVE_DIAGNOSE','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':entry,'exitPose':exit,'loop':[0,len(seq)]if name=='hold'else None,'warning':'Continuous attentive wait candidate; small shoulder/hand-supported head settle, hand comfort adjustment, sparse eye contact. No progress/retry/success implied. Normal-speed loop and shoulder seam QA pending.','frames':[{'source':n+'.png','durationMs':t,'offset':[0,0],'contacts':{},'phase':name,'pose':entry if i==0 else exit if i==len(seq)-1 else 'observe-wait-variation','exitTo':['observe-chin-contact']if n=='pose-005'else []}for i,(n,t)in enumerate(seq)]}
 (P/f'{name}.source.json').write_text(json.dumps(spec,indent=2))
qa=Image.new('RGB',(960,320),'#293546')
for i,n in enumerate(['pose-005','chin-settled','chin-glance-user']):
 a=Image.open(P/f'{n}.png').resize((320,320));qa.paste(a,(i*320,0),a.getchannel('A'))
qa.save(P/'hold-comparison-320.jpg')
