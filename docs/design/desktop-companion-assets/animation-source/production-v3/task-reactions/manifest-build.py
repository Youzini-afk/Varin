from pathlib import Path
import json,hashlib
D=Path(__file__).parent;sha=lambda p:hashlib.sha256((D/p).read_bytes()).hexdigest();N='references/upright-open-neutral-v2.png';R='references/open-screen-read-v2.png';A='references/attend-corrected.png';L='references/listen-rest.png';C='references/closed-rest-rigid-v2.png'
def f(p,ms,cue,phase='enter',safe=False):return {'source':p,'sourceSHA256':sha(p),'durationMs':ms,'cue':cue,'phase':phase,'pauseSafe':safe}
def pose(n):return f'poses/{n}.png'
new=['arrival-chest','thought-rise','thought-chin','explain-rise','explain-content','error-observe','error-locate','thought-blink'];assets={}
for n in new:
 ref='raw/thought-chin.png' if n in ['thought-rise','thought-blink'] else 'raw/explain-content.png' if n=='explain-rise' else 'raw/error-observe.png' if n=='error-locate' else N
 assets[n]={'source':pose(n),'sourceSHA256':sha(pose(n)),'raw':f'raw/{n}.png','rawSHA256':sha(f'raw/{n}.png'),'prompt':f'prompts/{n}.txt','reference':ref,'referenceSHA256':sha(ref),'editMask':f'masks/{n}.png','notForegroundMask':True,'note':'new genuinely drawn arm/anatomy; fixed nonchanging regions restored from neutral; no puppet rotation'}
assets['error-locate']['calmFaceReuse']={'source':R,'sourceSHA256':sha(R),'mask':'masks/error-locate-calm-face.png','reason':'raw frown rejected; exact gentle read face reused honestly while new hand still locates issue'}
actions={
'accept-open':{'facts':['C02 accepted','C03 preparing attention only'],'meaning':'received event/attention, not parsed or understood unless independently evidenced','frames':[f(R,100,'READ'),f(N,140,'ADDRESS'),f(A,130,'LIFT'),f(pose('arrival-chest'),420,'RECEIVED'),f(A,150,'LOWER','exit'),f(N,140,'REST','exit',True)],'endpoint':'upright-v2:open-user'},
'accept-closed':{'facts':['C02 accepted while mechanically closed'],'meaning':'honest reuse of existing small smile only; no new body action claimed, no forced opening','frames':[f(C,100,'ADDRESS'),f('references/closed-smile.png',240,'RECEIVED'),f(C,150,'REST','exit',True)],'endpoint':'upright-v2:closed-rest'},
'prepare':{'facts':['C03 preparing'],'meaning':'existing true typing preparation reused, not new source','frames':[f(N,120,'ADDRESS'),f('references/type-prepare.png',240,'READY'),f(R,180,'SCREEN','exit',True)],'endpoint':'upright-v2:open-screen'},
'think':{'facts':['C04 generating/thinking actual scoped contract'],'meaning':'short thoughtful excursion, never perpetual chin hold or side tilt','frames':[f(R,200,'READ'),f(pose('thought-rise'),160,'THINK_RISE'),f(pose('thought-chin'),4400,'CONSIDER','hold'),f(pose('thought-blink'),75,'THOUGHT_BLINK','hold'),f(pose('thought-chin'),2300,'CONSIDER','hold'),f(pose('thought-rise'),160,'LOWER','exit'),f(R,3600,'THINK_SCREEN','hold',True)],'endpoint':'upright-v2:open-screen','loopWhileFactTrue':False},
'output':{'facts':['C05 actual text_delta/output activity'],'meaning':'content-directed explanation; bounded gesture, mouth not held open indefinitely; debounce chunk stream','frames':[f(R,100,'READ'),f(A,120,'LIFT'),f(pose('explain-rise'),140,'CONTENT_PREP'),f(pose('explain-content'),430,'EXPLAIN'),f(pose('explain-rise'),180,'CONTENT_SETTLE','exit'),f(A,120,'LOWER','exit'),f(R,180,'SCREEN','exit',True)],'endpoint':'upright-v2:open-screen'},
'failure':{'facts':['E01 actual failed receipt'],'meaning':'mild concern then locating issue; not anger, blame, success or automatic retry','frames':[f(R,100,'READ'),f(pose('error-observe'),440,'NOTICE_ISSUE'),f(pose('error-locate'),650,'LOCATE'),f(L,200,'NEUTRAL_REST','exit',True)],'endpoint':'upright-v2:listen'},
'completion':{'facts':['actual successful completion receipt, deduplicate receipt ID'],'meaning':'bounded honest reuse of reviewed v2 wave; no new source claimed','frames':[f(N,160,'ADDRESS'),f('references/open-mid.png',130,'LIFT'),f('references/open-peak.png',280,'COMPLETION_ACK'),f('references/open-mid.png',150,'LOWER','exit'),f('references/open-smile.png',220,'SOFT_SMILE','exit'),f(N,160,'REST','exit',True)],'endpoint':'upright-v2:open-user'}
}
for name,cue,facts in [('retry-wait','RETRY_BACKOFF','W05 retry_scheduled; never guessed success'),('execution-observe','EXECUTION_OBSERVE','actual execution remains active'),('external-wait','EXTERNAL_WAIT','actual external dependency pending'),('queued','QUEUED','actual queued status'),('organizing','ORGANIZE_ALIGN','T06 actual organize operation'),('checking','VERIFY_SCAN','T07 actual verify/check operation')]:
 actions[name]={'facts':[facts],'meaning':'shared actual issue-location/observation body, distinct external cue; no fabricated new animation per label','frames':[f(R,160,'READ'),f(pose('error-locate'),600,cue,'hold'),f(L,300,'OBSERVE_REST','hold',True)],'endpoint':'upright-v2:listen','holdRequiresFact':True}
