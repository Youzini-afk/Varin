import { readFileSync, writeFileSync } from 'node:fs';
import { LidPlayback } from './interrupt-controller.mjs';
const seq = ['opening','closing'].map(n => JSON.parse(readFileSync(new URL(`./${n}/sequence.source.json`,import.meta.url))));
const cases=[];
for(const s of seq) for(let i=0;i<s.frames.length;i++) {
  const p=new LidPlayback(seq,s.id); p.index=i;
  // An interrupt in the middle of an exposure must not advance to a different image.
  p.advance(s.frames[i].durationMs/2);
  const hash=p.frame.motion.renderedPixelSha256;
  p.reverse();
  if(p.frame.motion.renderedPixelSha256!==hash) throw Error('Pixel discontinuity at reverse');
  const tail=p.sequence.frames.slice(p.index).reduce((a,f)=>a+f.durationMs,0);
  if(tail!==s.frames[i].motion.reverseTailDurationMs) throw Error('Incorrect reverse tail');
  p.advance(tail);
  if(!p.finished || !p.frame.motion.safeEndpoint) throw Error('Reverse did not end safely');
  const d=new LidPlayback(seq,s.id); d.index=i;
  const result=d.requestClosed();
  if(result==='settling') d.advance(10000);
  if(!d.canDrag) throw Error('Drag allowed before closure / failed closure');
  cases.push({sequence:s.id,frameIndex:i,reverseTailMs:tail,pixelContinuous:true,closedRequestReachesSafeEndpoint:true});
}
writeFileSync(new URL('./interrupt-runtime-qa.json',import.meta.url),JSON.stringify({status:'technical-contract-pass-not-visual-acceptance',cases},null,2));
console.log(`${cases.length} exposure interruption cases passed; exact pixels, reverse tails, close-before-drag.`);
