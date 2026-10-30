from pathlib import Path
import hashlib,json
D=Path(__file__).parent;R=D.parent;P=R/'question-permission'
sha=lambda p:hashlib.sha256((R/p).read_bytes()).hexdigest()
N='question-permission/references/upright-open-neutral-v2.png';C='question-permission/references/closed-rest-rigid-v2.png';listen='question-permission/poses/listen-rest.png';attend='question-permission/poses/attend-corrected.png';mid='question-permission/poses/offer-mid.png'
routes={}
def add(source,steps,endpoint):
 routes[sha(source)]={'source':source,'sourceSHA256':sha(source),'endpoint':endpoint,'steps':[{'source':p,'sourceSHA256':sha(p),'durationMs':ms,'phase':'exit','businessEvent':None} for p,ms in steps],'rule':'ordinary interruption only; no nod/approval/completion cue; runtime resolves original sourceSHA to matching stool-less derivative without changing timing'}
for name,steps in {
'ask':[(attend,140),(listen,140),(N,160)],
'offer':[(mid,130),(attend,140),(listen,140),(N,160)],
'offer-mid':[(attend,140),(listen,140),(N,160)],
'attend-corrected':[(listen,140),(N,160)],
'listen-rest':[(N,160)],
'nod-soft':[(N,140)],
}.items():add(f'question-permission/poses/{name}.png',steps,'upright-v2:open-user')
for state in ['half','closed']:
 add(f'question-permission/blink/listen-rest-{state}.png',[(listen,80),(N,160)],'upright-v2:open-user')
 add(f'question-permission/blink/neutral-{state}.png',[(N,80)],'upright-v2:open-user')
 add(f'question-permission/local-closures/closed-quiet-blink-{state}.png',[(C,80)],'upright-v2:closed-rest')
for kind,base,endpoint in [('open',N,'upright-v2:open-user'),('closed',C,'upright-v2:closed-rest')]:
 wmid=f'question-permission/wave/{kind}-mid.png';smile=f'question-permission/wave/{kind}-smile.png'
 add(f'question-permission/wave/{kind}-peak.png',[(wmid,120),(smile,140),(base,140)],endpoint)
 add(wmid,[(smile,140),(base,140)],endpoint)
 add(smile,[(base,140)],endpoint)
add(N,[],'upright-v2:open-user');add(C,[],'upright-v2:closed-rest');add('question-permission/references/open-screen-read-v2.png',[(N,140)],'upright-v2:open-user')
manifest={'version':1,'pathBase':'production-v2 root (parent directory of this manifest directory)','status':'author supplied ordinary interruption return prefixes; existing reviewed artwork only; controller compile pending','mappingKey':'exact original sourceSHA256, not semantic state name','scope':'question permission blink welcome tap completion and local open-tap actual exposures','never':'Do not run answered/allowed/completed receipt tails for generic interruption. No nod in these routes. Never close laptop just to acknowledge tap.','safeHandoff':'After final exact endpoint, controller may start matching hinge/relocation entry. Do not reset exposure clock within a recovery route or skip via whole-person crossfade.','routes':routes}
(D/'ordinary-recovery-by-source-sha.json').write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n')
print(len(routes),'exact source recovery entries')