for name,cue,facts in [('cancel-settling','CANCEL_REQUESTED','E02 cancellation requested, NOT executor-stopped'),('disconnected','CONNECTION_UNKNOWN','E04 actual health unknown/disconnected'),('reconnecting','SYNC_PENDING','E05 actual reconnect/sync pending, NOT completed'),('unknown-effect-check','EFFECT_UNKNOWN','E06 operation effect unknown, NOT rollback/success')]:
 actions[name]={'facts':[facts],'meaning':'honest shared neutral observation body plus independent semantic cue; no fake nod','frames':[f(L,220,cue,'hold',True)],'endpoint':'upright-v2:listen','holdRequiresFact':True}
recover={}
def rec(source,steps,end):recover[sha(source)]={'source':source,'steps':[f(p,ms,'NEUTRAL_RETURN','exit',p in [N,R,L,C]) for p,ms in steps],'endpoint':end,'never':'no receipt cue, nod or state transition from animation'}
rec(pose('arrival-chest'),[(A,140),(N,150)],'upright-v2:open-user');rec(pose('thought-chin'),[(pose('thought-rise'),160),(N,160)],'upright-v2:open-user');rec(pose('thought-blink'),[(pose('thought-chin'),70),(pose('thought-rise'),160),(N,160)],'upright-v2:open-user');rec(pose('thought-rise'),[(N,160)],'upright-v2:open-user')
rec(pose('explain-content'),[(pose('explain-rise'),140),(A,140),(N,160)],'upright-v2:open-user');rec(pose('explain-rise'),[(A,140),(N,160)],'upright-v2:open-user')
for n in ['error-observe','error-locate']:rec(pose(n),[(L,180),(N,160)],'upright-v2:open-user')
for p in [A,L,'references/type-prepare.png']:rec(p,[(N,160)],'upright-v2:open-user')
rec('references/open-peak.png',[('references/open-mid.png',120),('references/open-smile.png',140),(N,140)],'upright-v2:open-user');rec('references/open-mid.png',[('references/open-smile.png',140),(N,140)],'upright-v2:open-user');rec('references/open-smile.png',[(N,140)],'upright-v2:open-user');rec('references/closed-smile.png',[(C,140)],'upright-v2:closed-rest')
for p,e in [(N,'upright-v2:open-user'),(R,'upright-v2:open-screen'),(C,'upright-v2:closed-rest')]:rec(p,[],e)
for state in ['half','closed']:
 rec(f'references/listen-rest-{state}.png',[(L,80),(N,160)],'upright-v2:open-user')
