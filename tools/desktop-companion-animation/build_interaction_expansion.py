"""Append authored interactions to the immutable selected upright base; never install or accept art."""
import argparse,copy,hashlib,importlib.util,json,math,shutil
from pathlib import Path
from PIL import Image
from compile_upright_pickup import compile_pickup, compile_explicit_baseline

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',type=Path,help='production-v3 source root')
parser.add_argument('--base-source',type=Path,help='reproducible production-v2 source root')
parser.add_argument('--base-bundle',type=Path,help='immutable selected v2 bundle.json; may be rebuilt from source')
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--director-manifest',type=Path,help='Optional explicit authored management sequences; review-only, not a production selection')
parser.add_argument('--local-interaction-manifest',type=Path,action='append',help='Optional exact local hover/repeat source contract; candidate only')
parser.add_argument('--performance-manifest',type=Path,help='Explicit replacement performances and actual-source recovery; excludes legacy v3 display plans, keeps mechanical base; candidate only')
parser.add_argument('--pickup-manifest',type=Path,help='Optional explicit source-keyed pickup/landing graph for replacement performances; candidate only')
parser.add_argument('--detached-index',type=Path,help='explicit immutable new-source no-stool index')
parser.add_argument('--baseline-manifest',type=Path,help='Explicit clean candidate baseline; excludes all legacy base/art inputs')
a=parser.parse_args()
if a.baseline_manifest:
 if any((a.root,a.base_source,a.base_bundle,a.detached_index,a.director_manifest,a.local_interaction_manifest,a.performance_manifest,a.pickup_manifest)):
  parser.error('--baseline-manifest cannot mix with legacy/expansion inputs')
 print(json.dumps(compile_explicit_baseline(a.baseline_manifest,a.output),indent=2));raise SystemExit(0)
if not all((a.root,a.base_source,a.base_bundle,a.detached_index)):
 parser.error('Expansion requires --root, --base-source, --base-bundle and --detached-index')
R=a.root.resolve();B=a.base_source.resolve();OUT=a.output.resolve();OUT.mkdir(parents=True,exist_ok=True)
if a.performance_manifest and (a.director_manifest or a.local_interaction_manifest):
 parser.error('--performance-manifest cannot mix with legacy director/local manifests')
if a.pickup_manifest and not a.performance_manifest:
 parser.error('--pickup-manifest requires --performance-manifest')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
BASE_SHA='399bf528c3ee7b601ddbd1ca126df123a8a04b78d353b5a3216d1fce8ab1d268'
if sha(a.base_bundle)!=BASE_SHA:raise ValueError('Base is not the frozen upright selected bundle; rebuild v2, do not use mutable selected v3 output')
base=json.loads(a.base_bundle.read_text());packages=copy.deepcopy(base['packages']);baseIds={p['id'] for p in packages}
baseLedger=json.loads((a.base_bundle.parent/'acceptance.json').read_text())
if baseLedger['selectedBundleSha256']!=BASE_SHA:raise ValueError('Base acceptance does not identify the frozen bundle')
placements={}
for p in packages:
 for f in p['frames']:
  placements.setdefault(f['sha256'],{**f,'pageDescriptor':p['pages'][f['page']]})
for file in {page['file'] for p in packages for page in p['pages']}|{base['worldStool']['file']}:
 if sha(a.base_bundle.parent/file)!=baseLedger['fileSha256'].get(file):raise ValueError(f'Frozen base texture mismatch: {file}')
 shutil.copyfile(a.base_bundle.parent/file,OUT/file)

sources={};plans=[];recovery={};provenance=[]
def frame(root,f):
 path=(root/f['source']).resolve();h=sha(path)
 if h!=f.get('sourceSHA256',f.get('sha256')):raise ValueError(f'Source SHA mismatch: {path}')
 if a.performance_manifest:
  ms=f.get('durationMs')
  if isinstance(ms,bool) or not isinstance(ms,(int,float)) or not math.isfinite(ms) or ms<=0:
   raise ValueError('Replacement exposure must be finite and positive')
  with Image.open(path) as image:
   if image.size!=(512,512):
    raise ValueError('Replacement source must be registered to an actual 512x512 canvas; never silently resize raw art: '+str(path))
 sources[h]=path
 return {'sha256':h,'durationMs':f['durationMs'],'cue':f.get('cue'),'phase':f.get('phase','act'),'pauseSafe':f.get('pauseSafe',False)}
