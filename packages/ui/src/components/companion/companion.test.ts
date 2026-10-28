import { expect, it } from 'vitest';
import type { ThreadSnapshot } from '@varin/application-client';
import { projectCompanionIntent as project } from './presentation';
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
  player.tick(150); expect(player.current?.id).toBe('bridge');
  expect(route.clips).toEqual(['bridge','work']);
  player.tick(300); expect(player.current?.id).toBe('work');
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
