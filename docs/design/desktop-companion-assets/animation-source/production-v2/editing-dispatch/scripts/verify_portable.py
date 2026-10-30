from pathlib import Path
import tempfile,shutil,subprocess,sys,json,hashlib
from PIL import Image
import numpy as np
r=Path(__file__).resolve().parent.parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='varin-edit-dispatch-rebuild-') as temp:
 dst=Path(temp)/'isolated';shutil.copytree(r,dst)
 # Remove all generated outputs; references/raw/scripts are the only artwork inputs.
 for name in ['clean','masks','frames','qa']:
  shutil.rmtree(dst/name);(dst/name).mkdir()
 for p in dst.glob('*normal-speed.webp'):p.unlink()
 subprocess.run([sys.executable,str(dst/'scripts/rebuild.py')],check=True)
 pngs=[]
 for p in sorted((r/'frames').glob('*.png')):
  q=dst/'frames'/p.name
  pngs.append({'frame':'frames/'+p.name,'sha256':sha(p),'rebuiltSHA256':sha(q),'pngBytesEqual':sha(p)==sha(q),'rgbaPixelsEqual':bool(np.array_equal(np.asarray(Image.open(p).convert('RGBA')),np.asarray(Image.open(q).convert('RGBA'))))})
 src=json.loads((r/'sequence-manifest.json').read_text());reb=json.loads((dst/'sequence-manifest.json').read_text())
 timeline={n:{'exposures':len(v['frames']),'durationMs':v['durationMs'],'exactFrameCueHoldSHAEqual':v['frames']==reb['sequences'][n]['frames']} for n,v in src['sequences'].items()}
 report={'status':'portable source verification passed','sourceStatus':'candidate only; full runtime acceptance pending','independentCopy':True,'generatedFoldersDeletedBeforeRebuild':True,'noExternalArtInputs':True,'frames':pngs,'sequences':timeline,'allPNGBytesEqual':all(v['pngBytesEqual'] for v in pngs),'allRGBAPixelsEqual':all(v['rgbaPixelsEqual'] for v in pngs),'allTimelinesEqual':all(v['exactFrameCueHoldSHAEqual'] for v in timeline.values())}
 assert report['allPNGBytesEqual'] and report['allRGBAPixelsEqual'] and report['allTimelinesEqual']
 (r/'portable-verification.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps({k:v for k,v in report.items() if k!='frames'},indent=2))
