"""Derive one common alpha matte from the fixed white-backed drawing, without geometry edits."""
from pathlib import Path
import hashlib,json
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

root=Path(__file__).parent
source=root/'seated-open-canonical-v1.png'
rgb=np.asarray(Image.open(source).convert('RGB')).astype(float)
assert hashlib.sha256(source.read_bytes()).hexdigest()=='390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b', 'Re-review enclosed holes if source changes'
white=(rgb.min(2)>=248)&((rgb.max(2)-rgb.min(2))<=12)
labels,_=ndi.label(white,structure=np.ones((3,3)))
border=np.unique(np.r_[labels[0],labels[-1],labels[:,0],labels[:,-1]])
background=np.isin(labels,border[border!=0])
# Visually checked empty hair loops in this exact drawing. Do not remove white clothing,
# eyes or hair highlights merely because they are white.
reviewed_holes=[19,43,97,108,111,121,140,143,159,162,169,175]
background |= np.isin(labels,reviewed_holes)
foreground=~background
distance=ndi.distance_transform_edt(foreground)
core=distance>2
_,nearest=ndi.distance_transform_edt(~core,return_indices=True)
reference=rgb[nearest[0],nearest[1]]
alpha=foreground.astype(float)
edge=(distance>0)&(distance<=1.5)
denom=((255-reference)**2).sum(2)
estimate=np.divide(((255-rgb)*(255-reference)).sum(2),denom,out=np.ones_like(denom),where=denom>25)
alpha[edge]=np.clip(estimate[edge],0,1)
unmatted=rgb.copy()
soft=edge&(alpha>0)&(alpha<1)
unmatted[soft]=np.clip((rgb[soft]-255*(1-alpha[soft,None]))/alpha[soft,None],0,255)
rgba=np.dstack([np.round(unmatted).astype('uint8'),np.round(alpha*255).astype('uint8')])
result=Image.fromarray(rgba)
output=root/'seated-open-canonical-alpha-v1.png'
result.save(output)
Image.fromarray(np.round(alpha*255).astype('uint8')).save(root/'seated-open-canonical-alpha-mask-v1.png')
qa=Image.new('RGB',(1536,512))
for i,color in enumerate([(255,255,255),(25,29,36),(128,128,128)]):
    bg=Image.new('RGBA',result.size,(*color,255));bg.alpha_composite(result);qa.paste(bg.convert('RGB'),(i*512,0))
qa.save(root/'canonical-alpha-qa.png')
report={'source':source.name,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),
        'output':output.name,'outputSha256':hashlib.sha256(output.read_bytes()).hexdigest(),
        'geometry':'unchanged 512x512; no scale, warp or reposition',
        'method':'border-connected near-white matte, one-pixel boundary white unmatting; internal source colors unchanged',
        'backgroundPixels':int(background.sum()),'unmattedBoundaryPixels':int(soft.sum()),
        'visuallyReviewedEnclosedBackgroundComponents':reviewed_holes,
        'interiorRgbChanges':int(np.any(rgba[:,:,:3][distance>2]!=rgb[distance>2],axis=1).sum()),
        'status':'shared alpha visually reviewed on white, dark and gray backgrounds; geometric canonical unchanged; not motion approval'}
(root/'alpha-provenance.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
