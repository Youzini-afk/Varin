from pathlib import Path
import json
import numpy as np
from PIL import Image,ImageDraw
D=Path(__file__).parent
src=np.array(Image.open(D/'canonical-seated-clean-v3.png')); H,W=src.shape[:2]
# Ordered semantic visible-surface masks, same origin; all are hand-authored boundaries.
polys={
'lowerBody':[(418,708),(546,710),(570,677),(668,691),(722,730),(805,737),(832,768),(890,799),(847,822),(852,897),(900,980),(990,1170),(853,1169),(716,1104),(707,1222),(551,1224),(533,1184),(508,1215),(370,1215),(370,1108),(327,1129),(281,1032),(316,969),(361,858)],
'upperArmL':[(565,482),(582,512),(558,580),(565,625),(535,667),(493,663),(444,649),(466,603),(494,554),(535,512)],
'forearmL':[(474,616),(508,621),(538,642),(551,674),(550,702),(528,718),(470,731),(416,774),(390,811),(350,776),(337,752),(382,709),(414,670),(448,643)],
'upperArmR':[(736,479),(770,491),(799,547),(823,602),(848,649),(822,667),(795,650),(744,652),(729,576)],
'forearmR':[(742,643),(797,640),(815,656),(807,695),(798,742),(785,796),(755,784),(715,763),(685,721),(660,701),(650,678),(662,657),(699,652)],
}
# Import exact previously authored masks as new same-origin boundaries.
for name in ['torso','handL','handR','head']:
 p=np.array(Image.open(D/'layers-draft'/f'{name}.png'))[:,:,3]>0
 polys[name]=p
order=['handL','handR','forearmL','forearmR','upperArmL','upperArmR','torso','lowerBody','head']
remaining=np.ones((H,W),bool);layers={};assets=[];outdir=D/'layers-partition-v1';outdir.mkdir(exist_ok=True)
for name in order:
 poly=polys[name]
 if isinstance(poly,list):
  m=Image.new('L',(W,H));ImageDraw.Draw(m).polygon([(x+64,y+64) for x,y in poly],fill=255);m=np.array(m)>0
 else:m=poly
 m &= remaining;remaining &= ~m;layers[name]=m
layers['hairBack']=remaining
for name,m in layers.items():
 out=src.copy();out[~m]=0;Image.fromarray(out).save(outdir/f'{name}.png')
 assets.append({'node':name,'path':f'layers-partition-v1/{name}.png','status':'visible-surface-partition-draft','occlusionExtended':False})
reconstructed=np.zeros_like(src)
for m in layers.values():reconstructed[m]=src[m]
Image.fromarray(reconstructed).save(D/'partition-reconstruction.png')
error=int(np.abs(reconstructed.astype(int)-src.astype(int)).max())
manifest={'status':'STATIC_PARTITION_NOT_RIG_READY','canvas':[W,H],'source':'canonical-seated-clean-v3.png','composition':'mutually exclusive masks; RGBA pixel reconstruction exact, overpaint none','maxReconstructionChannelError':error,'assets':assets,'missing':['Hidden skin/torso/hair surface completion','24px joint overlaps','Front/back hair semantic refinement; hairBack currently remainder contains ribbon and jacket fragments','Independent face assets pending validation','Laptop base/lid and chair absent'],'warning':'Static partition tests coordinate contract, not permission to rotate these unfilled pieces as finished animation.'}
(D/'partition-manifest.json').write_text(json.dumps(manifest,indent=2));print(json.dumps({'layers':len(layers),'maxError':error}))
# labeled grid at 1/3 size
q=Image.new('RGB',(5*360,2*390),(95,95,95));draw=ImageDraw.Draw(q)
for i,(name,m) in enumerate(layers.items()):
 im=Image.open(outdir/f'{name}.png');bg=Image.new('RGBA',im.size,(95,95,95,255));bg.alpha_composite(im);bg.thumbnail((360,360));x=(i%5)*360;y=(i//5)*390;q.paste(bg.convert('RGB'),(x,y+25));draw.text((x+10,y+5),name,fill='white')
q.save(D/'partition-qa.jpg')
