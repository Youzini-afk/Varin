from pathlib import Path
from PIL import Image
import numpy as np,json,runpy,hashlib
p=Path(__file__).parent;closed=np.array(Image.open(p.parent/'canonical-lid-v1/closed-canonical-candidate.png').convert('RGBA'));neutral=np.array(Image.open(p.parent.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA'));yy,xx=np.indices((512,512));static=(xx<75)|(xx>395)|(yy<180)|(yy>370);r=[]
# Same fixed plane formula without executing art-generating scripts.
h0=np.array([130.,312.]);h1=np.array([239.,319.]);c=np.array([72.,-17.]);op=np.deg2rad(100);v=(np.array([-29.,-88.])-c*np.cos(op))/np.sin(op)
def quad(a):
 t=np.deg2rad(a);d=c*np.cos(t)+v*np.sin(t);far=np.array([4.,2.])*np.sin(t)/np.sin(op);return h0+d,h1+d+far
for name in ['opening','closing']:
 folder=p/name;j=json.load(open(folder/'sequence.source.json'));trace=json.load(open(folder/'contact-trace.json'));first=np.array(Image.open(folder/j['frames'][0]['source']));last=np.array(Image.open(folder/j['frames'][-1]['source']));expectedFirst,expectedLast=(closed,neutral)if name=='opening'else(neutral,closed);assert np.array_equal(first,expectedFirst);assert np.array_equal(last,expectedLast);contacts=[];maxstatic=0
 for f,t in zip(j['frames'],trace):
  a=np.array(Image.open(folder/f['source']));maxstatic=max(maxstatic,int(np.any(a[static]!=closed[static],axis=1).sum()))
  if 'drawing'in t:
   q0,q1=quad(t['angle']);u=(q1-q0);u=u/np.linalg.norm(u);dx=xx-q0[0];dy=yy-q0[1];along=dx*u[0]+dy*u[1];dist=np.abs(dx*u[1]-dy*u[0]);rgb=a[:,:,:3].astype(int);skin=(rgb[:,:,0]>150)&((rgb[:,:,0]-rgb[:,:,1])>12)&((rgb[:,:,0]-rgb[:,:,2])>12)&(a[:,:,3]>100)&(along>-5)&(along<38)&(dist<30);minimum=float(dist[skin].min())if skin.any()else None;contacts.append({'frame':t['frame'],'angle':t['angle'],'nearestSkinToTopLipPx':round(minimum,2)if minimum is not None else None})
 r.append({'sequence':name,'firstEndpointExact':True,'lastEndpointExact':True,'durationMs':sum(f['durationMs']for f in j['frames']),'maxChangedPixelsOutsideBroadMotionRegion':maxstatic,'fingerLipMeasurements':contacts,'interpretation':'Nearest skin-to-lip is a geometric diagnostic, not aesthetic or anatomical acceptance.'})
json.dump({'status':'candidate-technical-checks-only','reports':r},open(p/'motion-contract-qa.json','w'),indent=2);print([(x['sequence'],x['maxChangedPixelsOutsideBroadMotionRegion'],max(c['nearestSkinToTopLipPx'] or 0 for c in x['fingerLipMeasurements']))for x in r])
