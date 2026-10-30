"""Source-keyed graph compiler; no new player, inferred poses or artwork."""
import json,hashlib

def compile_pickup(root, inventory, core, *, extra_detached=None, extra_recovery=None, ordinary_frames=None, authored_pickup=None):
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
  seen={h}
  # A management sentence can recover to the exact listen-rest pose before
  # the already authored neutral hand return. Follow explicit source edges,
  # never substitute a family label or jump directly to the neutral body.
  while end not in {closed,user,screen} and end not in bysha:
   if end in seen or end not in recovery:raise ValueError(f'No finite authored recovery continuation for {h}: {end}')
   seen.add(end);tail=recovery[end]['steps']
   if not tail:raise ValueError(f'Empty authored recovery continuation for {end}')
   steps.extend(tail);end=steps[-1]['sha256']
  stop=next((i for i,f in enumerate(steps) if f['sha256'] in bysha),None)
  if stop is not None:return steps[:stop+1],bysha[steps[stop]['sha256']]['angle']
  if end==closed:return steps,None
  if end==screen:steps.extend({**f,'durationMs':min(f['durationMs'],130)} for f in gaze[1:]);end=user
  if end!=user:raise ValueError(f'No authored support connection for {h}: {end}')
  for f in closing[1:]:
   steps.append({**f,'durationMs':min(f['durationMs'],100)})
   if f['sha256'] in bysha:return steps,bysha[f['sha256']]['angle']
  raise ValueError('No lid support prefix')
 # Explicit artwork graph uses the existing flat continuation contract. It is
 # not a second player or an instruction to infer intermediate contacts.
 authoredEntries={}
 if authored_pickup:
  for row in authored_pickup['nodes']:
   id=row['id']
   if not isinstance(id,str) or not id.startswith('v2-') or id[3:] in nodes:
    raise ValueError('Authored pickup node ID is duplicate or not an existing v2 graph ID: '+str(id))
   h=image(row['sourcePath'],row['sourceSHA256']);gesture=row['gesture']
   entry=gesture.get('entrySourceSha256')
   if entry:
    if entry in authoredEntries:raise ValueError('Duplicate authored pickup entry source: '+entry)
    authoredEntries[entry]=id
   node(id[3:],h,row['durationMs'],**gesture)
  if set(authored_pickup['replaceEntrySources'])!=set(authoredEntries):
   raise ValueError('Authored replacement entry sources must exactly match its entry nodes')
 def authored_join(source):
  if not authoredEntries:return None
  steps=[{'sha256':source,'durationMs':60}];seen=set()
  while True:
   for i,f in enumerate(steps):
    if f['sha256'] in authoredEntries:return steps[:i],authoredEntries[f['sha256']]
   end=steps[-1]['sha256']
   if end in seen or end in {closed,user,screen} or end in bysha or end not in recovery:return None
   seen.add(end);tail=recovery[end]['steps']
   if not tail:return None
   steps.extend(tail)
 coreEntries={e['sourceSHA256'] for e in core['entries']}
 for source in ordinary:
  if source in authoredEntries:continue
  custom=authored_join(source)
  if custom:
   steps,target=custom;angle=None
  else:steps,angle=plan(source)
  ids=[f'v2-pick-{source[:16]}-{i}' for i in range(len(steps))]
  tail=([f'v2-lid-touch-{angle}',f'v2-lid-air-{angle}',*[f'v2-lid-air-{a}' for a in order[order.index(angle)+1:]],core_id('airborneNeutral')] if angle is not None else [core_id('closedDetached'),*[core_id(e['node'],e['durationMs']) for e in core['nodes']['closedDetached']['grabNext']]])
  if custom:tail=[target,*nodes[target[3:]]['gesture']['grabNext']]
  for i,f in enumerate(steps):
   h=f['sha256'];e=detached[h];dh=image(rel/e['detachedSource'],e['detachedSHA256'])
   props={'grabNext':ids[i+1:]+tail,'restoreSourceSha256':h,'restoreOnRelease':True}
   if i==0 and source not in coreEntries:props['entrySourceSha256']=source
   node(ids[i][3:],dh,min(f['durationMs'],160),**props)
 return nodes,sources


