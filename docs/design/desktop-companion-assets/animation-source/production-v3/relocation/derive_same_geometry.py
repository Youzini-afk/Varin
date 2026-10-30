"""Derive an explicitly approved same-geometry source, never auto-accept overlap.
Paths are relative to production-v3; preserve all bytes outside the real matte.
Usage: python derive_same_geometry.py source.png [--protect mask.png] [--review-overlap]
An overlap blocks derivation unless author protection is supplied or a human has
inspected the saved overlap review and explicitly requests --review-overlap.
"""
from pathlib import Path
import argparse, hashlib, json
import numpy as np
from PIL import Image
p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('--protect');p.add_argument('--review-overlap',action='store_true');a=p.parse_args()
r=Path(__file__).resolve().parent;root=r.parent;v2=root.parent/'production-v2';v2=v2 if v2.is_dir() else root.parent/'varin-animation-production-v2';src=(root/a.source).resolve()
im=Image.open(src).convert('RGBA');assert im.size==(512,512),'Only fixed 512 viewport admitted'
sha=hashlib.sha256(src.read_bytes()).hexdigest();outdir=r/'derived';outdir.mkdir(exist_ok=True)
ref=Image.open(v2/'shared/upright-open-neutral-v2.png').convert('RGBA')
mask=Image.open(v2/'relocation/frames/canonical-stool-removal-mask-v5.png').convert('L');m=np.array(mask)
dif=np.any(np.array(im)!=np.array(ref),axis=2)&(m>0)
review=Image.new('RGB',(1024,512),'#263846');b=Image.new('RGBA',im.size,'#263846');b.alpha_composite(im);review.paste(b.convert('RGB'),(0,0));mark=b.copy();pixels=np.array(mark);pixels[dif]=[255,75,140,255];review.paste(Image.fromarray(pixels).convert('RGB'),(512,0));review.save(outdir/f'{sha[:16]}-overlap.jpg',quality=95)
if dif.any() and not (a.protect or a.review_overlap):raise SystemExit(f'{dif.sum()} overlap pixels require actual visual review/author mask; no detached image made')
if a.protect:m=np.minimum(m,255-np.array(Image.open(root/a.protect).convert('L')))
mask=Image.fromarray(m);donor=Image.open(root/'task-reactions/references/secure-no-stool-clean-donor-v1.png').convert('RGBA');out=Image.composite(donor,im,mask)
path=outdir/f'{sha[:16]}.png';out.save(path);maskpath=outdir/f'{sha[:16]}-mask.png';mask.save(maskpath)
assert np.array_equal(np.array(out)[m==0],np.array(im)[m==0])
record={'source':str(src.relative_to(root)),'sourceSHA256':sha,'detachedSource':str(path.relative_to(root)),'detachedSHA256':hashlib.sha256(path.read_bytes()).hexdigest(),'mask':str(maskpath.relative_to(root)),'outsideMaskPixelExact':True,'overlapPixels':int(dif.sum()),'authorProtect':a.protect,'embeddedStool':False,'stage':'candidate; geometry/contact/light-dark visual review required; no runtime acceptance'}
(path.with_suffix('.json')).write_text(json.dumps(record,indent=2)+'\n')
qa=Image.new('RGB',(1024,512));
for i,bg in enumerate(['#263846','#ffffff']):
 b=Image.new('RGBA',(512,512),bg);b.alpha_composite(out);qa.paste(b.convert('RGB'),(i*512,0))
qa.save(outdir/f'{sha[:16]}-review.jpg',quality=96);print(json.dumps(record,indent=2))
