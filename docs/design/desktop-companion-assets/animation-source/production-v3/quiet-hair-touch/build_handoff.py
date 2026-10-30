from pathlib import Path
from PIL import Image,ImageDraw
import json,hashlib,numpy as np
R=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256((R/p).read_bytes()).hexdigest()
N='references/closed-rest-rigid-v2.png';L='references/yawn-hand-release-v1.png';A='frames/hair-raise-v1.png';B='frames/hair-near-v2.png';C='frames/hair-contact-v1.png';S='frames/hair-smooth-v1.png';D='frames/hair-detach-v1.png'
def f(p,ms,phase,cue,safe=False):return dict(source=p,actualSourceSHA=sha(p),durationMs=ms,phase=phase,cue=cue,pauseSafe=safe)
frames=[f(N,100,'enter','REST',True),f(L,120,'enter','HAIR_HAND_RELEASE'),f(A,130,'enter','HAIR_RAISE'),f(B,100,'enter','HAIR_NEAR'),f(C,180,'act','HAIR_CONTACT'),f(S,240,'act','HAIR_SMOOTH'),f(D,140,'exit','HAIR_DETACH'),f(L,110,'exit','HAIR_HAND_RETURN'),f(N,200,'exit','REST',True)]
paths={N:[N],L:[N],A:[L,N],B:[A,L,N],C:[S,D,L,N],S:[D,L,N],D:[L,N]}
recovery={sha(p):[f(t,100,'exit','REST'if t==N else 'LOCAL_RECOVER',t==N)for t in route]for p,route in paths.items()}
base=np.array(Image.open(R/N));records=[]
for p in [A,B,C,S,D]:
 a=np.array(Image.open(R/p));records.append({'source':p,'sha256':sha(p),'mask':'masks/'+Path(p).name,'provenance':'frames/'+Path(p).stem+'-provenance.json','below305Exact':bool(np.array_equal(base[305:],a[305:])),'nonActingRightHandExact':bool(np.array_equal(base[270:312,250:310],a[270:312,250:310]))})
manifest={'status':'independent candidate; full phrase review pending; not selected','geometryReference':'varin-upright-v2','canvas':[512,512],'actions':{'quiet-hair-smooth':{'publicAction':'quiet-hair-smooth','entryPose':'upright-v2:closed','exitPose':'upright-v2:closed','entrySource':N,'exitSource':N,'wholeSequenceLoop':False,'frames':frames}},'ordinaryRecoveryByActualSHA':recovery,'newSources':records,'contactContract':'image-left hand brushes one side lock; image-right hand continuously supports closed laptop. Face/head and pendant unchanged. Contact and smooth withdraw through genuine detach; no inverse grasp or head rotation.','eligibility':'clearly quiet local companionship, no active/unsettled/pending/unknown; optional sparse finite idle action, not a periodic timer or sleep signal; same source across Bot/Agent modes','interruptContract':'new facts immediately visible; stable neutral may interrupt now, moving exposure max40ms then exact recovery; drag must have exactSHA detached source; after recovery re-evaluate latest context, no queued hair replay'}
(R/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
inputs={'hair-contact-v1':[N,L],'hair-smooth-v1':['frames/hair-contact-v1.png'],'hair-raise-v1':[L],'hair-near-v2':['frames/hair-raise-v1.png'],'hair-detach-v1':['frames/hair-smooth-v1.png']}
(R/'generation-inputs.json').write_text(json.dumps([{'id':name,'tool':'built-in imagegen','prompt':'prompts/'+name+'.txt','exactPrompt':(R/'prompts'/f'{name}.txt').read_text(),'inputs':[{'path':p,'sha256':sha(p)}for p in ps],'raw':'raw/'+name+'.png','rawSHA256':sha('raw/'+name+'.png')}for name,ps in inputs.items()],ensure_ascii=False,indent=2)+'\n')
(R/'rejected.json').write_text(json.dumps([{'attempt':'hair-approach-v1','reason':'Reached cheek too early; replaced with real lower raise and near. Not an ancestor of any selected frame.'}],indent=2)+'\n')
print('5 new drawings; 7 actual reachable sources; exact closed E/X; ordinary recovery each source.')
