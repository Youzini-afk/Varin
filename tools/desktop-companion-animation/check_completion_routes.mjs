import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { CompanionPlayback, frameAt } from '../../packages/ui/src/components/companion/playback.mjs';
const file = process.argv[2] ?? new URL('../../packages/web/public/companion-assets/bundle.json', import.meta.url);
const output = process.argv[3];
const bundle = JSON.parse(fs.readFileSync(file)), assets = bundle.packages;
const targetIds = ['v5-quiet-seat-adjust','v5-idle-closed','v5-supervise','v5-open-attention','v5-idle','v5-unknown-check','v5-disconnected-check','v5-bot-think','v5-bot-dispatch','v5-bot-prepare','v5-query','v5-rest-sleep', ...assets.filter(a => a.id.startsWith('v5-completion-recovery-')).map(a => a.id)];
const targets = targetIds.map(id => { const a = assets.find(a => a.id === id); assert(a, id); return a; });
const intents = [...new Set([...targets.filter(a => a.kind === 'action').map(a => a.id), 'v5-work-active', 'v5-permission', 'v5-idle-closed', 'v5-query', 'v5-notice', 'v5-supervise'])].filter(id => assets.some(a => a.id === id));
const fresh = () => new CompanionPlayback(assets, { allowCandidates: true });
function displayed(p, a, i) { p.request(a.id); p.alignDisplayed({ packageId: a.id, exposure: i }); assert.equal(frameAt(p.current, p.timeMs).sha256, a.frames[i].sha256); }
function settle(p, id) {
  for (let i=0; i<1200 && (p.gesture || p.current?.id !== id); i++) { p.tick(20); assert(!p.blocker, p.blocker); }
  assert(!p.gesture, 'gesture failed to settle'); assert.equal(p.current.id, id); assert(!p.blocker, p.blocker);
}
const seenSeated = new Set(), seenDetached = new Set();
let exits=0, pickups=0, regrabs=0, duplicateRequests=0, loopChecks=0, pauseChecks=0;
for (const a of targets) {
  if (a.gesture) continue;
  // Normal authored time is checked separately from the exact displayed-exposure contract.
  if (a.loop) {
    const p=fresh(); p.request(a.id); p.tick(a.durationMs*3 + 17); assert.equal(p.current.id,a.id); assert(!p.blocker);
    const end=a.frames[a.loop[1]-1]; assert(p.timeMs>=a.frames[a.loop[0]].startMs && p.timeMs<end.startMs+end.durationMs); loopChecks++;
    const before=p.timeMs; p.request(a.id); assert.equal(p.timeMs,before); duplicateRequests++;
  }
  for (let i=0; i<a.frames.length; i++) {
    const f=a.frames[i];
    for (const intent of intents) {
      if(intent===a.id)continue;
      const p=fresh();displayed(p,a,i);p.request(intent,{context:'newest'});settle(p,intent);assert.equal(p.currentContext,'newest');exits++;
    }
    for (const delay of [0,45,160,700]) {
      const p=fresh();displayed(p,a,i);assert(p.grab(),p.blocker);
      const match=assets.find(x=>x.gesture?.entrySourceSha256===f.sha256);assert(match);assert.equal(p.current.id,match.id);seenDetached.add(match.id);
      p.tick(delay);p.request('v5-work-active',{context:'stale'});p.request('v5-permission',{context:'latest'});p.release();
      for(let t=0;t<1200&&p.gesture;t++){
        if(p.current?.gesture?.embeddedStool){
          seenSeated.add(p.current.id);
          // Regrab one live copy, preserving uninterrupted original release for coverage.
          const q=fresh(); displayed(q,a,i);assert(q.grab());q.tick(delay);q.request('v5-query',{context:'latest-query'});q.release();q.tick(t*20);
          if(q.gesture&&q.current?.gesture?.embeddedStool){ const seat=q.current;assert(q.grab());assert.equal(q.current.id,seat.gesture.grabImmediate);q.release();settle(q,'v5-query');assert.equal(q.currentContext,'latest-query');regrabs++; }
        }
        p.tick(20); assert(!p.blocker,p.blocker);
      }
      settle(p,'v5-permission');assert.equal(p.currentContext,'latest');pickups++;
    }
    if(a.loop && i>=a.loop[0] && i<a.loop[1]){
      const p=fresh();displayed(p,a,i);assert.equal(p.canPauseRepeatedMotion(),f.pauseSafe!==false && f.exitTo.includes(f.pose));pauseChecks++;
    }
  }
}
// Shared intent routes are explicit, but not separate drawings or repeated events.
const action = name => assets.find(a => a.action === name);
assert.deepEqual(action('unknown-effect-check').frames, action('disconnected').frames);
assert.equal(action('bot-dispatch').loop, null);
assert.equal(action('bot-dispatch').frames.filter(f => f.cue === 'DISPATCH_DOWN').length, 1);
for (const a of assets.filter(a => a.id.startsWith('v5-completion-recovery-'))) {
  assert(a.frames.every(f => f.cue === 'RECOVERY_ONLY'), 'Recovery re-emits semantic event');
}
for (const id of ['v5-idle-closed','v5-supervise','v5-open-attention']) {
  const a=assets.find(a=>a.id===id);
  assert(a.durationMs >= 30000, 'Neutral life must retain long quiet dwells');
  assert.equal(new Set(a.frames.map(f=>f.cue)).size, 1, 'Neutral life flickers scene cues');
}
for (const id of ['v5-d-question-05-wait-r1','v5-s-question-05-wait-r1']) {
  assert.equal(assets.find(a=>a.id===id).gesture.grabNext[0], 'v5-completion-open-side-approach');
}
const approach=assets.find(a=>a.id==='v5-completion-open-side-approach');
assert.equal(approach.durationMs,180);assert(!approach.gesture.entrySourceSha256);
const supervise=action('director-supervise');
const read=assets.find(a=>a.id==='v5-work-s-read').frames[0].sha256;
assert(supervise.frames.some(f=>f.sha256===read),'Missing quiet own-screen focus');
const strokes=new Set(['v5-work-s-key-left','v5-work-s-key-right'].map(id=>assets.find(a=>a.id===id).frames[0].sha256));
assert(supervise.frames.every(f=>!strokes.has(f.sha256)),'Quiet supervision invents typing strokes');
const sleep=action('rest-sleep');
assert(sleep.loop && sleep.loop[1]-sleep.loop[0]>1,'Sleep hold needs authored faint local breath');
const sleepRecovery=assets.filter(a=>a.id.startsWith('v5-completion-recovery-sleep-breath-'));
assert.equal(sleepRecovery.length,2);
const wake=assets.find(a=>a.id==='v5-sleep-05-wake-eyes-fg').frames[0].sha256;
for(const a of sleepRecovery)assert.equal(a.frames[1].sha256,wake,'Sleep interruption must wake eyes first, not finish breath');
const report={bundleSHA256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),targets:targetIds,exits,pickups,regrabs,duplicateRequests,loopChecks,pauseChecks,seenSeated:[...seenSeated],seenDetached:[...seenDetached],failures:[],scope:'Production CompanionPlayback contract tests at exact displayed exposures using its public alignDisplayed API, plus normal loop time and real grab/release/regrab routes. Not proof every exposure is naturally reached by the application, not visual or native/Host end-to-end acceptance.'};
if (output) fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,seenSeated:seenSeated.size,seenDetached:seenDetached.size}));
