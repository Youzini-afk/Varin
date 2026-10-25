import { afterEach, expect, it, vi } from 'vitest';
import { requestAfterFrame, requestFrame } from './frame';
import { SpringDriver, omegaSpring } from './spring';

afterEach(() => vi.unstubAllGlobals());

it('shares a frame and follows every spring after its writes, once before paint', () => {
  let next: FrameRequestCallback | undefined;
  const raf = vi.fn((callback: FrameRequestCallback) => { next = callback; return 1; });
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', () => { next = undefined; });
  const order: string[] = [];
  const first = new SpringDriver({ spring: omegaSpring(14), onUpdate: () => order.push('first') });
  const second = new SpringDriver({ spring: omegaSpring(14), onUpdate: () => order.push('second') });
  requestAfterFrame(() => order.push('follow'));
  first.to(100); second.to(200);
  expect(raf).toHaveBeenCalledTimes(1);
  next!(16);
  expect(order).toEqual(['first', 'second', 'follow']);
  first.stop(); second.stop();
});

it('allows cancellation during a frame and defers a self-scheduled follower', () => {
  let next: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { next = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => { next = undefined; });
  const calls: string[] = [];
  const cancelled = requestAfterFrame(() => calls.push('cancelled'));
  requestFrame(() => { cancelled.cancel(); calls.push('write'); });
  requestAfterFrame(() => { calls.push('first'); requestAfterFrame(() => calls.push('next')); });
  next!(16);
  expect(calls).toEqual(['write', 'first']);
  next!(32);
  expect(calls).toEqual(['write', 'first', 'next']);
});