localPlans=[]
replacementActions=None
if a.performance_manifest:
 performancePath=a.performance_manifest.resolve()
 performance=json.loads(performancePath.read_text())
 provenance.append({'source':str(performancePath.relative_to(R)),'sha256':sha(performancePath)})
 if performance.get('canvas')!=[512,512] or performance.get('geometryReference')!='varin-upright-v2':
  raise ValueError('Replacement drawings must be explicitly registered to the existing 512px upright mechanical canvas')
 declared=performance.get('replaceActions')
 if not isinstance(declared,list) or not declared or any(not isinstance(x,str) or not x for x in declared) or len(set(declared))!=len(declared):
  raise ValueError('replaceActions must name each replaced display action once')
 replacementActions=set(declared)
 sequences=performance.get('sequences')
 if not isinstance(sequences,list) or not sequences:
  raise ValueError('Replacement performances need authored sequences')
 ids=set()
 for sequence in sequences:
  name=sequence.get('id');kind=sequence.get('kind')
  if not isinstance(name,str) or not name or name in ids or name in baseIds:
   raise ValueError('Replacement sequence IDs must be unique and not shadow mechanical package IDs')
  ids.add(name)
  loop=sequence.get('loop')
  if loop is not None and (not isinstance(loop,list) or len(loop)!=2 or any(type(x) is not int for x in loop) or not 0<=loop[0]<loop[1]<=len(sequence.get('frames',[]))):
   raise ValueError('Replacement loop must be an authored [start,endExclusive] frame range')
  if kind not in ('action','bridge') or not sequence.get('frames'):
   raise ValueError('Replacement sequences must be nonempty authored actions or bridges')
  if kind=='action' and sequence.get('action') not in replacementActions:
   raise ValueError('Every replacement action must be explicitly declared')
  if kind=='bridge' and sequence.get('action') is not None:
   raise ValueError('A recovery bridge must not trigger a display action')
  localPlans.append({**sequence,'frames':[frame(performancePath.parent,f) for f in sequence['frames']]})
 if {p.get('action') for p in localPlans if p['kind']=='action'}!=replacementActions:
  raise ValueError('Every replaced action requires an authored replacement')
 for row in performance.get('ordinaryRecoveryByActualSource',[]):
  h=row['actualSourceSHA256'];path=(performancePath.parent/row['source']).resolve()
  if sha(path)!=h or h in recovery:
   raise ValueError('Duplicate or mismatched actual-source recovery')
  frame(performancePath.parent,{'source':row['source'],'sha256':h,'durationMs':1})
  recovery[h]={'steps':[frame(performancePath.parent,f) for f in row['frames']]}
