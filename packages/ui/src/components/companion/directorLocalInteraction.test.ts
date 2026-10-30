import { describe, expect, it } from 'vitest';
import { companionLocalIdle, directorLocalResponse } from './directorLocalInteraction';
const base = { event: 'tap' as const, current: true, visible: true, interacting: false, blockedUI: false, finiteHandover: false, closed: false };
describe('director local attention', () => {
  it('allows gentle attention without treating pending requests as approval', () => {
    expect(directorLocalResponse(base)).toBe('director-open-attention');
    expect(directorLocalResponse({ ...base, closed: true })).toBe('tap-response');
    expect(directorLocalResponse({ ...base, event: 'hover' })).toBe('director-open-attention');
    expect(directorLocalResponse({ ...base, event: 'hover', closed: true })).toBe('hover-response');
  });
  it('does not interrupt or queue a finite handover, hidden/dragging, or unknown state', () => {
    for (const override of [{ finiteHandover: true }, { visible: false }, { interacting: true }, { current: false }, { blockedUI: true }]) {
      expect(directorLocalResponse({ ...base, ...override })).toBeNull();
    }
  });
});

it('allows at most an idle safe-endpoint repeat variation, never a missing-art fallback replay', () => {
  const repeat = { ...base, event: 'tap-repeat' as const, idle: true, safeOpenEndpoint: true, playfulAvailable: true };
  expect(directorLocalResponse(repeat)).toBe('tap-repeat-response');
  expect(directorLocalResponse({...repeat,closed:true,safeOpenEndpoint:false,closedPlayfulAvailable:true})).toBe('tap-repeat-response');
  for (const override of [{idle:false},{responsePlaying:true},{safeOpenEndpoint:false},{playfulAvailable:false},{closed:true},{finiteHandover:true}]) expect(directorLocalResponse({...repeat,...override})).toBeNull();
  expect(directorLocalResponse({...base,responsePlaying:true})).toBeNull();
  expect(directorLocalResponse({...base,event:'hover',safeOpenEndpoint:true,openHoverAvailable:true})).toBe('open-hover-response');
  expect(directorLocalResponse({...base,event:'hover',safeOpenEndpoint:true})).toBe('director-open-attention');
});

import { createDirectorReviewFixtureSession } from './directorReviewFixtures';
it('uses fixture busy/pending/unknown facts rather than borrowing an empty live Host idle state', () => {
 const session=createDirectorReviewFixtureSession();
 const empty={...session.view().attention,branches:[],items:[],counts:{actionRequired:0,affectedBranches:0,unknownEffects:0}};
 expect(companionLocalIdle(empty,'current')).toBe(true);
 for(const step of ['portfolio','requests','unknown'] as const){session.step(step);const value=session.view();expect(companionLocalIdle(value.attention,value.presentation.health)).toBe(false);}
 expect(companionLocalIdle(empty,'unknown')).toBe(false);
});