for key,action in actions.items():
 action['safeExposureIndexes']=[i for i,x in enumerate(action['frames']) if x['pauseSafe']]
 action['ordinaryExit']='ordinaryRecoveryBySourceSHA for actual last rendered source, never receipt replay'
 action['wholeSequenceLoop']=False
 if key=='think':
  action['phaseContract']={'enterIndexes':[0,1],'holdIndexes':[2,3,4],'exitIndexes':[5,6],'holdLoopWhileFact':True,'holdMeaning':'same upright thoughtful body with one sparse matching-head blink per 6775ms; never replay hand lift/lower loop','pauseSafeHoldIndexes':[2,4]}
 elif key=='output':
  action['phaseContract']={'enterIndexes':[0,1,2],'holdIndexes':[4],'onRealProgressBeatIndexes':[3,4],'exitIndexes':[5,6],'repeatBeatRequires':'actual text_delta/output progress, debounce >=1200ms; no timed fake speech','holdMeaning':'closed-mouth content pointer between real output beats, never hold speaking mouth open','pauseSafeHoldIndexes':[4]}
 elif key in ['retry-wait','execution-observe','external-wait','queued','organizing','checking']:
  action['phaseContract']={'enterIndexes':[0,1],'holdIndexes':[2],'exitByActualSourceRecovery':True,'holdLoopWhileFact':True,'repeatCueRequires':'new real scoped progress/stage event; no one-second re-point timer','holdBlink':{'open':L,'half':'references/listen-rest-half.png','closed':'references/listen-rest-closed.png','exposureMs':[45,75,45],'intervalMs':[4500,7000]},'pauseSafeHoldIndexes':[2]}
 elif key=='failure':
  action['phaseContract']={'enterIndexes':[0,1,2],'holdIndexes':[3],'exitByActualSourceRecovery':True,'holdLoopWhileFact':False,'repeatCueRequires':'new distinct failed receipt only','pauseSafeHoldIndexes':[3]}
 elif key in ['cancel-settling','disconnected','reconnecting','unknown-effect-check']:
  action['phaseContract']={'enterIndexes':[],'holdIndexes':[0],'exitByActualSourceRecovery':True,'holdLoopWhileFact':True,'repeatCueRequires':'real state update only','pauseSafeHoldIndexes':[0]}
 else:action['phaseContract']={'finiteEvent':True,'shortEventWithdrawBySourceSHA':True}
actions['accept-open']['publicAction']='accept';actions['accept-closed']['publicAction']='accept'
m={'version':3,'status':'parent direction approved; source/sequence integration pending; not runtime accepted','pathBase':'manifest directory','canvas':[512,512],'generator':'built-in image_gen','references':{str(p.relative_to(D)):sha(str(p.relative_to(D))) for p in sorted((D/'references').glob('*.png'))},'assets':assets,'actions':actions,'ordinaryRecoveryBySourceSHA':recover,'shortEventWithdrawal':'from actual last exposure use its sourceSHA recovery, never restart neutral or play completion tail; during source return keep clock monotonic','authorizationBoundary':'no gesture authorizes tools, dismisses permission, or creates answer/completion receipt','sourceFreeze':'v2 sources copied read-only into references; no v2 files modified','noStool':'new sourceSHA needs actual derivative registry; never map by semantic action name alone'}
(D/'manifest.json').write_text(json.dumps(m,indent=2,sort_keys=True)+'\n')
