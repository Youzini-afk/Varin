from pathlib import Path
import json,hashlib
r=Path(__file__).parent;root=r.parent;o=r/'transition-contract-v7';o.mkdir(exist_ok=True);c=json.loads((r/'transition-contract-v6/relocation.source.json').read_text());idx=json.loads((root/'observe-diagnose/gesture-pickup-v2/index.json').read_text());idx['entries']+=json.loads((root/'observe-diagnose/gesture-pickup-v2/coverage-index.json').read_text())['entries'];seen={e['sourceSha256'] for e in c['currentPoseEntries']};added=[];duplicates=[];skippedAliases=[]
handoff=root/'observe-diagnose/gesture-pickup-v2/closed-handoff.png'
c['frames']['closedHandoff']={'source':str(handoff.relative_to(root)),'sha256':hashlib.sha256(handoff.read_bytes()).hexdigest(),'durationMs':65,'canvas':[512,512],'embeddedStool':False,'seatContact':False,'laptopSupport':'closed lid and base held by two hands','releaseNext':['detachClosed','contact','release','settle','seated'],'grabNext':['detachClosed','precontact','closed','turn20','turn','turn70','hug']}
# Prefer per-exposure authored rows over the redundant chin-contact representative preview.
for e in sorted(idx['entries'],key=lambda e:e['id'].endswith('chin-contact')):
 mp=root/e['manifest'];m=json.loads(mp.read_text());src=(root/m['sourceStart']).resolve();sha=hashlib.sha256(src.read_bytes()).hexdigest()
 if sha in seen:duplicates.append(e['id']);skippedAliases.append({'sourceSha256':sha,'source':str(src.relative_to(root.resolve()))});continue
 seen.add(sha);fr=m['frames'];paths=[(mp.parent/f['source']).resolve() for f in fr];closed='closed-laptop' in m['exitPose'];tail=['closedHandoff','detachClosed','precontact','closed','turn20','turn','turn70','hug'] if closed else ['detachHalf','detachMid','half','closed','turn20','turn','turn70','hug'];seq=[{'source':str(p.relative_to(root.resolve())),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'durationMs':f['durationMs']} for p,f in zip(paths[1:],fr[1:])]+[{'frame':n} for n in tail]
 row={'source':str(src.relative_to(root.resolve())),'sourceSha256':sha,'detachedSource':str(paths[0].relative_to(root.resolve())),'detachedSha256':hashlib.sha256(paths[0].read_bytes()).hexdigest(),'currentFrameMs':fr[0]['durationMs'],'grabNext':seq,'lidMode':'closed' if closed else 'open','acceptance':'author supplied explicit recovery; finite peer/native integration pending','releaseBeforeSupport':{'restoreSeatedSameExposure':str(src.relative_to(root.resolve())),'worldSeatAtReleasePosition':True,'stoolFadeInMs':100,'doNotForceCurlOrHug':True},'releaseDuringRecovery':'Finish current remaining supported hand recovery only, then detachClosed -> contact -> release -> settle -> seated; do not reopen a closed laptop or enter curl/hug first.','authorManifest':e['manifest']};c['currentPoseEntries'].append(row);added.append(row['source'])
for folder,mode in [('closed-grab-v1','closed'),('open-event-grab-v1','open')]:
 author=root/'user-attention'/folder
 mapping=json.loads((author/'source-map.json').read_text())['frames'];routing=json.loads((author/'routes.json').read_text())
 for item in mapping:
  sha=item['sourceSha256'];src=root/item['source'];assert hashlib.sha256(src.read_bytes()).hexdigest()==sha
  if sha in seen:skippedAliases.append({'sourceSha256':sha,'source':item['source']});continue
  seen.add(sha);route=routing[sha];cur=root/route[0][0]
  tail=['closedHandoff','detachClosed','precontact','closed','turn20','turn','turn70','hug'] if mode=='closed' else ['detachHalf','detachMid','half','closed','turn20','turn','turn70','hug']
  seq=[{'source':q,'durationMs':d,'sha256':hashlib.sha256((root/q).read_bytes()).hexdigest()} for q,d in route[1:]]+[{'frame':n} for n in tail]
  c['currentPoseEntries'].append({'source':item['source'],'sourceSha256':sha,'detachedSource':route[0][0],'detachedSha256':hashlib.sha256(cur.read_bytes()).hexdigest(),'currentFrameMs':route[0][1],'grabNext':seq,'lidMode':mode,'acceptance':'author exact current source candidate; group visual QA pending','authorMap':str((author/'source-map.json').relative_to(root)),'releaseBeforeSupport':{'restoreSeatedSameExposure':item['source'],'worldSeatAtReleasePosition':True,'stoolFadeInMs':100,'doNotForceCurlOrHug':True}})
work=json.loads((root/'seated-work/current-pose-detach-v2/current-pose-entries.json').read_text())
workLedger=json.loads((r/'work-entry-acceptance-ledger-v1.json').read_text());wa={e['sourceSha256']:e for e in workLedger['frames']}
for item in work['currentPoseEntries']+work['additionalEntries']:
 sha=item['sourceSha256']
 if sha in seen:skippedAliases.append({'sourceSha256':sha,'source':item['source']});continue
 seen.add(sha);entry=dict(item);core=[q['frame'] for q in entry['grabNext'] if 'frame' in q];closed=bool(core and core[0] in ['precontact','closed','turn20']);entry['lidMode']='closed' if closed else 'open';entry['releaseAfterRecoveryOverride']=([] if closed else ['detachHalf','detachClosed'])+['contact','release','settle','seated'];entry['acceptance']={'result':wa[sha]['decision'],'ledger':'relocation/work-entry-acceptance-ledger-v1.json','basis':wa[sha]['basis']};entry['authorMap']='seated-work/current-pose-detach-v2/current-pose-entries.json';c['currentPoseEntries'].append(entry)
