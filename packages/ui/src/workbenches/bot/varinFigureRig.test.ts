import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const frames = vi.hoisted(() => ({ queue: [] as ((time: number) => void)[] }));
vi.mock('@/lib/motion/frame', () => ({
  requestFrame: (callback: (time: number) => void) => {
    frames.queue.push(callback);
    return { cancel: () => { const at = frames.queue.indexOf(callback); if (at >= 0) frames.queue.splice(at, 1); } };
  },
}));

import { VarinFigureRig } from './varinFigureRig';

describe('Bot figure', () => {
  let host: HTMLElement;
  let visibility: DocumentVisibilityState;
  let notify: () => void;

  beforeEach(() => {
    const { window, document, Event } = parseHTML('<!doctype html><html><body></body></html>');
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
    notify = () => { document.dispatchEvent(new Event('visibilitychange')); };
    frames.queue.length = 0;
    host = document.createElement('span');
    document.body.append(host);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const flush = (time: number): void => { for (const callback of frames.queue.splice(0)) callback(time); };

  it('holds a still pose without running frames', () => {
    const figure = new VarinFigureRig(host, { state: 'sleeping', compact: true, still: true });
    expect(host.querySelector('svg')).not.toBeNull();
    expect(host.dataset.state).toBe('sleeping');
    figure.setState('waiting');
    expect(host.dataset.state).toBe('waiting');
    expect(frames.queue).toHaveLength(0);
    figure.dispose();
    expect(host.querySelector('svg')).toBeNull();
  });

  it('animates only while the page is visible', () => {
    const figure = new VarinFigureRig(host, { state: 'idle', compact: false, still: false });
    expect(frames.queue).toHaveLength(1);
    flush(16);
    figure.setState('result');
    flush(32);
    expect(frames.queue).toHaveLength(1);

    visibility = 'hidden';
    notify();
    flush(48);
    expect(frames.queue).toHaveLength(0);

    visibility = 'visible';
    notify();
    expect(frames.queue).toHaveLength(1);
    figure.dispose();
    expect(frames.queue).toHaveLength(0);
  });
});
