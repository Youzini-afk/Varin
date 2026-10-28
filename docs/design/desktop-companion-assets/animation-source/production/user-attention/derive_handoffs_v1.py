from pathlib import Path
import json,hashlib,shutil
r=Path(__file__).parent;o=r/'handoffs/v1';o.mkdir(parents=True,exist_ok=True)
geom='390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b'
N='seated-open-neutral-keyboard'; P='seated-open-permission-palm-attentive'; Q='seated-open-query-chin-attentive'; W='seated-open-watch-user-relaxed'; S='seated-open-watch-user-relaxed-settled'; H='seated-open-watch-user-halfblink'; C='seated-open-watch-user-closedblink'
assets=[]
def f(group,n,t,pose,phase='transition'):return (f'registered/{group}/pose-{n:03}.png',t,pose,phase)
def make(id,rows,entry,exit,loop=None,kind='action',trigger='',safe=None):
 p=o/id;p.mkdir(exist_ok=True);frames=[];sources=[]
 for i,(src,t,pose,phase) in enumerate(rows):
  dest=f'frame-{i:03}.png';shutil.copyfile(r/src,p/dest);frames.append(dict(source=dest,durationMs=t,offset=[0,0],pose=pose,phase=phase));sources.append(dict(frame=dest,source=src,sha256=hashlib.sha256((r/src).read_bytes()).hexdigest()))
 d=dict(id=id,family='USER_ATTENTION',kind=kind,canvas=[512,512],geometryReference=geom,stage='motion-candidate',reviewStatus='candidate',entryPose=entry,exitPose=exit,loop=loop,frames=frames,warning='Derived from peer-reviewed drawings, handoff order awaiting finite path review. Application state owns decisions; no approval, answer, success, timeout, or work command inferred from exposure completion.',trigger=trigger,safeExitFrames=safe or [])
 (p/'sequence.source.json').write_text(json.dumps(d,indent=2));(p/'provenance.json').write_text(json.dumps(dict(method='Exact source-cel copy, no scaling/deformation/fade or new image generation',sources=sources),indent=2));assets.append(dict(id=id,source=f'{id}/sequence.source.json',entryPose=entry,exitPose=exit,trigger=trigger,loop=loop,safeExitFrames=safe or []))
pg='permission-cycle-v2';qg='query-understand-v1';wg='wait-relaxed-v1'
# Enter ends in explicit question, without suggesting a decision.
make('permission-ask-enter-v1',[f(pg,i,t,N if i==0 else P if i==9 else 'permission-enter-moving','enter')for i,t in enumerate([100,70,70,70,75,75,80,120,100,250])],N,P,trigger='actual permission-pending begins')
make('permission-palm-release-v1',[f(pg,9,80,P),f(pg,10,110,'permission-release-moving'),f(pg,11,80,'permission-release-moving'),f(pg,12,100,N)],P,N,kind='bridge',trigger='permission granted or denied while palm is still raised',safe=[3])
make('question-ask-enter-v1',[f(qg,i,t,N if i==0 else Q if i==5 else 'question-enter-moving','enter')for i,t in enumerate([100,80,85,85,90,320])],N,Q,trigger='actual clarification question displayed')
make('question-chin-release-v1',[f(qg,i,t,Q if i==5 else N if i==10 else 'question-release-moving')for i,t in zip(range(5,11),[80,80,85,80,90,100])],Q,N,kind='bridge',trigger='answer or cancellation while chin question remains',safe=[5])
wait=[f(wg,i,t,[W,H,C,H,W,S,W][i],'hold')for i,t in enumerate([1800,50,70,70,1500,1600,1000])]
# A finite lowering lead is followed by explicitly looping relaxed hold, without a semantic change.
pl=[f(pg,9,220,P,'hold'),f(pg,10,110,'permission-release-moving'),f(pg,11,80,'permission-release-moving')]
ql=[f(qg,i,t,Q if i==5 else N if i==10 else 'question-release-moving')for i,t in zip(range(5,11),[220,80,85,80,90,100])]
for id,lead,entry in [('permission-unresolved-hold-v1',pl,P),('question-unanswered-hold-v1',ql,Q)]:
 n=len(lead);make(id,lead+wait,entry,W,loop=[n,n+len(wait)],trigger='same request remains unresolved; lowering hand does NOT resolve it',safe=[n,n+4,n+5,n+6])
# Exact authored blink cels bridge relaxed face back to neutral; no generic dissolve.
for id,first,entry in [('relaxed-to-neutral-v1',None,W),('relaxed-settled-to-neutral-v1',5,S)]:
 rows=[] if first is None else [f(wg,5,120,S),f(wg,0,120,W)]
 rows += [f(wg,0,120,W),f(wg,1,50,H),f(wg,2,70,C),f(pg,12,120,N)]
 make(id,rows,entry,N,kind='bridge',trigger='real resolution/cancellation or presentation transition after safe hold pose',safe=[len(rows)-1])
make('answer-understood-v1',[f(qg,i,t,N if i in [10,14] else 'understanding-nod-moving')for i,t in zip(range(10,15),[100,90,120,100,200])],N,N,trigger='actual user answer received and understood; never timeout or denial',safe=[0,4])
make('completion-once-v1',[f('completion-wave-v2',i,t,N if i in [0,10] else 'completion-moving')for i,t in enumerate([100,70,70,80,85,170,150,130,110,80,200])],N,N,trigger='actual task succeeded once; presentation repeats must not replay success gesture',safe=[0,10])
manifest=dict(status='handoff-path-review-pending',assets=assets,decisionGate={'permissionGranted':'release from actual safe pose -> neutral -> authored gaze-to-screen -> work','permissionDenied':'release from actual safe pose -> neutral; no success gesture/no resume command','questionAnswered':'release from actual safe pose -> neutral -> answer-understood-v1','questionCancelled':'release -> neutral; do NOT nod understanding','completionToRest':'completion-once -> open neutral -> accepted actual laptop-close bridge -> closed quiet; never relabel open as closed'},runtimeRules=['E completion is visual only, must not resolve request.','H loop never times out the request.','If application outcome arrives during movement, finish only to next registered safe pose, not entire long hold cycle.','At half/closed blink finish the blink to W before requesting exit; at S use matching S bridge.','Bridge target should come from real application presentation, not expose animation callbacks as commands.'],remaining=['Explicit open-to-closed laptop bridge acceptance is owned by seated/integration; do not fake it.'])
(o/'handoff-manifest.json').write_text(json.dumps(manifest,indent=2));print(o,len(assets))
