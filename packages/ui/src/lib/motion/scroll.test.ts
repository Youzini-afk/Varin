import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installScrollMotion, isViewportScrolling, moveViewport, SCROLL_INTENT, stopViewportScroll } from './scroll';
import { useUIStore } from '@/stores/useUIStore';

let viewport: HTMLElement, dispose: () => void, frames: Map<number, FrameRequestCallback>, time: number, id: number;
const advance = (count = 1) => {
  for (let i = 0; i < count; i++) {
    time += 1000 / 60;
    for (const [key, callback] of [...frames]) if (frames.delete(key)) callback(time);
  }
};
const fire = (type: string, data: Record<string, unknown> = {}, target = viewport) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, data); target.dispatchEvent(event); return event;
};
const wheel = (deltaY: number, data: Record<string, unknown> = {}, target = viewport) => fire('wheel', { deltaY, deltaX: 0, deltaMode: 1, ...data }, target);
beforeEach(() => {
  const { window, document } = parseHTML('<html><body><div id="scroll"></div></body></html>');
  for (const [key, value] of Object.entries({ window, document, Element: window.Element, HTMLElement: window.HTMLElement, Event: window.Event, CustomEvent: window.CustomEvent })) vi.stubGlobal(key, value);
  frames = new Map(); time = 0; id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  viewport = document.getElementById('scroll')!;
  Object.defineProperties(viewport, { clientHeight: { value: 600 }, scrollHeight: { value: 3000, writable: true }, scrollTop: { value: 600, writable: true } });
  useUIStore.setState({ motionPreference: 'full' });
  dispose = installScrollMotion(viewport);
});
afterEach(() => { dispose(); expect(frames.size).toBe(0); vi.unstubAllGlobals(); });

it('accumulates detents into one motion, reverses immediately, and stops on pointer takeover', () => {
  expect(wheel(5).defaultPrevented).toBe(true);
  advance(2); const first = viewport.scrollTop;
  expect(first).toBeGreaterThan(600); expect(first).toBeLessThan(720);
  wheel(5); advance(2);
  expect(viewport.scrollTop).toBeGreaterThan(first);
  const reversal = viewport.scrollTop;
  wheel(-2); advance();
  expect(viewport.scrollTop).toBeLessThan(reversal);
  fire('pointerdown', { button: 0, pointerType: 'mouse' });
  const stopped = viewport.scrollTop; advance(30);
  expect(viewport.scrollTop).toBe(stopped); expect(isViewportScrolling(viewport)).toBe(false);
});

it('retains platform pixel gestures, pinch/sideways input, and cancels an earlier wheel tail', () => {
  wheel(4); advance();
  const before = viewport.scrollTop;
  expect(wheel(7.4, { deltaMode: 0, wheelDeltaY: -22.2 }).defaultPrevented).toBe(false);
  advance(20); expect(viewport.scrollTop).toBe(before);
  expect(wheel(3, { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(wheel(3, { deltaX: 20 }).defaultPrevented).toBe(false);
  expect(wheel(100, { deltaMode: 0, wheelDeltaY: -120 }).defaultPrevented).toBe(true);
  advance(40); expect(viewport.scrollTop).toBeCloseTo(before + 100, 1);
});

it('keeps nested tool and editor input local, including at the child boundary', () => {
  const child = document.createElement('div'); child.setAttribute('data-conversation-tool-scroll', 'true'); viewport.append(child);
  Object.defineProperties(child, { clientHeight: { value: 100 }, scrollHeight: { value: 400 }, scrollTop: { value: 300 } });
  const intent = vi.fn(); viewport.addEventListener(SCROLL_INTENT, intent);
  expect(wheel(5, {}, child).defaultPrevented).toBe(false);
  const textarea = document.createElement('textarea'); viewport.append(textarea);
  expect(fire('keydown', { key: 'ArrowDown' }, textarea).defaultPrevented).toBe(false);
  expect(intent).not.toHaveBeenCalled(); expect(isViewportScrolling(viewport)).toBe(false);
  const short = document.createElement('div'); viewport.append(short);
  Object.defineProperties(short, { clientHeight: { value: 100 }, scrollHeight: { value: 100 }, scrollTop: { value: 0, writable: true } });
  const uninstall = installScrollMotion(short);
  try {
    wheel(5, {}, short); advance(30);
    expect(viewport.scrollTop).toBeGreaterThan(600);
    expect(short.scrollTop).toBe(0);
  } finally { uninstall(); }
});

it('carries layout compensation through a moving target and pages with reading overlap', () => {
  wheel(5); advance(3);
  viewport.scrollTop += 300;
  advance(40); expect(viewport.scrollTop).toBeCloseTo(1020, 1);
  fire('keydown', { key: 'PageDown' }); advance(50);
  expect(viewport.scrollTop).toBeCloseTo(1572, 1);
  fire('keydown', { key: 'PageUp' }); advance(50);
  expect(viewport.scrollTop).toBeCloseTo(1020, 1);
});

it('supports direct thumb placement and honors reduced motion without leftover writes', () => {
  wheel(5); advance();
  moveViewport(viewport, 1200, false); advance(40); expect(viewport.scrollTop).toBe(1200);
  wheel(5); advance(); stopViewportScroll(viewport);
  useUIStore.setState({ motionPreference: 'reduced' });
  expect(wheel(5).defaultPrevented).toBe(false);
  fire('keydown', { key: 'Home' }); expect(viewport.scrollTop).toBe(0);
  expect(isViewportScrolling(viewport)).toBe(false);
});
