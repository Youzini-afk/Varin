from pathlib import Path
from PIL import Image
import json,hashlib,numpy as np
R=Path(__file__).resolve().parents[2];dm=np.array(Image.open(R/'relocation/departure-bridge-v1/stool-replacement-mask-v2.png').convert('L'))>0
for name in ['closed-grab-v1','open-event-grab-v1']:
 p=R/'user-attention'/name;sm=json.load(open(p/'source-map.json'))['frames'];routes=json.load(open(p/'routes.json'));rows=[]
 for f in sm:
  current=f.get('currentDetached',f.get('current'));a=np.array(Image.open(R/f['source']).convert('RGBA'));b=np.array(Image.open(R/current).convert('RGBA'));diff=int(np.any(a!=b,axis=2)[~dm].sum());assert diff==0
  src=f['source'];g='closed-wave-return' if 'welcome-'in src else 'closed-head-response' if 'click-'in src else 'open-wave-return' if 'completion-'in src else 'open-head-response'
  rows.append({'source':src,'sourceSha256':f['sourceSha256'],'group':g,'currentDetached':current,'currentDetachedSha256':hashlib.sha256((R/current).read_bytes()).hexdigest(),'route':[{'source':s,'sha256':hashlib.sha256((R/s).read_bytes()).hexdigest(),'durationMs':ms}for s,ms in routes[f['sourceSha256']]],'unchangedOutsideStoolMask':diff==0,'status':'static-checked-awaiting-representative-dynamic-peer'})
 d={'scope':'Exact current local-event exposures, no neutral reset. Immediate pointer tracking separate native responsibility. No new generation. Existing authored supporting hands and real wave retraction only.','groups':sorted(set(x['group']for x in rows)),'sourceCount':len(rows),'uniqueSourceCount':len(set(x['sourceSha256']for x in rows)),'frames':rows};(p/'acceptance-ledger.json').write_text(json.dumps(d,indent=2)+'\n');print(name,len(rows),d['uniqueSourceCount'])
