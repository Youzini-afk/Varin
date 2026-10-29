import { expect, it } from 'vitest';
import { LocalInteractionTiming } from './localInteractionTiming';
it('bounds a rapid tap burst to one initial and one repeat intent, without replaying every tap', () => {
  const gate = new LocalInteractionTiming();
  const events = Array.from({ length: 30 }, (_, i) => gate.tap(i * 50)).filter(Boolean);
  expect(events).toEqual(['tap-first', 'tap-repeat']);
  expect(gate.tap(2500)).toBe('tap-first');
});
it('requires real dwell, cancels a departed hover and does not loop while parked', () => {
  const gate = new LocalInteractionTiming();
  gate.hoverEnter(0); expect(gate.hoverReady(699)).toBe(false);
  gate.hoverLeave(); expect(gate.hoverReady(1000)).toBe(false);
  gate.hoverEnter(1100); expect(gate.hoverReady(1800)).toBe(true);
  expect(gate.hoverReady(20000)).toBe(false);
  gate.hoverLeave(); gate.hoverEnter(20000); expect(gate.hoverReady(20700)).toBe(true);
});
it('suppresses edge jitter with cooldown and interruption drops pending local responses', () => {
  const gate = new LocalInteractionTiming(); gate.hoverEnter(0); expect(gate.hoverReady(700)).toBe(true);
  gate.hoverLeave(); gate.hoverEnter(800); expect(gate.hoverReady(1500)).toBe(false);
  gate.interrupt(); expect(gate.hoverReady(20000)).toBe(false); expect(gate.tap(20000)).toBe('tap-first');
});
it('offers a bounded greeting only on real local activity after observed hide/resume, never inferring online status', () => {
  const gate = new LocalInteractionTiming();
  expect(gate.returnOnActivity(0)).toBe(false);
  gate.visibility(false, 100); gate.visibility(true, 31000);
  expect(gate.returnOnActivity(31010)).toBe(true); expect(gate.returnOnActivity(31020)).toBe(false);
  gate.visibility(false, 40000); gate.visibility(true, 80000);
  expect(gate.returnOnActivity(90000)).toBe(false);
  gate.visibility(false, 100000); gate.visibility(true, 100100);
  expect(gate.returnOnActivity(100200)).toBe(false);
});

it('does not queue a repeat while its response is playing; a later actual tap can request the one variation', () => {
  const gate = new LocalInteractionTiming(); gate.tap(0);
  expect(gate.tap(150, false)).toBeNull(); expect(gate.tap(350, false)).toBeNull();
  expect(gate.tap(500, true)).toBe('tap-repeat'); expect(gate.tap(550, true)).toBeNull();
  gate.visibility(false, 1000); gate.reset('scope'); gate.visibility(true, 50000);
  expect(gate.returnOnActivity(50001)).toBe(false);
});

it('provides one cancellable hover deadline including reentry cooldown without parked repeat timers', () => {
  const gate = new LocalInteractionTiming();
  expect(gate.hoverDelay(0)).toBeNull(); gate.observeHover(true, 0);
  expect(gate.hoverDelay(100)).toBe(600); expect(gate.observeHover(true, 700)).toBe(true);
  expect(gate.hoverDelay(800)).toBeNull(); gate.observeHover(false, 800); gate.observeHover(true, 900);
  expect(gate.hoverDelay(900)).toBe(9800); gate.reset('drag'); expect(gate.hoverDelay(1000)).toBeNull();
});
