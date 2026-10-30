from pathlib import Path
from PIL import Image,ImageDraw
import numpy as np,json,shutil
r=Path(__file__).parent;old=r/'registered/click-closed-v2';out=r/'registered/click-closed-v3';out.mkdir(exist_ok=True)
# Manually visually inspected left-bang loops (hair-edge-detail.png). Only these background pockets;
# not white clothes, face, eyes, nails or all white pixels.
roi=Image.new('L',(512,512),0);d=ImageDraw.Draw(roi)
d.polygon([(150,82),(160,85),(158,103),(149,100)],fill=255)
d.polygon([(151,148),(162,151),(166,169),(157,171)],fill=255)
d.polygon([(167,172),(176,172),(185,188),(181,200),(169,199)],fill=255)
d.polygon([(144,70),(166,70),(162,106),(144,109)],fill=255)
d.polygon([(145,141),(166,141),(170,168),(145,170)],fill=255)
roi.save(out/'reviewed-hair-background-region.png');region=np.array(roi)>0
seq=json.loads((old/'sequence.json').read_text());seq['id']='click-closed-v3';seq['warning']+=' v2 locally clears visually reviewed new left-hair white background pockets.'
proof=[];ims=[]
for f in seq['frames']:
 p=f['source'];a=np.array(Image.open(old/p));b=a.copy();rgb=a[:,:,:3].astype(int);remove=region&(rgb.min(2)>238)&((rgb.max(2)-rgb.min(2))<15)&(a[:,:,3]>0)
 
 if p in ['pose-000.png','pose-001.png','pose-007.png','pose-008.png']:remove[:]=False
 b[remove,3]=0;Image.fromarray(b).save(out/p);proof.append({'frame':p,'reviewedBackgroundPixelsRemoved':int(remove.sum()),'outsideRegionExact':bool(np.array_equal(a[~region],b[~region]))})
 bg=Image.new('RGBA',(512,512),(25,29,36,255));bg.alpha_composite(Image.fromarray(b));ims.append(bg.convert('RGB'))
(out/'sequence.json').write_text(json.dumps(seq,indent=2));(out/'alpha-cleanup.json').write_text(json.dumps(proof,indent=2));shutil.copy2(old/'provenance.json',out/'provenance.json')
ims[0].save(out/'timing-review.gif',save_all=True,append_images=ims[1:],duration=[f['durationMs'] for f in seq['frames']],loop=0,disposal=2)
c=Image.new('RGB',(2048,1536),(25,29,36))
for i,im in enumerate(ims):c.paste(im,((i%4)*512,(i//4)*512))
c.save(out/'drawings-dark-review.png');ims[3].crop((110,60,230,225)).resize((480,660)).save(out/'hair-edge-detail.png')
print(proof)
