from PIL import Image
from scipy.ndimage import label,find_objects,binary_dilation
import numpy as np,json
from pathlib import Path
root=Path(__file__).parent
name='opening-six-source-v1';im=Image.open(root/f'source/{name}.png');a=np.array(im);lab,n=label(a[:,:,3]>80); objs=[]
for k,sl in enumerate(find_objects(lab),1):
 if sl and (lab[sl]==k).sum()>5000:objs.append((k,sl))
objs.sort(key=lambda t:(0 if t[1][0].start<500 else 1,t[1][1].start))
outdir=root/'open-close';outdir.mkdir(exist_ok=True);records=[]
for i,(k,sl) in enumerate(objs):
 mask=binary_dilation(lab==k,iterations=3);pix=a.copy();pix[:,:,3]=np.where(mask,a[:,:,3],0);full=Image.fromarray(pix);crop=full.crop((sl[1].start-3,sl[0].start-3,sl[1].stop+3,sl[0].stop+3));
 dx=[-44,-20,16][i%3];dy=16 if i<3 else -496;x=sl[1].start-3-(i%3)*512+dx;y=sl[0].start-3+dy
 canvas=Image.new('RGBA',(512,512));canvas.paste(crop,(x,y));canvas.save(outdir/f'open-{i+1:03}.png'); records.append({'frame':i+1,'component':int(k),'sourceBBox':[sl[1].start,sl[0].start,sl[1].stop,sl[0].stop],'canvasTranslation':[dx-(i%3)*512,dy]})
frames=[{'source':f'open-{i+1:03}.png','durationMs':d,'offset':[0,0],'phase':'open','pose':p,'contacts':{},'exitTo':[]} for i,(d,p) in enumerate(zip([300,140,140,160,140,300],['closed-rest','lid-grip','lid-partial','lid-open-lifting','lid-open-hand-held','keyboard-ready']))]
j={'id':'seated-work.open-laptop-v1','family':'SEATED_CLOSED','canvas':[512,512],'stage':'keyposes','reviewStatus':'needs-intermediates-and-contact-review','warning':'Six full-character opening drawings; support registration provisional, lid and hand contact require intermediate drawings and normal-speed review. Not production accepted.','entryPose':'seated-closed.hands-on-lid-v1','exitPose':'seated-work.ready-open-v1','loop':None,'frames':frames}
json.dump(j,open(outdir/'sequence.source.json','w'),indent=2);json.dump(records,open(outdir/'extraction.json','w'),indent=2);print(records)
