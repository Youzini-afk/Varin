from PIL import Image,ImageDraw
from pathlib import Path
import hashlib,json,shutil,subprocess,sys
r=Path(__file__).resolve().parent.parent;a=r/'references'
for name,src in [('neutral','upright-open-neutral-v2.png'),('screen-read','open-screen-read-v2.png')]:shutil.copyfile(a/src,r/'frames'/f'{name}.png')
subprocess.run([sys.executable,str(r/'scripts/register_typing_exposure.py')],check=True)
seqs={
'editing':[('screen-read','ENTER',240),('type-burst','TYPE_READY',160),('type-prepare','TYPE_PREPARE',160),('type-forward','TYPE_BURST',180),('type-forward-hands-b','TYPE_ALTERNATE',150),('type-forward','TYPE_BURST',180),('type-prepare','TYPE_STOP',180),('type-burst','TYPE_RELEASE',150),('review-rise','REVIEW_RISE',180),('review','REVIEW',720),('review-rise','REVIEW_LOWER',180),('select','SELECT',400),('type-burst','REVISE_PREPARE',150),('type-prepare','REVISE',160),('type-forward','REVISE',180),('type-forward-hands-b','REVISE_ALTERNATE',150),('type-forward','REVISE',160),('type-prepare','EDIT_RELEASE',180),('type-burst','EDIT_SETTLE',160),('screen-read','EXIT',650)],
'collaboration':[('neutral','ENTER',240),('review-v2','SPLIT',200),('split-gaze','GAZE_A',180),('dispatch-rise-gaze','DISPATCH_RISE',180),('dispatch-a-gaze','DISPATCH_A',400),('dispatch-rise-gaze','DISPATCH_TRANSIT_OUT',160),('dispatch-transit-gazeB','GAZE_B_TRANSIT',180),('dispatch-b-v2-gazeB','DISPATCH_B',400),('dispatch-transit-gazeB','RETURN_ROTATE',180),('review-v2','RETURN_LOWER',180),('gaze-right','WATCH',900),('neutral','WATCH_CENTER',450),('screen-read','RELEASE',300),('type-burst','WORK',180),('screen-read','EXIT',500)]}
manifest={'schemaVersion':1,'status':'complete authored sequence candidate; parent normal-speed visual QA pending','geometryReference':'varin-upright-v2','directionConvention':'viewer/screen coordinates','cueDirections':{'DISPATCH_A':'right','DISPATCH_B':'inner-left','GAZE_A':'right','GAZE_B_TRANSIT':'inner-left'},'viewport':[512,512],'engineContract':'scene descriptor/cues, no business state additions','sequences':{}}
for key,seq in seqs.items():
 ims=[];rows=[]
 for n,cue,hold in seq:
  p=r/'frames'/f'{n}.png';im=Image.open(p).convert('RGBA');bg=Image.new('RGBA',im.size,'#263846');bg.alpha_composite(im);ims.append(bg.convert('RGB'));rows.append({'frame':str(p.relative_to(r)),'pose':n,'cue':cue,'holdMs':hold,'sourceSHA256':hashlib.sha256(p.read_bytes()).hexdigest()})
 ims[0].save(r/f'{key}-normal-speed.webp',save_all=True,append_images=ims[1:],duration=[x[2] for x in seq],loop=0,lossless=True)
 w=256;sheet=Image.new('RGB',(w*6,286*((len(seq)+5)//6)),'#263846');d=ImageDraw.Draw(sheet)
 for i,(im,(n,cue,hold)) in enumerate(zip(ims,seq)):
  x=(i%6)*w;y=(i//6)*286;sheet.paste(im.resize((w,w),Image.Resampling.LANCZOS),(x,y+30));d.text((x+5,y+3),f'{i:02d} {cue} {hold}ms',fill='white')
 sheet.save(r/'qa'/f'{key}-sequence-contact.jpg',quality=94)
 manifest['sequences'][key]={'entryAnchor':'open-screen-read-v2' if key=='editing' else 'upright-open-neutral-v2','exitAnchor':'open-screen-read-v2','entryPose':'open-screen' if key=='editing' else 'open-user','exitPose':'open-screen','durationMs':sum(x[2] for x in seq),'frames':rows,'sustain':'Use review/read holds between bursts; dispatch episode one-shot then watch/work, do not loop dispatch during sustained collaboration.'}
(r/'sequence-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
