import {createCanvas} from '@napi-rs/canvas';
import {mkdir,writeFile} from 'node:fs/promises';
import {Renderer} from '../src/renderer.mjs';
import {sampleStudy,Motion} from '../src/motion.mjs';
const dir='evidence/offscreen';await mkdir(dir+'/frames',{recursive:true});
const canvas=createCanvas(1000,900),renderer=new Renderer(canvas),output=createCanvas(800,720),ctx=output.getContext('2d');
function draw(m,label){renderer.draw(m,true);ctx.fillStyle='#1b2637';ctx.fillRect(0,0,800,720);ctx.drawImage(canvas,0,0,800,720);ctx.fillStyle='#c8d9ef';ctx.font='14px sans-serif';ctx.fillText('DEBUG RIG / offscreen Canvas2D · NOT FINAL ART',20,28);ctx.fillText(label,20,50);return output.toBuffer('image/png');}
for(const t of [0,1.2,1.6,2.5,3.7,5.5,7.5])await writeFile(`${dir}/study-${t}.png`,draw(sampleStudy(t),`study ${t.toFixed(3)}s`));
for(let i=0;i<480;i++)await writeFile(`${dir}/frames/${String(i).padStart(4,'0')}.png`,draw(sampleStudy(i/60),`study ${(i/60).toFixed(3)}s`));
const m=new Motion();m.setMode('work');m.advance(2);for(let i=0;i<360;i++){if(i===10){m.beginDrag(500,350);m.moveDrag(508,350);}if(i===15)m.endDrag();if(i===30)m.setMode('ask');if(i===43)m.setMode('work');if(i===52)m.setMode('ask');if(i===100)m.beginDrag(500,350);if(i>=100&&i<=180)m.moveDrag(500+(i-100)*1.5,350-(i-100)*.4);if(i===180)m.endDrag();if(i===190)m.setMode('work');if(i===200)m.beginDrag(m.root.x,350+m.root.y);if(i===215)m.endDrag();m.advance(1/60);if([30,43,52,100,140,180,200,260].includes(i))await writeFile(`${dir}/stress-${i}.png`,draw(m,`interrupt / drag ${(i/60).toFixed(3)}s`));await writeFile(`${dir}/frames/stress-${String(i).padStart(4,'0')}.png`,draw(m,`interrupt / drag ${(i/60).toFixed(3)}s`));}
console.log('Rendered actual src/renderer.mjs: 480 study + 360 stress frames, no renderer substitute.');

for(const [name,phase]of [['tilt-mid',.63],['held',1]]){const n=new Motion();n.beginDrag(500,350);n.advance(phase);await writeFile(`${dir}/${name}.png`,draw(n,name));}
for(const [name,phase]of [['seat-contact',.52],['lower-laptop-mid',.71],['laptop-on-lap',.9]]){const n=new Motion();n.beginDrag(500,350);n.advance(1);n.endDrag();n.advance(phase);await writeFile(`${dir}/${name}.png`,draw(n,name));}
