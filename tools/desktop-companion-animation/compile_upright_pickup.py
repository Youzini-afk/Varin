"""Source-keyed graph compiler; no new player, inferred poses or artwork."""
import json,hashlib

def compile_pickup(root, inventory, core, *, extra_detached=None, extra_recovery=None, ordinary_frames=None):
 rel=root/'relocation'; work=root.parent; nodes={}; sources={}
 index=json.loads((rel/'current-source-detached-index-v4.json').read_text()); detached={e['sourceSHA256']:e for e in index['entries']}
 detached.update(extra_detached or {})
 recovery=json.loads((root/'integration/recovery-by-source.json').read_text())['routes']
 recovery.update(extra_recovery or {})
 support=json.loads((rel/'lid-support-bridge-v1.json').read_text()); angles={f['angle']:f for f in support['frames']}; bysha={f['originalSeatedSHA256']:f for f in support['frames']}
 ordinary={f['sha256']:f for f in ordinary_frames} if ordinary_frames is not None else {f['sha256']:f for s in inventory['sequences'] if s['id']!='relocation-core' for f in s['frames']}
 def image(path, expected):
  path=path.resolve(); actual=hashlib.sha256(path.read_bytes()).hexdigest()
  if actual!=expected:raise ValueError(f'pickup source mismatch: {path}')
  sources[actual]={'source':str(path.relative_to(work)),'sha256':actual,'durationMs':100,'cue':'RECOVERY_ONLY'}
  return actual
 def node(id,h,ms,**gesture):
  nodes[id]={'sha256':h,'durationMs':ms,'cue':'RECOVERY_ONLY','gesture':{'grabNext':[],'releaseNext':[],'embeddedStool':False,'settled':False,'restoreOnRelease':False,**gesture}}
  return 'v2-'+id
 def core_id(name,ms=100):return 'v2-core-'+name+'-'+str(ms)
 closed=hashlib.sha256((root/'lid/frames/closed-rest-rigid-v2.png').read_bytes()).hexdigest()
 user=hashlib.sha256((root/'shared/upright-open-neutral-v2.png').read_bytes()).hexdigest()
 screen=hashlib.sha256((root/'shared/open-screen-read-v2.png').read_bytes()).hexdigest()
 # Each angle lands at its actual contact/seated projection, not universal closed.
 order=support['parallelClosingAngles']
 for angle,f in angles.items():
  ms=support['closingStepDurationMs'][str(angle)]
  seated=image(rel/f['originalSeatedSource'],f['originalSeatedSHA256']); same=image(rel/f['samePoseDetachedSource'],f['samePoseDetachedSHA256']); air=image(rel/f['source'],f['sourceSHA256']); contact=image(rel/f['contactNoStoolSource'],f['contactNoStoolSHA256'])
  suffix=[f'v2-lid-air-{a}' for a in order[order.index(angle)+1:]]+[core_id('airborneNeutral')]
  recoveryPath=[f'v2-lid-touch-{angle}',f'v2-lid-seat-{angle}']
  node(f'lid-air-{angle}',air,ms,grabNext=suffix,releaseNext=recoveryPath,restoreSourceSha256=seated,releaseViaFrames=True)
  node(f'lid-touch-{angle}',contact,80,grabNext=[f'v2-lid-air-{angle}',*suffix],releaseNext=[f'v2-lid-seat-{angle}'],restoreSourceSha256=seated,releaseViaFrames=True)
  node(f'lid-seat-{angle}',seated,80,grabImmediate=f'v2-lid-same-{angle}',grabNext=[f'v2-lid-touch-{angle}',f'v2-lid-air-{angle}',*suffix],embeddedStool=True,settled=True,restorePreviousOnSettle=True)
  node(f'lid-same-{angle}',same,70,grabNext=[f'v2-lid-touch-{angle}',f'v2-lid-air-{angle}',*suffix],restoreSourceSha256=seated,restoreOnRelease=True)
 closing=next(s['frames'] for s in inventory['sequences'] if s['id']=='lid-closing')
 gaze=next(s['frames'] for s in inventory['sequences'] if s['id']=='upright-gaze-screen-to-user')
 # Prefix ends as soon as the real hand/lid support angle is reached. The subsequent
 # loss of support and closing use airborne source art in parallel, not seated delay.
 def plan(h):
  steps=[{'sha256':h,'durationMs':60}]
  if h not in bysha:
   steps.extend(recovery[h]['steps'])
  stop=next((i for i,f in enumerate(steps) if f['sha256'] in bysha),None)
  if stop is not None:return steps[:stop+1],bysha[steps[stop]['sha256']]['angle']
  end=steps[-1]['sha256']
  if end==closed:return steps,None
  if end==screen:steps.extend({**f,'durationMs':min(f['durationMs'],130)} for f in gaze[1:]);end=user
  if end!=user:raise ValueError(f'No authored support connection for {h}: {end}')
  for f in closing[1:]:
   steps.append({**f,'durationMs':min(f['durationMs'],100)})
   if f['sha256'] in bysha:return steps,bysha[f['sha256']]['angle']
  raise ValueError('No lid support prefix')
 coreEntries={e['sourceSHA256'] for e in core['entries']}
 for source in ordinary:
  steps,angle=plan(source)
  ids=[f'v2-pick-{source[:16]}-{i}' for i in range(len(steps))]
  tail=([f'v2-lid-touch-{angle}',f'v2-lid-air-{angle}',*[f'v2-lid-air-{a}' for a in order[order.index(angle)+1:]],core_id('airborneNeutral')] if angle is not None else [core_id('closedDetached'),*[core_id(e['node'],e['durationMs']) for e in core['nodes']['closedDetached']['grabNext']]])
  for i,f in enumerate(steps):
   h=f['sha256'];e=detached[h];dh=image(rel/e['detachedSource'],e['detachedSHA256'])
   props={'grabNext':ids[i+1:]+tail,'restoreSourceSha256':h,'restoreOnRelease':True}
   if i==0 and source not in coreEntries:props['entrySourceSha256']=source
   node(ids[i][3:],dh,min(f['durationMs'],160),**props)
 return nodes,sources
