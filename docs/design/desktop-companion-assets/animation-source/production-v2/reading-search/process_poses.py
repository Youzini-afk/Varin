from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
from scipy import ndimage as nd
import hashlib,json,numpy as np
R=Path(__file__).parent;A=R/'shared';base=Image.open(A/'upright-open-neutral-v2.png').convert('RGBA');sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
# Edge-only decontamination copied in method from approved anchor clean_anchor.py.
def clean(raw):
 a=np.array(raw);rgb=a[:,:,:3].astype(float);alpha=a[:,:,3].astype(float)/255;labels,n=nd.label(alpha>.02,np.ones((3,3)));sizes=np.bincount(labels.ravel());remove=(sizes[labels]<28)&(labels>0);alpha[remove]=0;fg=alpha>.02;dist=nd.distance_transform_edt(fg);core=(dist>3)&(alpha>.85);_,near=nd.distance_transform_edt(~core,return_indices=True);ref=rgb[near[0],near[1]];band=fg&(dist<=3);bad=band&((rgb.max(2)-rgb.min(2))>95);rgb[bad]=ref[bad];alpha[bad]*=.65;white=band&(rgb.min(2)>225)&((rgb-ref).mean(2)>24);den=((255-ref)**2).sum(2);est=np.divide(((255-rgb)*(255-ref)).sum(2),den,out=np.ones_like(den),where=den>50);alpha[white]*=np.clip(est[white],0,1);rgb[white]=ref[white];out=np.dstack([rgb.clip(0,255).astype('uint8'),(alpha*255).round().astype('uint8')]);out[out[:,:,3]==0]=0
 return Image.fromarray(out),{'islandPixels':int(remove.sum()),'chromaEdgePixels':int(bad.sum()),'whiteEdgePixels':int(white.sum()),'opaqueInteriorRGBUnchanged':bool(np.array_equal(out[:,:,:3][~band&fg],a[:,:,:3][~band&fg]))}
readpoly=[(90,0),(401,0),(417,214),(385,260),(370,318),(324,300),(303,279),(245,280),(222,231),(105,224)]
yawpoly=[(118,0),(402,0),(410,205),(373,233),(331,248),(303,216),(272,193),(224,197),(190,211),(126,226)]
# Generated image-left hand (character's right) performed the gesture despite prompt side; preserve the other hand.
handpoly=[(226,259),(238,257),(251,263),(258,280),(258,297),(249,302),(236,295),(232,282)]
jobs=[('read-prepare-v2','neutral',readpoly,'PAGE_PRESENT'),('read-middle-v1','neutral',readpoly,'READ_ENTER'),('read-settle-v1','neutral',readpoly,'READ_SETTLE'),('read-hand-prepare-v1','read-settle-v1',handpoly,'PAGE_TURN_PREPARE'),('read-turn-v1','read-settle-v1',handpoly,'PAGE_TURN'),('search-left-middle-v1','neutral',yawpoly,'SCAN_SIDE_A_ENTER'),('search-left-v1','neutral',yawpoly,'SCAN_SIDE_A'),('search-right-middle-v1','neutral',yawpoly,'SCAN_SIDE_B_ENTER'),('search-right-v1','neutral',yawpoly,'SCAN_SIDE_B'),('search-focus-v1','screen',handpoly,'SELECT')]
records=[]
for name,src,poly,cue in jobs:
 source=A/('upright-open-neutral-v2.png' if src=='neutral' else 'open-screen-read-v2.png') if src in ['neutral','screen'] else R/(src+'-candidate.png');ref=Image.open(source).convert('RGBA');raw=Image.open(R/(name+'-raw.png')).convert('RGBA');cl,stats=clean(raw);cl.save(R/(name+'-clean-native.png'));im=cl.resize((512,512),Image.Resampling.LANCZOS);im.save(R/(name+'-normalized.png'));m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon(poly,fill=255);m=m.filter(ImageFilter.GaussianBlur(1 if poly==handpoly else 2));arr=np.array(m);arr[arr<3]=0;m=Image.fromarray(arr);out=Image.composite(im,ref,m);out.save(R/(name+'-candidate.png'));m.save(R/(name+'-edit-mask.png'))
 info={'status':'internal candidate; not runtime accepted','cue':cue,'source':source.relative_to(R).as_posix(),'sourceSha256':sha(source),'raw':name+'-raw.png','rawSha256':sha(R/(name+'-raw.png')),'prompt':name+'-exactprompt.txt','candidate':name+'-candidate.png','candidateSha256':sha(R/(name+'-candidate.png')),'canvas':[512,512],'normalization':'full raw square viewport resized; no bbox fit, head rotation, body warp or interpolated drawings','mask':name+'-edit-mask.png','outsideMaskExact':bool(np.array_equal(np.array(out)[arr==0],np.array(ref)[arr==0])),'alphaCleanup':stats}
 if poly==handpoly:info['actualGestureSide']='image-left visible hand (character right); generated opposite prompt side; selected coherent authored gesture, other hand locked'
 (R/(name+'-provenance.json')).write_text(json.dumps(info,indent=2));records.append(info)
