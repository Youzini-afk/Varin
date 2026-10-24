/**
 * One animation frame. Uses `requestAnimationFrame` where it exists and a 16ms
 * timer elsewhere (tests, workers), so frame-driven code runs in both. The
 * callback receives a millisecond timestamp from a single clock per loop.
 */
export interface FrameHandle {
  cancel(): void;
}

export const requestFrame = (callback: (time: number) => void): FrameHandle => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    const handle = globalThis.requestAnimationFrame(callback);
    return { cancel: () => globalThis.cancelAnimationFrame(handle) };
  }
  // Date keeps fake timers in tests and the timestamp on the same clock.
  const handle = setTimeout(() => callback(Date.now()), 16);
  return { cancel: () => clearTimeout(handle) };
};
