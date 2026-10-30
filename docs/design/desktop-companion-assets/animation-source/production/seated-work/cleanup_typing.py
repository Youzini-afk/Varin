from PIL import Image
import numpy as np,json
from pathlib import Path
p=Path(__file__).parent/'typing';report=[]
for i in range(1,7):
 f=p/f'frame-{i:03}.png';a=np.array(Image.open(f));rgb=a[:,:,:3].astype(int);y,x=np.indices(a.shape[:2]);mask=(x>=350)&(x<=395)&(y>=456)&(y<=477)&(rgb.min(2)>165)&((rgb.max(2)-rgb.min(2))<43)&(a[:,:,3]>0);count=int(mask.sum());a[mask,3]=0;Image.fromarray(a).save(f);report.append({'frame':i,'removedSpuriousWhiteHemPixels':count})
json.dump(report,open(p/'cleanup.json','w'),indent=2)
f=p/'sequence.source.json';j=json.load(open(f));j.update(stage='keyposes',reviewStatus='needs-temporal-review',warning='Six generated source cels, integer support registration; contact coordinates estimated. Not an accepted seamless loop. Hand press/release and fixed-prop drift need normal-speed inspection.');json.dump(j,open(f,'w'),indent=2)
