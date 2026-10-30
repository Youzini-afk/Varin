from PIL import Image,ImageDraw,ImageFont
from pathlib import Path
import json,subprocess,hashlib
O=Path(__file__).parent
font=lambda n:ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',n)
im=Image.new('RGB',(1500,1040),'#eff3f7');d=ImageDraw.Draw(im)
d.text((40,22),'Varin · 六类工作与等待状态',font=font(30),fill='#274353')
d.text((42,72),'状态与交互演示 · 非桌面录屏 · 任务、答复与授权均为模拟',font=font(18),fill='#708390')
for i,(sec,title,note) in enumerate([(12,'阅读','翻页 · 扫读'),(24,'写作与编辑','输入 · 停顿 · 修订'),(35,'检索与浏览','左右查看 · 聚焦选取'),(46,'协作调度','分派两路 · 观察等待'),(60,'等待回答','保持询问 · 等待明确答复'),(76,'等待授权','请求未决 · 不自行允许')]):
 x=25+i%3*495;y=120+i//3*435
 panel=Image.open(O/f'frame-{sec}.jpg').crop((290,170,990,585)).resize((475,282),Image.Resampling.LANCZOS)
 im.paste(panel,(x,y+20));d.text((x+24,y+320),title,font=font(26),fill='#274353');d.text((x+24,y+363),note,font=font(18),fill='#607989')
im.save(O/'varin-upright-overview.jpg',quality=94)
p=O/'varin-upright-showcase.mp4';probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(p)]));subprocess.run(['ffmpeg','-v','error','-threads','1','-i',str(p),'-f','null','-'],check=True)
j=json.loads((O/'showcase-timeline.json').read_text());frames=j['frames'];report={'video':{'file':p.name,'sizeBytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'durationSeconds':probe['format']['duration'],'width':probe['streams'][0]['width'],'height':probe['streams'][0]['height'],'frameRate':probe['streams'][0]['r_frame_rate'],'frames':probe['streams'][0]['nb_frames'],'fullDecodeExitCode':0},'bundleSha256':j['sourceBundleSha256'],'uniqueSourceDrawings':len(set(f['sourceSha256'] for f in frames)),'coveredPackages':len(j['coveredPackages']),'cues':sorted(set(f['cue'] for f in frames)),'scenes':sorted(set(f['scene'] for f in frames if f['scene'])),'containsSyntheticCharacterFrames':False,'displaySampling':'24 fps, authored exposures through production CompanionPlayback; no whole-character crossfade or frame interpolation','worldEvents':[f for i,f in enumerate(frames) if f['world'] and (i==0 or f['world']!=frames[i-1]['world'])]}
(O/'delivery-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report['video'],indent=2))
