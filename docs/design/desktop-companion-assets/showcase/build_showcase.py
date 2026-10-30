from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json,hashlib,subprocess,math
from functools import lru_cache
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'packages/web/public/companion-assets/bundle.json').exists()); OUT=Path(__file__).parent; A=ROOT/'packages/web/public/companion-assets'; bundle=json.loads((A/'bundle.json').read_text()); P=bundle['packages']; by={p['id']:p for p in P}
FONT='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
@lru_cache(None)
def font(n):return ImageFont.truetype(FONT,n)
cache={};frames=[];timeline=[];chaptershots={}
def art(p,f):
 key=(p['pages'][f['page']]['file'],tuple(f['rect']),tuple(f['offset']))
 if key not in cache:
  page=Image.open(A/key[0]).convert('RGBA');x,y,w,h=f['rect']; im=Image.new('RGBA',(512,512));im.alpha_composite(page.crop((x,y,x+w,y+h)),tuple(f['offset']));cache[key]=im
 return cache[key]
chapters={
1:('日常陪伴','闭盖待命 · 眨眼 · 放松休息',['保留原始停留与动作节奏','长待机选取完整首轮，不加速','欢迎与轻触属于独立事件']),
2:('进入工作','开盖 · 输入 · 浏览 · 收起',['使用 accepted 连续工作时间轴','手指、视线与停顿按原始曝光','此处展示表演资产，不模拟任务执行']),
3:('注意与等待','观察 · 提问 · 等待回答',['进入、维持与退出分开展示','等待不是替用户作出回答','事件之间以章节剪辑组织']),
4:('权限与完成','请求授权 · 未决维持 · 完成反馈',['掌心请求 → 保持 → 收手','授权决策仍由实际业务事件触发','完成动作展示，不代表执行了任务']),
5:('搬移与落座','握稳电脑 · 离座 · 搬移 · 坐下',['交互路径示意：不是 native 录屏','原画与节点时长取自当前 bundle','位置与凳透明度为展示编排']),
6:('中断与恢复','早放 · 再抓 · 取消 · 回到陪伴',['展示真实节点的代表性接线','当前姿态支撑衔接，不切成站姿','不代表穷尽所有运行分支'])}
def emit(p,f,ch,label,dur=None,pos=(680,145),stool=None,note='原始表演时间轴'):
 im=Image.new('RGBA',(1280,720),'#eff3f7');d=ImageDraw.Draw(im);d.rectangle((0,0,1280,8),fill='#7d9daa');d.text((54,36),'VARIN  /  动画资产与交互状态展示',font=font(25),fill='#243b4b');d.text((55,110),f'{ch:02d}',font=font(64),fill='#a6bac4');title,sub,lines=chapters[ch];d.text((55,206),title,font=font(42),fill='#233e50');d.text((57,273),sub,font=font(22),fill='#506b7d')
 for j,s in enumerate(lines):d.text((57,346+j*37),s,font=font(19),fill='#627787')
 d.rounded_rectangle((51,495,598,581),16,fill='#dfe8ee');d.text((69,506),label,font=font(22),fill='#23465a');d.text((69,544),note,font=font(16),fill='#667f8c');d.line((55,650,1225,650),fill='#cedbe3',width=1);d.text((55,670),'当前 accepted 资产编排  ·  非桌面录屏  ·  无新增原画 / 无补帧',font=font(17),fill='#718897')
 if stool:
  sim=Image.open(A/'stool.png').convert('RGBA');sim.putalpha(sim.getchannel('A').point(lambda v:int(v*stool[2])));im.alpha_composite(sim,(int(stool[0]),int(stool[1])))
 im.alpha_composite(art(p,f),(round(pos[0]),round(pos[1])));fn=OUT/'render'/f'{len(frames):05}.png';fn.parent.mkdir(exist_ok=True);im.convert('RGB').save(fn);duration=f['durationMs'] if dur is None else dur;frames.append((fn,duration));timeline.append({'chapter':ch,'label':label,'package':p['id'],'frameIndex':p['frames'].index(f),'sourceSha256':f.get('sha256'),'durationMs':duration,'originalDurationMs':f['durationMs'],'position':pos,'worldStool':stool});chaptershots.setdefault(ch,im.copy())
def pkg(idx,ch,label,limit=None):
 p=P[idx]
 for f in p['frames']:
  if limit is not None and f['startMs']>=limit:break
  emit(p,f,ch,label)
def node(name,ch,label,dur=None,pos=(680,145),stool=None):
 p=by['relocation.node.'+name];emit(p,p['frames'][0],ch,label,dur,pos,stool,'真实节点素材 · 展示用路径编排')
