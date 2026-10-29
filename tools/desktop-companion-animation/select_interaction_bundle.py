"""Select an exact incremental artwork candidate using an explicit, artifact-bound review record."""
import argparse,hashlib,json,shutil
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('candidate',type=Path);p.add_argument('output',type=Path)
p.add_argument('--base-bundle',type=Path,required=True)
p.add_argument('--review-record',type=Path,required=True)
a=p.parse_args();sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
base=json.loads(a.base_bundle.read_text());baseSHA=sha(a.base_bundle)
if baseSHA!='399bf528c3ee7b601ddbd1ca126df123a8a04b78d353b5a3216d1fce8ab1d268':raise SystemExit('Not the immutable selected base')
baseLedger=json.loads((a.base_bundle.parent/'acceptance.json').read_text())
if baseLedger['selectedBundleSha256']!=baseSHA:raise SystemExit('Base acceptance mismatch')
d=json.loads(a.candidate.read_text());candidateSHA=sha(a.candidate);review=json.loads(a.review_record.read_text())
if review.get('decision')!='selected' or review.get('candidateSHA256')!=candidateSHA or not review.get('basis') or not review.get('notClaimed'):
 raise SystemExit('Missing explicit selection, exact candidate digest, evidence scope or limitations')
if not d.get('candidateOnly') or d.get('geometryEpoch')!=base['geometryEpoch'] or d.get('worldStool')!=base['worldStool']:
 raise SystemExit('Candidate does not preserve the selected upright identity and plate')
old={p['id']:p for p in base['packages']};new=[]
for package in d['packages']:
 if package.get('geometryReference')!=base['geometryEpoch']:raise SystemExit('Mixed geometry')
 if package.get('reviewStatus')=='accepted':
  if package!=old.get(package['id']):raise SystemExit('Accepted base package mutated')
 elif package.get('reviewStatus')=='candidate':new.append(package)
 else:raise SystemExit('Unexpected review status')
if sorted(review.get('newPackageIds',[]))!=sorted(p['id'] for p in new):raise SystemExit('Review does not name the exact new package set')
files={page['file'] for package in d['packages'] for page in package['pages']}|{d['worldStool']['file']}
hashes={}
for name in sorted(files):
 if Path(name).name!=name:raise SystemExit('Nonlocal artifact filename')
 hashes[name]=sha(a.candidate.parent/name)
 if name in baseLedger['fileSha256'] and hashes[name]!=baseLedger['fileSha256'][name]:raise SystemExit('Base texture changed')
if hashes[d['worldStool']['file']]!=d['worldStool']['sha256']:raise SystemExit('World plate mismatch')
# Everything is validated before writing; this never edits source or installs public files itself.
a.output.mkdir(parents=True,exist_ok=True)
for name in sorted(files):shutil.copyfile(a.candidate.parent/name,a.output/name)
for package in new:
 package['reviewStatus']='accepted';package['warning']='Selected exact interaction source set; see acceptance.json for representative visual, source, route and native validation scope.'
d['candidateOnly']=False;d['selection']={'candidateSha256':candidateSHA,'baseBundleSha256':baseSHA,'reviewRecordSha256':sha(a.review_record),'scope':'Exact frozen package and source set only'}
(a.output/'bundle.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
ledger={**review,'geometryEpoch':d['geometryEpoch'],'baseBundleSha256':baseSHA,'baseAcceptanceSha256':sha(a.base_bundle.parent/'acceptance.json'),'selectedBundleSha256':sha(a.output/'bundle.json'),'packageIds':[p['id'] for p in d['packages']],'uniqueDrawingSha256':sorted({f['sha256'] for p in d['packages'] for f in p['frames']}),'fileSha256':hashes}
(a.output/'acceptance.json').write_text(json.dumps(ledger,ensure_ascii=False,indent=2)+'\n')
print(ledger['selectedBundleSha256'])
