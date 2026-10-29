from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import json,hashlib,numpy as np
D=Path(__file__).parent;W=D/'wave';W.mkdir(exist_ok=True)
base=Image.open(D/'references/upright-open-neutral-v2.png').convert('RGBA');closed=Image.open(D/'references/closed-rest-rigid-v2.png').convert('RGBA')
m=Image.new('L',(512,512));d=ImageDraw.Draw(m);d.polygon([(310,177),(380,172),(386,244),(381,300),(374,361),(332,365),(300,337),(251,325),(250,280),(285,267),(299,227)],fill=255);m=m.filter(ImageFilter.GaussianBlur(1));m.save(W/'arm-mask.png')
face=Image.new('L',(512,512));ImageDraw.Draw(face).polygon([(209,131),(232,124),(295,122),(314,139),(302,169),(275,182),(244,179),(218,165)],fill=255);face=face.filter(ImageFilter.GaussianBlur(1));face.save(W/'expression-mask.png')
rawpeak=Image.open(D/'raw/wave-peak.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
for n in ['peak','mid']:
 raw=Image.open(D/'raw'/f'wave-{n}.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 im=Image.composite(raw,base,m);im=Image.composite(rawpeak,im,face);im.save(W/f'open-{n}.png')
# Shared smile uses exact expression source only, without moving the arm.
Image.composite(rawpeak,base,face).save(W/'open-smile.png')
# closed body keeps frozen endpoint. Actual redrawn sleeve/arm comes from open wave,
# while below-arm computer exposure comes from separately authored closed key source.
rawclosed=Image.open(D/'raw/wave-closed-corrected.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
contact=Image.new('L',(512,512));ImageDraw.Draw(contact).polygon([(249,274),(309,275),(313,313),(252,320)],fill=255);contact=contact.filter(ImageFilter.GaussianBlur(.8));contact.save(W/'closed-contact-mask.png')
for n in ['peak','mid']:
 raw=Image.open(D/'raw'/f'wave-{n}.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
 im=Image.composite(raw,closed,m);im=Image.composite(rawclosed,im,contact)
 # Reapply exact mechanical prop pixels only where raised hand uncovered lid; keep other supporting hand.
 im.alpha_composite(Image.open(D/'references/base-original-visible.png').convert('RGBA'))
 lid=Image.open(D/'references/lid-angle-000.png').convert('RGBA');a=np.asarray(lid.getchannel('A')).copy();a[:,:249]=0;lid.putalpha(Image.fromarray(a));im.alpha_composite(lid)
 im=Image.composite(rawpeak,im,face);im.save(W/f'closed-{n}.png')
Image.composite(rawpeak,closed,face).save(W/'closed-smile.png')
canvas=Image.new('RGB',(2048,1080),(235,238,242));draw=ImageDraw.Draw(canvas)
for j,kind in enumerate(['open','closed']):
 for i,(name,im) in enumerate([('rest',base if kind=='open' else closed)]+[(n,Image.open(W/f'{kind}-{n}.png')) for n in ['mid','peak','smile']]):canvas.paste(im,(i*512,j*540+25),im);draw.text((i*512+10,j*540+5),kind+' '+name,fill='black')
canvas.save(D/'qa/wave-contact.jpg')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
refnames=['upright-open-neutral-v2.png','closed-rest-rigid-v2.png','lid-angle-000.png','base-original-visible.png']
manifest={'status':'internal artwork reviewed; runtime integration pending, no runtime install','sharedMotion':'one small palm-facing-viewer lift-mid-peak-mid-rest action, no permission-palm reuse','references':{n:sha(D/'references'/n) for n in refnames},'closedEndpointOwner':'produce_relocation_animation_frames; new rigid v2 closed endpoint, not old shared static closed projection','provenance':{'open-mid':'raw/wave-mid.png plus frozen open outside arm mask','open-peak':'raw/wave-peak.png plus frozen open outside arm mask','closed':'same generated arm with raw/wave-closed-corrected exposed contact region, frozen mechanical closed endpoint, exact lid-angle-000 and base-original-visible restore prop pixels','smile':'expression-only mask from wave-peak; body unchanged'},'historicalGenerationReference':{'path':'references/closed-rest-rigid-v1.png','sha256':sha(D/'references/closed-rest-rigid-v1.png'),'role':'exact historical imagegen reference only; never runtime base'},'rejected':{'raw/wave-closed.png':'wrong arm; retained for provenance only'},'rawSHA256':{p.name:sha(p) for p in (D/'raw').glob('wave*.png')},'prompts':{p.name:sha(p) for p in (D/'prompts').glob('wave*.txt')},'semantics':{}}
for name,kind,times in [('welcome','closed',[160,110,300,140,240,150]),('tap','closed',[80,80,130,90,100,80]),('completion','open',[180,130,280,150,260,180])]:
 rest=D/'references'/('closed-rest-rigid-v2.png' if kind=='closed' else 'upright-open-neutral-v2.png')
 paths=[rest,W/f'{kind}-mid.png',W/f'{kind}-peak.png',W/f'{kind}-mid.png',W/f'{kind}-smile.png',rest]
 cue=['ADDRESS','LIFT','WAVE','LOWER','SOFT_SMILE','REST']
 rule={'welcome':'one local welcome event, once, never periodic background timer','tap':'only actual user tap, shorter local acknowledgement; no completion receipt','completion':'only actual successful completion receipt, deduplicate receipt ID; never elapsed time/pending/permission allow alone'}[name]
 manifest['semantics'][name]={'trigger':rule,'entry':str(rest.relative_to(D)),'exit':str(rest.relative_to(D)),'cue':'no baked symbols; any completion visual must derive from actual completion receipt','frames':[{'path':str(p.relative_to(D)),'durationMs':t,'cue':c} for p,t,c in zip(paths,times,cue)],'interruption':'neutral lower via mid then matching open/closed rest; no implied business result'}
 ims=[];sheet=Image.new('RGB',(1536,286),(235,238,242));draw=ImageDraw.Draw(sheet)
 for i,(p,t,c) in enumerate(zip(paths,times,cue)):
  im=Image.open(p).convert('RGBA');bg=Image.new('RGBA',(512,542),(235,238,242,255));bg.alpha_composite(im);ImageDraw.Draw(bg).text((10,520),name+' '+c,fill='black');ims.append(bg.convert('RGB'));small=im.resize((256,256),Image.Resampling.LANCZOS);sheet.paste(small,(i*256,0),small);draw.text((i*256+6,258),f'{c} {t}ms',fill='black')
 ims[0].save(D/'qa'/f'{name}-exposure.gif',save_all=True,append_images=ims[1:],duration=times,loop=0,disposal=2);sheet.save(D/'qa'/f'{name}-sequence.jpg')
(W/'manifest.json').write_text(json.dumps(manifest,indent=2,sort_keys=True))