pkg(32,1,'欢迎');pkg(7,1,'闭盖安静陪伴',11665);pkg(33,1,'轻触回应');pkg(8,1,'揉眼休息');pkg(9,1,'舒展一下')
pkg(10,2,'打开电脑');pkg(2,2,'视线转向屏幕');pkg(0,2,'连续输入与停顿');pkg(1,2,'浏览与阅读');pkg(3,2,'重新看向你')
pkg(4,3,'进入观察');pkg(5,3,'观察中的轻微变化');pkg(6,3,'退出观察');pkg(14,3,'有问题想确认');pkg(17,3,'等待回答');pkg(15,3,'收回托腮动作');pkg(20,3,'理解回答')
pkg(12,4,'请求权限');pkg(16,4,'未决：保持请求');pkg(13,4,'请求动作收回');pkg(21,4,'完成反馈')
# A real authored node chain with explicitly illustrative window position, not rendered OS capture.
node('seatedOpen',5,'准备搬移',800)
lift=['entryCurrent','entrySupported','detachHalf','detachMid','half','closed','turn20','turn','turn70','hug']
for i,n in enumerate(lift):node(n,5,'提起：先握稳，再离座',pos=(680-i*5,145-i*2),stool=(680,145,max(0,1-i/3)))
for i in range(38):
 t=i/37;node('hug',5,'搬移中：电脑保持抱稳',dur=40,pos=(635+110*t,127-35*math.sin(math.pi*t)))
for n in ['hugPrecontact','hugContact','seatedHug','seatedTurn','seatedGrip','contact','release','settle','seated']:
 node(n,5,'放下：凳先出现，再接触落座',pos=(745,145),stool=(745,145,1) if n in ['hugPrecontact','hugContact'] else None)
node('seated',5,'落座稳定',1400,pos=(745,145))
pkg(10,6,'重新开盖，再演示中断路径')
node('seatedOpen',6,'早放：不用绕完整抱机',650)
for n in ['entryCurrent','entrySupported','detachHalf','detachClosed','contact','release','settle','seated']:node(n,6,'提起中松手 → 原支持姿态落下',stool=(680,145,1) if n=='detachClosed' else None)
node('seated',6,'稳定落座',800)
for n in ['closedHandoff','detachClosed','precontact','closed','turn20','turn','turn70','hug','hugPrecontact','hugContact','hugPrecontact','hug','hugPrecontact','hugContact','seatedHug','seatedTurn','seatedGrip','contact','release','settle','seated']:node(n,6,'落下中再次抓起 → 继续抱稳 → 落座',stool=(680,145,1) if n=='hugContact' else None)
pkg(10,6,'回到开盖工作姿态');pkg(22,6,'任务取消：独立反馈');pkg(23,6,'取消后停留');pkg(30,6,'回到中性状态');pkg(11,6,'收起电脑');pkg(7,6,'继续安静陪伴',3895)
# Overview uses representative unchanged drawings, no claim of being a native screenshot.
over=Image.new('RGB',(1500,1040),'#eff3f7');d=ImageDraw.Draw(over);d.text((40,22),'Varin · 动画资产与交互状态展示',font=font(34),fill='#243b4b');d.text((42,72),'当前 accepted 素材编排总览 / 非 native 录屏',font=font(21),fill='#627787')
for j,(ch,shot) in enumerate(chaptershots.items()):
 x=30+(j%3)*495;y=120+(j//3)*445;panel=shot.crop((640,105,1230,640)).resize((390,354),Image.Resampling.LANCZOS);over.paste(panel,(x+45,y));d.text((x+20,y+355),f'{ch:02d}  {chapters[ch][0]}',font=font(26),fill='#243b4b');d.text((x+20,y+393),chapters[ch][1],font=font(17),fill='#627787')
over.save(OUT/'varin-animation-overview.jpg',quality=93)
manifest={'title':'动画资产与交互状态展示','notNativeRecording':True,'sourceBundle':str(A/'bundle.json'),'bundleSha256':hashlib.sha256((A/'bundle.json').read_bytes()).hexdigest(),'durationMs':sum(d for _,d in frames),'chapters':chapters,'frames':timeline};(OUT/'showcase-timeline.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
lines=['ffconcat version 1.0']
for ix,(fn,dur) in enumerate(frames):
 if ix==len(frames)-1:dur-=1
 lines += [f"file '{fn.resolve()}'",'option framerate 1000',f'duration {dur/1000:.6f}']
lines += [f"file '{frames[-1][0].resolve()}'",'option framerate 1000'];(OUT/'render.ffconcat').write_text('\n'.join(lines)+'\n')
subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-safe','0','-f','concat','-i',str(OUT/'render.ffconcat'),'-fps_mode','vfr','-enc_time_base','1:1000','-c:v','libx264','-preset','medium','-crf','23','-bf','0','-pix_fmt','yuv420p','-video_track_timescale','1000','-movflags','+faststart','-t',str(manifest['durationMs']/1000),str(OUT/'varin-animation-showcase.mp4')],check=True)
print('duration',manifest['durationMs']/1000,'frames',len(frames))
