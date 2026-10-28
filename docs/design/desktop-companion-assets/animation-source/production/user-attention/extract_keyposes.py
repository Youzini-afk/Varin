from PIL import Image
import numpy as np, json
from scipy import ndimage
from pathlib import Path
root=Path(__file__).parent
for name in ['completion-open-cycle-v1','query-nod-open-cycle-v2','permission-open-cycle-v2','welcome-closed-cycle-v2','click-open-cycle-v1','click-closed-cycle-v1']:
 im=Image.open(root/'sources'/f'{name}.png').convert('RGB'); w,h=im.size
 out=root/'frames'/name;out.mkdir(exist_ok=True,parents=True)
 frames=[]
 for i in range(6):
  box=(round((i%3)*w/3),round((i//3)*h/2),round((i%3+1)*w/3),round((i//3+1)*h/2))
  a=np.array(im.crop(box));
  if name=='click-closed-cycle-v1':
   a[:10]=255;a[-10:]=255;a[:,:10]=255;a[:,-10:]=255
  white=(a.min(2)>238)&((a.max(2)-a.min(2))<14)
  lab,n=ndimage.label(white,structure=np.ones((3,3)))
  edge=np.unique(np.r_[lab[0],lab[-1],lab[:,0],lab[:,-1]]);edge=edge[edge!=0]
  bg=np.isin(lab,edge);alpha=np.where(bg,0,255).astype('uint8')
  # Only border-connected nearwhite background removed; no globalwhite deletion.
  rgba=Image.fromarray(np.dstack([a,alpha]));dest=out/f'pose-{i+1:03}.png';rgba.save(dest)
  frames.append({'source':dest.name,'durationMs':[240,120,160,240,140,240][i], 'offset':[0,0], 'sourceSheetCell':i+1})
 data={'id':name,'family':'USER_ATTENTION','stage':'keyposes','canvas':[round(w/3),round(h/2)],'loop':False,'frames':frames,'warning':'KEYPOSE REVIEW ONLY. Not smooth final animation. Per-cell camera/prop registration and cleanup pending.'}
 (out/'sequence.json').write_text(json.dumps(data,indent=2))
 print(out)
