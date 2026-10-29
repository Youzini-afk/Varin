from pathlib import Path
from PIL import Image
import numpy as np,json,hashlib
r=Path(__file__).resolve().parent;root=r.parent;s=root/'task-reactions/integration-support';data=json.loads((s/'tail-support-manifest.json').read_text());donor=Image.open(s/data['donor']).convert('RGBA');base=np.array(Image.open(s/data['commonMask']).convert('L'));dest=r/'derived';dest.mkdir(exist_ok=True)
for name,x in data['records'].items():
 src=(s/x['source']).resolve();sha=hashlib.sha256(src.read_bytes()).hexdigest();assert sha==x['sourceSHA256'];im=Image.open(src).convert('RGBA');pro=np.array(Image.open(s/x['foregroundExclusion']).convert('L'));m=np.minimum(base,255-pro);out=Image.composite(donor,im,Image.fromarray(m));patch=Image.open(s/x['cleanPatch']).convert('RGBA');pm=Image.open(s/x['finalPatchMask']).convert('L');out=Image.composite(patch,out,pm);union=np.maximum(m,np.array(pm));assert np.array_equal(np.array(out)[union==0],np.array(im)[union==0]);p=dest/f'{sha[:16]}.png';out.save(p);mp=dest/f'{sha[:16]}-mask.png';Image.fromarray(union).save(mp)
 rec={'source':str(src.relative_to(root)),'sourceSHA256':sha,'detachedSource':str(p.relative_to(root)),'detachedSHA256':hashlib.sha256(p.read_bytes()).hexdigest(),'mask':str(mp.relative_to(root)),'outsideMaskPixelExact':True,'foregroundSupportManifest':str((s/'tail-support-manifest.json').relative_to(root)),'foregroundRecord':name,'embeddedStool':False,'stage':'candidate; finite visual review pending'};(p.with_suffix('.json')).write_text(json.dumps(rec,indent=2)+'\n');qa=Image.new('RGB',(1024,512))
 for i,bg in enumerate(['#263846','#ffffff']):
  b=Image.new('RGBA',(512,512),bg);b.alpha_composite(out);qa.paste(b.convert('RGB'),(i*512,0))
 qa.save(dest/f'{sha[:16]}-review.jpg',quality=96)
 print(name,sha[:16])