def compile_explicit_baseline(manifest_path, output):
    """Compile only declared source-keyed art for the existing player; never load legacy art.

    Every displayed seated source needs an explicit same-pose counterpart and
    entry. This proves source/graph integrity, not anatomical or visual acceptance.
    """
    import math
    import os
    import shutil
    from pathlib import Path
    from PIL import Image
    from pack_sequence import pack, FROZEN_STOOL_SHA256

    manifest_path, output = Path(manifest_path).resolve(), Path(output).resolve()
    raw = manifest_path.read_bytes()
    spec = json.loads(raw)
    if spec.get('version') != 1 or spec.get('canvas') != [512, 512]:
        raise ValueError('Explicit baseline requires version 1 and registered 512px canvas')
    geometry = spec.get('geometryReference')
    if not isinstance(geometry, str) or not geometry or geometry == 'varin-upright-v2':
        raise ValueError('Explicit baseline needs its own geometry identity, not the legacy identity')
    sources = {}

    def read_image(row):
        path = (manifest_path.parent / row['source']).resolve()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != row.get('sourceSHA256'):
            raise ValueError('Actual source SHA mismatch: ' + str(path))
        with Image.open(path) as image:
            if image.format != 'PNG' or image.mode != 'RGBA' or image.size != (512, 512) or not image.getchannel('A').getbbox():
                raise ValueError('Expected nonempty prepared RGBA PNG on actual 512px canvas: ' + str(path))
        sources[digest] = path
        return digest

    stool = spec['worldStool']
    stool_hash = read_image(stool)
    if stool_hash != FROZEN_STOOL_SHA256:
        raise ValueError('Explicit baseline must preserve the frozen world stool')
    stool_path = sources.pop(stool_hash)
    canonical = spec.get('canonicalSources')
    if not isinstance(canonical, dict) or not canonical or any(not isinstance(v, str) or not v for v in canonical.values()) or len(set(canonical.values())) != len(canonical):
        raise ValueError('Canonical sources must explicitly identify actual prepared source hashes')
    rows = spec.get('sequences', [])
    nodes = spec.get('nodes', [])
    if not rows or not nodes:
        raise ValueError('Explicit baseline needs sequences and pickup nodes')
    packages, ids = [], set()
    for is_node, row in [(False, r) for r in rows] + [(True, r) for r in nodes]:
        name = row.get('id')
        if not isinstance(name, str) or not name or name in ids:
            raise ValueError('Duplicate or missing package ID')
        ids.add(name)
        gesture = row.get('gesture')
        kind = 'gesture' if is_node else row.get('kind')
        if kind not in ('gesture', 'action', 'bridge') or is_node != (gesture is not None):
            raise ValueError('Explicit package kind/gesture mismatch')
        if kind == 'action' and not row.get('action') or kind != 'action' and row.get('action'):
            raise ValueError('Only authored actions may bind a presentation action')
        frames, time = [], 0
        for frame in ([row] if is_node else row.get('frames', [])):
            duration = frame.get('durationMs')
            if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
                raise ValueError('Exposure must be finite and positive')
            cue = frame.get('cue')
            if cue is not None and (not isinstance(cue, str) or not cue):
                raise ValueError('Authored cue must be a nonempty string')
            h = read_image(frame)
            pose = canonical.get(h, geometry + ':draw:' + h)
            frames.append({'sha256': h, 'startMs': time, 'durationMs': duration, 'pose': pose,
                           'exitTo': [pose] if frame.get('exitSafe', False) else [],
                           'pauseSafe': bool(frame.get('pauseSafe', False)), 'phase': frame.get('phase', 'act')})
            if cue is not None:
                frames[-1]['cue'] = cue
            time += duration
        if not frames:
            raise ValueError('Empty authored sequence')
        loop = row.get('loop')
        if loop is not None and (not isinstance(loop, list) or len(loop) != 2 or any(type(i) is not int for i in loop) or not 0 <= loop[0] < loop[1] <= len(frames)):
            raise ValueError('Loop must be an authored [start,endExclusive] frame range')
        p = {'id': name, 'canvas': [512, 512], 'geometryReference': geometry,
             'reviewStatus': 'candidate', 'stage': 'motion-candidate', 'kind': kind,
             'action': row.get('action'), 'sceneAction': row.get('sceneAction', row.get('action')),
             'entryPose': frames[0]['pose'], 'exitPose': frames[-1]['pose'],
             'frames': frames, 'durationMs': time, 'loop': loop,
             'warning': 'Explicit source candidate; graph validity is not visual acceptance.'}
        if gesture is not None:
            p['gesture'] = dict(gesture)
        packages.append(p)
    by_id = {p['id']: p for p in packages}
    seated = {f['sha256'] for p in packages if not p.get('gesture') or p['gesture'].get('embeddedStool') for f in p['frames']}
    if not set(canonical) <= seated:
        raise ValueError('Canonical source is not an actual displayed seated drawing')
    endpoints = spec.get('endpoints')
    if endpoints is not None:
        if not isinstance(endpoints, dict) or endpoints.get('geometryReference') != geometry:
            raise ValueError('Endpoint geometry does not match explicit baseline')
        for key in ('open', 'closed'):
            endpoint = endpoints.get(key)
            if not isinstance(endpoint, dict) or canonical.get(endpoint.get('sourceSha256')) != endpoint.get('pose') or endpoint.get('sourceSha256') not in seated:
                raise ValueError('Endpoint must bind its actual canonical seated source')
        opened, closed = endpoints['open'], endpoints['closed']
        membership = endpoints.get('closedSourceSha256')
        if opened == closed or opened['sourceSha256'] == closed['sourceSha256'] or opened['pose'] == closed['pose'] or not isinstance(membership, list) or any(not isinstance(h, str) for h in membership) or len(set(membership)) != len(membership) or not set(membership) <= seated or closed['sourceSha256'] not in membership or opened['sourceSha256'] in membership:
            raise ValueError('Invalid explicit closed drawing membership')
    pairs = {}
    for pair in spec.get('counterparts', []):
        h, d = pair['sourceSHA256'], pair['detachedSHA256']
        if h in pairs or h not in seated or d not in sources or h == d:
            raise ValueError('Duplicate, missing or invalid actual counterpart')
        pairs[h] = d
    if set(pairs) != seated:
        raise ValueError('Missing authored counterparts for displayed sources: ' + str(sorted(seated - set(pairs))))
    entries = {}
    allowed = {'grabNext', 'releaseNext', 'embeddedStool', 'settled', 'restoreOnRelease', 'releaseViaFrames',
               'restorePreviousOnSettle', 'grabImmediate', 'entrySourceSha256', 'restoreSourceSha256'}
    for p in packages:
        g = p.get('gesture')
        if g is None:
            continue
        if not isinstance(g, dict) or set(g) - allowed:
            raise ValueError('Unknown explicit gesture fields')
        for key in ('embeddedStool', 'settled', 'restoreOnRelease'):
            if type(g.get(key)) is not bool:
                raise ValueError('Explicit gesture booleans required: ' + key)
        for key in ('releaseViaFrames', 'restorePreviousOnSettle'):
            if key in g and type(g[key]) is not bool:
                raise ValueError('Optional gesture flag must be boolean: ' + key)
        for key in ('grabNext', 'releaseNext'):
            path = g.get(key)
            if not isinstance(path, list) or any(not isinstance(i, str) or i not in by_id or not by_id[i].get('gesture') for i in path):
                raise ValueError('Dangling/non-gesture continuation: ' + p['id'])
        if any(by_id[i]['gesture'].get('embeddedStool') for i in g['grabNext']):
            raise ValueError('Native drag continuation cannot carry an embedded stool: ' + p['id'])
        entry = g.get('entrySourceSha256')
        if entry:
            if entry in entries or entry not in pairs or g['embeddedStool'] or p['frames'][0]['sha256'] != pairs[entry]:
                raise ValueError('Ambiguous or non-matching same-exposure pickup entry: ' + p['id'])
            entries[entry] = p['id']
        immediate = g.get('grabImmediate')
        if g['embeddedStool']:
            target = by_id.get(immediate)
            if not target or not target.get('gesture') or target['gesture'].get('embeddedStool') or target['frames'][0]['sha256'] != pairs[p['frames'][0]['sha256']]:
                raise ValueError('Seated regrab needs its actual immediate detached counterpart: ' + p['id'])
        elif immediate is not None:
            raise ValueError('Only seated nodes declare an immediate counterpart')
        restore = g.get('restoreSourceSha256')
        if g['restoreOnRelease'] and not restore:
            raise ValueError('Direct release restoration requires an explicit actual source')
        if restore and restore not in seated:
            raise ValueError('Restore has no actual seated drawing')
        if restore and g['releaseNext'] and not g.get('releaseViaFrames'):
            raise ValueError('Drawn release must not be superseded by direct restore')
        lands = bool(g['releaseNext']) and by_id[g['releaseNext'][-1]]['gesture'].get('settled') is True
        restores = g['restoreOnRelease'] and bool(restore) and not g.get('releaseViaFrames')
        if g['settled'] and not g['embeddedStool']:
            raise ValueError('Settled node must actually be seated')
        if not (g['settled'] or lands or restores) or g.get('releaseViaFrames') and not lands:
            raise ValueError('Release must terminate at a seated settled node or exact restore: ' + p['id'])
    if set(entries) != seated:
        raise ValueError('Missing exact pickup entry for actual displayed sources: ' + str(sorted(seated - set(entries))))
    if any(path.is_relative_to(output) for path in [manifest_path, stool_path, *sources.values()]):
        raise ValueError('Baseline output must not contain or overwrite its source inputs')
    # All semantic validation above precedes any output. Pool uses hardlinks when
    # possible; atlas packing reads originals without rewriting them.
    pool = output / 'pool'
    pool.mkdir(parents=True, exist_ok=True)
    for h, source in sources.items():
        dest = pool / (h + '.png')
        if dest.exists():
            if hashlib.sha256(dest.read_bytes()).hexdigest() != h:
                raise ValueError('Stale pool source differs from its hash')
        else:
            try:
                os.link(source, dest)
            except OSError:
                shutil.copyfile(source, dest)
    source_manifest = {'id': 'explicit-baseline-pool', 'canvas': [512, 512],
                       'frames': [{'source': h + '.png', 'durationMs': 1} for h in sorted(sources)]}
    (pool / 'source.json').write_text(json.dumps(source_manifest))
    atlas = pack(pool / 'source.json', output)
    placements = {f['sha256']: f for f in atlas['frames']}
    for p in packages:
        pages, page_map = [], {}
        for f in p['frames']:
            placement = placements[f['sha256']]
            page = placement['page']
            if page not in page_map:
                page_map[page] = len(pages)
                pages.append(atlas['pages'][page])
            f.update(page=page_map[page], rect=placement['rect'], offset=placement['offset'])
        p['pages'] = pages
    if manifest_path.read_bytes() != raw or hashlib.sha256(stool_path.read_bytes()).hexdigest() != stool_hash or any(hashlib.sha256(path.read_bytes()).hexdigest() != h for h, path in sources.items()):
        raise ValueError('Source changed during compilation; freeze inputs and retry')
    stool_file = 'world-stool-' + stool_hash[:16] + '.png'
    shutil.copyfile(stool_path, output / stool_file)
    bundle = {'version': 1, 'candidateOnly': True, 'geometryEpoch': geometry, 'packages': packages,
              'worldStool': {'file': stool_file, 'sha256': stool_hash, 'canvas': [512, 512]}}
    if endpoints is not None:
        bundle['endpoints'] = endpoints
    (output / 'bundle.json').write_text(json.dumps(bundle, indent=2) + '\n')
    receipt = {'candidateSHA256': hashlib.sha256((output / 'bundle.json').read_bytes()).hexdigest(),
               'manifestSHA256': hashlib.sha256(raw).hexdigest(), 'geometryReference': geometry,
               'packageCount': len(packages), 'actualSources': sorted(sources), 'pickupEntrySources': sorted(entries),
               'actions': sorted({p['action'] for p in packages if p['action']}),
               'excludedScope': spec.get('excludedScope', []), 'legacyAssetsCopied': False,
               'productionInstalled': False, 'reviewStatus': 'candidate'}
    (output / 'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt
