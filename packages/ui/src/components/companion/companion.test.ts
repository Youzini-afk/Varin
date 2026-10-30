import { expect, it } from 'vitest';
import type { ThreadSnapshot } from '@varin/application-client';
import { projectCompanionIntent as project, companionObserverAction } from './presentation';
import { readCompanionPackage as read } from './sequencePackage';
const snap = (value: object) => ({ activeRun: null, operations: [], ...value }) as unknown as ThreadSnapshot;
it('separates stale facts and cancellation requests from settled outcomes', () => {
  const activeRun = { state: 'cancelled', cancel_requested: true };
  expect(project(snap({ activeRun }), 'unknown').state).toBe('E04');
  expect(project(snap({ activeRun }), 'synchronizing').state).toBe('E05');
  expect(project(snap({ activeRun, operations: [{ phase: 'running' }] }), 'current').state).toBe('E02');
  expect(project(snap({ activeRun, childActivity: { a: { state: 'settling' } } }), 'current').state).toBe('E02');
  expect(project(snap({ activeRun }), 'current').state).toBeNull();
  expect(project(snap({ activeRun, operations: [{ phase: 'terminal', handed_off: true, external_receipt: { executor_stopped: false } }] }), 'current').state).toBeNull();
});
it('uses Host permission/question facts and does not guess tool categories', () => {
  const permission = { id: 'p', decision: null as string | null, call: {}, scope: {} };
  const operation = { phase: 'waiting', result: { kind: 'control', value: { permission } } };
  expect(project(snap({ operations: [operation] }), 'current').state).toBe('W02');
  permission.decision = 'allow_once';
  expect(project(snap({ operations: [operation] }), 'current').state).toBe('W04');
  expect(project(snap({ operations: [{ phase: 'waiting', executor: 'ask_user' }] }), 'current').state).toBe('W03');
  expect(project(snap({ operations: [{ phase: 'running', executor: 'arbitrary' }] }), 'current').state).toBeNull();
  expect(project(snap({ operations: [{ phase: 'terminal', effect: 'unknown' }] }), 'current').state).toBe('E06');
});
const candidate = () => ({ id: 'a', canvas: [16,16], pages: [{ file: 'atlas.png' }], stage: 'keyposes', frames: [
  { page: 0, rect: [0,0,8,8], offset: [4,4], durationMs: 110 },
  { page: 0, rect: [0,0,8,8], offset: [4,4], durationMs: 70 },
] });
it('preserves authored timing while keeping candidates explicitly review-only', () => {
  expect(() => read(candidate(), false)).toThrow(/visual review/);
  const result = read(candidate(), true);
  expect(result.durationMs).toBe(180); expect(result.frames[1]!.startMs).toBe(110);
});
it('rejects escaping geometry, paths and invalid timing', () => {
  const data = candidate(); data.frames[0]!.offset = [15,15]; expect(() => read(data, true)).toThrow(/canvas/);
  const path = candidate(); path.pages[0]!.file = '../atlas.png'; expect(() => read(path, true)).toThrow(/filename/);
  const time = candidate(); time.frames[0]!.durationMs = NaN; expect(() => read(time, true)).toThrow(/duration/);
});

import { CompanionPlayback, type PlaybackAsset } from './playback.mjs';
import { pickupPreloadDependencies } from './pickupPreload';
it('holds an authored wait until intent changes, plays its exit and bridge, and blocks missing art', () => {
  const asset = (id: string, entryPose: string, exitPose: string): PlaybackAsset => ({
    id, entryPose, exitPose, geometryReference: 'shared', stage: 'motion-candidate', reviewStatus: 'accepted',
    canvas: [16,16], pages: [{ file: 'atlas.png' }], durationMs: 300,
    frames: [0,1,2].map(i => ({ page: 0, rect: [0,0,8,8], offset: [0,0], startMs: i*100, durationMs: 100 })),
  });
  const waiting = { ...asset('wait','seat','hand'), loop: [1,2] as [number,number] };
  const bridge = { ...asset('bridge','hand','seat'), kind: 'bridge' };
  const work = asset('work','seat','seat');
  const player = new CompanionPlayback([waiting, bridge, work]);
  player.request('wait'); player.tick(950); expect(player.timeMs).toBe(150);
  const route = player.request('work'); expect(route.clips).toEqual(['bridge','work']);
  expect(player.canPauseRepeatedMotion()).toBe(false); // Changed facts release the quiet hold.
  player.tick(150); expect(player.current?.id).toBe('bridge');
  expect(route.clips).toEqual(['bridge','work']);
  player.tick(300); expect(player.current?.id).toBe('work'); expect(player.canPauseRepeatedMotion()).toBe(false); // Finite actions, including welcome, must finish.
  player.request('missing'); const held = player.timeMs; player.tick(900);
  expect(player.timeMs).toBe(held); expect(player.blocker).toBeTruthy();
});

import { operationPresentation } from './toolPresentation';
it('classifies exact admitted tool contracts, never command text or arbitrary executor labels', () => {
  const operation = { phase: 'running', executor: 'file_read', intent: { kind: 'tool', call: { name: 'file_read', schema_version: '1', arguments: { command: 'train a model' } }, contract: { name: 'file_read', schema_version: '1' } } };
  expect(operationPresentation(operation as never)?.state).toBe('T01');
  operation.intent.contract.name = 'plugin-read'; expect(operationPresentation(operation as never)).toBeNull();
  operation.intent.call.name = operation.intent.contract.name = 'process_spawn';
  expect(operationPresentation(operation as never)?.state).toBe('T03'); // Not experiments merely because of the command.
  operation.phase = 'terminal'; expect(operationPresentation(operation as never)).toBeNull();
});

it('finishes the current gesture to an authored safe drawing and carries elapsed time through its bridge', () => {
  const asset = (id: string, entryPose: string, exitPose: string, kind = 'action'): PlaybackAsset => ({
    id, entryPose, exitPose, kind, geometryReference: 'shared', stage: 'motion-candidate', reviewStatus: 'accepted',
    canvas: [16,16], pages: [{ file: 'atlas.png' }], durationMs: 300,
    frames: [0,1,2].map(i => ({ page: 0, rect: [0,0,8,8], offset: [0,0], startMs: i*100, durationMs: 100 })),
  });
  const wait = asset('wait','contact','contact'); wait.loop = [0,3];
  wait.frames[2] = { ...wait.frames[2]!, pose: 'contact', exitTo: ['contact'] };
  const bridge = asset('release','contact','keyboard','bridge');
  bridge.frames[0] = { ...bridge.frames[0]!, pose: 'contact', exitTo: ['contact'] };
  const work = asset('work','keyboard','keyboard');
  const player = new CompanionPlayback([wait, bridge, work]);
  const quiet = new CompanionPlayback([wait, bridge, work]);quiet.request('wait');quiet.tick(220);
  expect(quiet.canPauseRepeatedMotion()).toBe(true);
  wait.frames[2]!.pauseSafe = false; expect(quiet.canPauseRepeatedMotion()).toBe(false);
  delete wait.frames[2]!.pauseSafe; quiet.request('work');expect(quiet.canPauseRepeatedMotion()).toBe(false);
  player.request('wait'); player.tick(120);expect(player.canPauseRepeatedMotion()).toBe(false); player.request('work', { urgent: true });
  expect(player.current?.id).toBe('wait'); // No teleport while the hand is moving.
  player.tick(130);
  expect(player.current?.id).toBe('release'); expect(player.timeMs).toBe(50);
  player.tick(300);
  expect(player.current?.id).toBe('work'); expect(player.timeMs).toBe(50);
});

import { newlyAnsweredQuestion } from './presentation';
it('acknowledges only a newly observed actual clarification answer, not cancellation or reconnect history', () => {
  const answered = { id: 'q', executor: 'ask_user', phase: 'terminal', outcome: 'succeeded', result: { kind: 'control', value: { answer_ref: { id: 'content' } } } };
  expect(newlyAnsweredQuestion(new Set(['q']), snap({ operations: [answered] }))).toBe('q');
  expect(newlyAnsweredQuestion(new Set(), snap({ operations: [answered] }))).toBeNull();
  expect(newlyAnsweredQuestion(new Set(['q']), snap({ operations: [{ ...answered, outcome: 'cancelled', result: { kind: 'control', value: { cancelled: true } } }] }))).toBeNull();
});

