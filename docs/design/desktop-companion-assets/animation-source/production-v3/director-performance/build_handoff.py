from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import hashlib,json
R=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
idx=json.loads((R/'current-source-index.json').read_text());names=[x['id'] for x in idx['sources']]
def source(n):return ('frames/'+n+'.png') if n in names else ('references/'+n+'.png')
def pose(n):return {'open-user':'upright-v2:open-user','listen-rest':'upright-v2:listen'}.get(n,'upright-v2:director:'+n)
def f(n,ms,cue,phase='act',safe=False):
 p=source(n);return {'source':p,'sourceSHA256':sha(R/p),'pose':pose(n),'durationMs':ms,'cue':cue,'phase':phase,'pauseSafe':safe}
seq={}
for side,turn,lean in [('right','listen-turn-reuse-v2','listen-lean-v2'),('left','listen-left-turn-reuse-v1','listen-left-lean-v1')]:
 seq['director-listen-'+side]={'publicAction':'director-listen','targetSide':side,'entryPose':pose('listen-rest'),'exitPose':pose('listen-rest'),'entrySource':source('listen-rest'),'exitSource':source('listen-rest'),'wholeSequenceLoop':False,'frames':[f('listen-rest',180,'REST','enter',True),f(turn,160,'ATTEND_LEAD','enter'),f(lean,650,'LISTEN','act'),f(turn,180,'RELEASE','exit'),f('listen-rest',900,'REST','hold',True)],'sustain':'After the one-shot attentive lean, hold exact listen-rest; do not loop head lean or alternate sides. Matching listen-rest blink may be reused from existing package.'}
seq['director-gather-present']={'publicAction':'director-gather-present','targetSide':'fixed-laptop-summary','entryPose':pose('open-user'),'exitPose':pose('open-user'),'entrySource':source('open-user'),'exitSource':source('open-user'),'wholeSequenceLoop':False,'frames':[f('open-user',160,'REST','enter',True),f('gather-release-v1',120,'HAND_RELEASE','enter'),f('gather-sweep-mid-v2',140,'GATHER_PREPARE','enter'),f('gather-out-v2',180,'GATHER_OUT'),f('gather-sweep-mid-v2',120,'GATHER_IN'),f('gather-in-v1',220,'GATHER_IN'),f('gather-user-v1',260,'ADDRESS_USER'),f('offer-mid',130,'PRESENT_PREPARE'),f('offer',500,'PRESENT'),f('offer-mid',130,'RELEASE','exit'),f('gather-release-v1',130,'HAND_RETURN','exit'),f('open-user',900,'REST','hold',True)],'sustain':'Stable open-user after finite presentation; any unresolved item stays on its identified card/list. No repeated palm lifting timer.'}
recovery={
 'listen-turn-reuse-v2':['listen-rest'], 'listen-lean-v2':['listen-turn-reuse-v2','listen-rest'],
 'listen-left-turn-reuse-v1':['listen-rest'],'listen-left-lean-v1':['listen-left-turn-reuse-v1','listen-rest'],
 'gather-release-v1':['open-user'],'gather-sweep-mid-v2':['gather-release-v1','open-user'],'gather-out-v2':['gather-sweep-mid-v2','gather-release-v1','open-user'],
 'gather-in-v1':['gather-user-v1','gather-release-v1','open-user'],'gather-user-v1':['gather-release-v1','open-user'],
 'offer':['offer-mid','gather-release-v1','open-user'],'offer-mid':['gather-release-v1','open-user'],
 'open-user':[],'listen-rest':[]}
