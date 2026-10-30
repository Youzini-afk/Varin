import {loadV3,tuning} from './art-v3-load.mjs';
import {sampleStudy} from '../src/motion.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const {canvas,renderer}=await loadV3();await mkdir('evidence/art-study/v3-frames',{recursive:true});
for(let i=0;i<480;i++){const pose=sampleStudy(i/60).pose();renderer.draw({background:'#243146',pose,motionMode:'limited-cutout',tuning});await writeFile(`evidence/art-study/v3-frames/${String(i).padStart(4,'0')}.png`,canvas.toBuffer('image/png'));if(i%120===0)console.log(i);}
