from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json,hashlib,html
R=Path(__file__).resolve().parent;W=R
font='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
F=lambda n:ImageFont.truetype(font,n)
paths={
'neutral':'varin-animation-production-v2/shared/upright-open-neutral-v2.png',
'listen':'varin-animation-production-v2/question-permission/poses/listen-rest.png',
'arrival':'varin-animation-production-v3/task-reactions/poses/arrival-chest.png',
'thought':'varin-animation-production-v3/task-reactions/poses/thought-chin.png',
'explain':'varin-animation-production-v3/task-reactions/poses/explain-content.png',
'locate':'varin-animation-production-v3/task-reactions/poses/error-locate.png',
'offer':'varin-animation-production-v2/question-permission/poses/offer.png',
'offer-mid':'varin-animation-production-v2/question-permission/poses/offer-mid.png',
'dispatch':'varin-animation-production-v2/editing-dispatch/frames/dispatch-a-gaze.png',
'yaw':'varin-animation-production-v2/reading-search/search-right-v1-candidate.png',
'read':'varin-animation-production-v2/shared/open-screen-read-v2.png',
'closed':'varin-animation-production-v2/lid/frames/closed-rest-rigid-v2.png',
'yawn':'varin-animation-production-v3/companionship/frames/yawn-cover-v1.png',
'doze':'varin-animation-production-v3/companionship/frames/doze-v1.png',
'wake':'varin-animation-production-v3/companionship/frames/wake-alert-v1.png',
'hover':'varin-animation-production-v3/companionship/frames/hover-attend-v1.png'}
paths={k:'references/'+k+'.png' for k in paths}
# Workspace portability: paths resolved relative to production-v3's parent, never private absolutes.
for k,v in paths.items():
 if not (W/v).exists():
  if k=='yaw':paths[k]='varin-animation-production-v2/reading-search/poses/search-right-v1-candidate.png'
assets=[]
for k,v in paths.items():
 p=W/v
 assets.append({'id':k,'path':v,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'reuse':'R0 same meaning' if k in ['closed','yawn','doze','wake','hover'] else 'R1 same pixels, new staging','status':'existing artwork; not proof of director runtime acceptance','direction': 'points into laptop, not side captain' if k in ['explain','locate'] else 'keep actual source orientation'})
(R/'reuse-audit.json').write_text(json.dumps({'canvas':[512,512],'newCharacterImagesGenerated':0,'sources':assets,'missing':['D-LISTEN-TURN','D-LISTEN-LEAN','D-GATHER-OUT','D-GATHER-IN','D-GATHER-TURN-USER'],'conditionalOnly':['comfortable shoulder settle if actual neutral/listen timing fails','true bridging drawing if gather-to-offer anatomy does not connect']},ensure_ascii=False,indent=2)+'\n')
rows=[('01 收到 → 交接 → 回观察',[('arrival','收到，不是已经理解','胸前回应 360ms','新项目 A'),('dispatch','单向开放掌心','只对已知负责人 400ms','A 负责人'),('neutral','手回支撑位','接待完整真回收','A 正在推进'),('listen','她退回总览','项目继续，她不无限输入','A / B / C')]),
('02 把注意给负责人',[('yaw','现有朝向可作注意引子','真实 yaw；不是新倾听姿态','A 状态'),(None,'缺新原画：LISTEN-TURN','手停、肩朝负责人打开','120–180ms'),(None,'缺新原画：LISTEN-LEAN','胸肩前移；直颈同向 yaw','500–900ms'),('listen','听完，回稳定监督','按新 TURN 真回收','A 身份不消失')]),
('03 汇拢多个事项 → 请用户决定',[(None,'缺新原画：GATHER-OUT','单手向虚拟台打开','B 授权 / C 问题'),(None,'缺新原画：IN → TURN-USER','真实内收，再转向用户（2 源）','卡不粘在掌上'),('offer','现低位呈交可复用','一次 400–650ms 后真收手','B / C 各自独立'),('listen','B 处理后，C 仍在','不演全局点头或全部完成','C 等待回答')]),
('04 A 的结果到达，B 仍工作',[('thought','先理清已知情况','托腮短停，不永久思考','A / B'),('explain','现指向只落在笔电','结果摘要须停屏幕内','A 本轮结果'),('offer','转向用户，有限呈现','不是持实体报告','A 已知结局'),('neutral','回到组合跟进','不让全台收场','B 仍推进')]),
('05 安静共处 → 新输入醒来',[('closed','组合明确静默后才休息','精确机械闭盖支撑','本地共处'),('yawn','罕见小哈欠，真回手','另一手持续支撑电脑','不循环打哈欠'),('doze','真实困意稳态','仅本地长 idle 合资格','不是系统睡眠'),('wake','被叫回注意','真醒来 / 回手 / 机械开盖','新事项立即显示')])]
CW=400;RH=390;im=Image.new('RGB',(1600,2060),'#edf1f5');d=ImageDraw.Draw(im);d.text((24,15),'Varin 主管表演分镜 · 复用原画 / 明确缺口',font=F(29),fill='#263c56');d.text((24,57),'内部设计板；现有 PNG 原样嵌入。空白格不是已完成角色。方向/时长为编排候选，不是运行验收。',font=F(18),fill='#526780')
for ri,(title,cells) in enumerate(rows):
 y0=105+ri*RH;d.text((20,y0),title,font=F(23),fill='#263c56')
 for ci,(asset,title,sub,card) in enumerate(cells):
  x=ci*CW;y=y0+40;d.rounded_rectangle((x+8,y,x+392,y+338),radius=13,fill='#fffdf9',outline='#b3c1ce',width=2)
  if asset:
   a=Image.open(W/paths[asset]).convert('RGBA');a=a.resize((238,238),Image.Resampling.LANCZOS);im.paste(a,(x+10,y+15),a)
   d.rounded_rectangle((x+248,y+103,x+380,y+169),radius=8,fill='#e4edf4',outline='#6b88a5',width=2)
   # Titles are scene plan annotations, not generated business data.
   for n,part in enumerate([card[i:i+8] for i in range(0,len(card),8)]):d.text((x+257,y+111+n*22),part,font=F(15),fill='#344d69')
   d.text((x+252,y+185),'说明标签，非实际卡锚',font=F(10),fill='#788a9c')
  else:
   d.rounded_rectangle((x+28,y+27,x+370,y+238),radius=8,outline='#b99d72',width=3)
   d.text((x+70,y+70),'尚未绘制人物姿态',font=F(23),fill='#8a6d42');d.text((x+60,y+113),'保留身份与机械支撑',font=F(20),fill='#8a6d42');d.text((x+60,y+155),card,font=F(18),fill='#8a6d42')
  d.text((x+18,y+253),title,font=F(18),fill='#263c56');d.text((x+18,y+286),sub,font=F(15),fill='#526780')
im.save(R/'director-performance-board.jpg',quality=94)
(R/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Varin director performance study</title><style>body{background:#edf1f5;color:#263c56;font:18px sans-serif;margin:24px}img{max-width:100%;height:auto}a{color:#506f96}</style><h1>Varin 主管表演 / 内部编排样板</h1><p>完整演员与 E/H/X 设计见仓库 desktop-companion-director-performance.md。此板不是动画成品；缺图明确留空，不用旧角色替新动作冒充完成。</p><img src="director-performance-board.jpg"><p><a href="reuse-audit.json">实际来源 / SHA / 复用等级</a></p>')
print('board and 16-source audit created')
