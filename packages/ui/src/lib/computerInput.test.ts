import { describe, expect, it } from 'vitest';
import { desktopKey, desktopPoint } from './computerInput';

describe('desktop input mapping', () => {
  it('maps a scaled frame through negative monitor origins and clamps captured pointer release', () => {
    const bounds = { x: -1920, y: -200, width: 4480, height: 1640 };
    const rect = { left: 100, top: 50, width: 1120, height: 410 };
    expect(desktopPoint(bounds, rect, 580, 100)).toEqual({ x: 0, y: 0 });
    expect(desktopPoint(bounds, rect, 2000, -100)).toEqual({ x: 2559, y: -200 });
  });
  it('preserves shortcuts, arrow keys and composed text boundaries', () => {
    const key = { key: 'c', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false };
    expect(desktopKey(key)).toEqual({ kind: 'key', key: 'ctrl+c' });
    expect(desktopKey({ ...key, key: 'ArrowLeft' })).toEqual({ kind: 'key', key: 'ctrl+left' });
    expect(desktopKey({ ...key, ctrlKey: false, key: '中' })).toEqual({ kind: 'text', text: '中' });
    expect(desktopKey({ ...key, key: 'Process', isComposing: true })).toBeNull();
  });
});
