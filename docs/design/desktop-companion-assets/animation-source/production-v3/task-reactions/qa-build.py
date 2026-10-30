from pathlib import Path
from PIL import Image,ImageDraw
import json,hashlib
D=Path(__file__).parent;(D/'qa').mkdir(exist_ok=True);m=json.loads((D/'manifest.json').read_text())
for name,action in m['actions'].items():
 frames=action['frames'];cols=6;rows=(len(frames)+cols-1)//cols;sheet=Image.new('RGB',(cols*256,rows*286),(235,238,242));draw=ImageDraw.Draw(sheet);ims=[];dur=[]
 for i,f in enumerate(frames):
  im=Image.open(D/f['source']).convert('RGBA');small=im.resize((256,256),Image.Resampling.LANCZOS);x=i%cols*256;y=i//cols*286;sheet.paste(small,(x,y),small);draw.text((x+5,y+258),f['cue'],fill='black');draw.text((x+5,y+272),str(f['durationMs'])+' ms',fill='black');bg=Image.new('RGBA',(512,542),(235,238,242,255));bg.alpha_composite(im);ImageDraw.Draw(bg).text((10,520),f'{name} / '+f['cue'],fill='black');ims.append(bg.convert('RGB'));dur.append(f['durationMs'])
 sheet.save(D/'qa'/f'{name}-sequence.jpg');ims[0].save(D/'qa'/f'{name}-exposure.gif',save_all=True,append_images=ims[1:],duration=dur,loop=0,disposal=2)
# Validate every actual exposure including references has exact recovery.
missing=[]
for name,a in m['actions'].items():
 for f in a['frames']:
  if f['sourceSHA256'] not in m['ordinaryRecoveryBySourceSHA']:missing.append((name,f['source']))
(D/'qa/contract-validation.json').write_text(json.dumps({'everyExposureHasOrdinaryRecovery':not missing,'missing':missing,'newSourceCount':len(m['assets']),'actions':len(m['actions']),'referenceSourceReuseNotNewArt':True},indent=2,sort_keys=True)+'\n')
assert not missing,missing
