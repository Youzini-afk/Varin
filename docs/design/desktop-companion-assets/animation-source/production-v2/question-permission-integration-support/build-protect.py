from PIL import Image,ImageDraw
from pathlib import Path
import numpy as np,json,hashlib
D=Path(__file__).parent;P=D.parent/'question-permission';common=Image.open(D.parent/'relocation/frames/canonical-stool-removal-mask-v5.png').convert('L')
# Hand-authored garment silhouette at the only common-mask collision area.
# Not the original edit mask: that includes background/seat cleanup pixels.
# Traced white/blue coat tail and lower sleeve; stops before black seat surface.
poly=[(290,170),(385,170),(385,305),(361,323),(365,329),(370,335),(375,341),(380,349),(384,357),(387,362),(373,364),(360,364),(352,358),(344,352),(333,341),(290,330)]
records={}
for n in ['ask','offer','offer-mid','attend-corrected','listen-rest']:
 mask=Image.new('L',(512,512));ImageDraw.Draw(mask).polygon(poly,fill=255)
 # Only claim protection where shared removal would touch this foreground.
 a=np.minimum(np.asarray(mask),np.asarray(common));Image.fromarray(a).save(D/f'{n}-stool-exclusion.png')
 records[n]={'source':str(Path('../question-permission/poses')/f'{n}.png'),'sourceSHA256':hashlib.sha256((P/'poses'/f'{n}.png').read_bytes()).hexdigest(),'protection':f'{n}-stool-exclusion.png','protectedPixels':int((a>0).sum()),'originalEditMask':str(Path('../question-permission/masks')/f'{n}.png')}
for n in ['half','closed']:
 mask=Image.open(D/'listen-rest-stool-exclusion.png');mask.save(D/f'listen-rest-{n}-stool-exclusion.png');records[f'listen-rest-{n}']={'source':str(Path('../question-permission/blink')/f'listen-rest-{n}.png'),'sourceSHA256':hashlib.sha256((P/'blink'/f'listen-rest-{n}.png').read_bytes()).hexdigest(),'protection':f'listen-rest-{n}-stool-exclusion.png','bodyGeometry':'identical to listen-rest; only eyelids differ'}
(D/'manifest.json').write_text(json.dumps({'pathBase':'manifest directory','status':'author traced integration foreground exclusion; verify donor composite visually','method':'removeMask=commonMask*(1-protection/255); retain exact garment foreground; not rectangle, not color threshold','polygon':poly,'notes':'Original edit masks are NOT foreground masks and include small seat/background changes. Do not protect all changed pixels: bottom edge changes y365..367 are seat noise. Only coat tail/lower sleeve silhouette is protected here. Frozen source files untouched.','records':records},indent=2))
