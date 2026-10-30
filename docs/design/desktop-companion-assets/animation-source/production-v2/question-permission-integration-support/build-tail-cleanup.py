from pathlib import Path
from PIL import Image,ImageDraw
import numpy as np,json,hashlib
D=Path(__file__).parent;R=D.parent;P=R/'question-permission';donor=Image.open(R/'relocation/frames/secure-no-stool-clean-donor-v1.png').convert('RGBA');hair=np.asarray(donor);records={};sheet=Image.new('RGB',(1500,360),'white');draw=ImageDraw.Draw(sheet)
# The generated poses reveal a black seat wedge outside the coat edge. Preserve
# original sleeve/fold contours; replace only the seat-facing side with adjacent
# donor silver hair. At most five source pixels of horizontal donor offset.
edge=[(374,332),(377,337),(380,343),(383,349),(386,355),(389,361),(389,365)]
for i,n in enumerate(['ask','offer','offer-mid','attend-corrected','listen-rest']):
 orig=Image.open(P/'poses'/f'{n}.png').convert('RGBA');a=np.asarray(orig).copy();m=Image.new('L',(512,512));dr=ImageDraw.Draw(m);dr.polygon(edge+[(394,365),(394,332)],fill=255)
 # Stay within requested local fix area; the extra right donor edge is already hair.
 mm=np.asarray(m).copy();mm[:,:365]=0;mm[:,390:]=0
 yy,xx=np.where(mm>0)
 # donor outer coat sits slightly right of source. Pull adjacent true silver hair
 # 5px left, so no duplicate donor coat outline is imported.
 a[yy,xx]=hair[yy,np.minimum(xx+5,511)]
 patch=Image.fromarray(a);patch.save(D/f'{n}-tail-clean-patch.png');Image.fromarray(mm).save(D/f'{n}-extra-removal.png')
 # Final local override restores actual original garment instead of donor's
 # different lower coat shape. Contains no seat after the wedge cleanup above.
 apply=Image.new('L',(512,512));ImageDraw.Draw(apply).rectangle((365,325,389,365),fill=255);apply.save(D/f'{n}-tail-patch-mask.png')
 records[n]={'source':f'../question-permission/poses/{n}.png','sourceSHA256':hashlib.sha256((P/'poses'/f'{n}.png').read_bytes()).hexdigest(),'patch':f'{n}-tail-clean-patch.png','extraRemovalMask':f'{n}-extra-removal.png','finalOverrideMask':f'{n}-tail-patch-mask.png','order':'apply common donor+foreground exclusion first, then this cleaned local patch with finalOverrideMask','donorOffsetPx':[5,0],'patchSHA256':hashlib.sha256((D/f'{n}-tail-clean-patch.png').read_bytes()).hexdigest(),'maskSHA256':hashlib.sha256((D/f'{n}-tail-patch-mask.png').read_bytes()).hexdigest()}
 view=patch.crop((330,310,405,390)).resize((300,320));sheet.paste(view,(i*300,30),view);draw.text((i*300+5,5),n,fill='black')
for state in ['half','closed']:
 records[f'listen-rest-{state}']={'aliasPatch':'listen-rest','reason':'same lower body pixels; eye-only difference'}
(D/'tail-cleanup-manifest.json').write_text(json.dumps({'pathBase':'manifest directory','status':'narrow cleanup candidate; parent/owner normal-scale visual check required','records':records,'edge':edge,'donor':'../relocation/frames/secure-no-stool-clean-donor-v1.png','donorSHA256':hashlib.sha256((R/'relocation/frames/secure-no-stool-clean-donor-v1.png').read_bytes()).hexdigest(),'note':'Preserve genuine sleeve fold line at x371–372 above the seat wedge. Do not erase that anatomy line merely because it is dark. No frozen source changed.'},indent=2)+'\n');sheet.save(D/'tail-cleanup-review.png')
