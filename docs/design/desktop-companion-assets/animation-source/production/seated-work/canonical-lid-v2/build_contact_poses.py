from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
from scipy.ndimage import map_coordinates,binary_dilation
import numpy as np,math,json
p=Path(__file__).parent;old=p.parent/'canonical-lid-v1';canonical=Image.open(p.parent.parent/'shared/seated-open-canonical-alpha-v1.png').convert('RGBA');closed=Image.open(old/'closed-canonical-candidate.png').convert('RGBA');plate=Image.open(old/'left-arm-hidden-cleanplate-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
rm=Image.new('L',(512,512));ImageDraw.Draw(rm).polygon([(165,242),(204,226),(230,239),(250,269),(248,301),(185,301),(162,278)],fill=255);base=Image.composite(plate,closed,rm.filter(ImageFilter.GaussianBlur(.7)))
q=np.array([[101,224],[214,233],[239,319],[130,312]],float);h0=q[3];h1=q[2];c=np.array([72.,-17.]);op=math.radians(100);v=(q[0]-h0-c*math.cos(op))/math.sin(op)
def quad(a):
 t=math.radians(a);d=c*math.cos(t)+v*math.sin(t);f=(q[1]-q[0]-(h1-h0))*math.sin(t)/math.sin(op);return np.array([h0+d,h1+d+f,h1,h0])
def warp(im,src,dst):
 A=[];b=[]
 for (x,y),(u,w) in zip(dst,src):A.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-w*x,-w*y]]);b.extend([u,w])
 co=np.linalg.solve(np.array(A),np.array(b));out=im.transform((512,512),Image.Transform.PERSPECTIVE,tuple(co),Image.Resampling.BICUBIC);m=Image.new('L',(1024,1024));ImageDraw.Draw(m).polygon([tuple(z*2)for z in dst],fill=255);m=m.resize((512,512),Image.Resampling.LANCZOS);out.putalpha(m);return out
# Hidden keyboard uses existing visible-key pixels from the same canonical prop, tiled as an offline texture repair.
key=canonical.crop((242,299,259,307));tex=Image.new('RGBA',(153,56))
for y in range(0,56,8):
 for x in range(0,153,17):tex.paste(key,(x,y))
kb=warp(tex,np.array([[0,0],[153,0],[153,56],[0,56]],float),np.array([h0+c,h1+c,h1,h0]));base.alpha_composite(kb)
known=Image.new('L',(512,512));ImageDraw.Draw(known).polygon([(239,296),(307,295),(313,320),(241,323)],fill=255);base=Image.composite(canonical,base,known.filter(ImageFilter.GaussianBlur(.4)))
polys={20:[(150,293),(156,266),(167,249),(182,241),(206,247),(226,230),(242,224),(245,270),(221,286),(195,298)],45:[(138,295),(145,254),(164,225),(186,222),(207,230),(230,216),(245,226),(245,270),(204,282),(170,300)],70:[(120,308),(123,238),(132,210),(153,206),(166,215),(189,226),(230,217),(245,234),(244,270),(185,303)],100:[(115,289),(112,229),(114,215),(132,212),(152,222),(184,225),(230,216),(245,231),(244,272),(176,303),(146,335),(123,339)]}
handboxes={20:(166,241,209,276),45:(162,221,200,252),70:(130,207,169,240),100:(111,210,154,243)}; shifts={20:(12,0),45:(3,-1),70:(0,0),100:(1,-1)}
records=[];sheet=Image.new('RGBA',(2048,512),(216,234,220,255))
for i,angle in enumerate([20,45,70,100]):
 source=Image.open(old/f'grip-{angle:03}-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);a=np.array(source);yy,xx=np.indices((512,512),dtype=float);shoulder=np.array([240.,226.]);wrist=np.array([185.,260.]) if angle==20 else np.array([180.,236.]);axis=wrist-shoulder;dx,dy=shifts[angle];sx=xx.copy();sy=yy.copy()
 for _ in range(3):weight=np.clip(((sx-shoulder[0])*axis[0]+(sy-shoulder[1])*axis[1])/(axis@axis),0,1);sx=xx-weight*dx;sy=yy-weight*dy
 arr=np.stack([map_coordinates(a[:,:,ch],(sy,sx),order=1,mode='constant',cval=0)for ch in range(4)],axis=-1).astype('uint8');draw=Image.fromarray(arr);mask=Image.new('L',(512,512));ImageDraw.Draw(mask).polygon(polys[angle],fill=255);mask=mask.filter(ImageFilter.GaussianBlur(.7));layer=draw.copy();layer.putalpha(Image.fromarray(np.minimum(np.array(mask),arr[:,:,3])));out=base.copy();out.alpha_composite(layer);out.alpha_composite(warp(canonical,q,quad(angle)))
 # Actual new drawn skin overlaps the top lip; no interpolated finger morphology.
 x0,y0,x1,y1=handboxes[angle];x0+=dx;x1+=dx;y0+=dy;y1+=dy;rgb=arr[:,:,:3].astype(int);skin=(rgb[:,:,0]>150)&((rgb[:,:,0]-rgb[:,:,1])>12)&((rgb[:,:,0]-rgb[:,:,2])>12)&(xx>=x0)&(xx<=x1)&(yy>=y0)&(yy<=y1);skin=binary_dilation(skin,iterations=1);fm=Image.fromarray((skin*255).astype('uint8')).filter(ImageFilter.GaussianBlur(.35));fg=draw.copy();fg.putalpha(Image.fromarray(np.minimum(np.array(fm),arr[:,:,3])));out.alpha_composite(fg);out.save(p/f'pose-{angle:03}.png');mask.save(p/f'arm-mask-{angle:03}.png');fm.save(p/f'finger-mask-{angle:03}.png');sheet.alpha_composite(out,(i*512,0));records.append({'angle':angle,'hinge':[h0.tolist(),h1.tolist()],'lidQuad':quad(angle).tolist(),'handDrawing':f'../canonical-lid-v1/grip-{angle:03}-source.png','wristRegistrationShift':[dx,dy],'deformation':'Shoulder-pinned cloth displacement; hand moves rigidly with registration, not invented hand shapes','leftArmContour':polys[angle]})
sheet.convert('RGB').save(p/'contact-poses.jpg');json.dump({'status':'contact-pose-candidates-not-complete-animation','sourcePlane':q.tolist(),'baseTextureRepair':'Existing visible canonical keyboard pixels tiled only on newly revealed rigid base plane','records':records},open(p/'provenance.json','w'),indent=2)
