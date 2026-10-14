import { afterEach, expect, it, vi } from 'vitest';
import { scheduleAtDeadline } from './deadline.js';
afterEach(() => vi.useRealTimers());
it('honors long deadlines and cancellation without timer overflow', () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const called = vi.fn();
  const cancel = scheduleAtDeadline(2_147_483_648, called);
  vi.advanceTimersByTime(2_147_483_647);
  expect(called).not.toHaveBeenCalled();
  cancel(); vi.advanceTimersByTime(1);
  expect(called).not.toHaveBeenCalled();
  scheduleAtDeadline(Date.now() + 10, called);
  vi.advanceTimersByTime(10);
  expect(called).toHaveBeenCalledOnce();
});