else:
 manifest=R/'task-reactions/manifest.json';task=json.loads(manifest.read_text());provenance.append({'source':str(manifest.relative_to(R)),'sha256':sha(manifest)})
 for name,action in task['actions'].items():
  plans.append({'name':name,'action':action.get('publicAction',name),'frames':[frame(manifest.parent,f) for f in action['frames']],'contract':action['phaseContract'],'root':manifest.parent})
 for h,r in task['ordinaryRecoveryBySourceSHA'].items():
  path=manifest.parent/r['source']
  if sha(path)!=h:raise ValueError('Recovery source mismatch')
  sources[h]=path;recovery[h]={'steps':[frame(manifest.parent,f) for f in r['steps']]}
 # Explicit authored blink sources, rather than an invented deform or full-body loop.
 for p in plans:
  blink=p['contract'].get('holdBlink')
  if blink:
   p['blink']=[]
   for name,ms in [('half',45),('closed',75),('half',45)]:
    path=p['root']/blink[name];h=sha(path);sources[h]=path
    p['blink'].append({'sha256':h,'durationMs':ms,'cue':'OBSERVE_REST','phase':'hold','pauseSafe':False})

 # The complete local chain is already authored as E/H/X sequences. Preserve it;
 # normalize identical source poses by SHA rather than trusting family labels.
 localManifest=R/'companionship/manifest.json'
 if localManifest.exists():
  local=json.loads(localManifest.read_text());provenance.append({'source':str(localManifest.relative_to(R)),'sha256':sha(localManifest)})
  for sequence in local['sequences']:
   localPlans.append({**sequence,'frames':[frame(localManifest.parent,f) for f in sequence['frames']]})
  for row in local['safeRecoveryByActualSource']:
   h=row['actualSourceSHA256']
   recovery[h]={'steps':[frame(localManifest.parent,f) for f in row['frames']]}

 # New local responses are opt-in, so the frozen prior candidate stays rebuildable.
 for localInput in a.local_interaction_manifest or []:
  localPath=localInput.resolve();local=json.loads(localPath.read_text())
  provenance.append({'source':str(localPath.relative_to(R)),'sha256':sha(localPath)})
  def local_frame(f):return frame(localPath.parent,{**f,'sourceSHA256':f['actualSourceSHA']})
  for name,action in local['actions'].items():
   if action.get('wholeSequenceLoop') is not False:raise ValueError('Local response must be finite')
   localPlans.append({'id':name,'kind':'action','action':action.get('publicAction',name),'loop':None,'frames':[local_frame(f) for f in action['frames']]})
  for h,steps in local['ordinaryRecoveryByActualSHA'].items():
   # Existing shared endpoints retain their already authored cross-family recovery.
   if h not in recovery:recovery[h]={'steps':[local_frame(f) for f in steps]}

 # Management performances retain directional action identity. Project execution
 # detail is not their trigger and must never be inferred from these source cues.
 if a.director_manifest:
  directorPath=a.director_manifest.resolve();director=json.loads(directorPath.read_text())
  provenance.append({'source':str(directorPath.relative_to(R)),'sha256':sha(directorPath)})
  for name,action in director['actions'].items():
   localPlans.append({'id':name,'kind':'action','action':name,'loop':None,'frames':[frame(directorPath.parent,f) for f in action['frames']]})
  for h,row in director['ordinaryRecoveryBySourceSHA'].items():
   path=directorPath.parent/row['actualSource']
   if sha(path)!=h:raise ValueError('Director actual recovery source mismatch')
   sources[h]=path;steps=[frame(directorPath.parent,f) for f in row['frames']]
   # A group's own rest has no internal return; keep its existing cross-family
   # real hand recovery rather than erasing that route with an empty endpoint.
   if steps or h not in recovery:recovery[h]={'steps':steps}

 if a.local_interaction_manifest:
  # The normal supervisor starts with a hand holding the laptop edge. Local
  # attention reaches its open-user entrance through the real hand-return image,
  # not the old two-exposure listening-to-neutral convenience return.
  listen='0633d12e97fd3e8f2bdb5b3bcfbcb7463888412e19263bd88e7ba12d14d2827a'
  attendPath='question-permission/poses/attend-corrected.png'
  attendHash='fe99fc6fdc42127249f67a5c3fa59bbb9cb02648ebd6a11e5394fadc6e69342f'
  provenance.append({'baseSource':attendPath,'sha256':attendHash})
  recovery[listen]={'steps':[frame(B,{'source':attendPath,'sourceSHA256':attendHash,'durationMs':120,'cue':'RECOVERY_ONLY'}),frame(B,{'source':'shared/upright-open-neutral-v2.png','sourceSHA256':sha(B/'shared/upright-open-neutral-v2.png'),'durationMs':160,'cue':'REST','pauseSafe':True})]}


# Add only source-exact new entries; the prior 55-entry graph remains untouched.
rel=R/'relocation';indexPath=a.detached_index.resolve()
index=json.loads(indexPath.read_text());provenance.append({'source':str(indexPath.relative_to(R)),'sha256':sha(indexPath)})
detached={e['sourceSHA256']:{**e,'detachedSource':str((R/e['detachedSource']).resolve())} for e in index['entries']}
oldEntries={p['gesture']['entrySourceSha256'] for p in packages if p.get('gesture',{}).get('entrySourceSha256')}
oldDetached=json.loads((B/'relocation/current-source-detached-index-v4.json').read_text())
available={e['sourceSHA256'] for e in oldDetached['entries']}|set(detached)
newOrdinary=set(sources)-oldEntries
missing=[];ready=[]
for h in sorted(newOrdinary):
 route=recovery.get(h)
 required={h}|{f['sha256'] for f in route['steps']} if route else {h}
 if not route or not required<=available:missing.append({'sourceSHA256':h,'missingRecovery':not bool(route),'missingDetached':sorted(required-available)})
 else:ready.append({'sha256':h})
