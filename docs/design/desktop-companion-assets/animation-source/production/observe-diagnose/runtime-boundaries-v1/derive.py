from pathlib import Path
import json, shutil, hashlib
P=Path(__file__).resolve().parent;R=P.parent.parent
specs={
'wait-enter':('observe-diagnose/canonical-wait-cycle-v1/enter.source.json','bridge'),
'wait-hold':('observe-diagnose/canonical-wait-cycle-v1/hold.source.json','action'),
'wait-exit':('observe-diagnose/canonical-wait-cycle-v1/exit.source.json','bridge'),
'quiet':('rest/canonical-quiet-v1/sequence.source.json','action'),
'eye-rub':('rest/canonical-eye-rub-v1/sequence.source.json','action'),
'stretch':('rest/canonical-stretch-v1/sequence.source.json','action')}
pose={'seated-open-read-screen':'seated-open-screen-keyboard','seated-closed-neutral':'seated-closed-neutral'}
index=[]
for name,(rel,kind) in specs.items():
 src=R/rel; d=json.loads(src.read_text()); out=P/name;out.mkdir(exist_ok=True)
 d['id']+='-boundary-v1';d['kind']=kind
 d['entryPose']=pose.get(d['entryPose'],d['entryPose']);d['exitPose']=pose.get(d['exitPose'],d['exitPose'])
 for i,f in enumerate(d['frames']):
  shutil.copyfile(src.parent/f['source'],out/f['source'])
  safe=(name.startswith('wait-') and f['source']=='pose-005.png') or (name in ['quiet','eye-rub','stretch'] and f['source'] in ['neutral.png','pose-000.png'])
  if name.startswith('wait-') and f['source']=='pose-000.png':f['pose']='seated-open-screen-keyboard';f['exitTo']=['seated-open-screen-keyboard']
  elif safe:
   f['pose']='observe-chin-contact' if name.startswith('wait-') else 'seated-closed-neutral';f['exitTo']=[f['pose']]
  else:f['pose']=d['id']+'-drawing-'+f['source'];f['exitTo']=[]
  if name in ['quiet','eye-rub','stretch']:
   f['phase']='stable' if safe else 'return' if i>len(d['frames'])//2 else 'performance'
 d['derivation']={'sourceManifest':rel,'sourceManifestSha256':hashlib.sha256(src.read_bytes()).hexdigest(),'change':'Metadata-only safe boundary normalization. All drawing bytes copied exactly. Non-safe named poses are not interrupt permission.'}
 (out/'sequence.source.json').write_text(json.dumps(d,indent=2)+'\n')
 index.append({'id':d['id'],'manifest':str((out/'sequence.source.json').relative_to(R)),'kind':kind,'entryPose':d['entryPose'],'exitPose':d['exitPose'],'safeFrameIndices':[i for i,f in enumerate(d['frames']) if f['exitTo']]})
(P/'index.json').write_text(json.dumps({'sourceRoot':'varin-animation-production','assets':index,'bridgeChain':['seated-open-screen-keyboard','wait-enter','observe-chin-contact','wait-hold','wait-exit','seated-open-screen-keyboard'],'closedWakeChain':['seated-closed-neutral','seated-work/canonical-lid-v2/opening/sequence.source.json','seated-open-neutral-keyboard','gaze-to-screen','seated-open-screen-keyboard'],'warning':'Source reviewStatus unchanged; lead applies peer acceptance when packaging. Safe exit may route from the actually displayed matching drawing; never seek/teleport to a later safe frame. If currently unsafe, continue authored recovery until a safe drawing appears.'},indent=2)+'\n')
