import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SWIPE_COMMIT_SHARE,
  rubberBand,
  shouldCommitSwipe,
  swipeOffset,
  swipeOpacity,
  swipeVelocity,
} from './edgeSwipe';

const navigation = vi.hoisted(() => ({
  count: 3,
  selected: { threadId: 'a', branchId: 'main' } as { threadId: string; branchId: string },
  switchRelativeThread: vi.fn(async (step: number) => {
    navigation.selected = { threadId: step < 0 ? 'previous' : 'next', branchId: 'main' };
  }),
  tapHaptic: vi.fn(),
}));

vi.mock('@/lib/agent-runtime/threadNavigation', () => ({
  navigableThreadCount: () => navigation.count,
  switchRelativeThread: navigation.switchRelativeThread,
}));
vi.mock('@/stores/useThreadStore', () => ({
  useThreadStore: { getState: () => ({ selectedIdentity: navigation.selected }) },
}));
vi.mock('@/lib/motion/haptics', () => ({ tapHaptic: navigation.tapHaptic }));

const { useEdgeSwipeSessionSwitch } = await import('./useEdgeSwipeSessionSwitch');

describe('edge swipe arithmetic', () => {
  it('follows the finger toward the centre and gives way less the further a dead end is pulled', () => {
    expect(swipeOffset(120, 400, 1, true)).toBe(120);
    expect(swipeOffset(-120, 400, -1, true)).toBe(-120);
    const near = swipeOffset(40, 400, 1, false);
    const far = swipeOffset(200, 400, 1, false);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeLessThan(200 * 0.4);
    // Per pixel of pull, the band gives less the further it already is.
    expect((far - near) / 160).toBeLessThan(near / 40);
    // Back past the start meets a stiffer band.
    expect(swipeOffset(-80, 400, 1, true)).toBeLessThan(0);
    expect(swipeOffset(-80, 400, 1, true)).toBeGreaterThan(-30);
    expect(rubberBand(0, 48)).toBe(0);
  });

  it('measures velocity over the end of the gesture only', () => {
    const samples = [{ t: 0, x: 0 }, { t: 100, x: 10 }, { t: 160, x: 70 }, { t: 180, x: 100 }];
    expect(swipeVelocity(samples)).toBeCloseTo(90 / 80);
    expect(swipeVelocity([{ t: 0, x: 5 }])).toBe(0);
  });

  it('commits on a throw or a long pull, and not on a pull flicked back', () => {
    const base = { width: 400, toward: 1 as const, canSwitch: true };
    expect(shouldCommitSwipe({ ...base, dx: 60, velocity: 0.8 })).toBe(true);
    expect(shouldCommitSwipe({ ...base, dx: 60, velocity: 0.2 })).toBe(false);
    expect(shouldCommitSwipe({ ...base, dx: 400 * SWIPE_COMMIT_SHARE + 1, velocity: 0 })).toBe(true);
    expect(shouldCommitSwipe({ ...base, dx: 300, velocity: -0.6 })).toBe(false);
    expect(shouldCommitSwipe({ ...base, dx: 300, velocity: 1, canSwitch: false })).toBe(false);
    expect(shouldCommitSwipe({ ...base, toward: -1, dx: -200, velocity: -0.1 })).toBe(true);
    expect(swipeOpacity(0, 400)).toBe(1);
    expect(swipeOpacity(400, 400)).toBeCloseTo(0.65);
  });
});

