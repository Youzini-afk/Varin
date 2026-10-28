// Local eyelid occlusion trial. Head geometry is never scaled. Independent artistic QA required.
export function drawBlink(ctx,face,amount){if(amount<=0)return;const b=Math.max(0,Math.min(1,amount));for(const side of ['L','R']){const data=face.meta['eye'+side],bounds=face.meta.sourcePixelBounds['eye'+side],curve=data.upperLidPolyline,travel=data.upperLidTravel[1];
 ctx.save();ctx.beginPath();ctx.rect(bounds[0],bounds[1],bounds[2]-bounds[0],bounds[3]-bounds[1]);ctx.clip();
 // Replace only original eye feature pixels with registered hidden-skin patch.
 ctx.drawImage(face.skin,0,0);
 if(b<.999){ctx.save();ctx.beginPath();ctx.moveTo(bounds[0],bounds[3]);ctx.lineTo(bounds[2],bounds[3]);for(let i=curve.length-1;i>=0;i--)ctx.lineTo(curve[i][0],curve[i][1]+travel*b);ctx.closePath();ctx.clip();ctx.drawImage(face['eye'+side],0,0);ctx.restore();}
 ctx.restore();ctx.save();ctx.translate(0,travel*b);ctx.drawImage(face['lid'+side],0,0);ctx.restore();}}
