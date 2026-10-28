from pathlib import Path
from PIL import Image,ImageChops
import json,shutil,hashlib
P=Path(__file__).resolve().parent;R=P.parent.parent
mask=Image.open(R/'relocation/departure-bridge-v1/stool-replacement-mask-v2.png').convert('L');detach=Image.open(R/'relocation/departure-bridge-v1/detach-protected-v2.png').convert('RGBA')
nearMask=Image.open(P/'near-support-mask.png');mask=ImageChops.subtract(mask,nearMask);near=Image.open(P/'near-support-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
entries=[]
def sequence(name,src,frames,exitPose):
 src=src.resolve();d=P/name;d.mkdir(exist_ok=True);first=Image.open(src).convert('RGBA');first=Image.composite(detach,first,mask);first.save(d/'current-detached.png')
 out=[('current-detached.png',45)]
 for f,t in frames:shutil.copyfile(P/f,d/f);out.append((f,t))
 j={'id':'gesture-pickup.'+name,'stage':'motion-candidate','reviewStatus':'unreviewed','family':'RELOCATION','canvas':[512,512],'entryPose':name+'-current-detached','exitPose':exitPose,'loop':None,'warning':'Window follows pointer immediately. First cel preserves actual starting upper gesture with world stool separately fading. Existing authored return cels play at short explicit durations, not full source hold. No neutral reset. New supporting near hand and shared lower clean-up. Final carried computer remains canonical projection; must use authored closing/tilt departure bridge, not jump to curled rapid open.','frames':[{'source':f,'durationMs':t,'offset':[0,0],'phase':'detach'if i==0 else'withdraw-to-support','pose':name+'-current-detached'if i==0 else exitPose if i==len(out)-1 else name+'-support-transition','contacts':{}}for i,(f,t)in enumerate(out)],'sourceStart':str(src.relative_to(R)),'sourceStartSha256':hashlib.sha256(src.read_bytes()).hexdigest()}
 (d/'sequence.source.json').write_text(json.dumps(j,indent=2)+'\n');entries.append({'id':j['id'],'manifest':str((d/'sequence.source.json').relative_to(R)),'sourceStart':j['sourceStart'],'sourceStartSha256':j['sourceStartSha256'],'endpoint':exitPose,'mode':'closed' if 'closed' in exitPose else 'open','durationMs':sum(t for _,t in out)})
sequence('chin-contact',P/'../canonical-chin-v2/pose-005.png',[('chin-detached.png',60),('early-detached.png',75),('pregrip-detached.png',70),('grip-detached.png',90)],'canonical-open-laptop-supported-detached')
for family,count in [('stretch',9),('eye-rub',5)]:
 for i in range(count):
  sequence(f'{family}-{i:03}',R/f'rest/canonical-{family}-v1/pose-{i:03}.png',[(f'{family}-{j:03}-supported.png',65 if j else 90)for j in range(i,-1,-1)],'canonical-closed-laptop-supported-detached')
(P/'index.json').write_text(json.dumps({'entries':entries,'newPixels':['near-support-source.png','far-screen-grip-source.png','far-pregrip-source.png','far-early-source.png','closed-near-support-source.png'],'pointerPolicy':'Root follows pointer immediately, current drawing upper gesture not reset; stool is world anchored, fades independently.','lowerDependency':'relocation/departure-bridge-v1/detach-protected-v2.png plus stool-replacement-mask-v2.png','acceptance':'pending finite normal-speed peer; source contains explicit current-frame variants, not backend-specific duplicate actions'},indent=2)+'\n')
# Reuse same actual support edit on current OBSERVE drawings without a neutral reset.
for i in range(6):
 src=R/f'observe-diagnose/canonical-chin-v2/pose-{i:03}.png';im=Image.open(src).convert('RGBA');im=Image.composite(near,im,nearMask);im=Image.composite(detach,im,mask);im.save(P/f'chin-{i:03}-supported.png')
for i in range(6):
 frames=[(f'chin-{j:03}-supported.png',55)for j in range(i,max(i,3)+1)]+[(f'{n}-detached.png',t)for n,t in [('early',75),('pregrip',70),('grip',90)]]
 sequence(f'chin-{i:03}',R/f'observe-diagnose/canonical-chin-v2/pose-{i:03}.png',frames,'canonical-open-laptop-supported-detached')
for name,src in [('raised-focused',R/'observe-diagnose/canonical-recovery-v1/raised-focused.png'),('raised-serious',R/'observe-diagnose/canonical-recovery-v1/raised-serious.png'),('chin-half',R/'observe-diagnose/canonical-chin-v2/hold-half.png'),('chin-closed',R/'observe-diagnose/canonical-chin-v2/hold-closed.png'),('chin-settled',R/'observe-diagnose/canonical-wait-cycle-v1/chin-settled.png'),('chin-rim',R/'observe-diagnose/canonical-wait-cycle-v1/rim-rest.png')]:
 im=Image.open(src).convert('RGBA');im=Image.composite(near,im,nearMask);im=Image.composite(detach,im,mask);im.save(P/f'{name}-supported.png')
 frames=[(f'{name}-supported.png',60)]
 if name.startswith('raised'):frames += [('chin-002-supported.png',60),('chin-003-supported.png',60)]
 frames += [(f'{n}-detached.png',t)for n,t in [('early',75),('pregrip',70),('grip',90)]]
 sequence(name,src,frames,'canonical-open-laptop-supported-detached')
(P/'index.json').write_text(json.dumps({'entries':entries,'newPixels':['near-support-source.png','far-screen-grip-source.png','far-pregrip-source.png','far-early-source.png','closed-near-support-source.png'],'pointerPolicy':'Root follows pointer immediately. Exact current upper drawing retained on first detached cel. World stool independently fades.','lowerDependency':'relocation/departure-bridge-v1/detach-protected-v2.png plus stool-replacement-mask-v2.png','acceptance':'finite peer pending, not automatic acceptance'},indent=2)+'\n')
