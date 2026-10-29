from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib,json,shutil,subprocess,sys
from PIL import Image
import numpy as np
R=Path(__file__).resolve().parent;sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();manifest=json.loads((R/'manifest.json').read_text());names=manifest['runtimeSourceNames']
with TemporaryDirectory(prefix='varin-companionship-rebuild-') as t:
 C=Path(t)/'companionship';shutil.copytree(R,C);subprocess.run([sys.executable,str(C/'register_pose.py')],check=True,cwd=C);subprocess.run([sys.executable,str(C/'build_handoff.py')],check=True,cwd=C)
 checks=[]
 for n in names:
  a=R/'frames'/f'{n}.png';b=C/'frames'/f'{n}.png';checks.append({'name':n,'sourceSHA256':sha(a),'rebuiltPNGHashEqual':sha(a)==sha(b),'rebuiltRGBAEqual':bool(np.array_equal(np.array(Image.open(a)),np.array(Image.open(b)))),'maskHashEqual':sha(R/'masks'/f'{n}.png')==sha(C/'masks'/f'{n}.png')})
 textbad=[]
 for p in R.rglob('*'):
  if p.is_file() and p.suffix in ['.py','.txt','.json','.md','.html'] and (('/'+'workspace'+'/') in p.read_text() or ('/'+'home'+'/'+'agent'+'/') in p.read_text()):textbad.append(p.relative_to(R).as_posix())
 mh=sha(R/'manifest.json')==sha(C/'manifest.json');ok=all(x['rebuiltPNGHashEqual'] and x['rebuiltRGBAEqual'] and x['maskHashEqual'] for x in checks) and mh and not textbad
 out={'status':'passed' if ok else 'failed','method':'independent temporary copy rebuild, no generation','actualSourceCount':len(names),'checks':checks,'manifestHashEqual':mh,'privateAbsolutePathFiles':textbad,'acceptance':'reproducibility only; runtime interaction acceptance separate'};(R/'portable-verification.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'status':out['status'],'sources':len(names),'manifestEqual':mh,'privatePaths':textbad}));
 if not ok:sys.exit(1)
