import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import {
  OFFSCREEN_ATTRIBUTE,
  PAGE_HIDDEN_ATTRIBUTE,
  pauseLoopsOffscreen,
  resetLoopTrackingForTests,
  trackPageVisibility,
} from './loops';

afterEach(() => {
  resetLoopTrackingForTests();
  vi.unstubAllGlobals();
});

it('marks the root while the window is hidden and clears it on return', () => {
  const { document } = parseHTML('<html><body></body></html>');
  let state: DocumentVisibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => state });
  trackPageVisibility(document);
  expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTRIBUTE)).toBe(false);
  state = 'hidden';
  document.dispatchEvent(new document.defaultView!.Event('visibilitychange'));
  expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTRIBUTE)).toBe(true);
  state = 'visible';
  document.dispatchEvent(new document.defaultView!.Event('visibilitychange'));
  expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTRIBUTE)).toBe(false);
});

it('marks a row while it is scrolled out of view, and lets it go when it leaves the page', () => {
  const { document } = parseHTML('<html><body><div id="row"></div></body></html>');
  const observed = new Set<Element>();
  let report: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null = null;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof report) { report = callback; }
    observe(target: Element) { observed.add(target); }
    unobserve(target: Element) { observed.delete(target); }
    disconnect() { observed.clear(); }
  });
  const row = document.getElementById('row')!;
  const release = pauseLoopsOffscreen(row);
  expect(observed.has(row)).toBe(true);
  report!([{ target: row, isIntersecting: false }]);
  expect(row.hasAttribute(OFFSCREEN_ATTRIBUTE)).toBe(true);
  report!([{ target: row, isIntersecting: true }]);
  expect(row.hasAttribute(OFFSCREEN_ATTRIBUTE)).toBe(false);
  report!([{ target: row, isIntersecting: false }]);
  release?.();
  expect(observed.has(row)).toBe(false);
  expect(row.hasAttribute(OFFSCREEN_ATTRIBUTE)).toBe(false);
});
