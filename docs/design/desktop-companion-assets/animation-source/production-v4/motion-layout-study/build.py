from pathlib import Path
import math,json,hashlib,subprocess
import numpy as np
from scipy.interpolate import PchipInterpolator
R=Path(__file__).resolve().parent
# Newly drawn schematic coordinates, not a raster character rig.
keys=[
(0,'REST',143,319,0,0,0,0),(.45,'BRACE',143,319,0,0,0,0),
(.65,'RELEASE',143,319,-2,1,0,0),(.85,'CLEAR EDGE',132,322,-3,2,0,4),
(1.10,'APPROACH',116,309,-4,4,1,15),(1.40,'APPROACH',106,282,-5,6,2,28),
(1.70,'OPEN ATTENTION',106,263,-4,7,3,35),(1.90,'PEAK',106,263,-4,7,3,35),
(2.14,'TURN DOWN',104,280,-3,5,2,30),(2.40,'LOWER',120,316,-1,3,1,18),
(2.70,'ARRIVE',143,319,0,1,0,0),(2.90,'TAKE LOAD',143,319,.7,0,0,0),
(3.20,'SETTLE',143,319,0,0,0,0),(4.2,'REST',143,319,0,0,0,0)]
t=np.array([k[0] for k in keys]);values=np.array([k[2:] for k in keys]);curves=[PchipInterpolator(t,values[:,i])for i in range(values.shape[1])]
def ik(a,w,l1=74,l2=66,sign=-1):
 dx,dy=w[0]-a[0],w[1]-a[1];d=math.hypot(dx,dy);assert abs(l1-l2)<d<l1+l2
 q=(l1*l1-l2*l2+d*d)/(2*d);h=math.sqrt(l1*l1-q*q)
 return [a[0]+q*dx/d-sign*h*dy/d,a[1]+q*dy/d+sign*h*dx/d]
def pose(tm):
 wx,wy,lift,pitch,headlead,depth=[float(f(tm)) for f in curves]
 chest=[259+pitch*.25,245+lift];neck=[262+pitch*.3,190+lift];head=[262+pitch*.3,105+lift-headlead*.45]
 shoulderL=[204+pitch*.25,215+lift];shoulderR=[304+pitch*.25,216+lift]
 stable=[282,307];wrist=[wx,wy]
 # A lag marker only, not final hair/cloth dynamics.
 lag=max(0,tm-.13);lp=float(curves[2](lag));settle=1.1*math.exp(-max(0,tm-2.70)*8)*math.sin(max(0,tm-2.70)*14) if tm>2.70 else 0
 return {'time':round(tm,5),'phase':keys[max(i for i,k in enumerate(keys)if k[0]<=tm)][1], 'pelvis':[254,324], 'chest':chest,'neck':neck,'head':head,'headRadii':[73,83], 'shoulderL':shoulderL,'shoulderR':shoulderR,'elbowL':ik(shoulderL,wrist,sign=-1),'elbowR':ik(shoulderR,stable,sign=-1),'wristL':wrist,'wristR':stable,'kneeL':[224,353],'kneeR':[260,355],'ankleL':[194,445],'ankleR':[250,451],'trunkPitchDeg':pitch,'headWorldPitchDeg':pitch*.25,'expressionDepth':-12,'screenDepth':0,'expressiveArmDepth':{'shoulder':-12,'elbow':-12,'wrist':-12},'palmOrientation':'three-quarter open, thumb inward; fingers together; no palm flip','followMarker':[347,270+lp+settle],'contact':{'seat':True,'laptopOnLap':True,'rightWristBase':True,'leftWristBase':tm<=.65 or tm>=2.70},'settle':settle}
def pts(p):return ' '.join(f'{a:.2f},{b:.2f}'for a,b in p)
def path(points,color,w=3,dash=''):
 return f'<polyline points="{pts(points)}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round" '+(f'stroke-dasharray="{dash}"'if dash else '')+'/>'
