import { afterEach, expect, it, vi } from 'vitest';
import { CompanionStoolWindows, type StoolBounds, type StoolPhase } from './companion-stool';
afterEach(() => vi.useRealTimers());
function fixture() {
  const calls: { bounds: StoolBounds; phase: StoolPhase; closed: boolean; ready?: () => void }[] = [];
  let bounds = { x: -300, y: 25, width: 440, height: 640 };
  const owner = { id: 5, isDestroyed: () => false, getBounds: () => bounds };
  const manager = new CompanionStoolWindows((captured, phase) => {
    const state = { bounds: captured, phase, closed: false }; calls.push(state);
    return { isDestroyed: () => state.closed, close: () => { state.closed = true; }, onReady: (cb: () => void) => { (state as typeof calls[number]).ready = cb; } };
  });
  return { manager, owner, calls, move: () => { bounds.x = 200; } };
}
it('captures fixed DIP bounds and expires lift while landing persists until takeover', () => {
  vi.useFakeTimers(); const f = fixture();
  f.manager.show(f.owner, f.owner.getBounds(), 'lift'); f.move();
  vi.advanceTimersByTime(1000); expect(f.calls[0]?.closed).toBe(false);
  f.calls[0]?.ready?.();
  expect(f.calls[0]?.bounds.x).toBe(-300);
  vi.advanceTimersByTime(149); expect(f.calls[0]?.closed).toBe(false);
  vi.advanceTimersByTime(1); expect(f.calls[0]?.closed).toBe(true);
  f.manager.show(f.owner, f.owner.getBounds(), 'landing'); vi.advanceTimersByTime(10000);
  expect(f.calls[1]?.closed).toBe(false);
  f.manager.clear(f.owner.id); expect(f.calls[1]?.closed).toBe(true);
});
it('replaces safely on quick regrab and clears all owner lifetimes', () => {
  vi.useFakeTimers(); const f = fixture();
  f.manager.show(f.owner, f.owner.getBounds(), 'lift'); f.calls[0]?.ready?.(); vi.advanceTimersByTime(100);
  f.manager.show(f.owner, f.owner.getBounds(), 'landing');
  f.calls[0]?.ready?.(); // Late ready callback from a replaced/closed window.
  vi.advanceTimersByTime(200);
  expect(f.calls.map(x => x.closed)).toEqual([true, false]);
  f.manager.show({ ...f.owner, id: 6 }, f.owner.getBounds(), 'landing');
  f.manager.clearAll(); expect(f.calls.every(x => x.closed)).toBe(true);
  f.manager.show({ ...f.owner, isDestroyed: () => true }, f.owner.getBounds(), 'lift');
  expect(f.calls).toHaveLength(3);
});
