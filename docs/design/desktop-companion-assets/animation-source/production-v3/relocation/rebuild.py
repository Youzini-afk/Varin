"""Rebuild the frozen 21 derived sources, checking the recorded output hashes.
Review was performed before freeze; --review-overlap does not bless future art.
"""
from pathlib import Path
import json,subprocess,sys,hashlib
r=Path(__file__).resolve().parent;root=r.parent
index=json.loads((r/'current-source-detached-index-v3.json').read_text())
for e in index['entries']:
 assert hashlib.sha256((root/e['source']).read_bytes()).hexdigest()==e['sourceSHA256'],e['source']
 if e.get('foregroundSupportManifest'):continue
 subprocess.run([sys.executable,str(r/'derive_same_geometry.py'),e['source'],'--review-overlap'],check=True,stdout=subprocess.DEVNULL)
subprocess.run([sys.executable,str(r/'derive_task_foreground.py')],check=True,stdout=subprocess.DEVNULL)
for e in index['entries']:assert hashlib.sha256((root/e['detachedSource']).read_bytes()).hexdigest()==e['detachedSHA256'],e['detachedSource']
print(f"Exact rebuild: {len(index['entries'])}/{len(index['entries'])} final derived PNG SHA256 match")
