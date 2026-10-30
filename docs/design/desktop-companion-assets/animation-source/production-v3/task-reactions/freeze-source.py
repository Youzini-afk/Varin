from pathlib import Path
import hashlib,json
D=Path(__file__).parent
(D/'SHA256SUMS.json').write_text(json.dumps({str(p.relative_to(D)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(D.rglob('*')) if p.is_file() and p.name!='SHA256SUMS.json' and not ('qa' in p.parts and p.suffix.lower() in ['.png','.jpg','.jpeg','.gif','.webp'])},indent=2,sort_keys=True)+'\n')
