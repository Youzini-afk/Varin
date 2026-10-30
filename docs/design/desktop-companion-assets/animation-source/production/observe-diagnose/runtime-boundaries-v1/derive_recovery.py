from pathlib import Path
import json,shutil,hashlib
P=Path(__file__).resolve().parent;R=P.parent.parent;S=R/'observe-diagnose/canonical-recovery-v1'
index=[]
for name in ['cancel-entry','cancel-hold','failure-entry','unknown-entry','unknown-hold','sync-attention','uncertain-check','uncertain-release','stopped-release']:
 d=json.loads((S/f'{name}.source.json').read_text()); target='neutral-recovery' if name=='stopped-release' else name
 out=P/target;out.mkdir(exist_ok=True);d['id']='observe.'+target+'-boundary-v1'
 d['kind']='action' if name in ['cancel-hold','unknown-hold'] else 'bridge'
 for k in ['entryPose','exitPose']:
  if d[k]=='seated-open-read-screen':d[k]='seated-open-screen-keyboard'
 d['loop']=[0,len(d['frames'])] if name.endswith('-hold') else None
 stable={'read.png':'seated-open-screen-keyboard','raised-focused.png':'observe-raised-focused','raised-serious.png':'observe-unknown','check-005.png':'observe-check-chin'}
 for i,f in enumerate(d['frames']):
  shutil.copyfile(S/f['source'],out/f['source']);f['pose']=stable.get(f['source'],d['id']+'-'+f['source']);f['exitTo']=[f['pose']]if f['source']in stable else []
  f['phase']='stable' if f['exitTo'] else 'transition'
 if target=='neutral-recovery':d['warning']='Presentation-only hand lowering to neutral screen posture after current round changes. Does not assert executor stopped, authorize retry, or imply success; never map to E03 without independent Host fact.'
 d['derivation']={'sourceManifest':str((S/f'{name}.source.json').relative_to(R)),'sourceSha256':hashlib.sha256((S/f'{name}.source.json').read_bytes()).hexdigest(),'method':'Exact existing drawing bytes; metadata-only holds and real safe points. Neutral recovery does not assert stopped.'}
 (out/'sequence.source.json').write_text(json.dumps(d,indent=2)+'\n');index.append({'id':d['id'],'manifest':str((out/'sequence.source.json').relative_to(R))})
# Actual eye/face bridge over identical held hand, shoulder and laptop.
name='raised-focus-to-unknown';out=P/name;out.mkdir(exist_ok=True)
d=json.loads((P/'cancel-hold/sequence.source.json').read_text());d.update(id='observe.'+name+'-boundary-v1',kind='bridge',loop=None,entryPose='observe-raised-focused',exitPose='observe-unknown',warning='Presentation-only gaze/face shift when observation becomes unknown. No hand movement, stopped or failure claim.',frames=[])
for n,t in [('raised-focused',80),('raised-half',45),('raised-closed',85),('raised-serious',120)]:
 shutil.copyfile(S/(n+'.png'),out/(n+'.png'));pose='observe-raised-focused'if n=='raised-focused'else'observe-unknown'if n=='raised-serious'else'raised-blink-transition'
 d['frames'].append({'source':n+'.png','durationMs':t,'offset':[0,0],'pose':pose,'exitTo':[pose]if n in ['raised-focused','raised-serious']else[],'phase':'transition','contacts':{}})
d['derivation']={'sourceDirectory':'observe-diagnose/canonical-recovery-v1','method':'Exact existing RGBA cels in authored 330ms blink/gaze bridge. New sequencing, no new pixels.'}
(out/'sequence.source.json').write_text(json.dumps(d,indent=2)+'\n');index.append({'id':d['id'],'manifest':str((out/'sequence.source.json').relative_to(R))})
(P/'recovery-index.json').write_text(json.dumps({'assets':index,'warning':'Holds loop only while corresponding real presentation intent remains. Acceptance belongs to peer/integration review. No E03 fact invented.'},indent=2)+'\n')
