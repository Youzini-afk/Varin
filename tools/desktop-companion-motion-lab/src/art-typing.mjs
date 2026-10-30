// Registered local typing pose morph. Source artwork supplies new finger silhouettes.
// Call replacement pass BEFORE laptopBase, then skin pass ABOVE laptopBase.
// Skip original handR. Other character layers can retain their original pixels:
// the replacement tile covers the split old fingertip in lowerBody.
const clamp=x=>Math.max(0,Math.min(1,x));
const smooth=x=>{x=clamp(x);return x*x*x*(10+x*(-15+6*x));};
export const TYPING_TIPS={rest:[679,774],prep:[682,769],press:[682,775]};
const BOX=[630,716,132,68];
export function typingWeights(pose){
 const e=clamp(pose.type??0),phase=(1-Math.cos((pose.time??0)*11))/2;
 const press=smooth(phase);
 return {rest:1-e,prep:e*(1-press),press:e*press};
}
export function typingTarget(pose){const w=typingWeights(pose);return [0,1].map(i=>Object.keys(w).reduce((s,n)=>s+w[n]*TYPING_TIPS[n][i],0));}
export function typingWarp(x,y,sourceTip,targetTip){
 const r=Math.hypot((x-sourceTip[0])/16,(y-sourceTip[1])/29);
 const w=1-smooth(r);return [x+(targetTip[0]-sourceTip[0])*w,y+(targetTip[1]-sourceTip[1])*w];
}
function canvasFor(resources,w,h){return resources.makeCanvas?resources.makeCanvas(w,h):Object.assign(document.createElement('canvas'),{width:w,height:h});}
function initialize(resources){
 const [x,y,w,h]=BOX;const parsed={};
 for(const n of ['rest','prep','press']){
  parsed[n]={};for(const kind of ['replacement','skin']){
   const canvas=canvasFor(resources,w,h),c=canvas.getContext('2d');
   const image=resources[n][kind];if(!image)throw Error(`Missing typing ${n}.${kind}`);
   c.drawImage(image,-x,-y);parsed[n][kind]=c.getImageData(0,0,w,h).data;
  }
 }
 const canvas=canvasFor(resources,w,h);resources._typing={parsed,canvas,ctx:canvas.getContext('2d')};
}
function sample(data,x,y,out){
 const [, ,w,h]=BOX;x=Math.max(0,Math.min(w-1,x));y=Math.max(0,Math.min(h-1,y));
 const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(x0+1,w-1),y1=Math.min(y0+1,h-1),u=x-x0,v=y-y0;
 out.fill(0);for(const [xx,yy,k] of [[x0,y0,(1-u)*(1-v)],[x1,y0,u*(1-v)],[x0,y1,(1-u)*v],[x1,y1,u*v]]){
  const o=(yy*w+xx)*4,a=data[o+3]/255;out[3]+=k*a;for(let j=0;j<3;j++)out[j]+=k*a*data[o+j];
 }
}
export function drawTyping(ctx,resources,pose){
 if(!resources._typing)initialize(resources);
 const pass=resources.pass??'replacement';if(!['replacement','skin'].includes(pass))throw Error('Typing pass must be replacement or skin');
 const {parsed,canvas,ctx:off}=resources._typing,[x0,y0,w,h]=BOX;
 const target=typingTarget(pose),weights=typingWeights(pose),image=off.createImageData(w,h),tmp=[0,0,0,0];
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const sums=[0,0,0,0];for(const n of ['rest','prep','press']){
   if(weights[n]<1e-8)continue;let sx=x+x0,sy=y+y0;
   // Fixed point inverse maps each original silhouette toward the SAME target.
   for(let k=0;k<5;k++){const q=typingWarp(sx,sy,TYPING_TIPS[n],target);sx+=x+x0-q[0];sy+=y+y0-q[1];}
   sample(parsed[n][pass],sx-x0,sy-y0,tmp);for(let j=0;j<4;j++)sums[j]+=weights[n]*tmp[j];
  }
  const o=(y*w+x)*4,a=sums[3];image.data[o+3]=Math.round(a*255);for(let j=0;j<3;j++)image.data[o+j]=a?Math.round(sums[j]/a):0;
 }
 off.putImageData(image,0,0);ctx.drawImage(canvas,x0,y0);
}
