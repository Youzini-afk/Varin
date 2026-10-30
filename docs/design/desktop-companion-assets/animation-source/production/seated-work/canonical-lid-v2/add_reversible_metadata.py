from pathlib import Path
from PIL import Image
import json,hashlib
p=Path(__file__).parent;seq={};hashes={}
for name in ['opening','closing']:
 j=json.load(open(p/name/'sequence.source.json'));seq[name]=j;hashes[name]=[hashlib.sha256(Image.open(p/name/f['source']).convert('RGBA').tobytes()).hexdigest()for f in j['frames']]
for name,j in seq.items():
 other='closing'if name=='opening'else'opening';trace=json.load(open(p/name/'contact-trace.json'));enhanced=[]
 for i,(f,t)in enumerate(zip(j['frames'],trace)):
  phase=f['phase'];angle=t.get('angle',0 if phase=='closed-rest'else 100);contact='holding-top-lip' if 'drawing'in t or phase=='open-grip-hold'else('keyboard-rest'if phase=='open-rest'else('closed-lid-rest'if phase=='closed-rest'else'released-reaching'))
  matches=[k for k,h in enumerate(hashes[other])if h==hashes[name][i]];assert matches, (name,i,'no exact reverse pose');r=matches[0]
  m={'lidAngleDeg':angle,'gripContact':contact,'renderedPixelSha256':hashes[name][i],'reverseFrom':{'sequence':seq[other]['id'],'frameIndex':r,'match':'exact-rgba-pixels'},'safeEndpoint':phase in ['open-rest','closed-rest'],'durationMs':f['durationMs'],'reverseTailDurationMs':sum(x['durationMs']for x in seq[other]['frames'][r:]),'reverseTailEndpoint':seq[other]['exitPose']}
  if 'drawing'in t:m.update({'actualGripDrawingReferenceAngle':t['drawing'],'artSource':f'../../canonical-lid-v1/grip-{t["drawing"]:03}-source.png','clothRegistrationShift':t.get('registration')})
  elif phase=='open-grip-hold':m.update({'actualGripDrawingReferenceAngle':100,'artSource':'../../canonical-lid-v1/grip-100-source.png','clothRegistrationShift':[1,-1]})
  elif contact=='released-reaching':m.update({'artSource':'../../canonical-lid-v1/release-100-source.png','releaseProgress':t.get('t'),'contactLost':True})
  if m['safeEndpoint']:m['endpointSource']='../../canonical-lid-v1/closed-canonical-candidate.png'if phase=='closed-rest'else'../../../shared/seated-open-canonical-alpha-v1.png'
  m['renderMethod']='fixed-canonical-endpoint'if m['safeEndpoint']else'actual-hand-drawing+fixed-hinge-plane+shoulder-pinned-cloth-registration';f['motion']=m;enhanced.append({'frameIndex':i,'phase':phase,**m})
 j['artworkAccounting']={'actualGripDrawings':4,'actualReleaseDrawings':1,'hiddenArmCleanPlateDrawings':1,'canonicalPlaneTextureReused':True,'exposures':len(j['frames']),'uniqueRenderedPixelComposites':len(set(hashes[name])),'note':'Exposure/render-sample count is not a count of unique hand-drawn illustrations or a requested 60 FPS standard.'};j['interruptionContract']='At a supported exposure, reverse by its exact pixel-matched reverseFrom frame and continue the opposite clip tail. Do not replay the whole open/close or jump to a closed/open endpoint. Drag can begin only at a verified closed endpoint after the supported reversal.';json.dump(j,open(p/name/'sequence.source.json','w'),indent=2);json.dump({'sequence':j['id'],'frames':enhanced,'supportedReverseAtEveryExposure':True},open(p/name/'reversible-contact-map.json','w'),indent=2)
print('All opening/closing exposures have exact RGBA-matched reverse entry frames.')
