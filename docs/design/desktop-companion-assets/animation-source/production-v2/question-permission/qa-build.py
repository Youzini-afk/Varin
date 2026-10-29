from PIL import Image,ImageDraw
from pathlib import Path
import json,numpy as np
D=Path(__file__).parent;m=json.loads((D/'manifest.json').read_text());base=np.asarray(Image.open(D/'references/upright-open-neutral-v2.png').convert('RGBA'));report={}
for name,a in m['assets'].items():
 im=np.asarray(Image.open(D/a['path']).convert('RGBA'));mask=np.asarray(Image.open(D/a['mask']));outside=mask==0
 if name=='nod-soft': baseCompare=np.asarray(Image.open(D/'poses/nod.png').convert('RGBA'))
 else: baseCompare=base
 report[name]={'outsideMaskChangedPixels':int(np.any(im[outside]!=baseCompare[outside],axis=-1).sum()),'canvas':list(im.shape[:2]),'changedPixelCount':int(np.any(im!=base,axis=-1).sum())}
for group,seq in [('question','questionEnter'),('permission','permissionEnter')]:
 entries=m['sequences'][seq]+m['sequences']['questionAnswered' if group=='question' else 'permissionAllow'];ims=[];dur=[]
 for step in entries:
  p=step['pose'];f=D/p if '/' in p else D/'poses'/f'{p}.png'
  out=Image.new('RGBA',(512,542),(235,238,242,255));out.alpha_composite(Image.open(f).convert('RGBA'));ImageDraw.Draw(out).text((12,520),step['phase'],fill='black');ims.append(out.convert('RGB'));dur.append(step['durationMs'] or 1600)
 ims[0].save(D/'qa'/f'{group}-exposure.gif',save_all=True,append_images=ims[1:],duration=dur,loop=0,disposal=2)
(D/'qa/verification.json').write_text(json.dumps(report,indent=2,sort_keys=True))
for group,entries in [('question',m['sequences']['questionEnter']+m['sequences']['questionAnswered']),('permission',m['sequences']['permissionEnter']+m['sequences']['permissionAllow'])]:
 cols=6;rows=(len(entries)+cols-1)//cols;sheet=Image.new('RGB',(cols*256,rows*286),(235,238,242));draw=ImageDraw.Draw(sheet)
 for i,e in enumerate(entries):
  p=e['pose'];f=D/p if '/' in p else D/'poses'/f'{p}.png';im=Image.open(f).convert('RGBA').resize((256,256),Image.Resampling.LANCZOS);x=i%cols*256;y=i//cols*286;sheet.paste(im,(x,y),im);draw.text((x+6,y+257),str(i+1)+' '+e['phase'],fill='black');draw.text((x+6,y+270),str(e['durationMs'] or 'EVENT HOLD')+' ms',fill='black')
 sheet.save(D/'qa'/f'{group}-sequence.jpg')
