import { describe, expect, it } from 'vitest';
import { CODE_PACE, PROSE_PACE, drainRate, revealIndex, stepPace } from './pace';

const FRAME = 1 / 60;

const reveal = (backlog: number, seconds: number, fixed?: number) => {
  let shown = 0;
  for (let t = 0; t < seconds - 1e-9; t += FRAME) shown = stepPace(PROSE_PACE, shown, backlog, FRAME, fixed);
  return shown;
};

describe('stepPace', () => {
  it('reveals at least the minimum rate while there is a backlog', () => {
    expect(reveal(1000, 1)).toBeGreaterThan(26);
    expect(stepPace(PROSE_PACE, 0, 3, FRAME)).toBeCloseTo(26 * FRAME, 6);
  });

  it('catches up with a burst on the 0.24s time constant', () => {
    // One time constant reveals about 1 - 1/e of a burst.
    const shown = reveal(400, 0.24);
    expect(shown / 400).toBeGreaterThan(0.55);
    expect(shown / 400).toBeLessThan(0.7);
    expect(reveal(400, 1.4)).toBe(400);
  });

  it('drains a fixed backlog evenly in the drain time', () => {
    const rate = drainRate(PROSE_PACE, 300);
    expect(rate).toBeCloseTo(300 / 0.16, 6);
    // Six frames are 0.1s: an even 62.5% of the drain.
    expect(reveal(300, 0.1, rate)).toBeCloseTo(187.5, 6);
    expect(reveal(300, 0.17, rate)).toBe(300);
  });

  it('never passes the target and clamps long frames', () => {
    expect(stepPace(PROSE_PACE, 10, 8, FRAME)).toBe(8);
    expect(stepPace(CODE_PACE, 0, 10_000, 3)).toBeCloseTo(stepPace(CODE_PACE, 0, 10_000, 0.05), 6);
  });
});

describe('revealIndex', () => {
  it('keeps surrogate pairs whole', () => {
    const text = 'a😀b';
    expect(revealIndex(text, 2)).toBe(3);
    expect(revealIndex(text, 1.9)).toBe(1);
    expect(revealIndex(text, 99)).toBe(text.length);
  });
});
