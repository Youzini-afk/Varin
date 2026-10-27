import { expect, test } from 'vitest';
import { drainRate, revealIndex, stepPace, type PaceProfile } from './pace';

// Test the pacing contract with a supplied profile, not product tuning constants.
// The usePacedText suite owns streamed/remounted text and timer retirement.
const profile: PaceProfile = { minRate: 10, catchUpSeconds: 0.5, drainSeconds: 0.2 };

test('makes bounded forward progress, catches up to a burst and drains a finished stream', () => {
  let shown = 0;
  for (let frame = 0; frame < 300; frame++) {
    const next = stepPace(profile, shown, 400, 1 / 60);
    expect(next).toBeGreaterThanOrEqual(shown);
    expect(next).toBeLessThanOrEqual(400);
    shown = next;
  }
  expect(shown).toBe(400);
  const rate = drainRate(profile, 100);
  let drained = 0;
  for (let frame = 0; frame < 60; frame++) drained = stepPace(profile, drained, 100, 1 / 60, rate);
  expect(drained).toBe(100);
  expect(stepPace(profile, 10, 8, 1 / 60)).toBe(8);
});

test('a suspended tab cannot reveal an entire burst in one resumed frame', () => {
  const next = stepPace(profile, 0, 10_000, 3);
  expect(next).toBeGreaterThan(0);
  expect(next).toBeLessThan(10_000);
});

test('keeps surrogate pairs whole', () => {
  expect(revealIndex('a😀b', 2)).toBe(3);
  expect(revealIndex('a😀b', 1.9)).toBe(1);
  expect(revealIndex('a😀b', 99)).toBe(4);
});
