import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ScrollTravel } from './scrollTravel';

let viewport: HTMLElement, travel: ScrollTravel, frames: Map<number, FrameRequestCallback>;
let animations: { finish(): void; cancel: ReturnType<typeof vi.fn> }[];
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)); };
beforeEach(() => {
  const { document } = parseHTML('<html><body><div></div></body></html>');
  viewport = document.querySelector('div')!; frames = new Map(); animations = [];
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  viewport.animate = vi.fn(() => {
    let finish!: () => void, reject!: (reason: Error) => void;
    const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
    const cancel = vi.fn(() => reject(new Error('cancelled')));
    animations.push({ finish, cancel });
    return { finished, cancel } as unknown as Animation;
  });
  travel = new ScrollTravel(viewport);
});
afterEach(() => { travel.stop(); expect(frames.size).toBe(0); vi.unstubAllGlobals(); });

it('places the destination only after departure and is interruptible on either side of placement', async () => {
  const place = vi.fn();
  travel.start(place); travel.stop(); animations[0]!.finish(); await Promise.resolve();
  expect(place).not.toHaveBeenCalled();
  travel.start(place); animations[1]!.finish(); await Promise.resolve();
  expect(place).toHaveBeenCalledTimes(1); expect(travel.active).toBe(true);
  flush(); expect(animations).toHaveLength(3);
  travel.stop(); expect(animations[2]!.cancel).toHaveBeenCalled();
  expect(travel.active).toBe(false);
  flush(); expect(place).toHaveBeenCalledTimes(1);
});
