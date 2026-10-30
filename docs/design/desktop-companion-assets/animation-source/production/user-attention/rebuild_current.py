"""Rebuild current study candidates from retained authored drawings; no image generation."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).parent
(root/'registered/attention-lift-v1').mkdir(parents=True,exist_ok=True)
for script in ['register_single_v1.py','register_attention_sequence_v1.py','register_attention_sequence_v2.py','register_permission_v1.py','register_permission_v2.py','register_completion_wave_v1.py','clean_wave_local_alpha_v2.py']:
    subprocess.run([sys.executable,str(root/script)],check=True,cwd=root)
