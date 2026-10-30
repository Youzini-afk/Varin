from pathlib import Path
from PIL import Image
import numpy as np,json,hashlib
root=Path(__file__).parent;gaze=root.parent/'observe-diagnose/canonical-gaze-v1';eye=Image.open(gaze/'read-screen.png').convert('RGBA')
for stem in ['typing','scroll','key-tap']:
 src=root/f'canonical-{stem}-v1';dst=root/f'canonical-{stem}-v2';dst.mkdir(exist_ok=True);j=json.load(open(src/'sequence.source.json'));j['id']=f'seated-work.canonical-{stem}-v2';j['entryPose']=j['exitPose']='seated-open-screen-keyboard';j['gaze']='screen';j['sourceReuse']={'handMotion':f'../canonical-{stem}-v1','eyes':'../../observe-diagnose/canonical-gaze-v1/read-screen.png','method':'Latest shared-alpha read-screen full-frame baseline; copy only already-baked hand-context pixels from earlier actual drawing sequence, not stale outer alpha edges.'};reports=[]
 handmask=Image.open((src if stem!='key-tap' else root/'canonical-typing-v1')/'hand-context-mask.png').convert('L');binary=handmask.point(lambda v:255 if v else 0)
 for idx,f in enumerate(j['frames']):
  old=Image.open(src/f['source']).convert('RGBA');out=eye.copy() if idx in (0,len(j['frames'])-1) else Image.composite(old,eye,binary);out.save(dst/f['source']);a=np.array(out);b=np.array(eye);m=np.array(handmask);n=int(np.any(a[m==0]!=b[m==0],axis=1).sum());assert n==0;reports.append({'frame':f['source'],'outsideHandMaskVsReadScreenChangedPixels':n})
 j['reviewStatus']='needs-normal-speed-review-with-screen-gaze';json.dump(j,open(dst/'sequence.source.json','w'),indent=2)
 first=np.array(Image.open(dst/j['frames'][0]['source']));last=np.array(Image.open(dst/j['frames'][-1]['source']));ref=np.array(eye);assert np.array_equal(first,ref) and np.array_equal(last,ref);json.dump({'stage':'motion-candidate','firstMatchesReadScreenPixels':True,'lastMatchesReadScreenPixels':True,'frames':reports,'eyeSourceSha256':hashlib.sha256((gaze/'read-screen.png').read_bytes()).hexdigest(),'handMaskSource':str((src if stem!='key-tap' else root/'canonical-typing-v1')/'hand-context-mask.png')},open(dst/'qa.json','w'),indent=2)
print('Three current-alpha screen-gaze variants: asserted exact first/last read-screen and zero differences outside hand mask.')
