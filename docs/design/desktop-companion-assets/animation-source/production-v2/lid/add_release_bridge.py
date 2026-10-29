from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json,hashlib
r=Path(__file__).parent
base=Image.open(r/'frames/release-near-registered-v1.png').convert('RGBA')
raw=Image.open(r/'sources/release-first-crop-v1-raw.png').convert('RGBA').resize((260,260),Image.Resampling.LANCZOS)
draw=base.copy(); draw.paste(raw,(90,190))
m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([(96,217),(132,199),(193,200),(224,221),(249,256),(229,281),(170,265),(103,250)],fill=255);m=m.filter(ImageFilter.GaussianBlur(.7))
out=Image.composite(draw,base,m)
out.alpha_composite(Image.open(r/'frames/lid-angle-100.png'))
out.save(r/'frames/release-first-registered-v1.png');m.save(r/'frames/release-first-mask.png')
j=json.loads((r/'sequence-source-v1.json').read_text());frames=j['opening'];p=r/'frames/release-first-registered-v1.png';frames.insert(8,{'source':'frames/release-first-registered-v1.png','durationMs':65,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()});j['closing']=frames[::-1];j['knownReviewFocus']=['0-degree hand/lid occlusion','normal speed contact transitions and release','new closed rest endpoint differs from static initial closed anchor'];j['stage']='motion candidate v2; release bridge added, parent review pending';(r/'sequence-source-v2.json').write_text(json.dumps(j,indent=2)+'\n')
for name,seq in [('opening',frames),('closing',frames[::-1])]:
 imgs=[]
 for f in seq:
  im=Image.open(r/f['source']).convert('RGBA');bg=Image.new('RGBA',(512,512),'#263846');bg.alpha_composite(im);imgs.append(bg.convert('RGB'))
 imgs[0].save(r/f'{name}-normal-speed-v2.webp',save_all=True,append_images=imgs[1:],duration=[f['durationMs'] for f in seq],loop=0,lossless=True)
sheet=Image.new('RGB',(1536,1024),'#263846')
for i,f in enumerate(frames):
 im=Image.open(r/f['source']).convert('RGBA').resize((384,384));bg=Image.new('RGBA',im.size,'#263846');bg.alpha_composite(im);sheet.paste(bg.convert('RGB'),(i%4*384,i//4*340))
sheet.save(r/'opening-sequence-review-v2.jpg',quality=95)
