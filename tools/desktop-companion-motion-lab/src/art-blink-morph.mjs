import { drawDeformed } from './art-deform.mjs';
// Registered painted open/half/closed eye-local blend shapes. No whole-face scaling.
const lerp=(a,b,t)=>a+(b-a)*t;
const at=(curve,x)=>{let i=0;while(i<curve.length-2&&x>curve[i+1][0])i++;const a=curve[i],b=curve[i+1];return lerp(a[1],b[1],Math.max(0,Math.min(1,(x-a[0])/(b[0]-a[0]))));};
export function drawBlinkMorph(ctx,face,amount){
 const b=Math.max(0,Math.min(1,amount));if(b===0)return;
 const states=b<.5?['open','half']:['half','closed'],u=b<.5?b*2:b*2-1;
 for(const side of ['L','R']){
  const bounds=face.meta.sourcePixelBounds['eye'+side];
  const curve=s=>face.morphMeta[s+side].curve6;
  const ca=curve(states[0]),cb=curve(states[1]);
  // Complete opaque local patches share original eye masks, so the original eye is erased.
  ctx.save();ctx.beginPath();ctx.rect(...[bounds[0],bounds[1],bounds[2]-bounds[0],bounds[3]-bounds[1]]);ctx.clip();
  const surface=face.makeCanvas(1382,1382),sc=surface.getContext('2d');
  for(let j=0;j<2;j++){
   const state=states[j],sourceCurve=j?cb:ca;
   const vertex=(x,y)=>{const sy=at(sourceCurve,x),ty=lerp(at(ca,x),at(cb,x),u);const edge=y<sy?bounds[1]:bounds[3];const w=Math.max(0,1-Math.abs(y-sy)/Math.max(1,Math.abs(edge-sy)));return{x,y:y+(ty-sy)*w};};
   const layer=face.makeCanvas(1382,1382),lc=layer.getContext('2d');
   drawDeformed(lc,face[state+side],{},6,bounds,vertex);
   sc.globalAlpha=j?u:1-u;sc.globalCompositeOperation='lighter';sc.drawImage(layer,0,0);
  }
  ctx.drawImage(surface,0,0);ctx.restore();
 }
}
