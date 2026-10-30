from pathlib import Path
import json,hashlib
import numpy as np
from PIL import Image
r=Path(__file__).resolve().parent;root=r.parent.parent;srcdir=root/'closed-tap-playful';v2=root.parent/'production-v2';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest=json.loads((srcdir/'manifest.json').read_text());old=json.loads((v2/'relocation/current-source-detached-index-v4.json').read_text());neutral=next(e for e in old['entries'] if e['sourceSHA256'].startswith('d029c4fc7'));ref=Image.open(srcdir/'references/closed-rest-rigid-v2.png').convert('RGBA');donor=Image.open(v2/'relocation'/neutral['detachedSource']).convert('RGBA');mask=Image.open(v2/'relocation'/neutral['mask']).convert('L');m=np.array(mask)>0;rows=[];(r/'frames').mkdir(exist_ok=True)
for e in manifest['newSources']:
 src=srcdir/e['source'];assert sha(src)==e['sha256'];im=Image.open(src).convert('RGBA');assert np.array_equal(np.array(im)[200:],np.array(ref)[200:]);assert np.array_equal(np.array(im)[m],np.array(ref)[m]);out=Image.composite(donor,im,mask);p=r/'frames'/Path(e['source']).name;out.save(p);mp=p.with_name(p.stem+'-mask.png');mask.save(mp);assert np.array_equal(np.array(out)[~m],np.array(im)[~m]);rows.append({'source':str(src.relative_to(root)),'sourceSHA256':e['sha256'],'detachedSource':str(p.relative_to(root)),'detachedSHA256':sha(p),'mask':str(mp.relative_to(root)),'maskSHA256':sha(mp),'outsideMaskPixelExact':True,'lowerBodyY200ExactToCanonical':True,'embeddedStool':False,'ordinaryRecovery':manifest['ordinaryRecoveryByActualSHA'][e['sha256']],'ordinaryRecoveryPathBase':'closed-tap-playful','restoreSeatedSameExposure':True,'stage':'candidate; art and actual player acceptance separate'})
known={e['sourceSHA256'] for e in old['entries']}|{e['sourceSHA256'] for e in rows};frames=[f for a in manifest['actions'].values() for f in a['frames']]+[f for fs in manifest['ordinaryRecoveryByActualSHA'].values() for f in fs];unique={f['actualSourceSHA']:f['source'] for f in frames};assert not(set(unique)-known)
for h,p in unique.items():assert sha(srcdir/p)==h
index={'pathBase':'production-v3','geometryReference':'varin-upright-v2','sourceManifest':'closed-tap-playful/manifest.json','sourceManifestSHA256':sha(srcdir/'manifest.json'),'entries':rows,'actualActionRecoverySourceCount':len(unique),'missing':[],'method':'Exact same lower geometry as canonical; accepted canonical no-stool source/matte, no new generated identity or pose','interruptRule':'Same displayed SHA first; suppress semantic cues on author recovery; exact seated counterpart on early release; current exposure on regrab','status':'candidate, no selected/public change'};(r/'index.json').write_text(json.dumps(index,indent=2)+'\n')
qa=Image.new('RGB',(1024,512*len(rows)))
for j,e in enumerate(rows):
 im=Image.open(root/e['detachedSource']).convert('RGBA')
 for i,bg in enumerate(['#263846','#ffffff']):
  b=Image.new('RGBA',(512,512),bg);b.alpha_composite(im);qa.paste(b.convert('RGB'),(i*512,j*512))
qa.save(r/'review.jpg',quality=96);print('new',len(rows),'action/recovery',len(unique),'missing0')
