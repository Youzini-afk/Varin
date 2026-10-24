import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SPRINGS,
  springCoefficients,
  springLinearEasing,
  springProgress,
  springSettleMs,
  springTransition,
  staggerDelay,
  STAGGER_MAX_ITEMS,
  type SpringToken,
} from './tokens';

const TOKENS = Object.keys(SPRINGS) as SpringToken[];
const motionCss = readFileSync(fileURLToPath(new URL('../../styles/motion.css', import.meta.url)), 'utf8');

describe('motion tokens', () => {
  it('converts visual duration and bounce like motion does', () => {
    const { stiffness, damping } = springCoefficients({ bounce: 0, visualDuration: 0.32 });
    const root = (2 * Math.PI) / (0.32 * 1.2);
    expect(stiffness).toBeCloseTo(root * root, 6);
    // Bounce 0 is critically damped.
    expect(damping).toBeCloseTo(2 * Math.sqrt(stiffness), 6);
    expect(springCoefficients({ bounce: 0.3, visualDuration: 0.42 }).damping)
      .toBeCloseTo(2 * 0.7 * Math.sqrt(springCoefficients({ bounce: 0.3, visualDuration: 0.42 }).stiffness), 6);
  });

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

  it('feeds motion components the same spring parameters', () => {
    expect(springTransition('travel')).toEqual({ type: 'spring', bounce: 0.06, visualDuration: 0.5 });
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
