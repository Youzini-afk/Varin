from pathlib import Path
from PIL import Image
import numpy as np,json,hashlib
r=Path(__file__).parent;j=json.loads((r/'current-source-detached-index-v2.json').read_text());entries={e['sourceSHA256']:e for e in j['entries']};idle=json.loads((r.parent/'closed-idle/manifest.json').read_text());dest=r/'current-source-detached-v3';dest.mkdir(exist_ok=True);mask=Image.open(r/'frames/canonical-stool-removal-mask-v5.png');donor=Image.open(r/'frames/secure-no-stool-clean-donor-v1.png');new=[]
for f in idle['frames']:
 sha=f['sha256']
 if sha in entries:continue
 src=r.parent/'closed-idle'/f['source'];im=Image.open(src).convert('RGBA');out=Image.composite(donor,im,mask);p=dest/f'{sha[:16]}.png';out.save(p);ma=np.array(mask)>0;e={'source':str(src.relative_to(r.parent.parent)),'sourceSHA256':sha,'detachedSource':str(p.relative_to(r)),'detachedSHA256':hashlib.sha256(p.read_bytes()).hexdigest(),'mask':'frames/canonical-stool-removal-mask-v5.png','outsideMaskPixelExact':bool(np.array_equal(np.array(out)[~ma],np.array(im)[~ma])),'foregroundDifferencePixelsProtected':0,'embeddedStool':False,'sequenceIds':['closed-idle'],'stage':'same lower geometry as approved closed; source-level review pending'};entries[sha]=e;new.append(e)
j['entries']=list(entries.values());j['closedIdleManifest']='../closed-idle/manifest.json';(r/'current-source-detached-index-v3.json').write_text(json.dumps(j,indent=2)+'\n')
qa=Image.new('RGB',(512*len(new),512),'#263846')
for i,e in enumerate(new):
 im=Image.open(r/e['detachedSource']);bg=Image.new('RGBA',im.size,'#263846');bg.alpha_composite(im);qa.paste(bg.convert('RGB'),(i*512,0))
qa.save(r/'closed-idle-detached-review-v3.jpg',quality=96);print('total',len(entries),'new',len(new))
