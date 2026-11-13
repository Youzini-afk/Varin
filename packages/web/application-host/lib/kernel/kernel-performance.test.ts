import {afterEach, expect, it, vi} from 'vitest';
import {KernelPerformance} from './kernel-performance.js';
afterEach(() => vi.restoreAllMocks());
it('records window wait and final round trip separately, without double-counting settlement', () => {
  let now = 10;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const counters = new KernelPerformance();
  const request = counters.start('runtime.thread.view');
  now = 12; request.admitted();
  now = 18; request.finished();
  now = 24; request.finished();
  expect(counters.snapshot()['runtime.thread.view']).toMatchObject({count: 1, disconnected: 0,
    windowWait: {count: 1, totalMs: 2}, roundTrip: {count: 1, totalMs: 6}});
  counters.reset();
  expect(counters.snapshot()).toEqual({});
});
it('distinguishes disconnects and requests that never entered the wire', () => {
  const counters = new KernelPerformance();
  const queued = counters.start('queued'); queued.finished();
  const request = counters.start('disconnected'); request.admitted(); request.finished(true);
  expect(counters.snapshot().queued).toMatchObject({count: 1, roundTrip: {count: 0}});
  expect(counters.snapshot().disconnected).toMatchObject({count: 1, disconnected: 1, roundTrip: {count: 1}});
});
