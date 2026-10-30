from pathlib import Path
from PIL import Image
import json,hashlib
r=Path(__file__).parent
seq=[('../lid/frames/closed-rest-rigid-v2.png',650,'closed rest'),('frames/lap-release-mid-v1.png',100,'left hand starts securing'),('frames/seated-secure-v2.png',110,'both hands secure'),('frames/land-contact-v1.png',90,'seat unloading'),('frames/detach-first-v2.png',140,'seat released'),('frames/airborne-response-v3.png',150,'loose leg response'),('frames/detach-first-v2.png',300,'supported airborne'),('frames/land-contact-v1.png',120,'seat takes weight'),('frames/seated-secure-v2.png',110,'body settles'),('frames/lap-release-mid-v1.png',110,'release grip onto lap'),('../lid/frames/closed-rest-rigid-v2.png',700,'closed rest')]
imgs=[];frames=[]
for p,t,cue in seq:
 im=Image.open(r/p).convert('RGBA');bg=Image.new('RGBA',im.size,'#263846');bg.alpha_composite(im);imgs.append(bg.convert('RGB'));frames.append({'source':p,'durationMs':t,'cue':cue,'sha256':hashlib.sha256((r/p).read_bytes()).hexdigest()})
imgs[0].save(r/'core-cycle-normal-speed-v2.webp',save_all=True,append_images=imgs[1:],duration=[t for _,t,_ in seq],loop=0,lossless=True)
sheet=Image.new('RGB',(1536,1152),'#263846')
for i,im in enumerate(imgs):sheet.paste(im.resize((384,384)),(i%4*384,i//4*384))
sheet.save(r/'core-cycle-review-v2.jpg',quality=96)
(r/'core-sequence-v2.json').write_text(json.dumps({'stage':'art core candidate; no runtime acceptance; world stool plate pending correction','canvas':[512,512],'movement':'actual drawn lower-body and hand changes; pointer root translation not simulated here','frames':frames,'knownGaps':['world stool cleanplate geometry/seams not accepted','precise current-pose pickup/release mapping not produced until core review','opening-to-pickup immediate half-lid entry not yet authored for v2']},indent=2)+'\n')
