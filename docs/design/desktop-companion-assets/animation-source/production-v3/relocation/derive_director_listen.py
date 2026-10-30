from pathlib import Path
import hashlib,json
import numpy as np
from PIL import Image
r=Path(__file__).resolve().parent;root=r.parent;v2=root.parent/'production-v2';srcdir=root/'director-performance';old=json.loads((v2/'relocation/current-source-detached-index-v4.json').read_text());old=next(e for e in old['entries'] if e['sourceSHA256']=='0633d12e97fd3e8f2bdb5b3bcfbcb7463888412e19263bd88e7ba12d14d2827a');donor=Image.open(v2/'relocation'/old['detachedSource']).convert('RGBA');mask=Image.open(v2/'relocation'/old['mask']).convert('L');ref=Image.open(srcdir/'references/listen-rest.png').convert('RGBA');m=np.array(mask)>0;outdir=r/'director-derived';outdir.mkdir(exist_ok=True);records=[]
for e in json.loads((srcdir/'current-source-index.json').read_text())['sources']:
 if not e['id'].startswith('listen'):continue
 p=srcdir/e['source'];assert hashlib.sha256(p.read_bytes()).hexdigest()==e['sourceSHA256'];im=Image.open(p).convert('RGBA');assert np.array_equal(np.array(im)[m],np.array(ref)[m]),'New foreground requires author review'
 out=Image.composite(donor,im,mask);q=outdir/(e['id']+'.png');out.save(q);mask.save(outdir/(e['id']+'-mask.png'));assert np.array_equal(np.array(out)[~m],np.array(im)[~m]);rec={'source':str(p.relative_to(root)),'sourceSHA256':e['sourceSHA256'],'detachedSource':str(q.relative_to(root)),'detachedSHA256':hashlib.sha256(q.read_bytes()).hexdigest(),'mask':str((outdir/(e['id']+'-mask.png')).relative_to(root)),'embeddedStool':False,'outsideMaskPixelExact':True,'stage':'candidate; visual review pending','method':'exact inherited listen lower-body pixels, same accepted v2 listen-specific matte and hidden-surface patch'};records.append(rec)
 qa=Image.new('RGB',(1024,512))
 for i,bg in enumerate(['#263846','#ffffff']):
  b=Image.new('RGBA',(512,512),bg);b.alpha_composite(out);qa.paste(b.convert('RGB'),(i*512,0))
 qa.save(outdir/(e['id']+'-review.jpg'),quality=96)
(r/'director-source-detached-index-v1.json').write_text(json.dumps({'pathBase':'production-v3','entries':records,'stage':'candidate, only4listen; gather5 awaiting author foreground'},indent=2)+'\n');print(len(records))
