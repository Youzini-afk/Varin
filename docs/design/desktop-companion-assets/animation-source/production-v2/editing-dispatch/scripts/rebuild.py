from pathlib import Path
import subprocess,sys
r=Path(__file__).resolve().parent
for n in ["clean_raw.py","register.py","build_sequences.py"]:
 subprocess.run([sys.executable,str(r/n)],check=True)
