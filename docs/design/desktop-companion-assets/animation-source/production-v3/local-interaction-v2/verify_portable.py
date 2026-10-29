from pathlib import Path
import tempfile,shutil,subprocess,json,hashlib
R=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
paths=[str(p.relative_to(R)) for folder in ['frames','masks'] for p in (R/folder).glob('*.png')]+['manifest.json','generation-inputs.json']
before={p:sha(R/p) for p in paths}
# workspace disk, never /tmp tmpfs
with tempfile.TemporaryDirectory(prefix='interaction-verify-',dir=R.parent) as t:
 c=Path(t)/'portable';shutil.copytree(R,c)
 subprocess.run(['python',str(c/'register_pose.py')],check=True,cwd=c)
 subprocess.run(['python',str(c/'build_handoff.py')],check=True,cwd=c)
 mismatches=[p for p,h in before.items() if sha(c/p)!=h]
 report={'result':'pass' if not mismatches else 'fail','checkedFileCount':len(paths),'mismatches':mismatches,'method':'independent workspace-disk copy; rebuild actual PNGs/masks and timing/source-input manifests byte-identical'}
 (R/'rebuild-verification.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));assert not mismatches
