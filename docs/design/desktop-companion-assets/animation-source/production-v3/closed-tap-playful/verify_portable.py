from pathlib import Path
import json,hashlib,shutil,tempfile,subprocess
R=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
files=['frames/closed-tap-playful-v1.png','masks/closed-tap-playful-v1.png','frames/closed-tap-playful-v1-provenance.json']
with tempfile.TemporaryDirectory(prefix='closed-playful-verify-',dir=R.parent)as t:
 c=Path(t)/'copy';shutil.copytree(R,c);subprocess.run(['python',str(c/'register_pose.py')],check=True,cwd=c)
 same={f:sha(c/f)==sha(R/f)for f in files};assert all(same.values())
 d=json.load(open(c/'manifest.json'));frames=[f for a in d['actions'].values()for f in a['frames']]+[f for v in d['ordinaryRecoveryByActualSHA'].values()for f in v]
 assert all(sha(c/f['source'])==f['actualSourceSHA']for f in frames)
 report={'candidateOnly':True,'rebuiltExact':same,'actualReachableSourceCount':len(set(f['actualSourceSHA']for f in frames)),'manifestAllReferencesMatchSHA':True}
 (R/'rebuild-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
