import { describe, expect, test } from 'vitest';

import {
  DEFAULT_DESKTOP_WINDOW_CONTROLS_POSITION,
  getDesktopWindowControlsOrder,
  normalizeDesktopWindowControlsPosition,
  resolveDesktopWindowControlsSide,
} from './desktop';

describe('desktop window controls position', () => {
  test('defaults to right', () => {
    expect(DEFAULT_DESKTOP_WINDOW_CONTROLS_POSITION).toBe('right');
    expect(resolveDesktopWindowControlsSide(undefined)).toBe('right');
    expect(resolveDesktopWindowControlsSide('right')).toBe('right');
    expect(resolveDesktopWindowControlsSide('left')).toBe('left');
  });

  test('accepts only current position values', () => {
    expect(normalizeDesktopWindowControlsPosition('auto')).toBeUndefined();
    expect(normalizeDesktopWindowControlsPosition('left')).toBe('left');
    expect(normalizeDesktopWindowControlsPosition('right')).toBe('right');
    expect(normalizeDesktopWindowControlsPosition('invalid')).toEqual(undefined);
  });

  test('left uses macOS traffic-light order', () => {
    expect(getDesktopWindowControlsOrder('left')).toEqual(['close', 'minimize', 'maximize']);
  });

  test('right uses Windows order', () => {
    expect(getDesktopWindowControlsOrder('right')).toEqual(['minimize', 'maximize', 'close']);
  });
});
