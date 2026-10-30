"""Select an exact incremental artwork candidate using an explicit, artifact-bound review record."""
import argparse,hashlib,json,shutil,os
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('candidate',type=Path);p.add_argument('output',type=Path)
mode=p.add_mutually_exclusive_group(required=True)
mode.add_argument('--base-bundle',type=Path)
mode.add_argument('--explicit-baseline',type=Path)
p.add_argument('--build-receipt',type=Path)
p.add_argument('--rebuild-receipt',type=Path)
p.add_argument('--review-record',type=Path,required=True)
a=p.parse_args();sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
if a.explicit_baseline:
 if not a.build_receipt or not a.rebuild_receipt:raise SystemExit('Explicit selection requires build and source rebuild receipts')
 if a.output.exists():raise SystemExit('Explicit selection requires a fresh output directory')
 inputs=[a.candidate,a.explicit_baseline,a.review_record,a.build_receipt,a.rebuild_receipt]
 if any(path.resolve().is_relative_to(a.output.resolve()) for path in inputs):raise SystemExit('Output cannot contain selection inputs')
 d=json.loads(a.candidate.read_text());baseline=json.loads(a.explicit_baseline.read_text())
 build=json.loads(a.build_receipt.read_text());rebuild=json.loads(a.rebuild_receipt.read_text());review=json.loads(a.review_record.read_text())
 candidateSHA=sha(a.candidate);baselineSHA=sha(a.explicit_baseline)
 bindings={'candidateSHA256':candidateSHA,'baselineSHA256':baselineSHA,'buildReceiptSHA256':sha(a.build_receipt),'rebuildReceiptSHA256':sha(a.rebuild_receipt)}
 if any(review.get(k)!=v for k,v in bindings.items()):raise SystemExit('Review artifact binding mismatch')
 if (review.get('decision')!='selected' or review.get('reviewer')!='assistant'
     or review.get('scope')!='feature-branch default candidate' or not review.get('basis') or not review.get('notClaimed')):
  raise SystemExit('Explicit assistant review scope and limitations required')
 if build.get('candidateSHA256')!=candidateSHA or rebuild.get('sourceManifestSHA256')!=baselineSHA or rebuild.get('historicalPreparedInputs') is not False:
  raise SystemExit('Candidate or standalone source rebuild receipt mismatch')
 prepared=a.rebuild_receipt.parent/'runtime-baseline.json'
 if not prepared.is_file() or sha(prepared)!=build.get('manifestSHA256'):raise SystemExit('Prepared baseline build binding mismatch')
 prep=baseline.get('sourcePreparation',{});recipe=a.explicit_baseline.parent/prep.get('recipe','')
 if not recipe.is_file() or sha(recipe)!=prep.get('recipeSHA256') or rebuild.get('recipeSHA256')!=prep.get('recipeSHA256'):
  raise SystemExit('Selected recipe binding mismatch')
 if not rebuild.get('pythonVersion') or not rebuild.get('pillowVersion') or not rebuild.get('toolSHA256'):
  raise SystemExit('Missing reproducible preparation tool versions')
 packages=d.get('packages',[]);ids=[x['id'] for x in packages]
 expectedIds=[x['id'] for x in baseline['sequences']+baseline['nodes']]
 sources=sorted({f['sha256'] for x in packages for f in x['frames']})
 expectedSources=sorted({x['sourceSHA256'] for x in baseline['nodes']}|{f['sourceSHA256'] for x in baseline['sequences'] for f in x['frames']})
 geometry=baseline['geometryReference']
 if (d.get('candidateOnly') is not True or d.get('geometryEpoch')!=geometry or d.get('endpoints')!=baseline.get('endpoints')
     or not d.get('endpoints') or len(ids)!=len(set(ids)) or sorted(ids)!=sorted(expectedIds)
     or sorted(review.get('newPackageIds',[]))!=sorted(ids) or build.get('packageCount')!=len(ids)
     or sources!=expectedSources or sources!=build.get('actualSources') or sources!=review.get('uniqueDrawingSha256')):
  raise SystemExit('Explicit package, source or endpoint set mismatch')
 if any(x.get('reviewStatus')!='candidate' or x.get('geometryReference')!=geometry or x.get('stage')!='motion-candidate' for x in packages):
  raise SystemExit('Mixed package acceptance or geometry')
 files={page['file'] for x in packages for page in x['pages']}|{d['worldStool']['file']};hashes={}
 for name in sorted(files):
  if Path(name).name!=name:raise SystemExit('Nonlocal artifact filename')
  hashes[name]=sha(a.candidate.parent/name)
 if hashes!=review.get('fileSha256'):raise SystemExit('Review atlas/plate digest map mismatch')
 if hashes[d['worldStool']['file']]!=d['worldStool']['sha256'] or d['worldStool']['sha256']!=baseline['worldStool']['sourceSHA256']:
  raise SystemExit('World plate mismatch')
 # All checks precede output. Immutable exact-byte links avoid a second large atlas copy.
 a.output.mkdir(parents=True)
 for name in sorted(files):
  try:os.link(a.candidate.parent/name,a.output/name)
  except OSError:shutil.copyfile(a.candidate.parent/name,a.output/name)
 for package in packages:
  package['reviewStatus']='accepted';package['warning']='Assistant-selected exact feature-branch source set; bounded review scope and unverified behavior are recorded in acceptance.json.'
 d['candidateOnly']=False;d['selection']={**bindings,'reviewRecordSha256':sha(a.review_record),'scope':review['scope']}
 (a.output/'bundle.json').write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
 ledger={**review,'geometryEpoch':geometry,'selectedBundleSha256':sha(a.output/'bundle.json'),'packageIds':ids,'fileSha256':hashes,'sourceRebuild':rebuild,'publicInstalled':False}
 (a.output/'acceptance.json').write_text(json.dumps(ledger,ensure_ascii=False,indent=2)+'\n')
 print(ledger['selectedBundleSha256']);raise SystemExit(0)
if a.build_receipt or a.rebuild_receipt:raise SystemExit('Source rebuild receipts require explicit-baseline mode')
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
