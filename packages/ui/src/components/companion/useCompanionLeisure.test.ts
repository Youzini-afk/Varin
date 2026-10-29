import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { useCompanionLeisure, COMPANION_QUIET_AFTER_MS, COMPANION_SLEEP_AFTER_MS } from './useCompanionLeisure';
let root: Root | undefined;
let view: ReturnType<typeof useCompanionLeisure>;
let eligible = true, revision = 0, available = true;
let actions: readonly string[] = ['quiet-hair-smooth'];
function Probe() { view = useCompanionLeisure(eligible, revision, available, actions); return null; }
function render() { act(() => root!.render(React.createElement(Probe))); }
function setup() {
  vi.useFakeTimers(); eligible = true; revision = 0; available = true; actions = ['quiet-hair-smooth'];
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  root = createRoot(document.getElementById('root')!); render();
}
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
it('offers one finite quiet phrase then the original sleep deadline, never repeating a quiet tick', () => {
  setup(); act(() => vi.advanceTimersByTime(COMPANION_QUIET_AFTER_MS - 1)); expect(view.quietDue).toBe(false);
  act(() => vi.advanceTimersByTime(1)); expect(view.quietDue).toBe(true); expect(view.restDue).toBe(false);
  act(() => view.finishQuiet()); expect(view.quietDue).toBe(false);
  act(() => vi.advanceTimersByTime(COMPANION_SLEEP_AFTER_MS - COMPANION_QUIET_AFTER_MS)); expect(view.restDue).toBe(true); expect(view.quietDue).toBe(false);
  act(() => vi.advanceTimersByTime(600_000)); expect(view.quietDue).toBe(false);
});
it('new work and local activity cancel old quiet intent rather than queueing it', () => {
  setup(); act(() => vi.advanceTimersByTime(COMPANION_QUIET_AFTER_MS)); eligible = false; render(); expect(view.quietDue).toBe(false);
  eligible = true; render(); act(() => vi.advanceTimersByTime(COMPANION_QUIET_AFTER_MS - 1)); revision++; render();
  act(() => vi.advanceTimersByTime(1)); expect(view.quietDue).toBe(false); expect(view.restDue).toBe(false);
});
it('hidden resets and absent art keeps the original sleep-only path', () => {
  setup(); act(() => vi.advanceTimersByTime(COMPANION_QUIET_AFTER_MS));
  act(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new window.Event('visibilitychange')); }); expect(view.quietDue).toBe(false);
  available = false; render(); act(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new window.Event('visibilitychange')); });
  act(() => vi.advanceTimersByTime(COMPANION_QUIET_AFTER_MS)); expect(view.quietDue).toBe(false);
  act(() => vi.advanceTimersByTime(COMPANION_SLEEP_AFTER_MS - COMPANION_QUIET_AFTER_MS)); expect(view.restDue).toBe(true);
});

it('rotates only available quiet phrases across idle epochs without adding performances or delaying sleep', () => {
  setup(); actions = ['quiet-hair-smooth', 'quiet-stretch', 'quiet-sleeve-smooth', 'quiet-seat-adjust']; render();
  for (const action of [...actions, actions[0]]) {
    act(() => vi.advanceTimersByTime(COMPANION_QUIET_AFTER_MS)); expect(view.quietAction).toBe(action);
    act(() => view.finishQuiet()); expect(view.quietAction).toBeNull();
    act(() => vi.advanceTimersByTime(COMPANION_SLEEP_AFTER_MS - COMPANION_QUIET_AFTER_MS));
    expect(view.restDue).toBe(true); expect(view.quietAction).toBeNull();
    revision++; render();
  }
});
it('discards interrupted variety and handles removed art without retaining an unavailable action', () => {
  setup(); actions = ['quiet-hair-smooth', 'quiet-stretch']; render();
  act(() => vi.advanceTimersByTime(COMPANION_QUIET_AFTER_MS)); expect(view.quietAction).toBe('quiet-hair-smooth');
  eligible = false; render(); expect(view.quietAction).toBeNull();
  eligible = true; render(); act(() => vi.advanceTimersByTime(COMPANION_QUIET_AFTER_MS)); expect(view.quietAction).toBe('quiet-stretch');
  actions = ['quiet-hair-smooth']; render(); expect(view.quietAction).toBeNull();
  act(() => vi.advanceTimersByTime(COMPANION_QUIET_AFTER_MS)); expect(view.quietAction).toBe('quiet-hair-smooth');
});
