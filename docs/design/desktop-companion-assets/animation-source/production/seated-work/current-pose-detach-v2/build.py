from pathlib import Path
import json,copy
p=Path(__file__).resolve().parent;r=p.parent.parent;v1=json.load(open(p.parent/'current-pose-detach-v1/current-pose-entries.json'))
by_original={x['originalSeatedSha256']:x for x in v1['recoveryExposures']}
closing=json.load(open(p.parent/'canonical-lid-v2/closing/sequence.source.json'))
import hashlib
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
def detached(src,ms):return {**by_original[sha(src)],'durationMs':ms}
cf=[{**detached(p.parent/'canonical-lid-v2/closing'/f['source'],min(f['durationMs'],32)),'motion':f.get('motion'),'phase':f.get('phase')}for f in closing['frames']]
posthalf=[{'frame':x}for x in ['detachHalf','detachMid','half','closed','turn20','turn','turn70','hug']]
closedcarry=[detached(r/x,65)for x in ['relocation/closed-handoff-v1/near-settled.png','relocation/canonical-static-v2/lap-release.png','relocation/canonical-static-v1/closed.png']]+[{'frame':x}for x in ['precontact','closed','turn20','turn','turn70','hug']]
support={'source':'relocation/shared-entry-v1/open-supported.png','sha256':sha(r/'relocation/shared-entry-v1/open-supported.png'),'durationMs':55,'embeddedStool':False,'releaseNext':[{'frame':x}for x in ['detachHalf','detachClosed','contact','release','settle','seated']]}
for e in v1['currentPoseEntries']+v1['additionalEntries']:
 use=e['uses'][0]
 if 'closingExactMatchIndex'in use:
  k=use['closingExactMatchIndex'];m=closing['frames'][k]['motion']
  if m['gripContact']=='keyboard-rest':tail=[support]+posthalf
  elif m['lidAngleDeg']>=35:
   end=next(i for i in range(k,len(cf)) if closing['frames'][i]['motion']['lidAngleDeg']<=35)
   tail=cf[k+1:end+1]+posthalf
  else:tail=cf[k+1:]+closedcarry
  e['recoveryPolicy']='Retain current exact contact. High-angle/released-hand recovery uses only the real closing reach/hinge section to 35 degrees, then authored supported half-lid pickup; low-angle recovery finishes the short shut-lid tail. No idle/read holds.'
 else:
  # Keep genuinely different hand/eye exposures, but no work/read rest holds.
  old=e['grabNext']; tail=[]
  for f in old:
   if 'frame'in f or '/canonical-lid-v2/' in f.get('originalSeatedSource',''):break
   ff=copy.deepcopy(f);ff['durationMs']=min(ff['durationMs'],45);tail.append(ff)
  tail += [support]+posthalf
  e['recoveryPolicy']='Short current operator release + real gaze bridge, each authored exposure <=45ms; acquire supported open-lid pose and enter half-lid pickup. Never queue the ordinary full seated close cycle.'
 e['grabNext']=tail;e['acceptance']='static detached source geometry checked; shortened supported recovery pending representative interactive review'
 e['releaseDuringRecovery']='If current recovery exposure has originalSeatedSource, restore that exact current supported seated equivalent at world-seat contact. For named pickup frames use that frame releaseNext. Never resume a stale grab queue.'
v1['method']+=' v2 removes ordinary-work holds and full high-angle close detours; source images unchanged.'
v1['revision']='short-supported-pickup-recovery-v2';(p/'current-pose-entries.json').write_text(json.dumps(v1,indent=2))
print('revised',len(v1['currentPoseEntries']),'missing source entries; v1 art reused')
