"""Rebuild current motion study assets from preserved art sources; not final rig."""
from pathlib import Path
from PIL import Image
import numpy as np,json,shutil
D=Path(__file__).resolve().parents[2]/'varin-animation-art';O=Path(__file__).resolve().parents[1]/'assets/art-study-v3';O.mkdir(exist_ok=True)
for name in ['layers-underlap-v3','props','face-layers']:shutil.copytree(D/name,O/name,dirs_exist_ok=True)
yy,xx=np.mgrid[:1382,:1382]
t=np.array(Image.open(D/'layers-partition-v3/torso.png'));h=np.array(Image.open(D/'layers-underlap-v3/hairBack.png'))
# Transfer actual silver hair wrongly assigned to rigid torso back to head-attached hair.
m=(xx<704)&(yy<555)&(t[:,:,3]>0);h[m]=t[m];t[m]=0
# The inverse error: these collar/shoulder pixels must not follow hair.
n=(xx>610)&(xx<710)&(yy>580-.625*(xx-620))&(yy<660)&(h[:,:,3]>0);t[n]=h[n];h[n]=0
Image.fromarray(t).save(O/'torso-hidden.png');Image.fromarray(h).save(O/'layers-underlap-v3/hairBack.png')
p=np.array(Image.open(D/'neck-plate/neck-plate-registered.png'));p[yy>=700]=0;Image.fromarray(p).save(O/'neck-backing.png')
for node in ['upperArmL','upperArmR','forearmL','forearmR']:shutil.copy2(D/'layers-partition-v3'/f'{node}.png',O/'layers-underlap-v3'/f'{node}.png')
manifest=json.loads((D/'underlap-v3-manifest.json').read_text());manifest['headAttachmentBand']={'fullUntilY':550,'fixedFromY':850};manifest['frontAttachmentBand']={'fullUntilY':490,'fixedFromY':680}
for a in manifest['assets']:
 if a['node']=='torso':a['path']='torso-hidden.png'
 if a['node']=='hairFront':a['bounds']=[752,345,830,636]
manifest['assets'].insert(0,{'node':'neckBacking','path':'neck-backing.png'})
manifest['status']='NORMAL_RANGE_ART_INTEGRATION_STUDY_NOT_FINAL';manifest['corrections']={'hairFromTorsoPixels':int(m.sum()),'garmentFromHairPixels':int(n.sum()),'source':'Generated neck/shoulder backing; not nearest-color hidden anatomy','remaining':'Normal-range seams and torso/arm overlap need full clip review. Source underlap counts apply before these semantic corrections.'}
(O/'runtime-manifest.json').write_text(json.dumps(manifest,indent=2))
f=O/'face-layers';meta=json.loads((f/'blink-v3-manifest.json').read_text())
for side,lo,hi in [('L',574,629),('R',696,752)]:
 a=np.array(Image.open(f/f'upperLid{side}-brownonly-v3.png'));curve=[]
 for x in np.linspace(lo,hi,6).astype(int):
  ys=np.where((a[:,x-1:x+2,3]>100).any(1))[0];curve.append([int(x),float(np.median(ys))])
 meta['open'+side]={'curve6':curve}
(f/'blink-v3-manifest.json').write_text(json.dumps(meta,indent=2))
(O/'typing').mkdir(exist_ok=True)
for p in (D/'typing').glob('handR-*.png'):shutil.copy2(p,O/'typing'/p.name)
print(json.dumps(manifest['corrections']))
