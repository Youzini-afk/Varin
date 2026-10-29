from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json,hashlib,subprocess
O=Path(__file__).parent; m=json.load(open(O/'showcase-timeline.json'));fs=m['frames']; font=lambda n:ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',n)
targets=[(1,'rest.closed-stretch-v1-boundary-v1',8),(2,'continuous.editing-v1',3),(3,'question-ask-enter-v1',5),(4,'permission-ask-enter-v1',8),(5,'relocation.node.hug',0),(6,'relocation.node.detachClosed',0)]
over=Image.new('RGB',(1500,1040),'#eff3f7');d=ImageDraw.Draw(over);d.text((40,22),'Varin · 动画资产与交互状态展示',font=font(34),fill='#243b4b');d.text((42,72),'日常表演与代表性交互路径 / 素材编排，非桌面录屏',font=font(21),fill='#627787')
for j,(ch,p,fi) in enumerate(targets):
 ix=next(i for i,f in enumerate(fs) if f['chapter']==ch and f['package']==p and f['frameIndex']==fi);shot=Image.open(O/'render'/f'{ix:05}.png');x=30+j%3*495;y=120+j//3*445;panel=shot.crop((640,105,1275,650)).resize((420,360),Image.Resampling.LANCZOS);over.paste(panel,(x+30,y));d.text((x+20,y+355),f'{ch:02d}  {m["chapters"][str(ch)][0]}',font=font(26),fill='#243b4b');d.text((x+20,y+393),m['chapters'][str(ch)][1],font=font(17),fill='#627787')
over.save(O/'varin-animation-overview.jpg',quality=93)
probe=json.loads(subprocess.check_output(['ffprobe','-v','quiet','-show_format','-show_streams','-of','json',str(O/'varin-animation-showcase.mp4')]))
info={'durationSeconds':float(probe['format']['duration']),'width':probe['streams'][0]['width'],'height':probe['streams'][0]['height'],'bundleSha256':m['bundleSha256'],'repoCommit':'db598369','render':'variable frame rate, source exposure durations, no interpolation','files':{}}
for n in ['varin-animation-showcase.mp4','varin-animation-overview.jpg']:
 b=(O/n).read_bytes();info['files'][n]={'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
(O/'delivery-verification.json').write_text(json.dumps(info,indent=2)+'\n')
(O/'README.md').write_text('''# Varin 动画资产与交互状态展示

成片：`varin-animation-showcase.mp4`；总览：`varin-animation-overview.jpg`。

来源为仓库 db598369 的当前 accepted bundle。原图由 atlas 按 rect/offset 还原到512画布，成片1280×720；无新增原画、骨骼变形、整人交叉淡化或生成补帧。视频使用可变帧率与毫秒时间基准，保留普通动作原始曝光/停留时长。无配音或音乐。

六章覆盖闭盖陪伴/眨眼/欢迎/轻触/休息；真实开盖→连续输入→浏览；观察/提问/未回答等待；权限请求/未决/完成；握稳/提起/搬移/落座；早放/落下中再抓/取消/恢复/闭盖。

160秒待机选取首轮完整11.665秒，片尾取首轮前3.895秒至中性停留端；没有加速长等待。所有章节切换是展示剪辑，不冒充一条未经剪辑的运行会话。搬移章节沿现有真实节点编排，人物整体位置与凳层显隐是说明性布局，不是操作系统录屏；悬空保持适当延长供观看。所有修改时长均在 showcase-timeline.json 中逐帧列出，普通表演保持原值。闭/开盖之间使用真实开盖素材，提起与落地采用已登记支撑链。

本片展示已接受表演资源与代表性状态路径，不证明所有平台/所有134入口均在该视频中实跑，也不代表实际执行授权、任务完成等业务动作。真正运行联动验收应看独立 native 验收证据。

复现：在本目录运行 `python build_showcase.py` 后运行 `python finish_delivery.py`。需要 Pillow、ffmpeg 和 Noto Sans CJK。逐帧来源、时长、位置、原图SHA见 showcase-timeline.json；最终文件哈希见 delivery-verification.json。
''')
print(json.dumps(info,indent=2))
