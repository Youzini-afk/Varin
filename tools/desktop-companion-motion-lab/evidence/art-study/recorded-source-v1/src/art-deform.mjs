import {smooth} from './motion.mjs';
// Restricted shared-surface deformation. Not independent cutout joints or hidden-face reconstruction.
// All coordinates measured in the unchanged 1382² canonical canvas.
export function artVertex(x,y,pose){const neck={x:738,y:510};const angle=(pose.head+.035)*.14;
 const weight=1-smooth((y-490)/130),dx=x-neck.x,dy=y-neck.y;
 let ox=(dx*Math.cos(angle)-dy*Math.sin(angle)-dx)*weight;
 let oy=(dx*Math.sin(angle)+dy*Math.cos(angle)-dy)*weight;
 const chest=smooth((y-500)/65)*(1-smooth((y-650)/70))*Math.exp(-(((x-705)/130)**4));
 oy+=pose.breath*.8*chest;
 // Long side hair only. Roots/tips and all hand-contact neighborhoods remain pinned.
 const hairSide=smooth((Math.abs(x-705)-150)/120),hairLength=smooth((y-550)/170)*(1-smooth((y-1000)/180));
 ox+=2.8*Math.sin(pose.time*1.7-.7)*hairSide*hairLength;
 return {x:x+ox,y:y+oy};
}
export function drawDeformed(ctx,image,pose,step=64,region=null,vertex=artVertex){const w=image.width,h=image.height;
 const triangle=(src,dst)=>{const [a,b,c]=src,[A,B,C]=dst;const det=(b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y);const a11=((B.x-A.x)*(c.y-a.y)-(C.x-A.x)*(b.y-a.y))/det,a12=((C.x-A.x)*(b.x-a.x)-(B.x-A.x)*(c.x-a.x))/det,a21=((B.y-A.y)*(c.y-a.y)-(C.y-A.y)*(b.y-a.y))/det,a22=((C.y-A.y)*(b.x-a.x)-(B.y-A.y)*(c.x-a.x))/det;
 ctx.save();ctx.beginPath();const center={x:(A.x+B.x+C.x)/3,y:(A.y+B.y+C.y)/3};for(let i=0;i<3;i++){const p=dst[i],dx=p.x-center.x,dy=p.y-center.y,d=Math.hypot(dx,dy),q={x:p.x+dx/d*1.8,y:p.y+dy/d*1.8};i?ctx.lineTo(q.x,q.y):ctx.moveTo(q.x,q.y);}ctx.closePath();ctx.clip();ctx.transform(a11,a21,a12,a22,A.x-a11*a.x-a12*a.y,A.y-a21*a.x-a22*a.y);ctx.drawImage(image,0,0);ctx.restore();};
 const [x0,y0,x1,y1]=region??[0,0,w,h];for(let y=y0;y<y1;y+=step)for(let x=x0;x<x1;x+=step){const source=[{x,y},{x:Math.min(x+step,x1),y},{x:Math.min(x+step,x1),y:Math.min(y+step,y1)},{x,y:Math.min(y+step,y1)}],dest=source.map(p=>vertex(p.x,p.y,pose));triangle([source[0],source[1],source[2]],[dest[0],dest[1],dest[2]]);triangle([source[0],source[2],source[3]],[dest[0],dest[2],dest[3]]);}
}

export function handVertex(side,x,y,pose){const wrist=side==='L'?{x:569,y:747}:{x:737,y:751};const weight=smooth((Math.hypot(x-wrist.x,y-wrist.y)-25)/45),lift=(1-Math.cos(pose.time*(side==='L'?10:11)+(side==='L'?0:.8)))/2;return{x,y:y-1.6*pose.type*weight*lift};}
