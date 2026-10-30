from PIL import Image,ImageDraw,ImageFilter
from pathlib import Path
import json
P=Path(__file__).resolve().parent
base=Image.open(P/'../../shared/seated-open-canonical-alpha-v1.png').convert('RGBA')
mask=Image.new('L',(512,512));d=ImageDraw.Draw(mask)
d.polygon([(257,254),(289,251),(317,270),(345,278),(337,319),(318,333),(298,309),(249,307)],fill=255)
d.polygon([(201,220),(232,217),(245,248),(249,285),(229,292),(215,246)],fill=255)
d.polygon([(99,222),(215,231),(244,315),(130,311)],fill=0)
mask=mask.filter(ImageFilter.GaussianBlur(.7));mask.save(P/'hand-mask.png')
base.save(P/'rest.png')
for name in ['middle','raised']:
 src=Image.open(P/f'{name}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 Image.composite(src,base,mask).save(P/f'{name}.png')
fm=Image.new('L',(512,512));d=ImageDraw.Draw(fm)
d.polygon([(205,137),(245,132),(259,157),(252,180),(217,180),(205,161)],fill=255)
d.polygon([(260,112),(295,98),(317,114),(319,147),(279,155)],fill=255)
d.ellipse((263,166,289,184),fill=255)
fm=fm.filter(ImageFilter.GaussianBlur(.8));fm.save(P/'face-mask.png')
for expression in ['serious','surprise']:
 src=Image.open(P/f'{expression}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 for pose in ['rest','middle','raised']:
  Image.composite(src,Image.open(P/f'{pose}.png'),fm).save(P/f'{pose}-{expression}.png')
qa=Image.new('RGB',(512*4,512),'white')
for i,n in enumerate(['rest','middle','raised-surprise','raised-serious']):qa.paste(Image.open(P/f'{n}.png'),(i*512,0),Image.open(P/f'{n}.png').getchannel('A'))
qa.save(P/'strip.jpg')
common={'family':'OBSERVE_DIAGNOSE','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','loop':None,'entryPose':'seated-open-gaze-screen','exitPose':'observe-hands-raised-serious','warning':'Candidate entry only; terminal hold is attentive, not stopped/completed. No automatic success/recovery. Shoulder release and continuing hold need further art.'}
for name,seq in [('cancel-entry',[('rest',90),('middle-serious',70),('raised-serious',1200)]),('failure-entry',[('rest',90),('middle-surprise',65),('raised-surprise',210),('raised-serious',1000)])]:
 spec={**common,'id':f'observe.{name}-v1','frames':[{'source':n+'.png','durationMs':t,'offset':[0,0],'phase':'enter' if i<len(seq)-1 else 'hold','contacts':{},'pose':'seated-open-gaze-screen' if n=='rest' else 'observe-hands-raised-serious' if n=='raised-serious' else 'observe-hands-transition'} for i,(n,t) in enumerate(seq)]};(P/f'{name}.source.json').write_text(json.dumps(spec,indent=2))
