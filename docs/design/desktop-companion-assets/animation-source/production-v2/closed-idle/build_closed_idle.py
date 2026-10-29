from pathlib import Path
from PIL import Image,ImageDraw
import numpy as np,json,hashlib
R=Path(__file__).resolve().parent;ref=R/'references';F=R/'frames';Q=R/'qa';F.mkdir(exist_ok=True);Q.mkdir(exist_ok=True);sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();base=Image.open(ref/'closed-rest-rigid-v2.png').convert('RGBA');neutral=Image.open(ref/'open-neutral.png').convert('RGBA');records=[]
# Already composited eyelids copied only where actual source eye mask is nonzero: do not feather twice.
for name,source,maskfile in [('blink-half','neutral-blink-half.png','eye-mask.png'),('blink-closed','neutral-blink-closed.png','eye-mask.png'),('look-left-middle','left-middle-authored.png','yaw-edit-mask.png'),('look-left-peak','left-peak-authored.png','yaw-edit-mask.png')]:
 im=Image.open(ref/source).convert('RGBA');mask=Image.open(ref/maskfile).convert('L');m=np.array(mask)
 if name.startswith('blink'):
  assert np.array_equal(np.array(base)[m>0],np.array(neutral)[m>0]),'head geometry differs; cannot reuse blink'
  mask=Image.fromarray(np.where(m>0,255,0).astype('uint8'));out=Image.composite(im,base,mask)
 else:out=Image.composite(im,base,mask)
 out.save(F/(name+'.png'));mask.save(F/(name+'-mask.png'));a=np.array(mask);z=np.array(out);b=np.array(base)
 records.append({'pose':name,'source':'frames/'+name+'.png','sha256':sha(F/(name+'.png')),'authorSource':'references/'+source,'authorSourceSHA256':sha(ref/source),'mask':'frames/'+name+'-mask.png','outsideMaskExact':bool(np.array_equal(z[a==0],b[a==0])),'closedLaptopHandsKneesStoolProtectedY250PlusExact':bool(np.array_equal(z[250:],b[250:]))})
base.save(F/'closed-rest.png')
# Unequal quiet rests; a single purposefully held side glance, never a symmetrical clockwork sway.
seq=[('closed-rest',4100,'hold','QUIET'),('blink-half',45,'act','BLINK_CLOSE'),('blink-closed',75,'act','BLINK_CLOSED'),('blink-half',45,'act','BLINK_OPEN'),('closed-rest',6350,'hold','QUIET'),('look-left-middle',110,'enter','NOTICE_SIDE'),('look-left-peak',780,'hold','LOOK_SIDE'),('look-left-middle',120,'exit','RETURN_ATTENTION'),('closed-rest',3180,'hold','QUIET'),('blink-half',45,'act','BLINK_CLOSE'),('blink-closed',75,'act','BLINK_CLOSED'),('blink-half',45,'act','BLINK_OPEN'),('closed-rest',7580,'hold','QUIET'),('blink-half',45,'act','BLINK_CLOSE'),('blink-closed',85,'act','BLINK_CLOSED'),('blink-half',50,'act','BLINK_OPEN'),('closed-rest',5300,'hold','QUIET')]
frames=[]
for n,ms,phase,cue in seq:frames.append({'source':'frames/'+n+'.png','sha256':sha(F/(n+'.png')),'durationMs':ms,'phase':phase,'cue':cue,'pose':'upright-v2:closed' if n=='closed-rest' else 'upright-v2:closed-idle:'+n,'exitTo':['upright-v2:closed'] if n=='closed-rest' else []})
recovery={str(i):[i] if n=='closed-rest' else [i,0] if n=='blink-half' else [i,3,0] if n=='blink-closed' else [i,0] if n=='look-left-middle' else [i,7,0] for i,(n,*_) in enumerate(seq)}
manifest={'status':'candidate, parent visual review and integration pending','geometryReference':'varin-upright-v2','canvas':[512,512],'canonicalClosedSHA256':sha(ref/'closed-rest-rigid-v2.png'),'entryPose':'upright-v2:closed','exitPose':'upright-v2:closed','loop':[0,len(frames)],'durationMs':sum(f['durationMs'] for f in frames),'frames':frames,'safeRecoveryFromActualExposure':recovery,'newUniqueSourceCount':4,'sources':records,'rules':['Do not replay a side glance merely because a new business state arrives.','Latest real intent interrupts quiet hold immediately; actual gaze/eyelid drawing follows listed short recovery.','No blink over yawed head; all blinks occur on canonical head.','Reduced motion uses canonical closed-rest; no optional repeating gaze/blink.','No fake operations, completion or waiting receipt are conveyed.','Root pointer movement has priority; source-grab map must cover the four added actual SHA.'],'reuseEvidence':'Blink eye support pixels match canonical neutral exactly; yaw authored neck/head uses original coherent motion mask, all pixels y>=250 exactly canonical mechanical closed.'}
manifest['safeRecoveryExposureOverridesMs']={str(i):([min(ms,60),80] if n in ['blink-half','look-left-middle'] else [min(ms,75),45,80] if n=='blink-closed' else [min(ms,60),110,80] if n=='look-left-peak' else [1]) for i,(n,ms,*_) in enumerate(seq)}
manifest['blinkSourceAliases']={'blink-half':'../question-permission/local-closures/closed-quiet-blink-half.png','blink-closed':'../question-permission/local-closures/closed-quiet-blink-closed.png'}
(R/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
qa=Image.new('RGB',(1536,1070),'#e9eef2');d=ImageDraw.Draw(qa)
for j,bgc in enumerate(['#e9eef2','#263846']):
 for i,n in enumerate(['closed-rest','look-left-middle','look-left-peak']):
  bg=Image.new('RGBA',(512,512),bgc);bg.alpha_composite(Image.open(F/(n+'.png')));qa.paste(bg.convert('RGB'),(i*512,j*535));d.text((i*512+10,j*535+514),n,fill='#516b86')
qa.save(Q/'closed-idle-yaw-contact.jpg',quality=95)
qa=Image.new('RGB',(1536,540),'#e9eef2');d=ImageDraw.Draw(qa)
for i,n in enumerate(['closed-rest','blink-half','blink-closed']):
 bg=Image.new('RGBA',(512,512),'#e9eef2');bg.alpha_composite(Image.open(F/(n+'.png')));qa.paste(bg.convert('RGB'),(i*512,0));d.text((i*512+10,514),n,fill='#516b86')
qa.save(Q/'closed-idle-blink-contact.jpg',quality=95)
gif=[]
for f in frames:
 bg=Image.new('RGBA',(512,512),'#e9eef2');bg.alpha_composite(Image.open(R/f['source']));gif.append(bg.convert('RGB'))
gif[0].save(Q/'closed-idle-normal-timing.gif',save_all=True,append_images=gif[1:],duration=[f['durationMs'] for f in frames],loop=0)
