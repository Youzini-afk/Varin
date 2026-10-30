import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { useCompanionWindow } from './useCompanionWindow';
vi.mock('@/lib/desktop', () => ({ isElectronShell: () => false, invokeDesktop: vi.fn() }));
let root: Root | undefined;
let view: ReturnType<typeof useCompanionWindow>;
let opaque = true, repeated = false;
const capture = new Set<number>();
const node = {
  width: 1, height: 1,
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
  getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, opaque ? 255 : 0]) }) }),
  setPointerCapture: (id: number) => capture.add(id), hasPointerCapture: (id: number) => capture.has(id), releasePointerCapture: (id: number) => capture.delete(id),
} as unknown as HTMLCanvasElement;
function setup() {
  vi.useFakeTimers(); opaque = true; repeated = false; capture.clear();
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  const ref = { current: node };
  function Probe() { view = useCompanionWindow(ref, true, undefined, () => repeated); return null; }
  root = createRoot(document.getElementById('root')!); act(() => root!.render(React.createElement(Probe))); act(() => view.refreshHitMask());
}
function event(x = 50) { return { pointerId: 1, button: 0, pointerType: 'mouse', clientX: x, clientY: 50, currentTarget: node, preventDefault() {} } as React.PointerEvent<HTMLCanvasElement>; }
function tap() { act(() => { view.handlers.onPointerDown(event()); view.handlers.onPointerUp(); }); }
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
it('admits only completed clicks, bounds repeated taps, and never turns capture loss or drag into a click', () => {
  setup(); act(() => { view.handlers.onPointerDown(event()); view.handlers.onPointerCancel(); view.handlers.onLostPointerCapture(); }); expect(view.tapRevision).toBe(0);
  tap(); expect(view.tapRevision).toBe(1); expect(view.tapKind).toBe('tap-first');
  act(() => vi.advanceTimersByTime(150)); tap(); expect(view.tapRevision).toBe(1);
  repeated = true; act(() => vi.advanceTimersByTime(200)); tap(); expect(view.tapRevision).toBe(2); expect(view.tapKind).toBe('tap-repeat');
  tap(); expect(view.tapRevision).toBe(2);
  act(() => { view.handlers.onPointerDown(event()); view.handlers.onPointerMove(event(60)); view.handlers.onPointerUp(); }); expect(view.phase).toBe('landing'); expect(view.tapRevision).toBe(2);
});
it('rechecks actual drawn alpha while parked and cancels the sole dwell deadline', () => {
  setup(); act(() => view.handlers.onPointerMove(event())); act(() => vi.advanceTimersByTime(400)); opaque = false; act(() => view.refreshHitMask());
  expect(view.hovered).toBe(false); act(() => vi.advanceTimersByTime(1000)); expect(view.hoverRevision).toBe(0);
  opaque = true; act(() => { view.refreshHitMask(); view.handlers.onPointerMove(event()); }); act(() => vi.advanceTimersByTime(700)); expect(view.hoverRevision).toBe(1);
  act(() => vi.advanceTimersByTime(20000)); expect(view.hoverRevision).toBe(1); act(() => view.resetLocalInteraction()); expect(view.hovered).toBe(false);
});
it('does not greet on resume without a real local click', () => {
  setup(); act(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new window.Event('visibilitychange')); });
  act(() => vi.advanceTimersByTime(31000)); act(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new window.Event('visibilitychange')); });
  expect(view.tapRevision).toBe(0); expect(view.hoverRevision).toBe(0); tap(); expect(view.returnedOnActivity).toBe(true); expect(view.tapRevision).toBe(1); tap(); expect(view.returnedOnActivity).toBe(false);
});
