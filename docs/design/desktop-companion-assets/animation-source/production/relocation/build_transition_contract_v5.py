from pathlib import Path
import json,hashlib
r=Path(__file__).parent;o=r/'transition-contract-v5';o.mkdir(exist_ok=True);c=json.loads((r/'transition-contract-v3/relocation.source.json').read_text());f=c['frames']
def add(n,p,d=65,contact=False):
 p=r/p;f[n]={'source':str(p.relative_to(r.parent)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'durationMs':d,'canvas':[512,512],'embeddedStool':False,'seatContact':contact,'laptopSupport':'lap + hands; actual authored contact','releaseNext':[],'grabNext':[]}
for n,p in {'entryCurrent':'shared-entry-v1/open-current.png','entrySupported':'shared-entry-v1/open-supported.png','detachHalf':'departure-bridge-v1/detach-protected-v2.png','detachMid':'departure-bridge-v3/mid-protected.png','detachClosed':'shared-entry-v1/closed-detached.png','hugPrecontact':'hug-landing-v2/mid.png','hugContact':'hug-landing-v3/contact-no-stool.png'}.items():add(n,p,contact=n=='hugContact')
f.pop('hugSettle');up=['entryCurrent','entrySupported','detachHalf','detachMid','half','closed','turn20','turn','turn70','hug'];land=['hugPrecontact','hugContact','seatedHug','seatedTurn','seatedGrip','contact','release','settle','seated'];lap=['contact','release','settle','seated']
for i,n in enumerate(up):f[n]['grabNext']=up[i+1:]
f['seatedOpen']['grabNext']=up
for n in ['entryCurrent','entrySupported']:f[n]['releaseNext']=['entrySupported','detachHalf','detachClosed']+lap
for n in ['detachHalf','detachMid']:f[n]['releaseNext']=['detachClosed']+lap
f['detachClosed']['releaseNext']=lap;f['detachClosed']['grabNext']=['precontact','closed','turn20','turn','turn70','hug']
for n in ['turn','turn70','hug']:f[n]['releaseNext']=(['turn70','hug'] if n=='turn' else ['hug'] if n=='turn70' else [])+land
for i,n in enumerate(land):f[n]['releaseNext']=land[i+1:]
f['hugPrecontact']['grabNext']=['hug'];f['hugContact']['grabNext']=['hugPrecontact','hug'];f['seatedHug']['grabNext']=['hugContact','hugPrecontact','hug']
for n in ['seated','contact','release','settle']:f[n]['grabNext']=['precontact','closed','turn20','turn','turn70','hug']
for v in f.values():
 for edge in ['grabNext','releaseNext']:v[edge]=[n for n in v[edge] if n!='hugSettle']
mp=json.loads((r/'user-current-detach-v1/current-pose-map.json').read_text());routes=json.loads((r.parent/'user-attention/drag-bridges-v1/grab-next-map-candidate.json').read_text());entries=[]
for row in mp['frames']:
 key=row['source'].split('/registered/')[1];route=routes['rows'].get(key);entry={**row,'currentFrameMs':35,'acceptance':'representative permission reviewed; per-node sampling pending'}
 if route:
  seq=route['afterCurrentExposure'];entry['grabNext']=[{**q,'sha256':hashlib.sha256((r.parent/q['source']).read_bytes()).hexdigest()} for q in seq]+[{'frame':n} for n in ['detachHalf','detachMid','half','closed','turn20','turn','turn70','hug']]
  entry['releaseBeforeSupport']={'restoreSeatedSameExposure':row['source'],'worldSeatAtReleasePosition':True,'stoolFadeInMs':100,'doNotForceCurlOrHug':True}
  entry['releaseDuringRecovery']='Finish only remaining current hand recovery to supported contact, then detachHalf -> detachClosed -> contact -> release -> settle -> seated; never enter curled carry first.'
 else:entry['missing']='author has not supplied recovery chain'
 entries.append(entry)
c['currentPoseEntries']=entries;c['entryRouting']='Match actually displayed original source SHA; swap to corresponding no-stool exposure immediately and follow pointer. Never infer from family name alone.';c['acceptance']['knownGaps']=['core entry/early-release and corrected hug-tail have limited v4 peer acceptance; not final smoothness acceptance','native pointer/window/world stool integration QA pending','USER low-hand/direct and nod entries need representative sampling','OBSERVE/REST source map pending merge; do not pretend all families covered','direction response optional study not included'];c['acceptance']['playback']='Seated peer inspected interactive v4 current-pose early release without forced curl, plus hug -> newmid/contact -> shared seatedHug/Turn/Grip; supported nodes accepted as integration candidate. New boot-only mid correction pending peer; laptop angle already corrected.'
for n,v in f.items():
 for e in ['releaseNext','grabNext']:
  assert all(k in f for k in v[e]),(n,e)
(o/'relocation.source.json').write_text(json.dumps(c,indent=2));print(len(f),len(entries))
