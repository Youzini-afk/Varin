import { expect, it } from 'vitest';
import { CompanionPlayback, type PlaybackAsset } from './playback.mjs';
function asset(id:string, poses:string[], kind='bridge'):PlaybackAsset {
  return { id, kind, reviewStatus:'accepted', stage:'motion-candidate', geometryReference:'same-drawings', canvas:[512,512], pages:[],
    entryPose:poses[0]!,exitPose:poses.at(-1)!,durationMs:poses.length*100,
    frames:poses.map((pose,i)=>({pose,exitTo:[pose],sha256:pose,durationMs:100,startMs:i*100,page:0,rect:[0,0,1,1],offset:[0,0]})) };
}
const assets=[asset('rest',['A'],'action'),asset('forward',['A','hand-contact','B']),asset('return-hand',['hand-contact','A']),asset('target',['B'],'action'),asset('stop',['A'],'action')];
it('finishes the committed bridge instead of cycling through its intermediate safe return route',()=>{
  const p=new CompanionPlayback(assets);p.request('rest');p.request('target');
  p.tick(120);expect(p.current?.id).toBe('forward');
  p.tick(250);expect(p.current?.id).toBe('target');expect(p.blocker).toBeNull();
});
it('a new intent can still interrupt that bridge at the actual safe hand drawing',()=>{
  const p=new CompanionPlayback(assets);p.request('rest');p.request('target');p.tick(120);
  p.request('stop');expect(p.current?.id).toBe('return-hand');p.tick(250);
  expect(p.current?.id).toBe('stop');expect(p.blocker).toBeNull();
});
it('keeps an old subject context through recovery and delayed decoding, then admits only the latest subject',()=>{
  const sentence=asset('sentence',['A','hand-contact','A'],'action');
  const p=new CompanionPlayback([sentence,asset('recover',['hand-contact','A'])]);
  p.request('sentence',{context:'B'});p.tick(120);
  expect(p.currentContext).toBe('B');
  p.request('sentence',{context:'C'});
  expect(p.current?.id).toBe('recover');expect(p.currentContext).toBeNull();
  p.canDisplay=id=>id!=='sentence';p.tick(250);
  expect(p.loading).toBe('sentence');expect(p.currentContext).toBeNull();
  p.request('sentence',{context:'D'});
  expect(p.currentContext).not.toBe('D');
  p.canDisplay=()=>true;p.advance();
  expect(p.current?.id).toBe('sentence');expect(p.currentContext).toBe('D');expect(p.timeMs).toBe(0);
});
it('can enter a new subject at the exact shared entrance without replaying the old subject',()=>{
  const p=new CompanionPlayback([asset('sentence',['A','hand-contact','A'],'action')]);
  p.request('sentence',{context:'B'});p.tick(50);p.request('sentence',{context:'C'});
  expect(p.currentContext).toBe('C');expect(p.timeMs).toBe(0);
});

it('grabs the last actually drawn B context after logical C, then restores B before the latest D',()=>{
 const sentence=asset('sentence',['A'],'action'),stop=asset('stop',['A'],'action');
 const pickup={...asset('pickup',['A'],'gesture'),gesture:{entrySourceSha256:'A',grabNext:[],releaseNext:[],restoreSourceSha256:'A',embeddedStool:false,settled:false,restoreOnRelease:true}};
 const p=new CompanionPlayback([sentence,stop,pickup]);
 p.request('sentence',{context:'B'});
 const drawn={packageId:'sentence',exposure:0,context:'B'};
 p.request('sentence',{context:'C'});expect(p.currentContext).toBe('C');
 expect(p.grab(drawn)).toBe(true);expect(p.gesture).toMatchObject({previousContext:'B'});
 p.request('stop',{context:'D'});p.canDisplay=id=>id!=='stop';
 p.release({packageId:'pickup',exposure:0,context:null});p.tick(110);
 expect(p.current?.id).toBe('sentence');expect(p.currentContext).toBe('B');expect(p.loading).toBe('stop');
 p.canDisplay=()=>true;p.advance();expect(p.currentContext).toBe('D');
});