describe('useEdgeSwipeSessionSwitch', () => {
  let root: Root;
  let container: HTMLElement;
  let doc: Document;
  let win: Window;
  let animated: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions }>;
  const commits: string[] = [];

  function Harness() {
    const main = React.useRef<HTMLElement>(null);
    const surface = React.useRef<HTMLDivElement>(null);
    const options = React.useMemo(() => ({ surface, onCommit: (direction: string) => { commits.push(direction); } }), []);
    useEdgeSwipeSessionSwitch(main, options);
    return <main ref={main}><div ref={surface} data-surface /></main>;
  }

  beforeEach(async () => {
    const parsed = parseHTML('<html><body></body></html>');
    doc = parsed.document;
    win = parsed.window as unknown as Window;
    vi.stubGlobal('window', parsed.window); vi.stubGlobal('document', parsed.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('HTMLElement', parsed.window.HTMLElement);
    animated = [];
    commits.length = 0;
    navigation.count = 3;
    navigation.selected = { threadId: 'a', branchId: 'main' };
    navigation.switchRelativeThread.mockClear();
    navigation.tapHaptic.mockClear();
    parsed.window.HTMLElement.prototype.animate = function animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      animated.push({ keyframes, options });
      return { cancel: () => undefined, playState: 'running', finished: Promise.resolve() } as unknown as Animation;
    } as unknown as typeof HTMLElement.prototype.animate;
    container = doc.createElement('div');
    doc.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
    Object.defineProperty(doc.querySelector('main'), 'clientWidth', { value: 400 });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  const main = () => doc.querySelector('main')!;
  const surface = () => doc.querySelector<HTMLElement>('[data-surface]')!;
  const touch = (type: string, x: number, y: number, t: number) => {
    const event = new (win as unknown as { Event: typeof Event }).Event(type);
    const point = [{ clientX: x, clientY: y }];
    Object.defineProperties(event, {
      touches: { value: type === 'touchend' || type === 'touchcancel' ? [] : point },
      changedTouches: { value: point },
      timeStamp: { value: t },
    });
    main().dispatchEvent(event);
  };

  it('follows the finger from the left edge and, thrown, leaves rightward and switches to the previous session', async () => {
    touch('touchstart', 4, 300, 0);
    touch('touchmove', 30, 302, 16);
    touch('touchmove', 150, 304, 64);
    expect(surface().style.transform).toBe('translateX(146px)');
    expect(Number(surface().style.opacity)).toBeLessThan(1);
    touch('touchend', 230, 304, 96);
    expect(navigation.tapHaptic).toHaveBeenCalledTimes(1);
    expect(commits).toEqual(['prev']);
    const leave = animated.at(-1)!;
    expect(String(leave.keyframes[1]!.transform)).toBe('translateX(240px)');
    expect(leave.keyframes[1]!.opacity).toBe(0);
    // The animation holds the picture; the inline styles are gone in the same task.
    expect(surface().style.transform).toBe('');
    // The session switches once the old content has left, so the next one is never seen leaving.
    expect(navigation.switchRelativeThread).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(navigation.switchRelativeThread).toHaveBeenCalledWith(-1));
  });

  it('springs home from a short, slow pull without switching', () => {
    touch('touchstart', 396, 300, 0);
    touch('touchmove', 370, 300, 40);
    touch('touchmove', 330, 301, 200);
    expect(surface().style.transform).toBe('translateX(-66px)');
    touch('touchend', 326, 301, 400);
    expect(navigation.switchRelativeThread).not.toHaveBeenCalled();
    expect(navigation.tapHaptic).not.toHaveBeenCalled();
    const home = animated.at(-1)!;
    expect(String(home.keyframes[0]!.transform)).toBe('translateX(-66px)');
    expect(home.keyframes[1]!.transform).toBe('none');
    expect(surface().style.transform).toBe('');
  });

  it('brings the content back when a second finger lands mid-drag', () => {
    touch('touchstart', 4, 300, 0);
    touch('touchmove', 30, 300, 16);
    touch('touchmove', 120, 300, 40);
    const event = new (win as unknown as { Event: typeof Event }).Event('touchmove');
    Object.defineProperties(event, { touches: { value: [{ clientX: 130, clientY: 300 }, { clientX: 200, clientY: 500 }] }, timeStamp: { value: 60 } });
    main().dispatchEvent(event);
    expect(surface().style.transform).toBe('');
    expect(animated.at(-1)!.keyframes[1]!.transform).toBe('none');
    touch('touchend', 130, 300, 80);
    expect(navigation.switchRelativeThread).not.toHaveBeenCalled();
  });

  it('lets a vertical scroll that starts at the edge go', () => {
    touch('touchstart', 6, 300, 0);
    touch('touchmove', 9, 340, 30);
    touch('touchmove', 120, 340, 60);
    touch('touchend', 200, 340, 80);
    expect(surface().style.transform).toBe('');
    expect(navigation.switchRelativeThread).not.toHaveBeenCalled();
  });

  it('meets a rubber band and never switches with a single session', () => {
    navigation.count = 1;
    touch('touchstart', 4, 300, 0);
    touch('touchmove', 30, 300, 16);
    touch('touchmove', 300, 300, 50);
    const offset = parseFloat(surface().style.transform.replace('translateX(', ''));
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(60);
    touch('touchend', 380, 300, 60);
    expect(navigation.switchRelativeThread).not.toHaveBeenCalled();
  });

  it('still switches without following under reduced motion', async () => {
    doc.documentElement.dataset.motion = 'reduced';
    touch('touchstart', 4, 300, 0);
    touch('touchmove', 30, 300, 16);
    touch('touchmove', 200, 300, 50);
    expect(surface().style.transform).toBe('');
    touch('touchend', 260, 300, 70);
    await vi.waitFor(() => expect(navigation.switchRelativeThread).toHaveBeenCalledWith(-1));
    expect(animated).toHaveLength(0);
  });
});
