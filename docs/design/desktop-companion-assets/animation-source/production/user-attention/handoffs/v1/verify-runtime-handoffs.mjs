import fs from 'node:fs';
import path from 'node:path';
import {CompanionPlayback,frameAt} from '../../../../varin-main-20261028/packages/ui/src/components/companion/playback.mjs';
const root=path.resolve('varin-animation-production');
const inventory=JSON.parse(fs.readFileSync(path.join(root,'accepted-runtime-v2-inventory.json')));
const assets=inventory.map(x=>JSON.parse(fs.readFileSync(path.join(root,x.package))));
const results=[];
for(const action of ['permission','query']){
 const source=assets.find(a=>a.action===action);
 for(let i=0;i<source.frames.length;i++)for(const offset of [0,Math.floor(source.frames[i].durationMs/2)])for(const outcome of ['idle-closed','understood','external-wait','editing','disconnected','cancel-settling','failure','unknown-effect-check']){
  const c=new CompanionPlayback(assets),target=assets.find(a=>a.action===outcome);
  c.current=source;c.timeMs=source.frames[i].startMs+offset;
  const events=[];c.request(target.id);let elapsed=0,last='';
  while(c.current?.id!==target.id&&!c.blocker&&elapsed<15000){
   const key=c.current.id;if(key!==last){events.push(key);last=key;}
   c.tick(17);elapsed+=17;
  }
  const ok=c.current?.id===target.id&&!c.blocker;
  results.push({action,frame:i,offset,outcome,ok,elapsed,events,blocker:c.blocker});
 }
 const c=new CompanionPlayback(assets);c.current=source;c.tick(90000);
 results.push({action,unresolved90s:true,ok:c.current===source&&!!frameAt(source,c.timeMs)&&c.timeMs>=source.frames[source.loop[0]].startMs,current:c.current.id,timeMs:c.timeMs});
}
const report={utc:new Date().toISOString(),scope:'Actual shared controller, current accepted inventory. Pure routing/timing test complements visual peer review, not replacement.',packageCount:assets.length,checks:results.length,failures:results.filter(x=>!x.ok),maxResolutionMs:Math.max(...results.filter(x=>x.elapsed).map(x=>x.elapsed)),results};
fs.writeFileSync(path.join(root,'user-attention/handoffs/v1/runtime-handoff-qa.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({checks:report.checks,failures:report.failures,maxResolutionMs:report.maxResolutionMs},null,2));
