from pathlib import Path
import hashlib,json
D=Path(__file__).parent
files={str(p.relative_to(D)):hashlib.sha256(p.read_bytes()).hexdigest() for p in D.rglob('*') if p.is_file() and p.name not in ['SHA256SUMS.json','portable-test-location.txt']}
(D/'SHA256SUMS.json').write_text(json.dumps(files,indent=2,sort_keys=True)+'\n')
