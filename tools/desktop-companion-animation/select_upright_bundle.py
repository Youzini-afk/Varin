"""Select one explicitly reviewed candidate artifact by exact digest; never blanket-accept future art."""
import argparse,hashlib,json,shutil
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('candidate',type=Path);p.add_argument('output',type=Path);p.add_argument('--expected-sha',required=True);a=p.parse_args()
raw=a.candidate.read_bytes();digest=hashlib.sha256(raw).hexdigest()
if digest!=a.expected_sha:raise SystemExit('Candidate changed since selection; no artwork promoted')
d=json.loads(raw)
if not d.get('candidateOnly') or d.get('geometryEpoch')!='varin-upright-v2':raise SystemExit('Not the reviewed upright candidate')
files={page['file'] for package in d['packages'] for page in package['pages']}|{d['worldStool']['file']}
a.output.mkdir(parents=True,exist_ok=True)
fileHashes={}
for name in sorted(files):
 if Path(name).name!=name:raise SystemExit('Nonlocal artifact filename')
 source=a.candidate.parent/name;fileHashes[name]=hashlib.sha256(source.read_bytes()).hexdigest();shutil.copyfile(source,a.output/name)
if fileHashes[d['worldStool']['file']]!=d['worldStool']['sha256']:raise SystemExit('World plate hash mismatch')
for package in d['packages']:
 if package.get('reviewStatus')!='candidate' or package['geometryReference']!=d['geometryEpoch']:raise SystemExit('Unexpected review or geometry contract')
 package['reviewStatus']='accepted';package['warning']='Selected upright source set: representative parent/peer visual review, exact preserved-pixel/source checks and complete route checks. Native v2 integration validation remains required.'
d['candidateOnly']=False;d['selection']={'candidateSha256':digest,'scope':'This exact frozen artifact only; no permission to accept later candidate art.'}
(a.output/'bundle.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
ledger={'geometryEpoch':d['geometryEpoch'],'candidateSha256':digest,'selectedBundleSha256':hashlib.sha256((a.output/'bundle.json').read_bytes()).hexdigest(),'packageIds':[x['id'] for x in d['packages']],'uniqueDrawingSha256':sorted({f['sha256'] for x in d['packages'] for f in x['frames']}),'fileSha256':fileHashes,'basis':['Parent and peer representative normal-speed/source visual checks of the six upright families, mechanical lid, closed idle, no-stool source groups and world plate','Exact source SHA and protected-pixel provenance; 55/55 ordinary-source pickup entries','361 action routes,390 hold interruptions,990 actual-controller pickup/release/regrab cases and28 core repetitions','Limited browser reading/permission/denial/closed and permission pointer relocation observations'],'notClaimed':['Every unique frame independently played by every reviewer','Windows/macOS or new-epoch native Electron QA','Generic neutral recovery constitutes confirmed executor stop'],'nativeV2Status':'pending'}
(a.output/'acceptance.json').write_text(json.dumps(ledger,ensure_ascii=False,indent=2)+'\n');print(ledger['selectedBundleSha256'])
