from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,hashlib
D=Path(__file__).parent;B=D/'blink';B.mkdir(exist_ok=True);base=Image.open(D/'references/upright-open-neutral-v2.png').convert('RGBA');mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask)
d.polygon([(202,133),(215,128),(238,129),(247,136),(246,153),(230,159),(211,151)],fill=255)
d.polygon([(271,131),(284,124),(306,125),(316,131),(310,149),(289,155),(274,149)],fill=255)
mask=mask.filter(ImageFilter.GaussianBlur(.65));mask.save(B/'eye-mask.png');records={}
for state in ['half','closed']:
 raw=Image.open(D/'raw'/f'blink-{state}.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 for name,anchor in [('neutral',base),('listen-rest',Image.open(D/'poses/listen-rest.png').convert('RGBA'))]:
  im=Image.composite(raw,anchor,mask);im.save(B/f'{name}-{state}.png');a=np.asarray(im);b=np.asarray(anchor);outside=np.asarray(mask)==0;records[f'{name}-{state}']={'outsideEyeMaskChangedPixels':int(np.any(a[outside]!=b[outside],axis=-1).sum())}
 # Eye patch is replacement RGBA; composite with mask, do not alpha-over twice.
 raw.putalpha(mask);raw.save(B/f'eye-patch-{state}.png')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'status':'internal artwork reviewed; runtime integration pending; eye animation is not business state','geometryAnchor':'references/upright-open-neutral-v2.png','geometryAnchorSHA256':sha(D/'references/upright-open-neutral-v2.png'),'targetSourceSHA256':{'neutral':sha(D/'references/upright-open-neutral-v2.png'),'listen-rest':sha(D/'poses/listen-rest.png')},'mask':'blink/eye-mask.png','maskMethod':'two narrowly authored eyelid polygons feather .65px; eyebrows, mouth, silhouette and all non-eye pixels preserved exactly','allowed':['neutral','listen-rest','permission hold using identical listen-rest head'],'prohibited':['nod-soft','nod','turned head','bowed/leaning head','other head geometry'],'exposureMs':{'halfClose':45,'closed':75,'halfOpen':45},'timing':'sparse randomized 4–7 second interval while event-controlled waiting; no response signal, no nod; interrupt immediately on real event','states':{s:{'raw':f'raw/blink-{s}.png','rawSHA256':sha(D/'raw'/f'blink-{s}.png'),'prompt':f'prompts/blink-{s}.txt','source':'references/upright-open-neutral-v2.png'} for s in ['half','closed']},'verification':records}
(B/'manifest.json').write_text(json.dumps(manifest,indent=2,sort_keys=True))
canvas=Image.new('RGB',(1536,550),(235,238,242));draw=ImageDraw.Draw(canvas)
for i,(label,im) in enumerate([('open',base),('half',Image.open(B/'neutral-half.png')),('closed',Image.open(B/'neutral-closed.png'))]):canvas.paste(im,(i*512,25),im);draw.text((i*512+10,5),label,fill='black')
canvas.save(D/'qa/blink-contact.jpg')
