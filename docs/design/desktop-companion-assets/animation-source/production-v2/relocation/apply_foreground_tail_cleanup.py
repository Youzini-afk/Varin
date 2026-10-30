from pathlib import Path
from PIL import Image
import numpy as np,json,hashlib
r=Path(__file__).parent;s=r.parent/'question-permission-integration-support';patches=json.loads((s/'tail-cleanup-manifest.json').read_text())['records'];original=json.loads((s/'manifest.json').read_text())['records'];mapping={}
for name,rec in patches.items():
 p=patches[rec['aliasPatch']] if 'aliasPatch' in rec else rec;mapping[original[name]['sourceSHA256']]=p
j=json.loads((r/'current-source-detached-index-v3.json').read_text());dest=r/'current-source-detached-v4';dest.mkdir(exist_ok=True)
for e in j['entries']:
 if e['sourceSHA256'] not in mapping:continue
 p=mapping[e['sourceSHA256']];im=Image.open(r/e['detachedSource']);patch=Image.open(s/p['patch']);mask=Image.open(s/p['finalOverrideMask']);out=Image.composite(patch,im,mask);target=dest/f"{e['sourceSHA256'][:16]}.png";out.save(target);union=Image.fromarray(np.maximum(np.array(Image.open(r/e['mask'])),np.array(mask)));mp=dest/f"{e['sourceSHA256'][:16]}-mask.png";union.save(mp);src=Image.open(r.parent.parent/e['source']).convert('RGBA');outside=np.array(union)==0;e['detachedSource']=str(target.relative_to(r));e['detachedSHA256']=hashlib.sha256(target.read_bytes()).hexdigest();e['mask']=str(mp.relative_to(r));e['outsideMaskPixelExact']=bool(np.array_equal(np.array(out)[outside],np.array(src)[outside]));e['foregroundTailCleanup']='../question-permission-integration-support/tail-cleanup-manifest.json'
j['stage']='55 exact-source no-stool drawings; finite pixel review, runtime pending';(r/'current-source-detached-index-v4.json').write_text(json.dumps(j,indent=2)+'\n');print(len(j['entries']),all(x['outsideMaskPixelExact'] for x in j['entries']))
