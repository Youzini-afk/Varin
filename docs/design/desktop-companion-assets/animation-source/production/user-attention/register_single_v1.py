from pathlib import Path
from PIL import Image,ImageDraw,ImageFilter
import numpy as np,json
r=Path(__file__).parent
base=Image.open(r/'sources/click-open-single-master-v1.png').convert('RGB')
gen=Image.open(r/'sources/attention-lift-single-01-v1.png').convert('RGB')
# Match declared square viewport, NOT per-frame subject bounding box. No changing proportions.
gen=gen.resize(base.size,Image.Resampling.LANCZOS)
# Full upper head/collar cel; fixed held source below/around, no skeleton or transformed fragments.
mask=Image.new('L',base.size,0)
ImageDraw.Draw(mask).polygon([(116,0),(405,0),(430,103),(420,176),(386,221),(344,246),(250,250),(206,227),(124,205),(104,128)],fill=255)
mask=mask.filter(ImageFilter.GaussianBlur(1.0))
merged=Image.composite(gen,base,mask)
out=r/'registered/attention-lift-v1'
base.save(out/'pose-000.png');merged.save(out/'pose-001.png');mask.save(out/'edit-region-mask.png');gen.save(out/'generated-viewport.png')
proof=Image.new('RGB',(1024,512),'white');proof.paste(base,(0,0));proof.paste(merged,(512,0));proof.save(out/'pair-review.png')
a=np.array(base);b=np.array(merged);m=np.array(mask)
assert np.array_equal(a[m==0],b[m==0])
report={'status':'single-authored-inbetween-candidate-not-smooth-cycle','viewport':[512,512],'generatedSourceSize':[1254,1254],'normalization':'fixed full viewport resize only, not subject normalization','protectedPixelsExact':int((m==0).sum()),'updatedRegion':'whole upper head and collar, 1px edge feather for compositing only','noAnimationInterpolation':True,'occlusionWarning':'reject if edit-region boundary cuts changing hair/cloth; inspect pair before using'}
(out/'provenance.json').write_text(json.dumps(report,indent=2))
print(report)