if replacementActions is not None and missing:
 raise ValueError('Replacement source recovery/detached contacts are incomplete: '+json.dumps(missing))
authoredPickup=None
if a.pickup_manifest:
 pickupPath=a.pickup_manifest.resolve();authoredPickup=json.loads(pickupPath.read_text())
 provenance.append({'source':str(pickupPath.relative_to(R)),'sha256':sha(pickupPath)})
 declared=authoredPickup.get('replaceEntrySources')
 if not isinstance(declared,list) or not declared or len(set(declared))!=len(declared) or any(not isinstance(h,str) or len(h)!=64 for h in declared):
  raise ValueError('Authored pickup must explicitly declare unique actual source replacements')
 if not isinstance(authoredPickup.get('nodes'),list) or not authoredPickup['nodes']:
  raise ValueError('Authored pickup requires explicit nodes')
 ids=set();allowed={'grabNext','releaseNext','embeddedStool','settled','restoreOnRelease','releaseViaFrames','restorePreviousOnSettle','grabImmediate','entrySourceSha256','restoreSourceSha256'}
 for row in authoredPickup['nodes']:
  if not isinstance(row.get('id'),str) or not row['id'].startswith('v2-') or row['id'] in ids or row['id'] in baseIds:raise ValueError('Authored pickup node IDs must not duplicate or shadow base IDs')
  ids.add(row.get('id'));frame(pickupPath.parent,row)
  row['sourcePath']=(pickupPath.parent/row['source']).resolve();g=row.get('gesture')
  if not isinstance(g,dict) or set(g)-allowed:raise ValueError('Unknown authored gesture field')
  if any(not isinstance(g.get(k),list) or any(not isinstance(x,str) or not x for x in g[k]) for k in ('grabNext','releaseNext')):
   raise ValueError('Authored gesture routes must be explicit ordered node ID lists')
  if any(type(g.get(k)) is not bool for k in ('embeddedStool','settled','restoreOnRelease')):
   raise ValueError('Authored gesture contact and settle flags must be explicit booleans')
  if any(k in g and type(g[k]) is not bool for k in ('releaseViaFrames','restorePreviousOnSettle')):
   raise ValueError('Authored optional gesture flags must be booleans')
  if any(k in g and (not isinstance(g[k],str) or not g[k]) for k in ('grabImmediate','entrySourceSha256','restoreSourceSha256')):raise ValueError('Authored gesture source and immediate identifiers must be nonempty strings')
  if g.get('restoreSourceSha256') and g['releaseNext'] and not g.get('releaseViaFrames'):raise ValueError('Authored drawn release with restore source requires releaseViaFrames')
  if g['embeddedStool'] and not g.get('grabImmediate'):raise ValueError('Authored seated gesture needs its same-pose immediate detached node')
core=json.loads((B/'relocation/core-transition-contract-v3.json').read_text())
nodes,pickSources=compile_pickup(B,json.loads((B/'integration/inventory.json').read_text()),core,extra_detached=detached,extra_recovery=recovery,ordinary_frames=ready,authored_pickup=authoredPickup)
for h,f in pickSources.items():sources[h]=B.parent/f['source']

# New pages have their own names; no duplication/repacking of base textures.
new={h:path for h,path in sources.items() if h not in placements};pool=OUT/'pool';(pool/'sources').mkdir(parents=True,exist_ok=True)
if new:
 for h,path in sorted(new.items()):shutil.copyfile(path,pool/'sources'/f'{h}.png')
 source={'id':'interaction-expansion-pool','canvas':[512,512],'frames':[{'source':f'sources/{h}.png','durationMs':1} for h in sorted(new)]}
 (pool/'source.json').write_text(json.dumps(source))
 spec=importlib.util.spec_from_file_location('packer',Path(__file__).with_name('pack_sequence.py'));packer=importlib.util.module_from_spec(spec);spec.loader.exec_module(packer)
 packed=packer.pack(pool/'source.json',pool/'atlas')
 pages=[]
 for page in packed['pages']:
  dest='expansion-'+page['file'];shutil.copyfile(pool/'atlas'/page['file'],OUT/dest);pages.append({**page,'file':dest})
 for f in packed['frames']:placements[f['sha256']]={**f,'pageDescriptor':pages[f['page']]}
