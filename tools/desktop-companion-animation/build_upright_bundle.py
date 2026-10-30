"""Compile new-identity source exposures for the existing player. Never accepts or installs art."""
import importlib.util, hashlib, json, shutil, argparse
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',type=Path,required=True);parser.add_argument('--repo',type=Path);parser.add_argument('--output',type=Path)
args=parser.parse_args();R=args.root.resolve();W=R.parent;OUT=(args.output or R/'integration/candidate-runtime').resolve();OUT.mkdir(parents=True,exist_ok=True)
repo=(args.repo or Path(__file__).resolve().parents[2]).resolve()
spec=importlib.util.spec_from_file_location('packer',repo/'tools/desktop-companion-animation/pack_sequence.py');pack=importlib.util.module_from_spec(spec);spec.loader.exec_module(pack)
inv=json.loads((R/'integration/inventory.json').read_text());seq={s['id']:s['frames'] for s in inv['sequences']};pool=OUT/'pool';(pool/'sources').mkdir(parents=True,exist_ok=True)
unique={f['sha256']:f for s in inv['sequences'] for f in s['frames']}
corePath=R/'relocation/core-transition-contract-v3.json';core=json.loads(corePath.read_text())
for n in core['nodes'].values():
 p=(corePath.parent/n['source']).resolve();h=hashlib.sha256(p.read_bytes()).hexdigest()
 if h!=n['sourceSHA256']:raise ValueError('core source hash mismatch')
 unique[h]={'source':str(p.relative_to(W)),'sha256':h,'durationMs':100,'cue':'RECOVERY_ONLY'}
from compile_upright_pickup import compile_pickup
pickupNodes,pickupSources=compile_pickup(R,inv,core)
unique.update(pickupSources)
for h,f in unique.items():shutil.copyfile(W/f['source'],pool/'sources'/f'{h}.png')
meta={'id':'upright-source-pool','canvas':[512,512],'frames':[{'source':f'sources/{h}.png','durationMs':1} for h in unique]}
(pool/'source.json').write_text(json.dumps(meta));atlas=pack.pack(pool/'source.json',pool/'atlas');placements={f['sha256']:f for f in atlas['frames']}
for page in atlas['pages']:shutil.copyfile(pool/'atlas'/page['file'],OUT/page['file'])
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
anchors={sha(R/'shared/upright-open-neutral-v2.png'):'upright-v2:open-user',sha(R/'shared/open-screen-read-v2.png'):'upright-v2:open-screen',sha(R/'lid/frames/closed-rest-rigid-v2.png'):'upright-v2:closed',sha(R/'question-permission/poses/listen-rest.png'):'upright-v2:listen'}
packages=[]
def add(id,frames,kind='action',action=None,loop=None,poses=None,safe=None):
    fs=[];time=0;pages=[];pageMap={}
    for i,f in enumerate(frames):
        base=placements[f['sha256']];p=base['page']
        if p not in pageMap:pageMap[p]=len(pages);pages.append(atlas['pages'][p])
        pose=(poses or {}).get(i,anchors.get(f['sha256'],'upright-v2:draw:'+f['sha256'][:16]))
        duration=f.get('durationMs') or 800
        fs.append({'sha256':f['sha256'],'page':pageMap[p],'rect':base['rect'],'offset':base['offset'],'durationMs':duration,'startMs':time,'pose':pose,'phase':'hold' if loop else ('enter' if i==0 else 'exit' if i==len(frames)-1 else 'act'),'cue':f.get('cue'),'exitTo':[pose] if i in (safe or [0,len(frames)-1]) else []})
        time+=duration
    p={'id':'v2-'+id,'canvas':[512,512],'geometryReference':'varin-upright-v2','stage':'motion-candidate','reviewStatus':'candidate','kind':kind,'action':action,'entryPose':fs[0]['pose'],'exitPose':fs[-1]['pose'],'loop':loop,'durationMs':time,'frames':fs,'pages':pages,'warning':'Internal candidate. Not production accepted. Source-level visual checks do not imply full native/interrupt acceptance.'}
    packages.append(p);return p
for name in ['upright-gaze-screen-to-user','upright-gaze-user-to-screen']:add(name,seq[name],'bridge')
r=seq['reading'];add('reading-enter',r[:4],'bridge');add('reading',r[3:8],action='reading',loop=[0,5]);add('reading-exit',r[7:],'bridge')
e=seq['editing'];add('editing-enter',e[:2],'bridge');add('editing',e[1:19],action='editing',loop=[0,18]);add('editing-exit',e[18:],'bridge')
# A real eye-refocussing bridge closes the scan/select cycle, rather than aliasing different eyes.
s=seq['search']+seq['upright-gaze-screen-to-user'];add('search',s,action='browsing',loop=[0,len(s)],safe=[0,4,8,len(s)-1])
d=seq['collaboration'];add('dispatch-enter',d[:11],'bridge');watch=[d[i] for i in [10,11,12,13,14]]+seq['upright-gaze-screen-to-user']+[d[10]];add('dispatch',watch,action='dispatch',loop=[0,len(watch)]);add('dispatch-exit',[d[10],d[11]],'bridge')
blink=seq['waiting-blink']
for family,enter,exitName,action in [('question','questionEnter','questionCancel','query'),('permission','permissionEnter','permissionDenyOrCancel','permission')]:
    f=seq[enter];pose='upright-v2:'+family+'-listen';add(family+'-enter',f,'bridge',poses={len(f)-1:pose})
    rest={**f[-1],'durationMs':4800,'cue':'ATTEND'};hold=[rest,*blink,{**rest,'durationMs':300}]
    add(family+'-hold',hold,action=action,loop=[0,len(hold)],poses={0:pose,len(hold)-1:pose})
    tail=seq[exitName];add(family+'-exit',tail,'bridge',poses={0:pose})
    response=seq['questionAnswered' if family=='question' else 'permissionAllow'];add(family+'-receipt',response,action='understood' if family=='question' else 'permission-allowed',poses={0:pose})
