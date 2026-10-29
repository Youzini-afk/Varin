from pathlib import Path
from PIL import Image
r=Path(__file__).parent
for raw,out in [('contact-015-crop-v2-raw.png','contact-015-crop-placed.png'),('release-low-crop-v2-raw.png','release-low-crop-placed.png')]:
 im=Image.open(r.parent/'shared/upright-open-neutral-v2.png').convert('RGBA');crop=Image.open(r/'sources'/raw).convert('RGBA').resize((260,260),Image.Resampling.LANCZOS);im.paste(crop,(90,190));im.save(r/'sources'/out)
