from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json
P=Path(__file__).resolve().parent
base=Image.open(P/'../../shared/seated-open-canonical-alpha-v1.png').convert('RGBA')
mask=Image.open(P/'../canonical-chin-v1/editable-eyes-mask.png')
src=Image.open(P/'read-screen-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
out=Image.composite(src,base,mask);out.save(P/'read-screen.png');mask.save(P/'eyes-mask.png')
qa=Image.new('RGB',(1024,512),'#eeeeee')
for i,a in enumerate([base,out]):qa.paste(a,(512*i,0),a.getchannel('A'))
qa.save(P/'comparison.jpg')
face=Image.new('RGB',(800,400),'white')
for i,a in enumerate([base,out]):face.paste(a.crop((200,105,325,185)).resize((400,256)),(400*i,50))
face.save(P/'eye-comparison.jpg')
json.dump({'entryPose':'seated-open-neutral','exitPose':'seated-open-read-screen','geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','method':'Authored new lower-left gaze pasted through shared eyelid mask; no moved head; same 512 viewport','exactProtectedPixels':int((np.array(mask)==0).sum()),'visualIntent':'Irises visibly left/down, larger eye white on right versus neutral eye contact','status':'Static gaze candidate, not complete reading animation'},open(P/'provenance.json','w'),indent=2)
base.save(P/'neutral.png')
for name in ['half','closed']:
 src=Image.open(P/f'../canonical-chin-v1/{name}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 Image.composite(src,base,mask).save(P/f'{name}.png')
for name,seq,entry,exit in [
('to-screen',[('neutral',80),('half',45),('closed',65),('read-screen',160)],'seated-open-neutral','seated-open-read-screen'),
('to-user',[('read-screen',80),('half',40),('closed',65),('neutral',160)],'seated-open-read-screen','seated-open-neutral')]:
 spec={'id':'observe.gaze-'+name+'-v1','family':'OBSERVE_DIAGNOSE','kind':'bridge','stage':'motion-candidate','reviewStatus':'unreviewed','canvas':[512,512],'geometryReference':'390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b','entryPose':entry,'exitPose':exit,'loop':None,'frames':[{'source':f+'.png','durationMs':t,'offset':[0,0],'contacts':{},'phase':'bridge','pose':entry if i==0 else exit if i==len(seq)-1 else 'eyelids-transition'}for i,(f,t) in enumerate(seq)]}
 (P/f'{name}.source.json').write_text(json.dumps(spec,indent=2))