def circle(p,r,c,fill='white'):return f'<circle cx="{p[0]:.2f}" cy="{p[1]:.2f}" r="{r}" fill="{fill}" stroke="{c}" stroke-width="2"/>'
def text(x,y,word,size=12,color='#405164'):return f'<text x="{x}" y="{y}" font-family="sans-serif" font-size="{size}" fill="{color}">{word}</text>'
def drawing(p,guide=True):
 L,Ri=p['shoulderL'],p['shoulderR'];head=p['head'];pel=p['pelvis'];neck=p['neck'];e=p['elbowL'];w=p['wristL'];er=p['elbowR'];wr=p['wristR'];ch=p['chest']
 parts=['<rect width="512" height="512" fill="#f6f8fb"/>',path([[75,484],[424,484]],'#c9d1db',1),'<ellipse cx="264" cy="351" rx="99" ry="17" fill="#e2e7ed"/>',path([[185,354],[184,460]],'#9aa6b3',9),path([[335,351],[352,455]],'#9aa6b3',9),'<rect x="175" y="328" width="173" height="27" rx="12" fill="#dde3ea" stroke="#8493a1"/>']
 # Pelvis and actual support legs precede torso; same foot/seat contacts throughout.
 parts +=[path([pel,p['kneeL'],p['ankleL']],'#a6adba',27),path([pel,p['kneeR'],p['ankleR']],'#a6adba',27),'<path d="M175 435L211 438L211 474Q195 486 163 476Z M232 441L269 443L273 481Q252 492 224 483Z" fill="#8792a3" stroke="#536174" stroke-width="2"/>',f'<ellipse cx="254" cy="324" rx="49" ry="24" fill="#d1c5e8" stroke="#79678f" stroke-width="2"/>']
 # Whole torso mass recomputed from body landmarks; not a transformed raster.
 parts +=[f'<path d="M{L[0]} {L[1]} Q{neck[0]} {neck[1]-12} {Ri[0]} {Ri[1]} L296 313 Q254 342 208 314Z" fill="#dfd6ef" stroke="#79678f" stroke-width="2"/>',path([pel,ch,neck],'#79678f',2,'5 4')]
 # All expressive joints remain on the body side of the rigid screen plane.
 # The screen occludes the actual thick upper arm, forearm, cuff and palm.
 parts += ['<defs><mask id="screen-occlusion" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect width="512" height="512" fill="white"/><path d="M110 229L218 237L240 307L138 303Z" fill="black" stroke="black" stroke-width="4"/></mask></defs>']
 arm=path([L,e],'#b77549',17)+path([e,w],'#d9844b',13)
 # Wrist-aligned cuff and a readable palm mass rather than a joint dot.
 import math
 a=math.degrees(math.atan2(w[1]-e[1],w[0]-e[0]))-90
 palm=f'<g transform="translate({w[0]} {w[1]}) rotate({a})"><path d="M-8 -9 L8 -9 L7 2 L-7 2Z" fill="#e6b895" stroke="#a6643e" stroke-width="2"/><path d="M-6 0 Q-10 8 -6 14 L3 17 Q9 14 8 5 L5 -1Z" fill="#f8dbc5" stroke="#a6643e" stroke-width="2"/><path d="M-5 4 Q-15 4 -11 10 L-5 12" fill="#f8dbc5" stroke="#a6643e" stroke-width="2"/><path d="M-2 5 L2 12" stroke="#c58d69" fill="none"/></g>'
 parts += ['<g mask="url(#screen-occlusion)">'+arm+palm+'</g>',path([Ri,er,wr],'#4d9ba5',13)]
 # Constant laptop on lap. No prop redraw/scale drift.
 parts +=['<path d="M145 292L281 300L279 319L150 311Z" fill="#b5c1cf" stroke="#536174" stroke-width="2"/>','<path d="M110 229L218 237L240 307L138 303Z" fill="#dce4ed" stroke="#536174" stroke-width="3"/>',path([[138,303],[240,307]],'#536174',4),path([[160,320],[236,329],[274,322]],'#99a2b1',2,'3 3')]
 # No layer switch: the screen has already occluded the entire expressive chain.
 parts +=[circle(wr,8,'#428f9a','#cbe8e9')] # No foreground forearm override.
 parts +=[path([neck,[head[0],head[1]+72]],'#79678f',12),f'<ellipse cx="{head[0]}" cy="{head[1]}" rx="73" ry="83" fill="#eee9f7" stroke="#79678f" stroke-width="2"/>',path([[head[0],head[1]-68],[head[0]+1,head[1]+63]],'#a999bd',1,'4 4'),path([[head[0]-60,head[1]+19],[head[0]+60,head[1]+19]],'#a999bd',1,'4 4'),path([[head[0]-26,head[1]+23],[head[0]-15,head[1]+23]],'#79678f',3),path([[head[0]+15,head[1]+23],[head[0]+26,head[1]+23]],'#79678f',3)]
 if guide:
  arc=[pose(float(z))['wristL']for z in np.linspace(.65,1.70,32)];ret=[pose(float(z))['wristL']for z in np.linspace(1.90,2.70,32)]
  parts +=[path(arc,'#d9844b',1.5,'4 3'),path(ret,'#8e9f57',1.5,'2 3')]
  for k in ['pelvis','chest','shoulderL','shoulderR','elbowR']:parts.append(circle(p[k],3,'#66758a'))
  parts +=[text(293,326,'fixed support wrist',10,'#428f9a'),text(173,376,'seat / lap carry load',10),circle(p['followMarker'],4,'#aa82ba'),text(353,273,'lag',10,'#aa82ba')]
 return ''.join(parts)
