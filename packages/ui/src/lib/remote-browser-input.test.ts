import { describe, expect, test, vi } from 'vitest';
import type { BrowserFrameInfo, BrowserInputRequest, BrowserUserInput } from '@varin/protocol';
import { createBrowserInputQueue } from './remote-browser-input';

const frame: BrowserFrameInfo = { browserId: 'browser', pageId: 'page', pageGeneration: 'page-generation', ownerGeneration: 'owner',
  streamId: 'stream', sequence: 1, controlEpoch: 'control', viewport: { width: 800, height: 600, scale: 1 }, mimeType: 'image/jpeg' };
const press: BrowserUserInput = { type: 'key', phase: 'down', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, location: 0, modifiers: 0, autoRepeat: false };
const motion = (x: number): BrowserUserInput => ({ type: 'pointer', phase: 'move', x, y: 20, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 });
const deferred = () => { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('remote browser human input lane', () => {
  test('termination waits for the original press, drops unsent input and releases once', async () => {
    const pending = deferred(), calls: BrowserInputRequest[] = [], failed = vi.fn();
    const queue = createBrowserInputQueue({ frame: () => frame, failed, send: async request => { calls.push(request); if (calls.length === 1) await pending.promise; } });
    queue.enqueue(press); await Promise.resolve(); queue.enqueue(motion(20));
    const stopped = queue.stop(); expect(queue.stop()).toBe(stopped);
    queue.enqueue(press); await Promise.resolve(); expect(calls.map(value => value.input.type)).toEqual(['key']);
    pending.resolve(); await stopped;
    expect(calls.map(value => value.input.type)).toEqual(['key', 'release']); expect(failed).not.toHaveBeenCalled();
    queue.resume(); queue.enqueue(press); await Promise.resolve(); expect(calls).toHaveLength(2);
  });

  test('coalesces only unsent motion and retains input barriers in order', async () => {
    const pending = deferred(), calls: BrowserInputRequest[] = [];
    const queue = createBrowserInputQueue({ frame: () => frame, failed: error => { throw error; }, send: async request => { calls.push(request); if (calls.length === 1) await pending.promise; } });
    queue.enqueue(press); await Promise.resolve(); queue.enqueue(motion(1)); queue.enqueue(motion(2)); queue.enqueue(press); queue.enqueue(motion(3));
    pending.resolve(); await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.map(value => value.input.type === 'pointer' ? value.input.x : value.input.type)).toEqual(['key', 2, 'key', 3]);
    await queue.stop();
  });

  test('a late rejection from revoked control cannot discard the new control lane', async () => {
    const pending = deferred(), calls: BrowserInputRequest[] = [], failed = vi.fn(); let current = frame;
    const queue = createBrowserInputQueue({ frame: () => current, failed, send: async request => { calls.push(request); if (calls.length === 1) await pending.promise; } });
    queue.enqueue(press); await Promise.resolve();
    current = { ...frame, controlEpoch: 'new-control' }; queue.resume(); queue.enqueue(motion(9));
    pending.reject(new Error('Old control was revoked'));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.controlEpoch).toBe('new-control'); expect(failed).not.toHaveBeenCalled();
    await queue.stop();
  });
});


test('waiting for settled input drains the original click before screenshot capture', async () => {
  const first = deferred(), second = deferred(), calls: BrowserInputRequest[] = [];
  const queue = createBrowserInputQueue({ frame: () => frame, failed: vi.fn(), send: async request => {
    calls.push(request); if (calls.length === 1) await first.promise; else if (calls.length === 2) await second.promise;
  } });
  queue.enqueue(press); await Promise.resolve(); queue.enqueue(motion(12));
  const settled = vi.fn(); const waiting = queue.settled().then(settled);
  first.resolve(); await vi.waitFor(() => expect(calls).toHaveLength(2)); expect(settled).not.toHaveBeenCalled();
  second.resolve(); await waiting; expect(settled).toHaveBeenCalledOnce(); await queue.stop();
});
