/**
 * One animation frame. Uses `requestAnimationFrame` where it exists and a 16ms
 * timer elsewhere (tests, workers), so frame-driven code runs in both. The
 * callback receives a millisecond timestamp from a single clock per loop.
 */
export interface FrameHandle {
  cancel(): void;
}

const updates = new Map<number, (time: number) => void>();
const followers = new Map<number, (time: number) => void>();
let nextId = 0;
let scheduled: FrameHandle | null = null;
let flushing = false;

const scheduleNative = (callback: (time: number) => void): FrameHandle => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    const handle = globalThis.requestAnimationFrame(callback);
    return { cancel: () => globalThis.cancelAnimationFrame(handle) };
  }
  // Date keeps fake timers in tests and the timestamp on the same clock.
  const handle = setTimeout(() => callback(Date.now()), 16);
  return { cancel: () => clearTimeout(handle) };
};

const run = (callbacks: Map<number, (time: number) => void>, time: number): void => {
  // Remove before calling: a callback can schedule itself for the next frame.
  for (const [id, callback] of [...callbacks]) {
    if (!callbacks.delete(id)) continue;
    try { callback(time); } catch (error) { queueMicrotask(() => { throw error; }); }
  }
};

const schedule = (): void => {
  if (scheduled || flushing || (!updates.size && !followers.size)) return;
  scheduled = scheduleNative(time => {
    scheduled = null;
    flushing = true;
    try {
      run(updates, time);
      run(followers, time);
    } finally {
      flushing = false;
      schedule();
    }
  });
};

const enqueue = (queue: Map<number, (time: number) => void>, callback: (time: number) => void): FrameHandle => {
  const id = ++nextId;
  queue.set(id, callback);
  schedule();
  return { cancel: () => {
    queue.delete(id);
    if (!updates.size && !followers.size) { scheduled?.cancel(); scheduled = null; }
  } };
};

/** Frame updates share one clock and one browser callback. */
export const requestFrame = (callback: (time: number) => void): FrameHandle => enqueue(updates, callback);

/** Follow geometry after this frame's springs have written, before painting.
 * A follower that schedules itself runs again on the next frame. */
export const requestAfterFrame = (callback: (time: number) => void): FrameHandle => enqueue(followers, callback);
