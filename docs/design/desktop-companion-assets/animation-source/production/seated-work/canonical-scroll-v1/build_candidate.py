from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json,hashlib
import numpy as np
p=Path(__file__).parent;base=Image.open(p.parent.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA');src=Image.open(p/'hand-six-source.png');frames=[]
# Generated contexts are registered from observed crop bounds into one local viewport; no body/face warping.
# All local crops target the same 160x104 viewport; small sheet-spacing differences are absorbed at this local crop registration.
boxes=[(24,108,508,439),(527,108,1012,439),(1031,108,1520,439),(22,575,509,909),(527,575,1012,909),(1029,575,1519,909)]
mask=Image.new('L',(512,512));ImageDraw.Draw(mask).polygon([(254,278),(281,274),(301,278),(313,287),(314,306),(266,316),(254,306)],fill=255);mask=mask.filter(ImageFilter.GaussianBlur(.7));mask.save(p/'hand-context-mask.png')
for i,box in enumerate(boxes):
 context=src.crop(box).resize((160,104),Image.Resampling.LANCZOS); # uniform 0.8 of 200x130 reference context
 redraw=base.copy();redraw.paste(context,(205,250));out=base.copy() if i in (0,5) else Image.composite(redraw,base,mask);arr=np.array(out);old=np.array(base); yy,xx=np.indices(arr.shape[:2]); q=(xx>=309)&(xx<=316)&(yy>=293)&(yy<=309)&((old[:,:,2].astype(int)-old[:,:,0])>20)&(arr[:,:,:3].min(2)>200)&((arr[:,:,:3].max(2).astype(int)-arr[:,:,:3].min(2))<30);arr[q]=old[q];out=Image.fromarray(arr);out.save(p/f'frame-{i+1:03}.png');frames.append({'source':f'frame-{i+1:03}.png','durationMs':[250,150,200,160,160,300][i],'offset':[0,0],'phase':'scroll','pose':['rest','reach-palmrest','two-finger-contact','scroll','release','rest-return'][i],'contacts':{'wrist':[309,295],'seat':[307,361]},'exitTo':[]})
sh=Image.new('RGBA',(1536,1024),(213,232,216,255))
for i in range(6):sh.alpha_composite(Image.open(p/f'frame-{i+1:03}.png'),((i%3)*512,(i//3)*512))
sh.convert('RGB').save(p/'contact-sheet.jpg')
json.dump({'id':'seated-work.canonical-scroll-v1','family':'SEATED_WORK','canvas':[512,512],'entryPose':'seated-open-canonical-v1','exitPose':'seated-open-canonical-v1','loop':None,'stage':'motion-candidate','reviewStatus':'needs-hand-seam-and-temporal-review','warning':'Protected common full-body pixels; generated actual six hand drawings registered locally. Keyboard contact and patch edge need review. Not final accepted.','frames':frames},open(p/'sequence.source.json','w'),indent=2)
json.dump({'baselinePixelSha256':hashlib.sha256(base.tobytes()).hexdigest(), 'baselineFile':'../../shared/seated-open-canonical-alpha-v1.png','technique':'held full cel with localized actual generated redrawing, not bones/mesh or frame blending','sourceBoxes':boxes,'contextOutputSize':[160,104],'contextCanvasOrigin':[205,250],'unchangedOutsideMask':True},open(p/'provenance.json','w'),indent=2)
