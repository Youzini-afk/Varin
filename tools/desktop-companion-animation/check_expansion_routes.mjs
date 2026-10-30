/** Candidate integration checks use the production player, not a second timeline. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CompanionPlayback, route, frameAt } from '../../packages/ui/src/components/companion/playback.mjs';
const path=process.argv[2];
if(!path) throw new Error('Provide candidate bundle.json');
const raw=fs.readFileSync(path), bundle=JSON.parse(raw), assets=bundle.packages;
const actions=assets.filter(p=>p.kind==='action');
const failures=[], traces={}; let pairs=0, grabs=0, interrupts=0;
for(const a of actions) for(const b of actions){pairs++; if(route(a,b,assets,true).status!=='ready') failures.push(`route:${a.id}->${b.id}`);}
for(const action of ['organizing','checking']) {
 const target=actions.find(p=>p.action===action), player=new CompanionPlayback(assets,{allowCandidates:true});
 player.request(target.id); const seen=[];
 for(let ms=0;ms<9000;ms+=20){const f=frameAt(player.current,player.timeMs);if(seen.at(-1)!==f?.cue) seen.push(f?.cue);player.tick(20);}
 traces[action]=seen;
 const expected=action==='organizing'?'ORGANIZE_ALIGN':'VERIFY_SCAN';
 if(!seen.includes(expected)||seen.filter(c=>c===expected).length!==1) failures.push(`actual entrance cue:${action}`);
}
for(const source of actions.filter(p=>p.id.startsWith('v3-')))for(const frame of source.frames)for(const name of ['idle-closed','editing','permission-request','disconnected']) {
 const target=actions.find(p=>p.action===name);if(!target)continue;
 const player=new CompanionPlayback(assets,{allowCandidates:true});player.request(source.id);player.timeMs=frame.startMs+frame.durationMs/2;
 player.request(target.id,{urgent:true});for(let n=0;n<1200&&player.current?.id!==target.id;n++)player.tick(25);
 interrupts++;if(player.current?.id!==target.id||player.blocker)failures.push(`interrupt:${source.id}:${frame.startMs}->${name}:${player.blocker}`);
}
const unique=new Map();for(const p of actions)for(const f of p.frames)unique.set(f.sha256,{p,f});
for(const {p,f} of unique.values())for(const elapsed of [0,75,350]){
 const player=new CompanionPlayback(assets,{allowCandidates:true});player.request(p.id);player.timeMs=f.startMs;
 if(!player.grab()){failures.push(`missing grab:${p.id}:${f.sha256}`);continue;}
 player.tick(elapsed);player.release();for(let n=0;n<400&&player.gesture;n++)player.tick(25);
 grabs++;if(player.gesture||player.blocker)failures.push(`release:${p.id}:${f.sha256}:${elapsed}:${player.blocker}`);
}
for(const action of ['think','output']){const p=actions.find(p=>p.action===action), [start,end]=p.loop;if(!p.frames.slice(start,end).some(f=>f.pauseSafe))failures.push(`no reduced-motion stable hold:${action}`);}
const result={candidateSHA:crypto.createHash('sha256').update(raw).digest('hex'),actionPairs:pairs,interruptCases:interrupts,uniqueActionSources:unique.size,grabCases:grabs,actualCueTraces:traces,failures,scope:'Production controller routes, exact-source early release and actual entrance cues; not visual/native acceptance'};
fs.writeFileSync(new URL('./controller-qa.json','file://'+path),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));if(failures.length)process.exitCode=1;