anchors={'neutral':base,'screen':Image.open(A/'open-screen-read-v2.png')}
def get(n):return anchors[n] if n in anchors else Image.open(R/(n+'-candidate.png'))
rows=[['neutral','read-prepare-v2','read-middle-v1','read-settle-v1','read-hand-prepare-v1','read-turn-v1'],['search-left-v1','search-left-middle-v1','neutral','search-right-middle-v1','search-right-v1','search-focus-v1']]
qa=Image.new('RGB',(1800,650),'#e9eef2');d=ImageDraw.Draw(qa)
for j,row in enumerate(rows):
 for i,n in enumerate(row):
  bg=Image.new('RGBA',(512,512),'#e9eef2');bg.alpha_composite(get(n));qa.paste(bg.convert('RGB').resize((300,300)),(i*300,j*325));d.text((i*300+5,j*325+304),n,fill='#304353')
qa.save(R/'reading-search-keypose-sequence-v2.jpg',quality=95)
seqs={'reading':[('neutral',550,'prepare'),('read-prepare-v2',100,'PAGE_PRESENT'),('read-middle-v1',110,'READ_ENTER'),('read-settle-v1',800,'READ_SETTLE'),('read-hand-prepare-v1',100,'PAGE_TURN_PREPARE'),('read-turn-v1',180,'PAGE_TURN'),('read-hand-prepare-v1',90,'PAGE_TURN_RELEASE'),('read-settle-v1',450,'READ_SETTLE'),('read-middle-v1',120,'release'),('read-prepare-v2',110,'release'),('neutral',700,'exit')],'search':[('neutral',500,'FAN_OUT'),('search-left-middle-v1',100,'SCAN_SIDE_A_ENTER'),('search-left-v1',650,'SCAN_SIDE_A'),('search-left-middle-v1',90,'release'),('neutral',230,'attend'),('search-right-middle-v1',100,'SCAN_SIDE_B_ENTER'),('search-right-v1',950,'SCAN_SIDE_B'),('search-right-middle-v1',110,'release'),('neutral',140,'return'),('screen',180,'SELECT_PREPARE'),('search-focus-v1',180,'SELECT'),('screen',600,'exit')]}
for name,seq in seqs.items():
 frames=[]
 for n,ms,cue in seq:
  bg=Image.new('RGBA',(512,512),'#e9eef2');bg.alpha_composite(get(n));frames.append(bg.convert('RGB'))
 frames[0].save(R/(name+'-normal-timing-v2.gif'),save_all=True,append_images=frames[1:],duration=[ms for n,ms,cue in seq],loop=0)
 (R/(name+'-timing-v2.json')).write_text(json.dumps({'status':'QA exposure study, not final animation acceptance','frameInterpolation':'none; authored cels only','exitNote':'Reverse traversal uses actual matching authored poses, not synthesized deformation','frames':[{'source':(A/('upright-open-neutral-v2.png' if n=='neutral' else 'open-screen-read-v2.png')).relative_to(R).as_posix() if n in anchors else n+'-candidate.png','durationMs':ms,'cue':cue} for n,ms,cue in seq]},indent=2))
(R/'pose-source-manifest.json').write_text(json.dumps({'status':'10 authored candidate poses + shared anchors, pending parent sequence review','records':records,'knownLimitations':['Full-body static regions locked, but head volume/age still require playback review.','Hand preparation and tap remain sparse authored drawings; this is not final smooth runtime delivery.','Generated hand gestures use character-right/image-left hand, intentionally documented; no mirrored character.','READ_PREPARE_V1 rejected for excessive lean and excluded.'],'files':[{'path':p.name,'sha256':sha(p)} for p in sorted(R.glob('*')) if p.is_file() and p.name!='pose-source-manifest.json']},indent=2))