for name,action in [('local-welcome','welcome'),('local-tap','tap-response'),('local-completion','completion'),('local-open-tap','tap-response')]:add(name,seq[name],action=action)
user=seq['upright-gaze-user-to-screen'][0];closed=seq['lid-opening'][0]
quiet=json.loads((R/'closed-idle/manifest.json').read_text())
quietPackage=add('idle-closed',seq['closed-idle'],action='idle-closed',loop=quiet['loop'],safe=list(range(len(quiet['frames']))))
for f in quietPackage['frames']:f['pauseSafe']=f['sha256']==quiet['canonicalClosedSHA256']
seenQuiet=set()
for i,indices in quiet['safeRecoveryFromActualExposure'].items():
 first=seq['closed-idle'][int(i)]
 if first['sha256'] in anchors or first['sha256'] in seenQuiet:continue
 seenQuiet.add(first['sha256']);ms=quiet['safeRecoveryExposureOverridesMs'][i]
 add('quiet-recover-'+i,[{**seq['closed-idle'][j],'durationMs':ms[k],'cue':'RECOVERY_ONLY'} for k,j in enumerate(indices)],'bridge')
# Body reuse is deliberate; factual labels remain immediate and never assert executor-stop.
for action in ['external-wait','execution-observe','cancel','uncertain','disconnected','failure']:
 add('neutral-'+action,[{**user,'durationMs':1000}],action={'cancel':'cancel-settling','uncertain':'unknown-effect-check'}.get(action,action),loop=[0,1])
opening=add('opening',seq['lid-opening'],'bridge');closing=add('closing',seq['lid-closing'],'bridge')
for a,b in [(opening,closing),(closing,opening)]:
 for f in a['frames']:
  j=next((i for i,g in enumerate(b['frames']) if g['sha256']==f['sha256']),None)
  if j is not None:f['motion']={'renderedPixelSha256':f['sha256'],'reverseFrom':{'sequence':b['id'],'frameIndex':j}}
# Core gestures compile from the supplied graph; variants preserve edge exposure timings.
variants={(name,100) for name in core['nodes']}
for n in core['nodes'].values():
 for field in ['grabNext','releaseNext']:
  variants.update((e['node'],e['durationMs']) for e in n[field])
def coreId(name,ms=100):return 'v2-core-'+name+'-'+str(ms)
entryMap={e['detachedNode']:e['sourceSHA256'] for e in core['entries']}
for name,ms in sorted(variants):
 n=core['nodes'][name];f={**unique[n['sourceSHA256']],'durationMs':ms}
 p=add('core-'+name+'-'+str(ms),[f],kind='gesture')
 p['gesture']={'grabImmediate':coreId(n['grabImmediate']),'grabNext':[coreId(e['node'],e['durationMs']) for e in n['grabNext']],'releaseNext':[coreId(e['node'],e['durationMs']) for e in n['releaseNext']],'embeddedStool':n['embeddedStool'],'settled':name=='closedSeated','restoreOnRelease':bool(n.get('originalSeatedSHA256'))}
 if n['embeddedStool'] and name!='closedSeated' and not n['releaseNext']:
  # Source graph lists landing as a complete route. When exact-source restore
  # enters its seated intermediate, retain that explicitly authored remaining tail.
  route=next((d['releaseNext'] for d in core['nodes'].values() if d.get('originalSeatedSHA256')==n['sourceSHA256'] and d['releaseNext'] and d['releaseNext'][0]['node']==name),[])
  p['gesture']['releaseNext']=[coreId(e['node'],e['durationMs']) for e in route[1:]]
 if ms==100 and name in entryMap:p['gesture']['entrySourceSha256']=entryMap[name]
 if n.get('originalSeatedSHA256'):p['gesture']['restoreSourceSha256']=n['originalSeatedSHA256']
for id,n in pickupNodes.items():
 p=add(id,[n],kind='gesture');p['gesture']=n['gesture']
world=core['worldStool'];worldPath=corePath.parent/world['source'];worldHash=hashlib.sha256(worldPath.read_bytes()).hexdigest();worldFile='world-stool-'+worldHash[:16]+'.png';shutil.copyfile(worldPath,OUT/worldFile)
# Bridge selection and the actually drawn performance family are different fields.
# Entry gestures must drive their own scene, without becoming request targets.
for p in packages:
    for family,action in [('reading','reading'),('editing','editing'),('search','browsing'),('dispatch','dispatch'),('question','query'),('permission','permission')]:
        if p['id'].startswith('v2-'+family):p['sceneAction']=action
(OUT/'bundle.json').write_text(json.dumps({'version':1,'candidateOnly':True,'geometryEpoch':'varin-upright-v2','worldStool':{'file':worldFile,'sha256':worldHash,'canvas':[512,512]},'packages':packages},ensure_ascii=False,indent=2)+'\n')
(OUT/'build-receipt.json').write_text(json.dumps({'packageCount':len(packages),'uniqueSourceCount':len(unique),'atlasCount':len(atlas['pages']),'productionInstalled':False,'acceptance':'none; use explicit allowCandidates review option','knownMissing':[],'scopeNotes':['External waiting, cancellation and uncertain/failure recovery deliberately reuse the selected upright neutral body; actual Host status remains distinct and no executor-stop outcome is fabricated.']},indent=2)+'\n')
print(len(packages),'candidate packages',len(atlas['pages']),'shared atlases')