def svg(p):
 # Side inset states depth/clearance intent separately from projected silhouette.
 pitch=math.radians(p['trunkPitchDeg']);hip=(730,410);should=(730+95*math.sin(pitch),410-95*math.cos(pitch));hd=(should[0]+12,should[1]-67)
 inset=path([[730,410],[785,420],[785,495]],'#8792a3',10)+path([hip,should],'#9b85b5',20)+f'<ellipse cx="{hd[0]}" cy="{hd[1]}" rx="28" ry="36" fill="#eee9f7" stroke="#79678f" stroke-width="2"/>'+path([should,[hd[0],hd[1]+34]],'#79678f',7)+path([[777,361],[792,417],[833,417]],'#536174',5)+circle([818,412],5,'#428f9a')+path([should,[790,356],[818,412]],'#428f9a',4)+path([[695,415],[760,415]],'#8493a1',8)
 inset += path([[764,352],[764,401]],'#d9844b',10)+text(683,458,'orange: body side',12)+text(795,354,'screen z=0',12)
 stamp=format(p['time'], '.2f')+' s / 4.20 s'
 return f'<svg xmlns="http://www.w3.org/2000/svg" width="960" height="660"><rect width="960" height="660" fill="#f6f8fb"/>{text(24,30,"INTERNAL MOTION LAYOUT — NOT VARIN ART / NOT A PRODUCTION RIG",18)}{text(24,55,"picture-right hand supports / picture-left hand responds · one common rest",13)}<g transform="translate(26 80)">{drawing(p)}</g>{text(576,110,p["phase"],22)}{text(576,137,stamp,16)}{text(576,175,"Orange: side-edge response / separate return arc",13)}{text(576,198,"Cyan: fixed base contact, elbow accommodates",13)}{text(576,221,"Purple: chest/head follow, not a face swap",13)}{text(576,244,"Grey: pelvis, lap and prop support",13)}<g transform="translate(130 100) scale(.8)">{inset}</g>{text(650,540,"Side depth / load diagram",14)}{text(600,564,"Orange arm stays BEHIND screen plane (z=-12).",12)}{text(600,583,"Hand emerges around lower-left edge; no plane crossing.",12)}{text(26,635,"SCHEMATIC ONLY · New mass/line drawings; no existing raster transformed. Timing is a layout proposal.",13)}</svg>'
