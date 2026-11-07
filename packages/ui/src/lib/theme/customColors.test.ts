import { describe, expect, test } from 'vitest';
import { getDefaultTheme } from './themes';
import { applyCustomColors, normalizeCustomColor } from './customColors';

describe('custom theme colors', () => {
  test('changes palette references while retaining status and syntax tokens', () => {
    const original = getDefaultTheme(false);
    const customized = applyCustomColors(original, {
      accent: '#da7756', background: '#f5f3ee', foreground: '#1d1b16',
    });
    expect(customized.colors.primary.base).toBe('#da7756');
    expect(customized.colors.surface.background).toBe('#f5f3ee');
    expect(customized.colors.surface.foreground).toBe('#1d1b16');
    expect(customized.colors.syntax.base.background).toBe('#f5f3ee');
    expect(customized.colors.syntax.base.keyword).toBe(original.colors.syntax.base.keyword);
    expect(customized.colors.status).toEqual(original.colors.status);
    expect(original.colors.surface.background).not.toBe('#f5f3ee');
    expect(applyCustomColors(original)).toBe(original);
  });

  test('rejects malformed color values', () => {
    expect(normalizeCustomColor('#DA7756')).toBe('#da7756');
    expect(normalizeCustomColor('#zz0000')).toBeUndefined();
    expect(normalizeCustomColor('red')).toBeUndefined();
  });
});