it('uses the actually displayed pickup frame, keeps latest intent, and restores same exposure on early release', () => {
  const asset = (id: string, sha: string): PlaybackAsset => ({ id, entryPose: 'seat', exitPose: 'seat', geometryReference: 'shared', stage: 'motion-candidate', reviewStatus: 'accepted', canvas: [16,16], pages: [{file:'atlas.png'}], durationMs: 100, frames: [{page:0,rect:[0,0,8,8],offset:[0,0],startMs:0,durationMs:100,sha256:sha}] });
  const seated = asset('seated','actual'), work = asset('work','work');
  const entry = {...asset('detached','detached'),gesture:{entrySourceSha256:'actual',grabNext:['carry'],releaseNext:[],embeddedStool:false,settled:false,restoreOnRelease:true}};
  const carry = {...asset('carry','carry'),gesture:{grabNext:[],releaseNext:['land'],embeddedStool:false,settled:false,restoreOnRelease:false}};
  const land = {...asset('land','land'),gesture:{grabNext:['carry'],releaseNext:[],embeddedStool:true,settled:true,restoreOnRelease:false}};
  const p = new CompanionPlayback([seated,entry,carry,land,work]);p.request('seated');
  expect(p.grab({packageId:'seated',exposure:0})).toBe(true); expect(p.current?.id).toBe('detached');
  p.release({packageId:'detached',exposure:0});expect(p.canPauseRepeatedMotion()).toBe(false);p.tick(100);expect(p.current?.id).toBe('seated');expect(p.gesture).toBeNull();
  p.grab({packageId:'seated',exposure:0});p.tick(100);expect(p.current?.id).toBe('carry');
  p.request('work');expect(p.current?.id).toBe('carry'); // Host presentation never steals the drag canvas.
  p.release({packageId:'carry',exposure:0});p.release();p.tick(200);expect(p.current?.id).toBe('work');expect(p.gesture).toBeNull();
  carry.gesture = { ...carry.gesture, restoreSourceSha256: 'work' } as typeof carry.gesture;
  p.request('seated');p.tick(100);p.grab({packageId:'seated',exposure:0});p.tick(100);
  p.release({packageId:'carry',exposure:0});
  p.canDisplay = id => id !== 'work';p.tick(100);expect(p.current?.id).toBe('carry');expect(p.loading).toBe('work');
  p.canDisplay = () => true;p.advance();expect(p.current?.id).toBe('work');expect(p.gesture).toBeNull(); // Exact seated counterpart, not the original pre-grab angle.
});

it('prepares the immediate detached drawing before a landing seat can be shown and regrabbed', () => {
  const asset = (id: string, sha: string): PlaybackAsset => ({ id, entryPose: 'seat', exitPose: 'seat', geometryReference: 'shared', stage: 'motion-candidate', reviewStatus: 'accepted', canvas: [16,16], pages: [{file:'atlas.png'}], durationMs: 100, frames: [{page:0,rect:[0,0,8,8],offset:[0,0],startMs:0,durationMs:100,sha256:sha}] });
  const gesture = { grabNext: [] as string[], releaseNext: [] as string[], embeddedStool: false, settled: false, restoreOnRelease: false };
  const rest = asset('rest','rest');
  const entry = {...asset('entry','entry'),gesture:{...gesture,entrySourceSha256:'rest',grabNext:['air']}};
  const air = {...asset('air','air'),gesture:{...gesture,releaseNext:['seat']}};
  const seat = {...asset('seat','seat'),gesture:{...gesture,embeddedStool:true,settled:true,grabImmediate:'seat-detached',grabNext:['air']}};
  const detached = {...asset('seat-detached','seat-detached'),gesture:{...gesture,grabNext:['air']}};
  const assets = [rest,entry,air,seat,detached], dependencies = pickupPreloadDependencies(assets);
  const ready = new Set(['rest','entry','air','seat']);
  const player = new CompanionPlayback(assets);
  player.canDisplay = id => ready.has(id) && (dependencies.get(id) ?? []).every(next => ready.has(next));
  player.request('rest'); player.grab(); player.tick(100); player.release(); player.tick(100);
  expect(player.current?.id).toBe('air'); expect(player.loading).toBe('seat');
  // The decoder uses the same direct dependency set for its pending landing.
  expect(dependencies.get(player.loading!)).toContain('seat-detached');
  ready.add('seat-detached'); player.advance();
  expect(player.current?.id).toBe('seat');
  expect(player.grab({packageId:'seat',exposure:0})).toBe(true);
  expect(player.current?.id).toBe('seat-detached'); expect(player.loading).toBeNull();
});

it('keeps task activity factual but never casts the observing companion as its executor', () => {
  const generating = project(snap({ activeRun: { state: 'generating' } }), 'current');
  expect(generating.state).toBe('C04'); // The project detail still knows the actual state.
  for (const action of ['think', 'accept', 'prepare', 'dispatch', 'reading', 'editing', 'organizing', 'output', 'output-emphasis']) {
    expect(companionObserverAction(action)).toBe('execution-observe');
    expect(companionObserverAction(action, true)).toBe(action); // Explicit art review only.
  }
  for (const action of ['permission', 'query', 'failure', 'unknown-effect-check', 'completion', 'understood', 'permission-allowed', 'cancel-settling']) {
    expect(companionObserverAction(action)).toBe(action);
  }
});
