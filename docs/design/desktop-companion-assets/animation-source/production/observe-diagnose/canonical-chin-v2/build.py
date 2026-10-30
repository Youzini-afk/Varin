from pathlib import Path
from PIL import Image
import json
P=Path(__file__).resolve().parent
old=P/'../canonical-chin-v1';gaze=Image.open(P/'../canonical-gaze-v1/read-screen.png');mask=Image.open(P/'../canonical-gaze-v1/eyes-mask.png')
for i in range(6):
 src=Image.open(old/f'pose-{i:03}.png');Image.composite(gaze,src,mask).save(P/f'pose-{i:03}.png')
gaze.save(P/'pose-000.png')
for n in ['hold-half','hold-closed']:Image.open(old/f'{n}.png').save(P/f'{n}.png')
spec=json.loads((old/'sequence.source.json').read_text());spec['id']='observe.chin-enter-hold-release-v2';spec['entryPose']=spec['exitPose']='seated-open-read-screen';spec['warning']='Corrected actual eye gaze to screen. Same hand construction, normal-speed and body settle quality still unreviewed.'
for f in spec['frames']:
 if f['pose']=='seated-open-gaze-screen':f['pose']='seated-open-read-screen';f['exitTo']=['seated-open-read-screen']
(P/'sequence.source.json').write_text(json.dumps(spec,indent=2))
(P/'provenance.json').write_text(json.dumps({'derivedFrom':['../canonical-chin-v1','../canonical-gaze-v1'],'change':'Real eyes-only pixel replacement shifts irises toward laptop, not metadata-only rename.'},indent=2))
