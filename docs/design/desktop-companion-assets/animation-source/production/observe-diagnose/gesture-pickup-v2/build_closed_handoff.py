from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter,ImageChops
P=Path(__file__).resolve().parent
base=Image.open(P/'stretch-000-supported.png').convert('RGBA');src=Image.open(P/'closed-handoff-source.png').convert('RGBA').resize((512,512),Image.Resampling.LANCZOS)
m=Image.new('L',(512,512));ImageDraw.Draw(m).polygon([(158,255),(218,255),(245,272),(242,298),(200,307),(161,300)],fill=255);m=m.filter(ImageFilter.GaussianBlur(.6));m=ImageChops.lighter(m,Image.open(P/'near-support-mask.png'));m.save(P/'closed-handoff-mask.png')
out=Image.composite(src,base,m);out.save(P/'closed-handoff.png');bg=Image.new('RGBA',(512,512),'#1a2836');bg.alpha_composite(out);bg.convert('RGB').save(P/'closed-handoff-dark.jpg')
