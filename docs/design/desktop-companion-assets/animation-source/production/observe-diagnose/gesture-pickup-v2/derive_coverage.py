from pathlib import Path
from PIL import Image,ImageChops
import json,hashlib,shutil
P=Path(__file__).resolve().parent;R=P.parent.parent
h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
mask=Image.open(R/'relocation/departure-bridge-v1/stool-replacement-mask-v2.png').convert('L');nearMask=Image.open(P/'near-support-mask.png').convert('L');mask=ImageChops.subtract(mask,nearMask);detach=Image.open(R/'relocation/departure-bridge-v1/detach-protected-v2.png').convert('RGBA')
near=Image.open(P/'near-support-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
closedNear=Image.open(P/'closed-near-support-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
entries=[]
for e in json.loads((P/'coverage-source-input.json').read_text()):
 src=R/e['path'];assert h(src)==e['sha'];name='coverage-'+e['sha'][:12];d=P/name;d.mkdir(exist_ok=True);closed='canonical-quiet' in str(src);im=Image.open(src).convert('RGBA');first=Image.composite(detach,im,mask);first.save(d/'current-detached.png');supported=Image.composite(closedNear if closed else near,first,nearMask);supported.save(d/'current-supported.png');frames=[('current-detached.png',45),('current-supported.png',60)]
 if closed: tail=[('stretch-000-supported.png',65)]
 else:
  f=src.name
  if f.startswith('check-'):i=int(f[6:9]);start=min(5,i+1) if i else 0
  elif 'chin-' in f or f=='rim-approach.png':start=5
  elif f.startswith('raised-'):start=2
  elif f.startswith('middle-'):start=1
  else:start=0
  tail=[(f'chin-{i:03}-supported.png',55) for i in range(start,max(start,3)+1)]
  tail += [(f'{n}-detached.png',t)for n,t in [('early',75),('pregrip',70),('grip',90)]]
 for f,t in tail:shutil.copyfile(P/f,d/f);frames.append((f,t))
 endpoint='canonical-'+('closed'if closed else'open')+'-laptop-supported-detached'
 j={'id':'gesture-pickup.'+name,'stage':'motion-candidate','reviewStatus':'structural-variant-review','family':'RELOCATION','canvas':[512,512],'entryPose':name+'-detached','exitPose':endpoint,'loop':None,'sourceStart':e['path'],'sourceStartSha256':e['sha'],'frames':[{'source':f,'durationMs':t,'offset':[0,0],'phase':'detach'if i==0 else'withdraw-to-support','pose':endpoint if i==len(frames)-1 else name+'-transition','contacts':{}}for i,(f,t)in enumerate(frames)]}
 (d/'sequence.source.json').write_text(json.dumps(j,indent=2)+'\n');entries.append({'id':j['id'],'manifest':str((d/'sequence.source.json').relative_to(R)),'sourceStart':e['path'],'sourceStartSha256':e['sha'],'endpoint':endpoint,'mode':'closed'if closed else'open','durationMs':sum(t for f,t in frames),'uses':e['uses'],'reviewStatus':'derived-awaiting-source-contact-check'})
(P/'coverage-index.json').write_text(json.dumps({'entries':entries,'scope':'Actual unique source hashes missing from 2324 consumer inventory; no new backend action families','dependencies':['index.json','coverage-source-input.json','near-support-mask.png'],'newDrawings':0},indent=2)+'\n')
# review contact sheet initial/support/first recovery/last
from PIL import ImageDraw
sheet=Image.new('RGB',(4*200,len(entries)*220),'#1d2b37');draw=ImageDraw.Draw(sheet)
for r,e in enumerate(entries):
 d=(R/e['manifest']).parent;j=json.loads((d/'sequence.source.json').read_text());fs=j['frames'];sub=[fs[0],fs[1],fs[2],fs[-1]]
 for c,f in enumerate(sub):
  im=Image.open(d/f['source']).convert('RGBA');im.thumbnail((200,200));sheet.paste(im,(c*200,r*220),im)
 draw.text((0,r*220+200),e['sourceStart'],fill='white')
sheet.save(P/'coverage-strip.jpg')
