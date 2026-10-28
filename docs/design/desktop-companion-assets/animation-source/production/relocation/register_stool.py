from pathlib import Path
from PIL import Image
import json
r=Path(__file__).parent
p=Image.open(r/'source/canonical-stool-plate-v2.png').resize((512,512),Image.Resampling.LANCZOS)
p.save(r/'canonical-v1/stool-plate-v2.png')
reg=p.transform((512,512),Image.Transform.AFFINE,(1/.8,0,-54/.8,0,1/.8,-85/.8),Image.Resampling.BICUBIC)
reg.save(r/'canonical-registered-v1/stool-world-candidate-v2.png')
(r/'canonical-registered-v1/stool-registration-candidate.json').write_text(json.dumps({'source':'source/canonical-stool-plate-v2.png','fullViewport':512,'worldFit':{'scale':.8,'translate':[54,85]},'observedCanonicalVisibleCushionRight':[434,365],'observedCanonicalLegBottom':[424,473],'estimatedOccludedSeatSupport':[300,347],'status':'candidate: hidden perspective not exact source match; contact not verified','constraint':'Fixed world transform; opacity only animates. No body motion from this transform.'},indent=2))
