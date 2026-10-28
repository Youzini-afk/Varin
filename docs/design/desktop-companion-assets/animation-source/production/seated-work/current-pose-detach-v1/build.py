from pathlib import Path
from PIL import Image
import json,hashlib,numpy as np
p=Path(__file__).resolve().parent;r=p.parent.parent
sha=lambda f:hashlib.sha256(Path(f).read_bytes()).hexdigest()
rel=lambda f:str(Path(f).relative_to(r))
donor_path=r/'relocation/departure-bridge-v1/detach-protected-v2.png'
mask_path=r/'relocation/family-detach-v1/replacement-excluding-authored-arms.png'
donor=Image.open(donor_path).convert('RGBA');mask=Image.open(mask_path).convert('L');ma=np.array(mask)
(p/'frames').mkdir(exist_ok=True)
outputs={};qa=[]
def detach(src):
 src=Path(src).resolve();h=sha(src)
 if h not in outputs:
  im=Image.open(src).convert('RGBA');out=Image.composite(donor,im,mask);f=p/'frames'/f'{h}.png';out.save(f)
  a,b=np.array(im),np.array(out);assert np.array_equal(a[ma==0],b[ma==0])
  assert np.array_equal(a[:328],b[:328])
  outputs[h]={'source':rel(f),'sha256':sha(f),'originalSeatedSource':rel(src),'originalSeatedSha256':h,'embeddedStool':False,'seatContact':False}
  qa.append({'source':rel(src),'unchangedOutsideReplacement':True,'headHandsLidThroughY327Exact':True})
 return outputs[h]
def sequence(src):
 src=Path(src);j=json.load(open(src));return j,[{**detach(src.parent/f['source']),'durationMs':f['durationMs'],'phase':f.get('phase'),'motion':f.get('motion')}for f in j['frames']]
work=p.parent
closing,cf=sequence(work/'canonical-lid-v2/closing/sequence.source.json');opening,of=sequence(work/'canonical-lid-v2/opening/sequence.source.json')
gaze,gf=sequence(r/'observe-diagnose/canonical-gaze-v1/to-user.source.json')
# Reuse actual reverse-settling art, not a closed-hand teleport to a different laptop.
bridge=[{**detach(r/x),'durationMs':70}for x in ['relocation/closed-handoff-v1/near-settled.png','relocation/canonical-static-v2/lap-release.png','relocation/canonical-static-v1/closed.png']]
carry=bridge+[{'frame':x}for x in ['precontact','closed','turn20','turn','turn70','hug']]
closing_by_pixels={f['motion']['renderedPixelSha256']:i for i,f in enumerate(closing['frames'])}
entries={}
def entry(src,head,tail,uses):
 h=sha(src);d=detach(src)
 entries.setdefault(h,{'source':rel(src),'sourceSha256':h,'detachedSource':d['source'],'detachedSha256':d['sha256'],'currentFrameMs':35,'acceptance':'exact upper-body preservation; representative detached visual review pending','grabNext':tail+carry,'releaseBeforeSupport':{'restoreSeatedSameExposure':rel(src),'worldSeatAtReleasePosition':True,'stoolFadeInMs':100,'doNotForceCurlOrHug':True},'releaseDuringRecovery':'Use originalSeatedSource of the actually displayed detached recovery exposure when the world stool reaches contact; preserve current hands/lid. Do not restart closing or force curled carry.','uses':[]})['uses'].append(uses)
for j,frames,folder in [(opening,of,'opening'),(closing,cf,'closing')]:
 for i,f in enumerate(j['frames']):
  k=closing_by_pixels[f['motion']['renderedPixelSha256']]
  entry(work/f'canonical-lid-v2/{folder}'/f['source'],frames[i],cf[k+1:],{'sequence':j['id'],'exposure':i,'closingExactMatchIndex':k})
for name in ['typing','scroll','key-tap']:
 j,frames=sequence(work/f'canonical-{name}-v2/sequence.source.json')
 for i,f in enumerate(j['frames']):
  entry(work/f'canonical-{name}-v2'/f['source'],frames[i],frames[i+1:]+gf[1:]+cf[1:],{'sequence':j['id'],'exposure':i})
coverage=json.load(open(r/'qa/pickup-source-coverage-20261028-2324.json'))
wanted={d['sourceSha256']for d in coverage['drawings'] if not d['mapped'] and any(u['package'].startswith('seated-work')for u in d['uses'])}
assert wanted<=entries.keys(),wanted-entries.keys()
manifest={'stage':'motion-candidate','coordinateRoot':'varin-animation-production','method':'Actual authored hidden garment donor replaces exact shared stool regions; all current face/hands/lid unchanged. No body transform or alpha-only erasure.','mask':{'source':rel(mask_path),'sha256':sha(mask_path)},'donor':{'source':rel(donor_path),'sha256':sha(donor_path)},'windowMovement':'Immediate from pickup; never wait for recovery/closing.','currentPoseEntries':[entries[h]for h in sorted(wanted)],'additionalEntries':[v for k,v in entries.items()if k not in wanted],'recoveryExposures':list(outputs.values()),'counts':{'previouslyMissingEntries':len(wanted),'allWorkSourceEntries':len(entries),'uniqueDetachedExposures':len(outputs)}}
(p/'current-pose-entries.json').write_text(json.dumps(manifest,indent=2));(p/'qa.json').write_text(json.dumps(qa,indent=2));print(manifest['counts'])
