import {loadV3,tuning} from './art-v3-load.mjs';
import {writeFile} from 'node:fs/promises';
const {canvas,renderer}=await loadV3(1382);renderer.setProps(null);renderer.typing=null;renderer.face=null;renderer.draw({pose:{time:0,head:-.035,gaze:0,breath:0,type:0},motionMode:'limited-cutout',tuning});await writeFile('evidence/art-study/v3-neutral.png',canvas.toBuffer('image/png'));
