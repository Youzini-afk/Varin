/** Exact installed/candidate artwork exercised through the production body player.
 * No Host facts, approval, execution or visual acceptance are manufactured here. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { CompanionPlayback, frameAt, route } from '../../packages/ui/src/components/companion/playback.mjs';
const file = process.argv[2];
if (!file) throw new Error('Provide candidate or selected bundle.json');
const raw = fs.readFileSync(file), assets = JSON.parse(raw).packages;
const work = assets.find(asset => asset.action === 'work-active');
if (!work?.loop) throw new Error('Missing authored work-active loop');
const failures = [], cases = { exits: 0, pickups: 0, recoveryRegrabs: 0 };
const check = (ok, label) => { if (!ok) failures.push(label); };
const make = () => new CompanionPlayback(assets, { allowCandidates: true });
// A finite simple route cannot exceed the sum of all installed clip durations.
const routeBudget = assets.reduce((sum, asset) => sum + asset.durationMs, 0) * 2;
function settle(player, target, visit = () => {}) {
 for (let elapsed = 0; elapsed <= routeBudget; elapsed += 25) {
  visit(player, elapsed);
  if (!player.gesture && player.current?.id === target.id && !player.pending && !player.path.length) return !player.blocker;
  if (player.blocker) return false;
  player.tick(25);
 }
 return false;
}
const targets = ['permission', 'query', 'failure', 'unknown-effect-check', 'director-supervise', 'idle-closed']
 .map(action => assets.find(asset => asset.action === action)
   ?? (action === 'unknown-effect-check' ? assets.find(asset => asset.action === 'director-notify-attention') : undefined));
check(targets.every(Boolean), 'Missing required attention/neutral/closed target');
const [first, end] = work.loop;
const loopFrames = work.frames.slice(first, end);
check(new Set(loopFrames.map(frame => frame.sha256)).size >= 3, 'Work loop has no genuine changing source drawings');
const loopMs = loopFrames.reduce((sum, frame) => sum + frame.durationMs, 0);
const player = make(); player.request(work.id, { context: 'working' });
player.tick(work.frames[first].startMs + loopMs * 3 + 17);
check(player.current?.id === work.id && player.timeMs >= work.frames[first].startMs
 && player.timeMs < work.frames[end - 1].startMs + work.frames[end - 1].durationMs, 'Work does not stay in authored loop');
const before = player.timeMs;
player.request(work.id, { context: 'working' });
check(player.timeMs === before, 'Unchanged observed intent restarts work');
check(loopFrames.some(frame => {
 player.timeMs = frame.startMs;
 return player.canPauseRepeatedMotion();
}), 'Reduced-motion has no authored safe loop hold');
const recovery = new Map();
for (const frame of work.frames) {
 for (const target of targets.filter(Boolean)) {
  const p = make(); p.request(work.id, { context: 'old-work' }); p.timeMs = frame.startMs;
  check(route(work, target, assets, true).status === 'ready', `No route to ${target.action}`);
  // A newer request replaces the obsolete result, never a queued choreography.
  p.request(targets[0].id, { context: 'obsolete' });
  p.request(target.id, { context: 'latest' });
  check(settle(p, target) && p.currentContext === 'latest', `Exit ${frame.startMs}->${target.action}: ${p.blocker}`);
  cases.exits++;
 }
 for (const elapsed of [0, 75, 350]) {
  const p = make(); p.request(work.id, { context: 'old-work' }); p.timeMs = frame.startMs;
  const source = frameAt(p.current, p.timeMs).sha256;
  check(p.grab(), `Missing actual-source pickup ${frame.startMs}`);
  check(p.current?.gesture?.entrySourceSha256 === source, `Pickup mismatches shown source ${frame.startMs}`);
  p.tick(elapsed); p.request(work.id, { context: 'obsolete-resume' });
  const target = targets.at(-1); p.request(target.id, { context: 'newest-ended' }); p.release();
  const ok = settle(p, target, (current, recoveryElapsed) => {
   if (!current.gesture || !current.current?.gesture) return;
   const index = current.current.frames.indexOf(frameAt(current.current, current.timeMs));
   recovery.set(`${current.current.id}/${index}`, {sourceTime:frame.startMs, elapsed, recoveryElapsed});
  });
  check(ok && p.currentContext === 'newest-ended', `Release ${frame.startMs}/${elapsed}: ${p.blocker}`);
  cases.pickups++;
 }
}
// Every encountered detached/seated recovery drawing must be safe to grab again.
for (const [key, sample] of recovery) {
 const p = make(); p.request(work.id, {context:'old-work'}); p.timeMs = sample.sourceTime;
 p.grab(); p.tick(sample.elapsed); const target = targets.at(-1);
 p.request(target.id, {context:'ended'}); p.release(); p.tick(sample.recoveryElapsed);
 check(p.grab(), `Regrab refused ${key}`);
 p.tick(75); p.request(target.id, {context:'latest-after-regrab'}); p.release();
 check(settle(p,target) && p.currentContext === 'latest-after-regrab', `Recovery regrab ${key}: ${p.blocker}`);
 cases.recoveryRegrabs++;
}
const result = {bundleSHA256:crypto.createHash('sha256').update(raw).digest('hex'), package:work.id,
 loopMs, loopSourceDrawings:new Set(loopFrames.map(frame=>frame.sha256)).size, ...cases, failures,
 scope:'Production playback of actual packages; not visual, native, or real Host end-to-end acceptance'};
console.log(JSON.stringify(result,null,2));
if (failures.length) process.exitCode = 1;
