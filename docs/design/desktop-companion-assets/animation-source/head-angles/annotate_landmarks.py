from pathlib import Path
import json
import numpy as np
from PIL import Image,ImageDraw
D=Path(__file__).parent
# Approximate hand-inspected points on the normalized 680x600 crops.
poses={
 'canonical':{'eye_viewer_left_outer':[218,341],'eye_viewer_left_inner':[282,323],'eye_viewer_right_inner':[343,288],'eye_viewer_right_outer':[411,263],'nose':[309,346],'mouth_center':[330,370],'chin':[315,407],'ear_center':[463,279],'neck_ring_center':[388,410]},
 'up':{'eye_viewer_left_outer':[227,286],'eye_viewer_left_inner':[289,265],'eye_viewer_right_inner':[341,235],'eye_viewer_right_outer':[420,225],'nose':[310,283],'mouth_center':[332,314],'chin':[336,373],'ear_center':[473,263],'neck_ring_center':[382,392]},
 'down':{'eye_viewer_left_outer':[222,359],'eye_viewer_left_inner':[290,338],'eye_viewer_right_inner':[336,313],'eye_viewer_right_outer':[412,289],'nose':[310,363],'mouth_center':[332,386],'chin':[344,411],'ear_center':[469,290],'neck_ring_center':[388,408]}}
reports={r['pose']:r for r in json.loads((D/'registration-report.json').read_text())['registration']}
result={'status':'APPROXIMATE_VISUAL_LANDMARKS_NOT_TRACKER_GROUND_TRUTH','coordinateNote':'Input normalized crop680x600; source global offset350,100. Individual points are hand-inspected estimates with roughly5-10px uncertainty, to be refined during rigging. No measured pitch angle. Exact source crop and canonical rig pivot separately recorded.','exactCanonicalRigPivot':[738,510],'exactCropBox':[350,100,1030,700],'poses':{}}
qa=Image.new('RGB',(2040,650),(230,230,230))
for idx,(name,points) in enumerate(poses.items()):
 if name=='canonical': mat=np.array([[1,0,0],[0,1,0]]);im=Image.open(D/'head-neck-source.png').convert('RGBA')
 else: mat=np.array(reports[name]['similarityTransformAfterResize']);im=Image.open(D/f'head-pitch-{name}-registered-crop.png').convert('RGBA')
 bg=Image.new('RGBA',im.size,(230,230,230,255));bg.alpha_composite(im);draw=ImageDraw.Draw(bg)
 registered={k:(mat@np.r_[p,1]).tolist() for k,p in points.items()}
 for number,(key,(x,y)) in enumerate(registered.items(),1):
  draw.ellipse((x-3,y-3,x+3,y+3),fill=(255,50,50,255));draw.text((x+4,y-8),str(number),fill=(160,0,0,255))
 qa.paste(bg.convert('RGB'),(idx*680,25));ImageDraw.Draw(qa).text((idx*680+10,5),name+' approximate landmarks',fill=(0,0,0))
 result['poses'][name]={'normalizedCropApproximate':points,'registeredCropApproximate':registered,'registeredFullCanvasApproximate':{k:[p[0]+350,p[1]+100] for k,p in registered.items()}}
qa.save(D/'landmark-qa.jpg',quality=95)
(D/'landmarks.json').write_text(json.dumps(result,indent=2)+'\n')