canonical={sha(B/'shared/upright-open-neutral-v2.png'):'upright-v2:open-user',sha(B/'shared/open-screen-read-v2.png'):'upright-v2:open-screen',sha(B/'lid/frames/closed-rest-rigid-v2.png'):'upright-v2:closed'}
pose=lambda h:canonical.get(h,'upright-v2:draw:'+h[:16])
newPackages=[]
def add(name,fs,kind='bridge',action=None,loop=None,sceneAction=None):
 if not fs:return None
 out=[];pages=[];pageMap={};time=0
 for f in fs:
  placement=placements[f['sha256']];page=placement['pageDescriptor'];key=page['file']
  if key not in pageMap:pageMap[key]=len(pages);pages.append(page)
  duration=f['durationMs']
  if duration<=0:raise ValueError('Nonpositive exposure')
  h=f['sha256'];q=pose(h)
  out.append({'sha256':h,'page':pageMap[key],'rect':placement['rect'],'offset':placement['offset'],'durationMs':duration,'startMs':time,'pose':q,'phase':f.get('phase','act'),'cue':f.get('cue'),'pauseSafe':f.get('pauseSafe',False),'exitTo':[q] if h in canonical or h in recovery else []})
  time+=duration
 p={'id':name,'canvas':[512,512],'geometryReference':'varin-upright-v2','reviewStatus':'candidate','stage':'motion-candidate','kind':kind,'action':action,'entryPose':out[0]['pose'],'exitPose':out[-1]['pose'],'frames':out,'pages':pages,'durationMs':time,'loop':loop,'sceneAction':sceneAction,'warning':('authored replacement candidate' if replacementActions is not None else 'v3 source candidate')+': normal-speed/whole-route acceptance required; never auto-promote'}
 newPackages.append(p);return p
for p in plans:
 name=p['name'];fs=p['frames'];c=p['contract'];action=p['action']
 hold=c.get('holdIndexes')
 if hold is None:
  add('v3-'+name,fs,'action',action,sceneAction=action);continue
 h=[{**fs[i],'pauseSafe':fs[i]['pauseSafe'] or i in c.get('pauseSafeHoldIndexes',[])} for i in hold]
 if p.get('blink'):
  h=[{**h[0],'durationMs':4500},*p['blink'],{**h[0],'durationMs':2500}]
 elif len(h)==1:h[0]['durationMs']=3000
 # Every long state has a stable looping exposure, including failure's neutral hold.
 enter=[fs[i] for i in c.get('enterIndexes',[])]
 exit=[fs[i] for i in c.get('exitIndexes',[])]
 if action == 'output':
  # This unique content-pointer pose supports event-triggered beats without
  # lowering/re-raising the arm between actual text deltas.
  if enter:add('v3-'+name+'-enter',[*enter,{**h[0],'durationMs':1}],sceneAction=action)
  add('v3-'+name,h,'action',action,[0,len(h)],action)
  if exit:add('v3-'+name+'-exit',[{**h[-1],'durationMs':1},*exit],sceneAction=action)
 else:
  # Shared observation holds are NOT interchangeable activity entrances.
  # Each request starts its own real enter drawings; only its hold repeats.
  add('v3-'+name,[*enter,*h,*exit],'action',action,[len(enter),len(enter)+len(h)],action)
 if c.get('onRealProgressBeatIndexes'):
  beat=[{**h[0],'durationMs':1},*[fs[i] for i in c['onRealProgressBeatIndexes']]]
  add('v3-'+name+'-beat',beat,'action','output-emphasis',sceneAction=action)
