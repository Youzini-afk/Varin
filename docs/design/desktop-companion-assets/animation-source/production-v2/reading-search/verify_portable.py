from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib,json,shutil,subprocess,sys
from PIL import Image
import numpy as np
R=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
expect=json.loads((R/'original-candidate-checksums.json').read_text())['candidates']
with TemporaryDirectory(prefix='varin-reading-search-rebuild-') as t:
 C=Path(t)/'reading-search';shutil.copytree(R,C)
 subprocess.run([sys.executable,str(C/'process_poses.py')],check=True,cwd=C)
 checks=[]
 for e in expect:
  p=e['path'];checks.append({'path':p,'matchesOriginalPNGHash':sha(C/p)==e['sha256'],'rebuiltBytesEqual':sha(C/p)==sha(R/p),'rebuiltRGBAEqual':bool(np.array_equal(np.array(Image.open(C/p).convert('RGBA')),np.array(Image.open(R/p).convert('RGBA'))))})
 other=[]
 for p in sorted(R.glob('*-edit-mask.png'))+sorted(R.glob('*-timing-v2.json')):
  other.append({'path':p.name,'sha256':sha(p),'rebuiltHashEqual':sha(p)==sha(C/p.name)})
 private=[]
 for p in R.rglob('*'):
  if p.is_file() and p.suffix in ['.json','.py','.txt','.md','.html']:
   s=p.read_text()
   if ('/'+'workspace'+'/') in s or ('/'+'home'+'/'+'agent'+'/') in s:private.append(p.relative_to(R).as_posix())
 ok=all(x['matchesOriginalPNGHash'] and x['rebuiltBytesEqual'] and x['rebuiltRGBAEqual'] for x in checks) and all(x['rebuiltHashEqual'] for x in other) and not private
 result={'status':'passed' if ok else 'failed','method':'independent temporary directory rebuild; no generation','originalAndRebuiltCandidates':checks,'rebuiltMasksAndTiming':other,'privateAbsolutePathFiles':private,'acceptance':'source reproducibility only, not animation acceptance'}
 (R/'portable-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'status':result['status'],'candidates':len(checks),'masksAndTiming':len(other),'privatePaths':private}))
 if not ok:sys.exit(1)
