from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib,json,shutil,subprocess,sys
from PIL import Image
import numpy as np
R=Path(__file__).resolve().parent;sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();m=json.loads((R/'manifest.json').read_text());names=m['runtimeSourceNames']
with TemporaryDirectory(prefix='varin-director-rebuild-') as t:
 c=Path(t)/'new-poses';shutil.copytree(R,c)
 subprocess.run([sys.executable,str(c/'register_pose.py')],cwd=c,check=True);subprocess.run([sys.executable,str(c/'build_handoff.py')],cwd=c,check=True)
 checks=[]
 for n in names:
  a=R/'frames'/f'{n}.png';b=c/'frames'/f'{n}.png';checks.append({'id':n,'sourceSHA256':sha(a),'PNGHashEqual':sha(a)==sha(b),'RGBAEqual':bool(np.array_equal(np.array(Image.open(a)),np.array(Image.open(b)))),'maskEqual':sha(R/'masks'/f'{n}.png')==sha(c/'masks'/f'{n}.png')})
 same=sha(R/'manifest.json')==sha(c/'manifest.json');bad=[]
 for p in R.rglob('*'):
  if p.is_file() and p.suffix in ['.py','.txt','.json','.md','.html'] and any(x in p.read_text() for x in ['/'+'workspace'+'/','/'+'home'+'/'+'agent'+'/']):bad.append(p.relative_to(R).as_posix())
 ok=same and not bad and all(x['PNGHashEqual'] and x['RGBAEqual'] and x['maskEqual'] for x in checks)
 out={'status':'passed' if ok else 'failed','method':'independent temporary copy raw registration rebuild, no generation','actualSourceCount':len(names),'checks':checks,'manifestHashEqual':same,'privateAbsolutePaths':bad,'acceptance':'source reproducibility only; parent scene/runtime review separate'};(R/'portable-verification.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'status':out['status'],'sources':len(names),'manifestEqual':same}))
 if not ok:sys.exit(1)