# A generic observation transition admits neutral cancellation/sync holds.
# It uses the authored external-wait contact drawings, never a permission/answer tail.
if replacementActions is None:
 observer=next(p for p in plans if p['name']=='external-wait')
 add('v3-observation-settle',[{**f,'cue':'RECOVERY_ONLY'} for f in observer['frames']])
for p in localPlans:
 # A tap-specific convenience bridge cannot be a global pose shortcut: it
 # would replay a response during unrelated interruption. Current consumer
 # uses the source-exact neutral recovery followed by its closed tap action.
 if replacementActions is None and p['id'].endswith('hover-to-tap'):continue
 add(p['id'] if replacementActions is not None else 'v3-'+p['id'],p['frames'],p['kind'],p.get('action') if p['kind']=='action' else None,p.get('loop'),p.get('action') if (p.get('action') or '').startswith('director-') else None)
if a.director_manifest:
 # Explicit new ordering, not a borrowed question/permission sentence. This
 # bridge remains a candidate until the actual hand-contact timing is reviewed.
 neutral=sha(B/'shared/upright-open-neutral-v2.png')
 attend='fe99fc6fdc42127249f67a5c3fa59bbb9cb02648ebd6a11e5394fadc6e69342f'
 if attend not in placements:raise ValueError('Missing exact existing attend hand drawing')
 listen='0633d12e97fd3e8f2bdb5b3bcfbcb7463888412e19263bd88e7ba12d14d2827a'
 add('v3-director-neutral-to-listen',[{'sha256':h,'durationMs':ms,'cue':'RECOVERY_ONLY'} for h,ms in [(neutral,120),(attend,120),(listen,180)]])
 # Comfortable supervision is a held listening pose with its already drawn
 # blink, not the focused project's typing/reading loop renamed as management.
 blink=next(p for p in base['packages'] if p['id']=='v2-question-hold')['frames']
 add('v3-director-supervise',[{'sha256':f['sha256'],'durationMs':f['durationMs'],'cue':'REST','pauseSafe':f['sha256']==listen} for f in blink], 'action','director-supervise',[0,len(blink)],'director-supervise')
 # Local user attention is not a project handoff or an approval. Exact existing
 # face-only smile preserves the open laptop and all hand/body pixels.
 smile='e11e8ffe9617e9714f6ada8911566d100cdb9516e4921056f007d1c99d4c72fc'
 if smile not in placements:raise ValueError('Missing exact open local smile drawing')
 add('v3-director-open-attention',[{'sha256':h,'durationMs':ms,'cue':'LOCAL_ATTENTION','pauseSafe':h==neutral} for h,ms in [(neutral,80),(smile,180),(neutral,100)]], 'action','director-open-attention')
 # A complete one-shot project intake uses real receipt then handoff drawings.
 # It is triggered only by a scoped project edge, never by a tool/child count.
 received=next(p for p in plans if p['name']=='accept-open')['frames'][1:]
 intake=[{**f,'cue':'RECEIVE_PROJECT' if f['cue']=='RECEIVED' else 'RECOVERY_ONLY'} for f in received]
 collaborationPath=B/'editing-dispatch/sequence-manifest.json'
 collaboration=json.loads(collaborationPath.read_text())['sequences']['collaboration']['frames']
 provenance.append({'baseSource':'editing-dispatch/sequence-manifest.json','sha256':sha(collaborationPath)})
 # One right-hand handoff, then its authored inward rotation/lowering; no
 # repeated dispatch and no tool typing tail. The graphic travels to the lead.
 for i in [1,2,3,4,5,6,9,11]:
  f=collaboration[i];h=f['sourceSHA256']
  if h not in placements:raise ValueError('Missing exact intake donor drawing')
  intake.append({'sha256':h,'durationMs':f['holdMs'] if i!=11 else 200,'cue':'HANDOFF_LEAD' if i==4 else 'RECOVERY_ONLY','pauseSafe':i==11})
 add('v3-director-intake',intake,'action','director-intake',None,'director-intake')


for h,r in recovery.items():
 if r['steps']:add('v3-recover-'+h[:16],[{'sha256':h,'durationMs':1,'cue':'RECOVERY_ONLY'},*[{**f,'cue':'RECOVERY_ONLY'} for f in r['steps']]])
