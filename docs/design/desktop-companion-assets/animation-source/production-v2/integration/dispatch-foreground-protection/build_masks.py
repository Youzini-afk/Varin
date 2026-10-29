from pathlib import Path
from PIL import Image,ImageFilter,ImageDraw
import numpy as np,json,hashlib
r=Path(__file__).resolve().parent;root=r.parent.parent;a=root/'editing-dispatch';rem=np.array(Image.open(root/'relocation/frames/canonical-stool-removal-mask-v4.png').convert('L'))>0
pairs={'dispatch-rise-gaze':'dispatch-rise','dispatch-a-gaze':'dispatch-a','dispatch-transit-gazeB':'dispatch-transit','dispatch-b-v2-gazeB':'dispatch-b-v2'}
rows=[];qa=Image.new('RGB',(1024,768),'#263846')
for i,(name,maskname) in enumerate(pairs.items()):
 p=a/'frames'/f'{name}.png';im=Image.open(p).convert('RGBA');arr=np.array(im);auth=np.array(Image.open(a/'masks'/f'{maskname}.png').convert('L'))>0
 # Canonical removal overlaps generated pale sleeve and the silver hair it occludes/reveals.
 # Protect only light foreground inside authored anatomy union, not the dark stool.
 rgb=arr[:,:,:3].astype(float);fg=auth&(arr[:,:,3]>0)&(rgb.mean(2)>110)&(rgb.max(2)>130)
 # One-pixel outline capture is confined to non-dark current pixels (not stool surface).
 dil=np.array(Image.fromarray((fg*255).astype('uint8')).filter(ImageFilter.MaxFilter(3)))>0
 protect=(fg|(dil&(rgb.mean(2)>75)))&auth&rem
 out=Image.fromarray((protect*255).astype('uint8'));out.save(r/f'{name}-foreground-protect.png')
 ov=im.copy();overlay=Image.new('RGBA',im.size,(0,255,80,0));overlay.putalpha(out.point(lambda x:int(x*.55)));ov.alpha_composite(overlay)
 cr=ov.crop((280,300,450,410)).resize((510,330));qa.paste(cr,((i%2)*512,(i//2)*384+30),cr);ImageDraw.Draw(qa).text(((i%2)*512+5,(i//2)*384+5),name,fill='white')
 rows.append({'frame':str(p.relative_to(root)),'sourceSHA256':hashlib.sha256(p.read_bytes()).hexdigest(),'authoredUnionMask':str((a/'masks'/f'{maskname}.png').relative_to(root)),'protectMask':f'{name}-foreground-protect.png','protectedRemovalPixels':int(protect.sum()),'method':'light sleeve/silver-hair foreground within authored union and removal intersection, 1px non-dark outline expansion; excludes dark stool'})
qa.save(r/'foreground-protection-qa.jpg',quality=95);(r/'manifest.json').write_text(json.dumps(rows,indent=2)+'\n')
