from pathlib import Path
import numpy as np,json
from scipy.ndimage import map_coordinates
from scipy.optimize import least_squares
from PIL import Image,ImageDraw
D=Path(__file__).parent
ref=Image.open(D/'head-neck-source.png').convert('RGBA');R=np.asarray(ref).astype(float)/255
Y,X=np.mgrid[465:590:3,250:470:3];target=R[Y,X,:3]
rows=[];panels=[ref]
for pose in ['up','down']:
 src=Image.open(D/f'head-pitch-{pose}-generated.png').convert('RGBA');scaled=src.resize((680,600),Image.Resampling.LANCZOS);A=np.asarray(scaled).astype(float)/255
 def matrix(p):
  s,theta,tx,ty=p;c=np.cos(theta)*s;v=np.sin(theta)*s
  return np.array([[c,-v,340-c*340+v*500+tx],[v,c,500-v*340-c*500+ty],[0,0,1]])
 def residual(p):
  inv=np.linalg.inv(matrix(p));u=inv[0,0]*X+inv[0,1]*Y+inv[0,2];v=inv[1,0]*X+inv[1,1]*Y+inv[1,2]
  q=np.stack([map_coordinates(A[:,:,c],[v,u],order=1,mode='constant') for c in range(3)],axis=-1)
  return (q-target).ravel()
 fit=least_squares(residual,[1,0,0,0],bounds=([.97,-.025,-15,-15],[1.03,.025,15,15]),loss='soft_l1',f_scale=.08,max_nfev=100)
 mat=matrix(fit.x);inv=np.linalg.inv(mat);reg=scaled.transform((680,600),Image.Transform.AFFINE,tuple(inv[:2].ravel()),Image.Resampling.BICUBIC)
 reg.save(D/f'head-pitch-{pose}-registered-crop.png')
 canvas=Image.new('RGBA',(1382,1382));canvas.paste(reg,(350,100));canvas.save(D/f'head-pitch-{pose}-registered-reference.png')
 rows.append({'pose':pose,'sourceSize':list(src.size),'normalizedCropSize':[680,600],'similarityTransformAfterResize':mat[:2].tolist(),'parameters_scale_angleRadians_tx_ty':fit.x.tolist(),'stationaryTorsoFitROI':[250,465,470,590],'rgbResidualRMSE':float(np.sqrt(np.mean(residual(fit.x)**2))),'note':'Approximate torso texture registration, not exact source pixel preservation. Full crop is a reference; do not replace canonical torso or simply crossfade full heads.'})
 panels.append(reg)
qa=Image.new('RGB',(680*3,640),(220,220,220));draw=ImageDraw.Draw(qa)
for i,(p,label) in enumerate(zip(panels,['canonical','pitch up / generated','pitch down / generated'])):
 qa.paste(p,(i*680,30),p.getchannel('A'));draw.text((i*680+10,10),label,fill=(0,0,0))
qa.save(D/'pitch-comparison-qa.jpg',quality=95)
(D/'registration-report.json').write_text(json.dumps({'sourceCrop':[350,100,1030,700],'canonicalNeckPivot':[738,510],'registration':rows},indent=2)+'\n');print(json.dumps(rows,indent=2))