for name,n in nodes.items():
 id='v2-'+name
 if id in baseIds:continue
 p=add(id,[n],'gesture');p['gesture']=n['gesture']
if authoredPickup:
 # Retain old nodes for their existing internal references, but remove the old
 # entry binding. Both consumers must resolve one authoritative source entry.
 replaceEntries=set(authoredPickup['replaceEntrySources'])
 newEntryIds={row['id'] for row in authoredPickup['nodes'] if row['gesture'].get('entrySourceSha256')}
 for p in packages+newPackages:
  g=p.get('gesture')
  if g and g.get('entrySourceSha256') in replaceEntries and p['id'] not in newEntryIds:
   g.pop('entrySourceSha256')
   # A changed accepted binding is new reviewed metadata, not an unchanged base
   # package. The existing selector must include this ID in its exact review set.
   if p.get('reviewStatus')=='accepted':
    p['reviewStatus']='candidate'
    p['warning']='Candidate source-entry rebinding; original drawing and internal ID retained; exact review required.'
# Existing actions superseded by new authored performances cannot win shortest-path selection.
replaced={p['action'] for p in newPackages if p.get('action')}
packages=[p for p in packages if p.get('action') not in replaced or replacementActions is None and p.get('action')=='tap-response' and p['entryPose']!='upright-v2:closed']+newPackages
if authoredPickup:
 allIds={};entryIds={};authoredIds={row['id'] for row in authoredPickup['nodes']}
 seatedSources={f['sha256'] for p in packages if not p.get('gesture') or p['gesture']['embeddedStool'] for f in p['frames']}
 for p in packages:
  if p['id'] in allIds:raise ValueError('Duplicate final pickup/package ID: '+p['id'])
  allIds[p['id']]=p
  g=p.get('gesture',{});entry=g.get('entrySourceSha256')
  if entry:
   if entry in entryIds:raise ValueError('Ambiguous final pickup source entry: '+entry)
   entryIds[entry]=p['id']
 for p in packages:
  g=p.get('gesture')
  if not g:continue
  targets=[*g['grabNext'],*g['releaseNext']]+([g['grabImmediate']] if g.get('grabImmediate') else [])
  if any(t not in allIds or not allIds[t].get('gesture') for t in targets):raise ValueError('Dangling/non-gesture pickup route: '+p['id'])
  if g.get('grabImmediate') and allIds[g['grabImmediate']]['gesture']['embeddedStool']:raise ValueError('Immediate pickup counterpart still contains stool: '+p['id'])
  if p['id'] in authoredIds:
   if g.get('entrySourceSha256') and (g['embeddedStool'] or g['entrySourceSha256'] not in seatedSources):raise ValueError('Authored entry must detach an actual seated source: '+p['id'])
   if g.get('restoreSourceSha256') and g['restoreSourceSha256'] not in seatedSources:raise ValueError('Authored restore source has no actual seated counterpart: '+p['id'])
   restores=g['restoreOnRelease'] and bool(g.get('restoreSourceSha256')) and not g.get('releaseViaFrames')
   lands=bool(g['releaseNext']) and allIds[g['releaseNext'][-1]]['gesture']['settled']
   if not (g['settled'] or restores or lands):raise ValueError('Authored release must restore its source or terminate settled: '+p['id'])
   if g.get('releaseViaFrames') and not lands:raise ValueError('Authored release must terminate at a settled source: '+p['id'])
for item in provenance:
 if sha(B/item['baseSource'] if 'baseSource' in item else R/item['source'])!=item['sha256']:raise ValueError('Source changed while compiling; retry after owner freezes source')
result={**base,'candidateOnly':True,'packages':packages};(OUT/'bundle.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
receipt={'baseBundleSHA256':BASE_SHA,'candidateSHA256':sha(OUT/'bundle.json'),'sourceManifests':provenance,'newUniqueDrawings':len(new),'baseTexturesUnchanged':True,'atlasFileBytes':sum((OUT/f).stat().st_size for f in {page['file'] for p in packages for page in p['pages']}),'newOrdinarySources':len(newOrdinary),'missing':missing,'newEntrySources':len(ready),'packageCount':len(packages),'productionInstalled':False,'reviewStatus':'candidate'}
(OUT/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
