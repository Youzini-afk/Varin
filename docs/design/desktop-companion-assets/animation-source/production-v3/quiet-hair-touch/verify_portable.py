from pathlib import Path
import json,hashlib,shutil,tempfile,subprocess
R=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
d=json.load(open(R/'manifest.json'));paths=[]
for r in d['newSources']:paths.extend([r['source'],r['mask'],r['provenance']])
paths+=['manifest.json','generation-inputs.json']
with tempfile.TemporaryDirectory(prefix='hair-verify-',dir=R.parent)as t:
 c=Path(t)/'copy';shutil.copytree(R,c);subprocess.run(['python',str(c/'register_pose.py')],check=True,cwd=c);subprocess.run(['python',str(c/'build_handoff.py')],check=True,cwd=c)
 same={p:sha(c/p)==sha(R/p)for p in paths};assert all(same.values())
 frames=[f for a in d['actions'].values()for f in a['frames']]+[f for v in d['ordinaryRecoveryByActualSHA'].values()for f in v];assert all(sha(c/f['source'])==f['actualSourceSHA']for f in frames)
 report={'candidateOnly':True,'independentRebuildExact':same,'actualReachableSourceCount':len(set(f['actualSourceSHA']for f in frames)),'manifestAllReferencesMatchSHA':True,'notEvidence':'This deterministic rebuild is not a normal-speed or native lifecycle acceptance.'}
 (R/'rebuild-verification.json').write_text(json.dumps(report,indent=2)+'\n');print('PASS',len(paths),'rebuild items;',report['actualReachableSourceCount'],'reachable sources')