samples=[pose(i/24) for i in range(101)]
(R/'pose-time-data.json').write_text(json.dumps({'coordinateSystem':'512 square, manually estimated from inspected rest proportions; picture-left/right not anatomical naming','reference':'production-v4/calibration-probe-20261029/shared/raw/open-common-rest-v2.png (provisional, not accepted)','durationSeconds':4.2,'fpsForGuide':24,'keyIntent':keys,'samples':samples,'limits':['explicit schematic depth ordering, not final anatomical/cloth proof','PCHIP smooths guide coordinates only, never final raster art','no production source acceptance or automatic painting claim']},indent=2))
(R/'frames').mkdir(exist_ok=True)
for i,p in enumerate(samples):(R/'frames'/f'{i:03}.svg').write_text(svg(p))
for n,tm in [('rest',0),('brace',.60),('release',.85),('approach',1.40),('peak',1.80),('return',2.14),('lower',2.40),('contact',2.70),('settle',3.05)]: (R/f'guide-{n}.svg').write_text(svg(pose(tm)))
# Self-contained browser preview uses the same precomputed SVG samples, no runtime app code.
frames=[svg(p)for p in samples]
(R/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Internal whole-body motion layout</title><style>body{margin:20px;background:#e5eaf0;font:14px sans-serif}#stage svg{width:min(960px,100%);height:auto}button{margin:8px}</style><h2>Internal animation layout only — not final Varin art</h2><button id="play">Play once</button><input id="scrub" type="range" min="0" max="100" value="0" style="width:400px"><div id="stage"></div><script>const frames='+json.dumps(frames)+';let raf=0;const stage=document.querySelector("#stage"),scrub=document.querySelector("#scrub");function draw(i){stage.innerHTML=frames[i];scrub.value=i}draw(0);scrub.oninput=()=>{cancelAnimationFrame(raf);draw(+scrub.value)};document.querySelector("#play").onclick=()=>{cancelAnimationFrame(raf);let start=performance.now();function tick(t){let i=Math.min(100,Math.floor((t-start)*24/1000));draw(i);if(i<100)raf=requestAnimationFrame(tick)}raf=requestAnimationFrame(tick)};</script>')
print('created',len(samples),'schematic samples')

# Small invariant receipt for this one schematic phrase (not a general simulator).
v={'rightWristMaxDrift':max(math.dist(p['wristR'],samples[0]['wristR'])for p in samples),'pelvisMaxDrift':max(math.dist(p['pelvis'],samples[0]['pelvis'])for p in samples),'upperArmLengthMaxError':max(abs(math.dist(p['shoulderL'],p['elbowL'])-74)for p in samples),'forearmLengthMaxError':max(abs(math.dist(p['elbowL'],p['wristL'])-66)for p in samples),'screenLocalPlaneZ':0,'allExpressiveSegmentEndpointZ':-12,'segmentScreenPlaneCrossings':0,'sameRestEnd':samples[0]['wristL']==samples[-1]['wristL'],'scope':'Schematic coordinate and explicit layer ordering only; not final anatomy/cloth or aesthetic acceptance'}
(R/'layout-validation.json').write_text(json.dumps(v,indent=2))
d=json.loads((R/'pose-time-data.json').read_text())
d['screenPlane']={'coordinateConvention':'depth relative to rigid screen plane, positive toward viewer','planeZ':0,'hingeProjected':[[138,303],[240,307]],'expressiveArmZ':-12,'occlusion':'same polygon mask for full upper arm, forearm, cuff and palm; no front redraw','route':'below lower edge then around picture-left silhouette; no crossing of plane'}
(R/'pose-time-data.json').write_text(json.dumps(d,indent=2))
