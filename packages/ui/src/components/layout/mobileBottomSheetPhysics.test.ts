import { describe, expect, it } from 'vitest';
import { settleSheet, sheetOffsets } from './mobileBottomSheetPhysics';

describe('mobile bottom sheet', () => {
  const height = 800;
  const stops = sheetOffsets(height);

  it('opens over a little more than half of the host and keeps a gap at full height', () => {
    expect(stops.closed - stops.half).toBeCloseTo(440);
    expect(stops.full).toBe(0);
    expect(stops.closed).toBe(788);
  });

  it('springs back from a short slow drag and commits a fling or a long drag', () => {
    expect(settleSheet('half', stops.half + 60, 0.2, height)).toBe('half');
    expect(settleSheet('half', stops.half + 60, 0.8, height)).toBe('closed');
    expect(settleSheet('half', stops.half + 200, 0.1, height)).toBe('closed');
    expect(settleSheet('half', stops.half - 40, -0.2, height)).toBe('half');
    expect(settleSheet('half', stops.half - 40, -0.9, height)).toBe('full');
    expect(settleSheet('half', stops.half - 150, -0.1, height)).toBe('full');
  });

  it('steps down from full height to half, and closes only when pulled well past it', () => {
    expect(settleSheet('full', 60, 0.8, height)).toBe('half');
    expect(settleSheet('full', stops.half + 300, 0.1, height)).toBe('closed');
    expect(settleSheet('full', -30, -0.9, height)).toBe('full');
  });
});
