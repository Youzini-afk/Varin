import { afterEach, expect, test, vi } from 'vitest';
import {
  SPLASH_EXIT_DURATION_MS,
  SPLASH_HANDOFF_ATTRIBUTE,
  SPLASH_REDUCED_EXIT_DURATION_MS,
  splashTilePlaybackTiming,
} from '@/components/ui/varin-splash-lattice';
import {
  STARTUP_ENTRANCE_ATTRIBUTE,
  playStartupEntrance,
  resetStartupEntranceForTests,
  startupEntranceMs,
} from '@/lib/motion/startupEntrance';
import { dismissInitialSplash } from './splash';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * `clock` gives the host a page clock (how long the splash has been up) and a reduced-motion query.
 * Without it the host has neither, which is the full exit.
 */
const fixture = (withFrames = true, clock?: { now: number; reduced?: boolean }) => {
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  const attributes = new Map<string, string>();
  const properties = new Map<string, string>();
  let removed = false;
  const ownerWindow = {
    setTimeout,
    requestAnimationFrame: withFrames
      ? (callback: FrameRequestCallback) => frames.push(callback)
      : undefined,
    ...(clock ? {
      performance: { now: () => clock.now },
      matchMedia: (query: string) => ({ matches: Boolean(clock.reduced) && query.includes('reduce') }),
    } : {}),
  };
  const ownerDocument = {
    defaultView: ownerWindow,
    documentElement: {
      dataset: {} as DOMStringMap,
      style: {
        setProperty: (name: string, value: string) => { properties.set(name, value); },
        removeProperty: (name: string) => { properties.delete(name); },
      },
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
  return { attributes, element, paint, properties, removed: () => removed };
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

test.each([600, 5000])('a ready app at %ims keeps the complete camera, press and scatter timeline', (now) => {
  resetStartupEntranceForTests();
  const host = fixture(true, { now });
  const timing = splashTilePlaybackTiming('standard');
  dismissInitialSplash();
  expect(host.element.setAttribute).toHaveBeenCalledTimes(1);
  expect(host.element.setAttribute).toHaveBeenCalledWith('data-leaving', 'true');
  expect(host.attributes.get(STARTUP_ENTRANCE_ATTRIBUTE)).toBe('playing');
  expect(host.properties.get('--startup-entrance-delay')).toBe(`${timing.releaseMs}ms`);
  vi.advanceTimersByTime(timing.releaseMs);
  expect(host.element.style.opacity).toBe('');
  expect(host.removed()).toBe(false);
  vi.advanceTimersByTime(SPLASH_EXIT_DURATION_MS - timing.releaseMs - 1);
  expect(host.element.style.opacity).toBe('');
  vi.advanceTimersByTime(1);
  expect(host.element.style.opacity).toBe('0');
  host.paint();
  host.paint();
  expect(host.removed()).toBe(true);
  vi.advanceTimersByTime(startupEntranceMs(timing.releaseMs) + 50);
  expect(host.attributes.has(STARTUP_ENTRANCE_ATTRIBUTE)).toBe(false);
  expect(host.properties.has('--startup-entrance-delay')).toBe(false);
});

test('reduced motion removes the cover after its one fade', () => {
  resetStartupEntranceForTests();
  const host = fixture(true, { now: 600, reduced: true });
  dismissInitialSplash();
  expect(host.element.setAttribute).toHaveBeenCalledTimes(1);
  expect(host.attributes.has(STARTUP_ENTRANCE_ATTRIBUTE)).toBe(false);
  vi.advanceTimersByTime(SPLASH_REDUCED_EXIT_DURATION_MS);
  expect(host.element.style.opacity).toBe('0');
  host.paint();
  host.paint();
  expect(host.removed()).toBe(true);
});

test('the entrance does not play below full motion, and plays once per page', () => {
  resetStartupEntranceForTests();
  const root = { dataset: { motion: 'reduced' } as DOMStringMap, style: { setProperty: vi.fn(), removeProperty: vi.fn() }, setAttribute: vi.fn(), removeAttribute: vi.fn() };
  expect(playStartupEntrance(root, 80)).toBe(false);
  expect(root.setAttribute).not.toHaveBeenCalled();
  root.dataset.motion = 'full';
  expect(playStartupEntrance(root, 80)).toBe(false);
  resetStartupEntranceForTests();
  expect(playStartupEntrance(root, 80, () => undefined)).toBe(true);
  expect(playStartupEntrance(root, 80, () => undefined)).toBe(false);
});

test('a host without a frame scheduler still completes boot retirement', () => {
  const host = fixture(false);
  dismissInitialSplash();
  vi.advanceTimersByTime(SPLASH_EXIT_DURATION_MS);
  expect(host.removed()).toBe(true);
  vi.runAllTimers();
  expect(host.attributes.has(SPLASH_HANDOFF_ATTRIBUTE)).toBe(false);
});
