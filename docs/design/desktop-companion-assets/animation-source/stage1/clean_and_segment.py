from PIL import Image,ImageDraw
import numpy as np
from scipy import ndimage as ndi
import json
from pathlib import Path
D=Path(__file__).parent
src=np.array(Image.open(D/'canonical-seated-v2.png').convert('RGBA')); out=src.copy(); a=out[:,:,3]; rgb=out[:,:,:3].astype(float)
# Discard disconnected matte debris, preserve main painted silhouette.
lab,n=ndi.label(a>16); counts=np.bincount(lab.ravel()); keep=counts>=36; keep[0]=False; valid=keep[lab]
a[~valid]=0
inside=a>16; distance=ndi.distance_transform_edt(inside)
mx=rgb.max(2); mn=rgb.min(2); sat=(mx-mn)/np.maximum(mx,1)
# Palette-extraneous high-chroma pixels only in narrow external fringe.
chroma=(sat>.58)&(mx>150)&(distance<5)
a[chroma]=0
# Remove hard white fringe only in outer 1.5 pixels; never interior white garments.
white=(mn>225)&(distance<1.5)
a[white]=0
# Remove newly detached tiny edge noise; preserve thin connected strands.
lab,n=ndi.label(a>12); counts=np.bincount(lab.ravel()); keep=counts>=24;keep[0]=False;a[~keep[lab]]=0
out[:,:,3]=a;out[a==0,:3]=0
# Fixed 64px border, translation only, no resampling or pose change.
pad=64; clean=np.pad(out,((pad,pad),(pad,pad),(0,0)))
Image.fromarray(clean).save(D/'canonical-seated-clean-v3.png')
changed=np.any(out!=src,2); ys,xs=np.where(changed)
meta={'source':'canonical-seated-v2.png','output':'canonical-seated-clean-v3.png','size':[1382,1382],'sourceSize':[1254,1254],'translation':[64,64],'resampling':False,'changedPixels':int(changed.sum()),'changedAlphaPixels':int((out[:,:,3]!=src[:,:,3]).sum()),'interiorChangeBeyond5px':int((changed&(distance>=5)).sum()),'method':'component filtering plus narrow boundary palette-outlier and near-white matte removal','notRigReady':True}
(D/'cleanup-report.json').write_text(json.dumps(meta,indent=2))
# QA triptych only, not source manipulation.
thumb=Image.fromarray(clean); panels=[]
for color in [(0,0,0),(128,128,128),(255,255,255)]:
 bg=Image.new('RGBA',thumb.size,color+(255,));bg.alpha_composite(thumb);bg.thumbnail((600,600));panels.append(bg.convert('RGB'))
qa=Image.new('RGB',(1800,600));
for i,im in enumerate(panels):qa.paste(im,(i*600,0))
qa.save(D/'cleanup-qa-black-gray-white.jpg')
print(json.dumps(meta))
# Same-origin semantic draft extraction. Polygons authored in original 1254px coordinates.
# No independent image-generation geometry. Hidden/occluded surfaces remain pending.
layerdir=D/'layers-draft';layerdir.mkdir(exist_ok=True)
polys={
 'head':[(340,310),(358,220),(433,133),(538,80),(654,83),(754,140),(815,227),(863,257),(878,314),(850,350),(798,360),(781,408),(733,430),(698,439),(674,458),(634,468),(576,454),(512,454),(454,436),(398,407),(364,365)],
 'torso':[(575,455),(621,449),(670,429),(692,445),(735,478),(737,540),(722,592),(701,635),(681,661),(565,664),(545,637),(548,593),(540,554),(557,493)],
 'handL':[(460,650),(482,652),(503,664),(520,685),(514,695),(501,693),(489,701),(474,703),(463,697),(449,705),(436,700),(426,706),(419,695),(427,681),(440,667)],
 'handR':[(602,658),(625,658),(649,663),(671,677),(687,693),(679,704),(658,700),(647,704),(629,699),(616,703),(606,710),(594,707),(585,712),(576,706),(581,690),(571,698),(565,695),(573,678),(585,667)]
}
assets=[]
for name,poly in polys.items():
 mask=Image.new('L',(1254,1254));ImageDraw.Draw(mask).polygon(poly,fill=255); m=np.array(mask)/255
 if name.startswith('hand'):
  # Skin-key within manually constrained hand silhouettes, not global palette deletion.
  skin=(rgb[:,:,0]-rgb[:,:,1]>9)&(rgb[:,:,1]-rgb[:,:,2]>1)&(rgb[:,:,0]>130)
  skin=ndi.binary_fill_holes(ndi.binary_closing(skin,iterations=1));m*=skin
 rgba=out.copy();rgba[:,:,3]=(rgba[:,:,3]*m).astype('uint8');rgba[rgba[:,:,3]==0,:3]=0
 rgba=np.pad(rgba,((64,64),(64,64),(0,0)));Image.fromarray(rgba).save(layerdir/(name+'.png'))
 assets.append({'node':name,'path':'layers-draft/'+name+'.png','size':[1382,1382],'status':'semantic-mask-draft-not-rig-ready','hiddenSurfaceFilled':False})
# Transparent overlays allow human inspection against canonical, not re-rendered pose.
qa=Image.new('RGB',(4*460,460),(90,90,90))
for i,it in enumerate(assets):
 im=Image.open(D/it['path']);bg=Image.new('RGBA',im.size,(90,90,90,255));bg.alpha_composite(im);bg.thumbnail((460,460));qa.paste(bg.convert('RGB'),(i*460,0))
qa.save(D/'mask-draft-qa.jpg')
anchors={'neck':[738,510],'waistProjection':[682,741],'hipSeat':[665,810],'headCenter':[670,348],'shoulderL':[627,555],'elbowL':[594,681],'wristL':[569,747],'handL':[537,746],'shoulderR':[794,565],'elbowR':[849,695],'wristR':[737,751],'handR':[694,751]}
(D/'layers-draft-manifest.json').write_text(json.dumps({'status':'MASK_DRAFT_ONLY','canvas':[1382,1382],'origin':[0,0],'source':'canonical-seated-clean-v3.png','anchorsApproximatePixels':anchors,'assets':assets,'limitations':['Head seed includes facial features and front hair; not yet face base/front hair decomposition','Torso visible source only, occluded garment pending inpaint patch','Hand masks require wrist overlap extension and finger contour QA','No claim of complete 16-node rig']},indent=2))