rec={sha(R/source(n)):{'actualSource':source(n),'actualPose':pose(n),'currentExposureMaxRemainingMs':0 if n in ['open-user','listen-rest'] else 40,'endpoint':pose('listen-rest') if n.startswith('listen') else pose('open-user'),'frames':[f(x,100 if i<len(v)-1 else 80,'ORDINARY_RETURN','exit',i==len(v)-1) for i,x in enumerate(v)],'discardOldSemanticCue':True} for n,v in recovery.items()}
manifest={'status':'authored director candidate; parent/runtime full-sequence review pending','geometryReference':'varin-upright-v2','canvas':[512,512],'pathBase':'.','runtimeSourceNames':names,'actions':seq,'ordinaryRecoveryBySourceSHA':rec,'layoutContract':{'sceneCanvas':[300,250],'actorRect':[50,25,200,200],'inspectionDock':{'right':[250,128],'left':[42,128]},'laptopSummary':[166,147],'resolveSideOnceForBodyAndScene':True,'noMirroring':True,'edgeChange':'On resolved-side change during lean, show latest card placement immediately and withdraw actual pose via TURN to listen-rest, then optionally attend new side only if still relevant; never interpolate across skull or replay historical event.'},'sourceReuse':{'listenTurns':'Genuinely drawn v2 yaw intermediates registered to exact listen-rest hand pose, not new generated yaw or whole-head rotation','offer':'Existing exact v2 offer sources; same actual SHA, no new artwork claimed'},'endpointBoundary':'LISTEN starts/ends exact public listen-rest. Cross-family open-user↔listen public bridge must be provided/confirmed by runtime owner; this package does not silently jump hands across laptop. Gather starts/ends exact open-user.','priority':'Latest factual UI/pointer motion immediate; bodily current-exposure recovery only. Drag uses exact SHA detached ingress. New user/business cue never waits for full scene.','reducedMotion':'Skip optional gesture; use appropriate existing exact endpoint while all scoped facts remain visible.'}
(R/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
for row in idx['sources']:row['ordinaryRecovery']=rec[row['sourceSHA256']]
(R/'current-source-index.json').write_text(json.dumps(idx,indent=2)+'\n')
# Internal scene studies: real PNG exposures with code-native annotation/abstract cards, not new character art.
font='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';F=lambda n:ImageFont.truetype(font,n)
for key,action in seq.items():
 images=[]
 for frame in action['frames']:
  base=Image.new('RGBA',(768,600),'#e9eef2');d=ImageDraw.Draw(base);d.text((20,12),key,font=F(20),fill='#29425e');d.text((20,43),frame['cue']+' / '+str(frame['durationMs'])+'ms',font=F(15),fill='#64768a')
  a=Image.open(R/frame['source']).convert('RGBA')
  # native actor x128 y80 w512; side targets intentionally outside face.
  if key.startswith('director-listen'):
   left=action['targetSide']=='left';x=4 if left else 614
   d.rounded_rectangle((x,280,x+148,370),radius=9,fill='#fffdf8',outline='#6a88a4',width=2);d.text((x+10,292),'A 项目负责人',font=F(16),fill='#29425e');d.text((x+10,320),'已知状态摘要',font=F(14),fill='#526b80')
  else:
   d.rounded_rectangle((610,240,762,334),radius=9,fill='#fffdf8',outline='#6a88a4',width=2);d.text((620,252),'B 授权 / C 问题',font=F(15),fill='#29425e');d.text((620,282),'独立事项保留',font=F(14),fill='#526b80')
   if frame['cue'] in ['GATHER_IN','ADDRESS_USER','PRESENT_PREPARE','PRESENT']:
    d.line([(610,321),(552,376),(425,392)],fill='#a291b7',width=3);d.rounded_rectangle((402,380,448,404),radius=4,fill='#edf1f6',outline='#a291b7',width=2)
  base.alpha_composite(a,(128,80))
  d.text((20,568),'内部正常曝光编排候选；卡为示意，最终采用 native 同一锚点解析。',font=F(15),fill='#64768a');images.append(base.convert('RGB'))
 images[0].save(R/'qa'/f'{key}.gif',save_all=True,append_images=images[1:],duration=[f['durationMs'] for f in action['frames']],loop=0)
(R/'qa/review.html').write_text('<!doctype html><meta charset="utf-8"><style>body{background:#e9eef2;color:#29425e;font:18px sans-serif}img{max-width:100%}</style><h1>主管完整场景曝光候选</h1><p>动画循环仅用于审片；runtime 每场一次，随后稳定保持，不循环倾听/呈交。</p>'+''.join('<h2>'+k+'</h2><img src="'+k+'.gif">' for k in seq))
print('9 actual source closure, 3 complete candidate scenes, 13 actual-SHA recovery entries')
