from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
from scipy.ndimage import map_coordinates,binary_dilation
import numpy as np,json,runpy
p=Path(__file__).parent;d=runpy.run_path(str(p/'build_contact_poses.py'));base=d['base'];canonical=d['canonical'];closed=d['closed'];quad=d['quad'];warp=d['warp'];q=d['q'];old=d['old'];yy,xx=np.indices((512,512),dtype=float);cache={}
for k in [20,45,70,100]:
 im=Image.open(old/f'grip-{k:03}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon(d['polys'][k],fill=255);m=m.filter(ImageFilter.GaussianBlur(.7));pm=Image.new('L',(512,512));planes={20:[(176,266),(302,271),(243,321),(133,312)],45:[(164,235),(281,242),(243,320),(132,310)],70:[(135,218),(252,227),(244,319),(132,309)],100:[(99,222),(217,231),(244,319),(128,308)]};pd=ImageDraw.Draw(pm);pd.polygon(planes[k],fill=255);pd.line(planes[k]+[planes[k][0]],fill=255,width=5);aa=np.array(im);rr=aa[:,:,:3].astype(int);skin=(rr[:,:,0]>150)&((rr[:,:,0]-rr[:,:,1])>12)&((rr[:,:,0]-rr[:,:,2])>12);mm=np.array(m);mm[(np.array(pm)>0)&(~skin)]=0;cache[k]=(aa,mm)
rel=Image.open(old/'release-100-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([(119,217),(125,198),(147,191),(172,198),(186,219),(208,224),(233,217),(247,234),(244,276),(180,295),(126,278)],fill=255);pm=Image.new('L',(512,512));pd=ImageDraw.Draw(pm);pl=[(98,222),(217,231),(245,320),(128,308)];pd.polygon(pl,fill=255);pd.line(pl+[pl[0]],fill=255,width=5);mm=np.array(m.filter(ImageFilter.GaussianBlur(.7)));mm[np.array(pm)>0]=0;cache['release']=(np.array(rel),mm)
def moving_layer(key,delta,wrist):
 a,ma=cache[key];shoulder=np.array([240.,226.]);axis=np.array(wrist)-shoulder;dx,dy=delta;sx=xx.copy();sy=yy.copy()
 for _ in range(4):
  weight=np.clip(((sx-shoulder[0])*axis[0]+(sy-shoulder[1])*axis[1])/(axis@axis),0,1);sx=xx-weight*dx;sy=yy-weight*dy
 arr=np.stack([map_coordinates(a[:,:,ch],(sy,sx),order=1,mode='constant',cval=0)for ch in range(4)],axis=-1).astype('uint8');mask=map_coordinates(ma,(sy,sx),order=1,mode='constant',cval=0).astype('uint8');arr[:,:,3]=np.minimum(arr[:,:,3],mask);return Image.fromarray(arr),arr
# The hold has genuine grip art; only cloth follows shoulder-pinned registration. No whole-body motion.
def grip(angle):
 k=min([20,45,70,100],key=lambda a:abs(angle-a));delta=np.array(d['shifts'][k])+quad(angle)[0]-quad(k)[0];wrist=[185,260]if k==20 else[180,236];layer,arr=moving_layer(k,delta,wrist);out=base.copy();out.alpha_composite(layer);out.alpha_composite(warp(canonical,q,quad(angle)))
 rgb=arr[:,:,:3].astype(int);x0,y0,x1,y1=d['handboxes'][k];x0+=delta[0];x1+=delta[0];y0+=delta[1];y1+=delta[1];skin=(rgb[:,:,0]>150)&((rgb[:,:,0]-rgb[:,:,1])>12)&((rgb[:,:,0]-rgb[:,:,2])>12)&(xx>=x0)&(xx<=x1)&(yy>=y0)&(yy<=y1)&(arr[:,:,3]>0);fm=Image.fromarray((binary_dilation(skin,iterations=1)*255).astype('uint8')).filter(ImageFilter.GaussianBlur(.35));fg=layer.copy();fg.putalpha(Image.fromarray(np.minimum(np.array(fm),arr[:,:,3])));out.alpha_composite(fg);return out,k,delta.tolist()
def retract(t):
 eased=t*t*(3-2*t);delta=[73*eased,64*eased];layer,a=moving_layer('release',delta,[167,219]);out=base.copy();out.alpha_composite(layer);out.alpha_composite(warp(canonical,q,quad(100)));return out
opening=[];opening.append((closed.copy(),180,'closed-rest',None))
im,k,de=grip(0);opening.append((im,120,'acquire-grip',{'angle':0,'drawing':k,'registration':de,'note':'Actual low-angle grip drawing at shut-lid lip; acquisition remains a review point.'}))
for j in range(1,26):
 t=j/25;angle=100*t*t*(3-2*t);im,k,de=grip(angle);opening.append((im,40,'open-lid',{'angle':angle,'drawing':k,'registration':de}))
opening.append((opening[-1][0].copy(),90,'open-grip-hold',{'angle':100}))
for j in range(9):opening.append((retract(j/8),40,'release-retract',{'angle':100,'releaseDrawing':True,'t':j/8}))
opening.append((canonical.copy(),200,'open-rest',None))
# Closing deliberately uses physically reversible contact/retraction poses, with its own timing.
closing=[(canonical.copy(),180,'open-rest',None)]
for j in range(8,-1,-1):closing.append((retract(j/8),35,'reach-lid',{'angle':100,'releaseDrawing':True,'t':j/8}))
im,k,de=grip(100);closing.append((im,80,'grip-open-lid',{'angle':100,'drawing':k}))
for j in range(24,-1,-1):
 t=j/25;angle=100*t*t*(3-2*t);im,k,de=grip(angle);closing.append((im,40 if angle>20 else 55,'close-lid',{'angle':angle,'drawing':k,'registration':de}))
closing.append((closed.copy(),250,'closed-rest',None))
for name,seq,entry,exit in [('opening',opening,'seated-closed-neutral-rest','seated-open-neutral-keyboard'),('closing',closing,'seated-open-neutral-keyboard','seated-closed-neutral-rest')]:
 outdir=p/name;outdir.mkdir(exist_ok=True);frames=[];trace=[]
 for i,(im,dur,phase,meta)in enumerate(seq):
  f=f'frame-{i:03}.png';im.save(outdir/f);frames.append({'source':f,'durationMs':dur,'offset':[0,0],'phase':phase,'pose':phase,'contacts':{'hingeLeft':[130,312],'hingeRight':[239,319]},'exitTo':[]});trace.append({'frame':i,**(meta or{})})
 data={'id':f'seated-work.{name}-hybrid-v2','family':'SEATED_WORK','canvas':[512,512],'stage':'motion-candidate','reviewStatus':'needs-native-size-contact-and-seam-review','entryPose':entry,'exitPose':exit,'loop':None,'frames':frames,'warning':'Fixed hard-surface projection + actual grip/release drawings with shoulder-pinned local cloth registration. Closed-rest seam, grip acquisition, grip-source switches and final retraction require review. Not accepted production animation.'};json.dump(data,open(outdir/'sequence.source.json','w'),indent=2);json.dump(trace,open(outdir/'contact-trace.json','w'),indent=2)
print('opening',len(opening),sum(x[1]for x in opening),'closing',len(closing),sum(x[1]for x in closing))
