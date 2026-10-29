from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
import json,hashlib,numpy as np
r=Path(__file__).resolve().parent.parent;a=r/'references'
polys={
 'type-burst':[[(223,263),(247,261),(265,264),(293,260),(321,267),(349,281),(362,313),(350,355),(316,350),(294,318),(248,308),(233,299)]],
 'review':[[(178,227),(195,204),(209,187),(230,177),(256,178),(263,189),(246,203),(230,234),(236,277),(248,286),(251,302),(233,303),(221,245)]],
 'dispatch-a':[[(304,196),(331,203),(355,225),(392,228),(412,208),(435,185),(458,183),(499,199),(497,215),(451,232),(441,269),(442,333),(427,355),(397,367),(366,381),(337,372),(303,324),(300,310),(248,306),(249,281),(295,271)]]
}
polys['dispatch-b-v2']=[[(300,195),(335,200),(362,258),(381,349),(371,368),(339,373),(301,321),(247,310),(245,277),(224,244),(227,229),(264,221),(293,233)]]
polys['review-v2']=[[(249,248),(273,245),(303,251),(328,256),(353,277),(366,316),(354,349),(331,367),(303,332),(294,312),(250,309),(248,284)]]
polys['gaze-right']=[[(209,135),(243,134),(245,153),(211,157)],[(276,132),(306,128),(307,148),(276,152)]]
polys['dispatch-rise']=[[(300,195),(338,204),(369,233),(400,226),(425,226),(448,238),(447,261),(412,272),(412,352),(384,367),(335,370),(299,325),(248,309),(249,281),(297,270)]]
polys['dispatch-transit']=[[(300,195),(337,203),(375,257),(390,361),(372,371),(339,373),(299,325),(249,309),(249,282),(269,263),(266,229),(295,221)]]
polys['review-rise']=polys['review']
polys['select']=[[(155,224),(164,205),(190,190),(226,188),(240,223),(258,267),(264,304),(242,309),(230,287),(210,239)],[(262,271),(308,270),(342,277),(365,305),(365,355),(339,370),(308,330),(299,310),(263,307)]]
polys['type-forward']=[[(126,0),(395,0),(406,165),(396,207),(376,232),(370,320),(359,359),(325,369),(296,318),(240,309),(233,268),(218,235),(110,229),(125,202)]]
polys['type-prepare']=polys['type-forward']
records=[]
for name,ps in polys.items():
 base=Image.open(a/('upright-open-neutral-v2.png' if name.startswith(('dispatch','gaze')) else 'open-screen-read-v2.png')).convert('RGBA');raw=Image.open(r/'clean'/f'{name}.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask)
 for p in ps:d.polygon(p,fill=255)
 mask=mask.filter(ImageFilter.GaussianBlur(.6));ImageDraw.Draw(mask).polygon([(109,228),(219,236),(242,313),(136,311)],fill=0);mask.save(r/'masks'/f'{name}.png')
 out=Image.composite(raw,base,mask);out.save(r/'frames'/f'{name}.png')
 records.append({'pose':name,'rawSHA256':hashlib.sha256((r/'raw'/f'{name}.png').read_bytes()).hexdigest(),'sourceSHA256':hashlib.sha256((r/'frames'/f'{name}.png').read_bytes()).hexdigest(),'outsideMaskExact':bool(np.array_equal(np.array(out)[np.array(mask)==0],np.array(base)[np.array(mask)==0])),'status':'pending parent visual QA'})
qa=Image.new('RGB',(512*5,550),'#263846');d=ImageDraw.Draw(qa)
for i,n in enumerate(['anchor','type-burst','review-v2','dispatch-a','dispatch-b-v2']):
 im=Image.open(a/'open-screen-read-v2.png' if n=='anchor' else r/'frames'/f'{n}.png').convert('RGBA');qa.paste(im,(i*512,30),im);d.text((i*512+20,10),n,fill='white')
qa.save(r/'qa/keypose-qa.jpg',quality=94)
# Apply registered gaze to A, with same mask and no head transform.
gaze=Image.open(r/'frames/gaze-right.png');gm=Image.open(r/'masks/gaze-right.png')
for name in ['dispatch-a','dispatch-rise']:
 im=Image.open(r/'frames'/f'{name}.png');Image.composite(gaze,im,gm).save(r/'frames'/f'{name}-gaze.png')
im=Image.open(r/'frames/review-v2.png');Image.composite(gaze,im,gm).save(r/'frames/split-gaze.png')
gazeB=Image.open(a/'open-screen-read-v2.png')
for name in ['dispatch-transit','dispatch-b-v2']:
 im=Image.open(r/'frames'/f'{name}.png');Image.composite(gazeB,im,gm).save(r/'frames'/f'{name}-gazeB.png')
(r/'provenance.json').write_text(json.dumps(records,indent=2))
