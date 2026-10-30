from pathlib import Path
import hashlib,json,subprocess,sys
r=Path(__file__).resolve().parent;index=json.loads((r/'director-source-detached-index-v2.json').read_text())
for e in index['entries']:assert hashlib.sha256((r.parent/e['source']).read_bytes()).hexdigest()==e['sourceSHA256']
for script in ['derive_director_listen.py','derive_director_gather.py']:subprocess.run([sys.executable,str(r/script)],check=True,stdout=subprocess.DEVNULL)
for e in index['entries']:assert hashlib.sha256((r.parent/e['detachedSource']).read_bytes()).hexdigest()==e['detachedSHA256']
print('Director derived art exact SHA rebuild: 9/9')
