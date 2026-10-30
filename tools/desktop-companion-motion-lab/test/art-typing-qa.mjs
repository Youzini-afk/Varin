import {createCanvas,loadImage} from '@napi-rs/canvas';import {writeFile} from 'node:fs/promises';import {drawTyping} from '../src/art-typing.mjs';
const root='../varin-animation-art/',resources={makeCanvas:createCanvas};
for(const n of ['rest','prep','press'])resources[n]={replacement:await loadImage(root+`typing/handR-${n}-replacement.png`),skin:await loadImage(root+`typing/handR-${n}.png`)};
const body=await loadImage(root+'canonical-seated-clean-v3.png');const base=await loadImage(root+'props/laptopBase.png'),lid=await loadImage(root+'props/laptopLid.png');const handL=await loadImage(root+'layers-partition-v3/handL.png');
const sheet=createCanvas(1600,600),sc=sheet.getContext('2d');
for(let i=0;i<5;i++){
 const c=createCanvas(1382,1382),ctx=c.getContext('2d');ctx.fillStyle='#243146';ctx.fillRect(0,0,1382,1382);ctx.drawImage(body,0,0);
 const pose={type:i===0?0:1,time:(i-1)*Math.PI/(3*11)};resources.pass='replacement';drawTyping(ctx,resources,pose);ctx.drawImage(base,0,0);ctx.drawImage(handL,0,0);resources.pass='skin';drawTyping(ctx,resources,pose);if(!process.env.NO_LID)ctx.drawImage(lid,0,0);
 sc.drawImage(c,610,680,220,170,i*320,0,320,250);sc.drawImage(c,0,0,1382,1382,i*320,270,320,320);
 sc.fillStyle='white';sc.font='16px sans-serif';sc.fillText(i===0?'idle':`phase ${i}/4`,i*320+12,265);
}
await writeFile(root+'typing/runtime-morph'+(process.env.NO_LID?'-no-lid':'')+'-qa.png',sheet.toBuffer('image/png'));
