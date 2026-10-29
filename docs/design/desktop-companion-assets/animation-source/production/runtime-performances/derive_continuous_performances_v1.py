"""Compose reviewed same-pose segments into interruptible, quiet continuous performances."""
import copy,hashlib,json,shutil
from pathlib import Path
r=Path(__file__).resolve().parent
inventory=r/'accepted-runtime/v3/inventory.json'
rows=json.loads(inventory.read_text())
def original(action):
 if action=='idle-closed':return r/'accepted-runtime/v2/rest-quiet-settle-v1/sequence.json'
 return Path(next(x['package'] for x in json.loads((r/'accepted-runtime-v2-inventory.json').read_text()) if x.get('action')==action))
def resolve(p): return p if p.is_absolute() else r/p
sources={a:resolve(original(a)) for a in ['editing','browsing','idle-closed','eye-rub','stretch']}
def compose(action,parts):
 base=json.loads(sources[action].read_text());out=r/'accepted-runtime/v3'/('continuous-'+action+'-v1');out.mkdir(parents=True,exist_ok=True)
 result=copy.deepcopy(base);result['id']='continuous.'+action+'-v1';result['frames']=[];result['pages']=[];page_map={};elapsed=0;refs=[]
 for key,extra_hold in parts:
  source=sources[key];a=json.loads(source.read_text());assert a['entryPose']==base['entryPose'] and a['exitPose']==base['exitPose']
  assert a['frames'][0]['sha256']==a['frames'][-1]['sha256']==base['frames'][0]['sha256']
  refs.append({'source':str(source.relative_to(r)),'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'finalNeutralAddedMs':extra_hold})
  index={}
  for i,page in enumerate(a['pages']):
   file=source.parent/page['file'];digest=hashlib.sha256(file.read_bytes()).hexdigest()
   if digest not in page_map:
    n=len(result['pages']);name=f'atlas-{n:03d}.png';shutil.copy2(file,out/name);page_map[digest]=n;result['pages'].append({'file':name})
   index[i]=page_map[digest]
  for i,f in enumerate(a['frames']):
   f=copy.deepcopy(f);f['page']=index[f['page']];f['durationMs']+=extra_hold if i==len(a['frames'])-1 else 0
   if f['sha256']==base['frames'][0]['sha256']: f['pose']=base['entryPose'];f['exitTo']=[base['entryPose']];f['phase']='stable'
   f['startMs']=elapsed;elapsed+=f['durationMs'];result['frames'].append(f)
 result['durationMs']=elapsed;result['loop']=[0,len(result['frames'])]
 result['warning']='Continuous authored performance from reviewed drawings. Nonessential recurrence stops under reduced motion; actual Host changes and pointer movement take priority. Timing visual follow-up recorded separately.'
 (out/'sequence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 (out/'provenance.json').write_text(json.dumps({'sources':refs,'newDrawingCount':0,'safeExits':'Only exact common neutral source pixels; all other original exits retained','normalSpeedCompositeReview':'pending'},indent=2)+'\n')
 for row in rows:
  if row.get('action')==action:row['package']=str((out/'sequence.json').relative_to(r))
 print(result['id'],elapsed,len(result['frames']))
compose('editing',[('editing',1600),('editing',3100),('editing',2200)])
compose('browsing',[('browsing',2800),('browsing',1900),('browsing',4200)])
compose('idle-closed',[('idle-closed',1800)]*6+[('eye-rub',6000)]+[('idle-closed',1800)]*6+[('stretch',6000)])
inventory.write_text(json.dumps(rows,indent=2)+'\n')
