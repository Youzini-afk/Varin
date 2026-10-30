from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
from scipy.spatial import ConvexHull
from scipy import ndimage as nd
import numpy as np,json,hashlib
r=Path(__file__).parent;master=Image.open(r.parent/'shared/upright-open-neutral-v2.png').convert('RGBA')
def whole_hand(im,box):
 # Color detection only locates the hand. Final matte is its complete expanded silhouette hull,
 # including all dark outlines, nails, finger shadows and inter-finger source pixels.
 a=np.array(im).astype('int16');x0,y0,x1,y1=box;reg=a[y0:y1,x0:x1];skin=(reg[:,:,0]>reg[:,:,1]+8)&(reg[:,:,0]>reg[:,:,2]+9)&(reg[:,:,0]>175)&(reg[:,:,1]>110)
 lab,n=nd.label(skin);sz=np.bincount(lab.ravel());sz[0]=0;valid=nd.binary_dilation(lab==sz.argmax(),iterations=2);ys,xs=np.where(valid);pts=np.column_stack([xs+x0,ys+y0]);h=ConvexHull(pts);m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([tuple(p) for p in pts[h.vertices]],fill=255);return m.filter(ImageFilter.GaussianBlur(.25))
rm=whole_hand(master,(251,278,318,320))
sources={0:'contact-000-v2-raw.png',15:'contact-015-crop-placed.png',30:'contact-020-v1-raw.png',45:'contact-045-v1-raw.png',55:'contact-055-v1-raw.png',70:'contact-070-v1-raw.png',100:'contact-100-v1-raw.png'}
boxes={0:(140,264,188,309),15:(158,243,204,287),30:(145,225,197,275),45:(145,211,188,262),55:(140,207,181,258),70:(128,204,176,258),100:(102,211,149,258)}
meta=[]
for angle,src in sources.items():
 raw=Image.open(r/'sources'/src).convert('RGBA').resize((512,512),Image.Resampling.LANCZOS);base=Image.open(r/f'frames/contact-{angle:03}-registered-v2.png').convert('RGBA');m=whole_hand(raw,boxes[angle]);out=Image.composite(raw,base,m);out=Image.composite(master,out,rm);p=r/f'frames/contact-{angle:03}-registered-v3.png';out.save(p);m.save(r/f'frames/contact-{angle:03}-whole-hand-mask-v3.png');meta.append({'source':str(p.relative_to(r)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
for name,src,box in [('release-first','release-first-crop-v1-raw.png',(121,204,184,244)),('release-near','release-near-cleanup-v2-raw.png',(162,203,225,250)),('release-low','release-low-crop-v2-raw.png',(223,275,256,318))]:
 raw=master.copy();raw.paste(Image.open(r/'sources'/src).convert('RGBA').resize((260,260),Image.Resampling.LANCZOS),(90,190));base=Image.open(r/f'frames/{name}-registered-v1.png').convert('RGBA');m=whole_hand(raw,box);out=Image.composite(raw,base,m);out=Image.composite(master,out,rm);p=r/f'frames/{name}-registered-v2.png';out.save(p);m.save(r/f'frames/{name}-whole-hand-mask-v2.png')
(r/'whole-hand-layer-provenance-v3.json').write_text(json.dumps({'method':'whole continuous hand silhouettes, no skin-key holes','frames':meta},indent=2)+'\n')
j=json.loads((r/'sequence-source-v2.json').read_text())
for f in j['opening']:
 f['source']=f['source'].replace('closed-rest-rigid-v1','closed-rest-rigid-v2').replace('registered-v2','registered-v3') if 'contact-' in f['source'] else f['source'].replace('closed-rest-rigid-v1','closed-rest-rigid-v2').replace('registered-v1','registered-v2')
 f['sha256']=hashlib.sha256((r/f['source']).read_bytes()).hexdigest()
j['closing']=j['opening'][::-1];j['stage']='motion candidate v3: complete hand matte correction, awaiting review';(r/'sequence-source-v3.json').write_text(json.dumps(j,indent=2)+'\n')
for name in ['opening','closing']:
 imgs=[]
 for f in j[name]:
  bg=Image.new('RGBA',(512,512),'#263846');bg.alpha_composite(Image.open(r/f['source']).convert('RGBA'));imgs.append(bg.convert('RGB'))
 imgs[0].save(r/f'{name}-normal-speed-v3.webp',save_all=True,append_images=imgs[1:],duration=[f['durationMs'] for f in j[name]],loop=0,lossless=True)
qa=Image.new('RGB',(1400,600),'#263846')
for i,f in enumerate(j['opening']):
 im=Image.open(r/f['source']).convert('RGBA');bg=Image.new('RGBA',im.size,'#263846');bg.alpha_composite(im);qa.paste(bg.crop((100,200,330,330)).resize((350,200)).convert('RGB'),(i%4*350,i//4*200))
qa.save(r/'whole-hand-layers-review-v3.jpg',quality=98)
