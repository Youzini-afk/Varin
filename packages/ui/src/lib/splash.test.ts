import { afterEach, expect, test, vi } from 'vitest';
import { SPLASH_EXIT_DURATION_MS, SPLASH_HANDOFF_ATTRIBUTE } from '@/components/ui/varin-splash-lattice';
import { dismissInitialSplash } from './splash';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const fixture = (withFrames = true) => {
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  const attributes = new Map<string, string>();
  let removed = false;
  const ownerWindow = {
    setTimeout,
    requestAnimationFrame: withFrames
      ? (callback: FrameRequestCallback) => frames.push(callback)
      : undefined,
  };
  const ownerDocument = {
    defaultView: ownerWindow,
    documentElement: {
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      removeAttribute: (name: string) => { attributes.delete(name); },
    },
    getElementById: (id: string): unknown => id === 'initial-loading' && !removed ? element : null,
  };
  const element = {
    ownerDocument,
    style: { opacity: '' },
    setAttribute: vi.fn(),
    remove: () => { removed = true; },
  };
  vi.stubGlobal('document', ownerDocument);
  const paint = () => {
    const pending = frames.splice(0);
    for (const callback of pending) callback(0);
  };
  return { attributes, element, paint, removed: () => removed };
};

test('boot gives a transparent layer a paint before detaching and keeps the background through cleanup', () => {
  const host = fixture();
  dismissInitialSplash();
  dismissInitialSplash();
  expect(host.element.setAttribute).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(SPLASH_EXIT_DURATION_MS - 1);
  expect(host.element.style.opacity).toBe('');
  expect(host.removed()).toBe(false);
  vi.advanceTimersByTime(1);
  expect(host.element.style.opacity).toBe('0');
  expect(host.removed()).toBe(false);

  // Another ready signal during retirement cannot start the animation again.
  dismissInitialSplash();
  expect(host.element.setAttribute).toHaveBeenCalledTimes(1);
  host.paint();
  expect(host.removed()).toBe(false);
  host.paint();
  expect(host.removed()).toBe(true);
  expect(host.attributes.get(SPLASH_HANDOFF_ATTRIBUTE)).toBe('true');
  host.paint();
  expect(host.attributes.get(SPLASH_HANDOFF_ATTRIBUTE)).toBe('true');
  host.paint();
  expect(host.attributes.has(SPLASH_HANDOFF_ATTRIBUTE)).toBe(false);
});

test('a host without a frame scheduler still completes boot retirement', () => {
  const host = fixture(false);
  dismissInitialSplash();
  vi.advanceTimersByTime(SPLASH_EXIT_DURATION_MS);
  expect(host.removed()).toBe(true);
  vi.runAllTimers();
  expect(host.attributes.has(SPLASH_HANDOFF_ATTRIBUTE)).toBe(false);
});
