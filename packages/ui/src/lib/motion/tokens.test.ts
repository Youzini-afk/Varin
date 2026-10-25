import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SPRINGS,
  springLinearEasing,
  springProgress,
  springSettleMs,
  staggerDelay,
  STAGGER_MAX_ITEMS,
  type SpringToken,
} from './tokens';

const TOKENS = Object.keys(SPRINGS) as SpringToken[];
const motionCss = readFileSync(fileURLToPath(new URL('../../styles/motion.css', import.meta.url)), 'utf8');

describe('motion tokens', () => {
  it('reaches its target and orders the tempo snap < glide < travel', () => {
    for (const token of TOKENS) {
      expect(springProgress(token, 0)).toBe(0);
      expect(springProgress(token, 1)).toBe(1);
    }
    expect(springSettleMs('snap')).toBeLessThan(springSettleMs('glide'));
    expect(springSettleMs('glide')).toBeLessThan(springSettleMs('travel'));
    // Only settle overshoots, and only slightly.
    const peak = (token: SpringToken) => Math.max(...Array.from({ length: 201 }, (_, i) => springProgress(token, i / 200)));
    expect(peak('glide')).toBeLessThanOrEqual(1.0001);
    expect(peak('settle')).toBeGreaterThan(1.02);
    expect(peak('settle')).toBeLessThan(1.08);
  });

  it('keeps the generated CSS curves in sync with the springs', () => {
    for (const token of TOKENS) {
      expect(motionCss).toContain(`--motion-ease-${token}: ${springLinearEasing(token)};`);
      expect(motionCss).toContain(`--motion-dur-${token}: ${springSettleMs(token)}ms;`);
    }
  });

  it('caps staggered delays', () => {
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(100)).toBeCloseTo(staggerDelay(STAGGER_MAX_ITEMS - 1), 10);
  });
});
