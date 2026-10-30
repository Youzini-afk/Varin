from pathlib import Path
import json,hashlib
from PIL import Image,ImageDraw
R=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
neutral='references/upright-open-neutral-v2.png';smile='references/open-smile.png';mid='frames/open-hover-middle-v2.png';peak='frames/open-hover-attend-v1.png';tap='frames/open-tap-playful-v1.png'
def frame(p,ms,phase,cue,safe=False):return dict(source=p,actualSourceSHA=sha(R/p),durationMs=ms,phase=phase,cue=cue,pauseSafe=safe,pose='upright-v2:open-user' if p==neutral else 'upright-v2:local:'+Path(p).stem)
actions={
'open-hover-response':[frame(neutral,80,'enter','LOCAL_NOTICE',True),frame(mid,120,'enter','LOCAL_APPROACH'),frame(peak,320,'hold','LOCAL_ATTEND',True),frame(mid,140,'exit','LOCAL_RELEASE'),frame(neutral,100,'exit','REST',True)],
'tap-repeat-response':[frame(neutral,80,'enter','LOCAL_NOTICE',True),frame(smile,110,'enter','LOCAL_SOFTEN'),frame(tap,380,'hold','LOCAL_PLAYFUL',True),frame(smile,140,'exit','LOCAL_RELEASE'),frame(neutral,120,'exit','REST',True)]}
recovery={sha(R/neutral):[frame(neutral,80,'exit','REST',True)],sha(R/mid):[frame(neutral,100,'exit','REST',True)],sha(R/peak):[frame(mid,120,'exit','LOCAL_RELEASE'),frame(neutral,100,'exit','REST',True)],sha(R/tap):[frame(smile,100,'exit','LOCAL_RELEASE'),frame(neutral,100,'exit','REST',True)],sha(R/smile):[frame(neutral,100,'exit','REST',True)]}
manifest={'status':'independent authored candidate; parent visual and normal-speed review pending; no runtime/selected integration','geometryReference':'varin-upright-v2','canvas':[512,512],'entryPose':'upright-v2:open-user','exitPose':'upright-v2:open-user','actions':{k:{'wholeSequenceLoop':False,'entrySource':neutral,'exitSource':neutral,'frames':v}for k,v in actions.items()},'ordinaryRecoveryByActualSHA':recovery,'interruptContract':{'stableHold':'immediate transition into actual-source recovery; not locked for remaining hold','intermediate':'finish at most 40ms exposure then actual-source recovery','hoverLeave':'discard local intention and recover; never replay approach','newFacts':'display immediately, latest context after recovery','drag':'needs exact actualSHA no-stool closure before runtime admission'},'eligibility':{'hover':'safe exact open-user endpoint after real hit dwell; no forced opening/closing; busy may keep existing short smile','repeat':'one per burst, previous response finished, clearly idle, no pending/unknown; not approval/nod','closed':'existing closed tap only, never open lid to use this package'},'newSources':[{'source':p,'sha256':sha(R/p),'provenance':'frames/'+Path(p).stem+'-provenance.json','mask':'masks/'+Path(p).name}for p in [mid,peak,tap]]}
(R/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
inputs={
'open-hover-attend-v1':['references/upright-open-neutral-v2.png','references/hover-attend-v1.png'],
'open-hover-middle-v2':['references/upright-open-neutral-v2.png'],
'open-tap-playful-v1':['references/upright-open-neutral-v2.png']}
(R/'generation-inputs.json').write_text(json.dumps([{'id':k,'tool':'built-in imagegen','prompt':'prompts/'+k+'.txt','exactPrompt':(R/'prompts'/f'{k}.txt').read_text(),'inputs':[{'path':p,'sha256':sha(R/p)}for p in ps],'raw':'raw/'+k+'.png','rawSHA256':sha(R/'raw'/f'{k}.png')}for k,ps in inputs.items()],ensure_ascii=False,indent=2)+'\n')
records=[]
for p in sorted(R.rglob('*')):
 if p.is_file() and 'qa' not in p.parts and p.name!='source-inventory.json':records.append({'path':str(p.relative_to(R)),'sha256':sha(p),'bytes':p.stat().st_size})
(R/'source-inventory.json').write_text(json.dumps(records,indent=2)+'\n')
print('Candidate 3 sources, 2 finite sequences; exact open-user endpoints; relocation pending.')
