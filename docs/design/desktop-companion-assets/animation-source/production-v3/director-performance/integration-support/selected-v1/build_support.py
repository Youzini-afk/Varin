from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json,hashlib,sys
D=Path(__file__).resolve().parent;R=D.parent.parent;sys.path.insert(0,str(R));from register_pose import clean
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();common=np.array(Image.open(D/'references/common-removal-mask.png').convert('L'));donor=Image.open(D/'references/clean-donor.png').convert('RGBA')
ns=['gather-release-v1','gather-out-v2','gather-sweep-mid-v2','gather-in-v1','gather-user-v1'];raws={'gather-out-v2':'gather-out-no-stool-donor-v1','gather-sweep-mid-v2':'gather-sweep-no-stool-donor-v1','gather-in-v1':'gather-in-no-stool-donor-v1','gather-user-v1':'gather-in-no-stool-donor-v1'};records={};sheet=Image.new('RGB',(1500,680),'#edf1f5');sd=ImageDraw.Draw(sheet);full=Image.new('RGB',(1500,650));fd=ImageDraw.Draw(full)
for i,n in enumerate(ns):
 orig=Image.open(R/'frames'/(n+'.png')).convert('RGBA');a=np.array(orig);fg=Image.new('L',(512,512));d=ImageDraw.Draw(fg)
 if n=='gather-out-v2':d.polygon([(300,190),(465,190),(465,270),(415,307),(405,333),(403,355),(392,358),(381,351),(371,344),(360,335),(350,325),(300,290)],fill=255)
 if n=='gather-sweep-mid-v2':d.polygon([(300,190),(430,190),(420,270),(382,307),(374,318),(380,340),(368,341),(358,336),(347,326),(300,290)],fill=255)
 protect=np.minimum(np.array(fg),common);Image.fromarray(protect).save(D/(n+'-foreground-exclusion.png'));out=Image.composite(donor,orig,Image.fromarray((common.astype(float)*(1-protect/255)).astype('uint8')));pm=Image.new('L',(512,512));patch=out
 if n in raws:
  rawname=raws[n];raw=R/'raw'/(rawname+'.png');new=clean(Image.open(raw).convert('RGBA')).resize((512,512),Image.Resampling.LANCZOS);new.save(D/'references'/(rawname+'-normalized.png'))
  ImageDraw.Draw(pm).polygon([(326,308),(420,308),(420,405),(340,405),(326,360)],fill=255);pm=pm.filter(ImageFilter.GaussianBlur(2));v=np.array(pm);v[v<3]=0;pm=Image.fromarray(v)
  actual=fg.copy()
  if n in ['gather-in-v1','gather-user-v1']:ImageDraw.Draw(actual).polygon([(290,180),(355,180),(370,280),(355,310),(357,331),(351,343),(338,338),(290,310)],fill=255)
  b=np.array(new);keep=np.array(actual)>0;b[keep]=a[keep];patch=Image.fromarray(b)
 patch.save(D/(n+'-clean-tail-patch.png'));pm.save(D/(n+'-patch-mask.png'));final=Image.composite(patch,out,pm);final.save(D/(n+'-detached-candidate.png'))
 for j,bg in enumerate(['#edf1f5','#263846']):
  b=Image.new('RGBA',(512,512),bg);b.alpha_composite(final);sheet.paste(b.crop((325,305,425,400)).resize((300,285)),(i*300,j*330+30));sd.text((i*300+2,j*330+5),n,fill='black');full.paste(b.convert('RGB').resize((300,300)),(i*300,j*325));fd.text((i*300+4,j*325+302),n,fill='#788b9d')
 records[n]={'source':'../../frames/'+n+'.png','sourceSHA256':sha(R/'frames'/(n+'.png')),'foregroundExclusion':n+'-foreground-exclusion.png','cleanPatch':n+'-clean-tail-patch.png','finalPatchMask':n+'-patch-mask.png','order':'common*(1-foregroundExclusion/255) donor composite, then cleanPatch via finalPatchMask','hiddenRaw':('../../raw/'+raws[n]+'.png') if n in raws else None,'hiddenRawSHA256':sha(R/'raw'/(raws[n]+'.png')) if n in raws else None,'ordinarySourceUnchanged':True,'note':'each sleeve pose uses its own same-pose genuinely generated hidden surface; IN/user share identical lower anatomy; exact visible sleeve preserved'}
 records[n]['supportSHA256']={k:sha(D/records[n][k]) for k in ['foregroundExclusion','cleanPatch','finalPatchMask']}
sheet.save(D/'tail-review.jpg',quality=97);full.save(D/'full-review.jpg',quality=96);(D/'manifest.json').write_text(json.dumps({'status':'frozen author support candidate for relocation peer review','pathBase':'manifest directory','donor':'references/clean-donor.png','commonMask':'references/common-removal-mask.png','records':records},indent=2)+'\n')
