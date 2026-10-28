from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json,hashlib
p=Path(__file__).parent;base=Image.open(p.parent.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA');src=Image.open(p/'hand-six-source.png');frames=[]
# Generated contexts are registered from observed crop bounds into one local viewport; no body/face warping.
# All local crops target the same 160x104 viewport; small sheet-spacing differences are absorbed at this local crop registration.
boxes=[(22,105,509,441),(530,105,1012,441),(1030,105,1514,441),(22,551,509,886),(530,551,1012,886),(1030,551,1514,886)]
mask=Image.new('L',(512,512));ImageDraw.Draw(mask).polygon([(256,280),(274,272),(291,277),(300,286),(300,300),(260,307),(254,298)],fill=255);mask=mask.filter(ImageFilter.GaussianBlur(.7));mask.save(p/'hand-context-mask.png')
for i,box in enumerate(boxes):
 context=src.crop(box).resize((160,104),Image.Resampling.LANCZOS); # uniform 0.8 of 200x130 reference context
 redraw=base.copy();redraw.paste(context,(205,250));out=base.copy() if i in (0,5) else Image.composite(redraw,base,mask);out.save(p/f'frame-{i+1:03}.png');frames.append({'source':f'frame-{i+1:03}.png','durationMs':[240,100,130,100,140,280][i],'offset':[0,0],'phase':'typing','pose':['rest','index-lift','index-press','middle-lift','middle-press','rest-return'][i],'contacts':{'wrist':[309,295],'seat':[307,361]},'exitTo':[]})
sh=Image.new('RGBA',(1536,1024),(213,232,216,255))
for i in range(6):sh.alpha_composite(Image.open(p/f'frame-{i+1:03}.png'),((i%3)*512,(i//3)*512))
sh.convert('RGB').save(p/'contact-sheet.jpg')
json.dump({'id':'seated-work.canonical-typing-v1','family':'SEATED_WORK','canvas':[512,512],'entryPose':'seated-open-canonical-v1','exitPose':'seated-open-canonical-v1','loop':None,'stage':'motion-candidate','reviewStatus':'needs-hand-seam-and-temporal-review','warning':'Protected common full-body pixels; generated actual six hand drawings registered locally. Keyboard contact and patch edge need review. Not final accepted.','frames':frames},open(p/'sequence.source.json','w'),indent=2)
json.dump({'baselinePixelSha256':hashlib.sha256(base.tobytes()).hexdigest(), 'baselineFile':'../../shared/seated-open-canonical-alpha-v1.png','technique':'held full cel with localized actual generated redrawing, not bones/mesh or frame blending','sourceBoxes':boxes,'contextOutputSize':[160,104],'contextCanvasOrigin':[205,250],'unchangedOutsideMask':True},open(p/'provenance.json','w'),indent=2)
