from PIL import Image
import numpy as np,json
from pathlib import Path
root=Path(__file__).parent; ims=[Image.open(root/f'typing/cel-{i+1:03}.png') for i in range(6)]
def place(im,dx,dy):
 out=Image.new('RGBA',(512,512));out.paste(im,(dx,dy));return out
ref=np.asarray(place(ims[0],-52,0)).astype(float); roi=(slice(368,480),slice(125,280)); records=[]
for i,im in enumerate(ims):
 expected=-52+(i%3)*32;best=None
 for dx in range(expected-3,expected+4):
  for dy in range(-3,4):
   out=place(im,dx,dy);a=np.asarray(out).astype(float);mask=(ref[roi][:,:,3]>180)&(a[roi][:,:,3]>180)
   err=((ref[roi][:,:,:3][mask]-a[roi][:,:,:3][mask])**2).mean()
   if best is None or err<best[0]:best=(err,dx,dy,out)
 err,dx,dy,out=best;out.save(root/f'typing/frame-{i+1:03}.png');records.append({'frame':i+1,'translation':[dx,dy],'bootRoiRgbMse':round(err,3)})
json.dump({'method':'integer translation only; stable boot ROI, no scaling/warping/parts','records':records},open(root/'typing/registration.json','w'),indent=2)
frames=[{'source':f'frame-{i+1:03}.png','durationMs':d,'offset':[0,0],'phase':'typing-study','pose':p,'contacts':{'seat':[330,314],'laptopHinge':[232,278]},'exitTo':[]} for i,(d,p) in enumerate(zip([240,100,110,130,120,300],['rest','near-finger-lift','near-press','release','far-press','rest-return']))]
json.dump({'id':'seated-work.typing-v2','family':'SEATED_WORK','canvas':[512,512],'entryPose':'seated-work.typing-rest-v2','exitPose':'seated-work.typing-rest-v2-candidate','loop':None,'frames':frames},open(root/'typing/sequence.source.json','w'),indent=2)
print(records)