c['workRecoveryExposures']=work['recoveryExposures']
for entry in c['currentPoseEntries']:
 closed=entry.get('lidMode')=='closed'
 entry['lidMode']='closed' if closed else 'open'
 raw=[dict(q) for q in entry.get('grabNext',[]) if 'source' in q]
 entry['carryAfterRecovery']=[q['frame'] for q in entry.get('grabNext',[]) if 'frame' in q]
 tail=(['closedHandoff','detachClosed'] if closed else ['detachHalf','detachClosed'])+['contact','release','settle','seated']
 tail=entry.pop('releaseAfterRecoveryOverride',tail)
 entry['releaseAfterRecovery']=tail
 entry.pop('releaseDuringRecovery',None)
 entry['recoveryFrames']=[{**q,'releaseNext':q.get('releaseNext',[dict(x) for x in raw[i+1:]]+[{'frame':n} for n in tail])} for i,q in enumerate(raw)]
 entry['releasePolicy']='If released during recovery, finish only remaining listed raw recovery drawings, then releaseAfterRecovery. Do not consume carryAfterRecovery. Pointer root freezes immediately at release.'
obsAccepted={}
for name in ['acceptance-ledger.json','coverage-acceptance-ledger.json']:
 ld=json.loads((root/'observe-diagnose/gesture-pickup-v2'/name).read_text())
 for v in ld['entries']:obsAccepted[v['sourceStartSha256']]={**v,'ledger':'observe-diagnose/gesture-pickup-v2/'+name}
for entry in c['currentPoseEntries']:
 if entry['sourceSha256'] in obsAccepted:
  v=obsAccepted[entry['sourceSha256']];entry['acceptance']={'result':v['decision'],'basis':v.get('basis','group representative actual playback and inspected structural variants; not individually replayed every start'),'ledger':v['ledger'],'scope':'current source to supported detached original-projection endpoint only'}
ledger=json.loads((root/'user-attention/drag-bridges-v1/user-grab-acceptance-ledger-v1.json').read_text())
accepted={v['source']:v for v in ledger['frames']}
for entry in c['currentPoseEntries']:
 if entry['source'] in accepted:
  v=accepted[entry['source']];entry['acceptance']={'result':v['result'],'group':v['group'],'basis':v['basis'],'ledger':'user-attention/drag-bridges-v1/user-grab-acceptance-ledger-v1.json'}
localAccepted={}
for folder in ['closed-grab-v1','open-event-grab-v1']:
 lp=root/'user-attention'/folder/'acceptance-ledger.json';ld=json.loads(lp.read_text())
 for item in ld['frames']:localAccepted[item['source']]={**item,'ledger':str(lp.relative_to(root))}
for entry in c['currentPoseEntries']:
 if entry['source'] in localAccepted:
  v=localAccepted[entry['source']];entry['acceptance']={'result':v['status'],'group':v['group'],'ledger':v['ledger'],'scope':'exact current pose and authored local-event withdrawal; grouped peer acceptance, native OS not included'}
groups={}
for entry in c['currentPoseEntries']:groups.setdefault(entry['sourceSha256'],[]).append(entry)
unique=[]
for sha,rows in groups.items():
 chosen=next((v for v in rows if v['source'].endswith('query-understand-v1/pose-000.png')),rows[0])
 chosen['sourceAliases']=[v['source'] for v in rows]
 chosen['aliasPolicy']='Exact same source bytes; one deterministic recovery. Shared neutral selects query-neutral contact to preserve neutral eyes rather than permission widened eyes.'
 unique.append(chosen)
for alias in skippedAliases:
 for row in unique:
  if row['sourceSha256']==alias['sourceSha256'] and alias['source'] not in row['sourceAliases']:row['sourceAliases'].append(alias['source'])
for row in unique:
 a=row['acceptance']
 if isinstance(a,dict):a['sourceDecision']=a['result'];a['result']='accepted-for-runtime-bridge';a.setdefault('scope','Limited grouped visual/source acceptance; native OS behavior pending')
c['currentPoseEntries']=unique
c['acceptance']['knownGaps']=[g for g in c['acceptance']['knownGaps'] if not g.startswith('USER low-hand') and not g.startswith('core entry/early-release')]
c['acceptance']['userGroupedAcceptance']={'ledger':'user-attention/drag-bridges-v1/user-grab-acceptance-ledger-v1.json','method':ledger['method'],'scope':ledger['scope']}
c['acceptance']['detachMid']='Seated peer static accepted v3 boot-only correction: original proportion, half lid monotonic, both hands/thigh support, no stool remnants.'
c['acceptance']['notBlanketAccepted']=['lid65 motion cadence','native OS pointer/world stool behavior','directional motion']
c['observeRestMerge']={'addedSources':added,'duplicateSamePixelEntriesSkipped':duplicates,'index':'observe-diagnose/gesture-pickup-v2/index.json','maskVersion':'departure-bridge-v1/stool-replacement-mask-v2.png','stage':'candidate; no blanket visual acceptance'};c['acceptance']['knownGaps']=[x for x in c['acceptance']['knownGaps'] if not x.startswith('OBSERVE/REST source map')];c['acceptance']['knownGaps'].append('OBSERVE/REST indexed recovery candidates need finite peer/native checks; closed handoff authored65ms half-step included; finite peer/native review pending')
(o/'relocation.source.json').write_text(json.dumps(c,indent=2));print('added',len(added),'duplicates',duplicates,'total',len(c['currentPoseEntries']))