import { companionClosedDrawing, companionClosedSequence, companionSafeOpenDrawing } from './directorLocalInteraction';
import { readCompanionEndpoints } from './sequencePackage';
import { CompanionPlayback, frameAt, type PlaybackAsset } from './playback.mjs';
const source = { open: 'a'.repeat(64), closed: 'b'.repeat(64), hair: 'c'.repeat(64), sleep: 'd'.repeat(64), contact: 'e'.repeat(64) };
function endpointFixture() {
  const asset = (id: string, poses: (keyof typeof source)[], action?: string, loop?: [number, number]): PlaybackAsset => ({
    id, action, kind: action ? 'action' : 'bridge', geometryReference: 'independent-drawings', canvas: [512,512], pages: [{file:'test.png'}],
    reviewStatus:'candidate',stage:'motion-candidate',entryPose:poses[0]!,exitPose:poses.at(-1)!,durationMs:poses.length*100,loop,
    frames:poses.map((pose,i)=>({pose,sha256:source[pose],exitTo:[pose],startMs:i*100,durationMs:100,page:0,rect:[0,0,1,1],offset:[0,0]})),
  });
  const assets=[asset('closed',['closed'],'idle-closed',[0,1]),asset('hair',['closed','hair','closed'],'quiet-hair-smooth'),
    asset('recover-hair',['hair','closed']),asset('sleep',['closed','sleep'],'rest-sleep',[1,2]),asset('wake',['sleep','closed']),
    asset('M01',['closed','contact','open']),asset('open',['open'],'director-supervise',[0,1]),
    asset('question',['open'],'query',[0,1]),asset('permission',['open'],'permission',[0,1])];
  const metadata={geometryReference:'independent-drawings',open:{pose:'open',sourceSha256:source.open},closed:{pose:'closed',sourceSha256:source.closed},closedSourceSha256:[source.closed,source.hair,source.sleep]};
  return {assets,metadata,endpoints:readCompanionEndpoints(metadata,assets)!};
}
it('uses verified current closed pixels including sleep, not the action name or old geometry alias',()=>{
  const {assets,endpoints,metadata}=endpointFixture(),sleep=assets.find(a=>a.id==='sleep')!,open=assets.find(a=>a.id==='open')!;
  expect(companionClosedDrawing(sleep,sleep.frames[1],endpoints)).toBe(true);
  expect(companionClosedSequence(sleep,endpoints)).toBe(true);
  expect(companionClosedDrawing({...open,action:'rest-sleep'},open.frames[0],endpoints)).toBe(false);
  expect(companionSafeOpenDrawing(open,open.frames[0],endpoints)).toBe(true);
  expect(companionClosedDrawing(sleep,sleep.frames[1],null)).toBe(false);
  expect(()=>readCompanionEndpoints({...metadata,closedSourceSha256:[source.closed,source.open]},assets)).toThrow();
  expect(()=>readCompanionEndpoints({...metadata,closed:{pose:'closed',sourceSha256:source.hair}},assets)).toThrow();
  expect(()=>readCompanionEndpoints(metadata,[...assets,{...open,id:'bad-boundary',entryPose:'closed'}])).toThrow();
  expect(()=>readCompanionEndpoints(metadata,[...assets,{...open,id:'bad-alias',frames:[{...open.frames[0]!,sha256:source.hair}]}])).toThrow();
});
it('takes actual closed leisure recovery and M01 to pending work, retaining the latest request without auto-answer',()=>{
  const {assets,endpoints}=endpointFixture(),p=new CompanionPlayback(assets,{allowCandidates:true});
  p.request('hair');p.tick(110);expect(companionClosedDrawing(p.current!,frameAt(p.current!,p.timeMs)!,endpoints)).toBe(true);
  p.request('question',{context:'question-A'});expect(p.current?.id).toBe('recover-hair');p.tick(200);expect(p.current?.id).toBe('M01');
  p.tick(500);expect(p.current?.id).toBe('question');p.tick(86400000);expect(p.currentContext).toBe('question-A');
  p.request('permission',{context:'permission-B'});p.tick(1000);expect(p.current?.id).toBe('permission');expect(p.currentContext).toBe('permission-B');
  p.request('open',{context:'cleared'});p.tick(1000);expect(p.current?.id).toBe('open');
  // Already open attentiveness is a matching endpoint; never replay the mechanical opening.
  expect(p.path).toEqual([]);expect(p.blocker).toBeNull();
  const sleep=new CompanionPlayback(assets,{allowCandidates:true});sleep.request('sleep');sleep.tick(86400000);expect(sleep.current?.id).toBe('sleep');
  sleep.request('question',{context:'wake-for-work'});expect(sleep.current?.id).toBe('wake');sleep.tick(1000);expect(sleep.current?.id).toBe('question');
});

it('uses routed open attention only when a closed response is missing, preserving available legacy responses',()=>{
  const hover={...base,event:'hover' as const,closed:true};
  expect(directorLocalResponse({...hover,responseAvailable:action=>action==='director-open-attention'})).toBe('director-open-attention');
  expect(directorLocalResponse({...hover,responseAvailable:()=>false})).toBeNull();
  expect(directorLocalResponse({...hover,responseAvailable:()=>true})).toBe('hover-response');
  expect(directorLocalResponse({...hover,event:'tap',responseAvailable:action=>action==='tap-response'})).toBe('tap-response');
  expect(directorLocalResponse({...hover,event:'tap-repeat',idle:true,playfulAvailable:true,responseAvailable:()=>true})).toBeNull();
});


it('uses the authored open tap only for idle safe pixels with a real route, otherwise keeps attention', () => {
  const tap = { ...base, idle: true, safeOpenEndpoint: true, responseAvailable: () => true };
  expect(directorLocalResponse(tap)).toBe('tap-response');
  for (const override of [{idle:false}, {safeOpenEndpoint:false}, {responseAvailable:(action:string)=>action==='director-open-attention'}])
    expect(directorLocalResponse({...tap,...override})).toBe('director-open-attention');
  for (const override of [{finiteHandover:true}, {interacting:true}, {blockedUI:true}, {responsePlaying:true}])
    expect(directorLocalResponse({...tap,...override})).toBeNull();
  const session=createDirectorReviewFixtureSession();session.step('requests');const pending=session.view();
  expect(directorLocalResponse({...tap,idle:companionLocalIdle(pending.attention,pending.presentation.health)})).toBe('director-open-attention');
});
