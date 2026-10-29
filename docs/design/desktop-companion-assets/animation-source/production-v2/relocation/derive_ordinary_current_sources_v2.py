from pathlib import Path
from PIL import Image,ImageFilter
import numpy as np,json,hashlib
r=Path(__file__).parent;root=r.parent.parent;inventory=json.loads((r/'ordinary-source-inventory-snapshot-v1.json').read_text());reference=np.array(Image.open(r.parent/'shared/upright-open-neutral-v2.png').convert('RGBA'));base=np.array(Image.open(r/'frames/canonical-stool-removal-mask-v5.png'));donor=Image.open(r/'frames/secure-no-stool-clean-donor-v1.png').convert('RGBA');dest=r/'current-source-detached-v2';dest.mkdir(exist_ok=True);items={};missing=[]
protections={}
qdir=r.parent/'question-permission-integration-support'
for rec in json.loads((qdir/'manifest.json').read_text())['records'].values():protections[rec['sourceSHA256']]=qdir/rec['protection']
ddir=r.parent/'integration/dispatch-foreground-protection'
for rec in json.loads((ddir/'manifest.json').read_text()):protections[rec['sourceSHA256']]=ddir/rec['protectMask']
for seq in inventory['sequences']:
 if seq['id']=='relocation-core':continue
 for f in seq['frames']:
  sha=f['sha256']
  if sha in items:
   items[sha]['sequenceIds'].append(seq['id']);continue
  src=root/f['source'];im=Image.open(src).convert('RGBA');a=np.array(im);dif=np.any(a!=reference,axis=2)&(base>0);count=int(dif.sum())
  if count>150 and sha not in protections:
   if not any(x['sourceSHA256']==sha for x in missing):missing.append({'source':f['source'],'sourceSHA256':sha,'reason':'authored lower sleeve intersects removal region; awaiting explicit foreground mask','changedPixelsInMask':count})
   continue
  # Preserve each actual authored foreground difference rather than resetting to canonical cuffs.
  protect=Image.open(protections[sha]).convert('L') if sha in protections else Image.fromarray((dif*255).astype('uint8')).filter(ImageFilter.MaxFilter(5));mask=Image.fromarray(np.minimum(base,255-np.array(protect)));out=Image.composite(donor,im,mask);p=dest/f'{sha[:16]}.png';out.save(p);mp=dest/f'{sha[:16]}-mask.png';mask.save(mp);ma=np.array(mask)>0
  items[sha]={'source':f['source'],'sourceSHA256':sha,'detachedSource':str(p.relative_to(r)),'detachedSHA256':hashlib.sha256(p.read_bytes()).hexdigest(),'mask':str(mp.relative_to(r)),'outsideMaskPixelExact':bool(np.array_equal(np.array(out)[~ma],a[~ma])),'foregroundDifferencePixelsProtected':count,'embeddedStool':False,'sequenceIds':[seq['id']],'stage':'same-geometry derived candidate; finite visual review pending'}
rows=list(items.values());(r/'current-source-detached-index-v2.json').write_text(json.dumps({'geometryReference':'varin-upright-v2','donor':'frames/secure-no-stool-clean-donor-v1.png','method':'actual no-stool hidden-surface drawing; source-specific foreground exclusion; no body rescale','entries':rows,'missing':missing},indent=2)+'\n')
w=8;size=256;qa=Image.new('RGB',(w*size,((len(rows)+w-1)//w)*size),'#263846')
for i,e in enumerate(rows):
 im=Image.open(r/e['detachedSource']).resize((size,size));b=Image.new('RGBA',im.size,'#263846');b.alpha_composite(im);qa.paste(b.convert('RGB'),(i%w*size,i//w*size))
qa.save(r/'current-source-detached-review-v2.jpg',quality=96);print('entries',len(rows),'missing',len(missing),'outside exact',all(e['outsideMaskPixelExact'] for e in rows))
