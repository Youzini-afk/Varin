import { describe, expect, test } from 'vitest';
import { getDefaultTheme } from './themes';
import { parseImportedTheme } from './importedThemes';

describe('importing themes', () => {
  test('round trips a copied complete theme with a distinct ID', () => {
    const original = getDefaultTheme(false);
    const copy = parseImportedTheme(JSON.stringify(original));
    expect(copy.metadata.id).toBe(`imported-${original.metadata.id}`);
    expect(copy.colors).toEqual(original.colors);
    expect(parseImportedTheme(JSON.stringify(copy)).metadata.id).toBe(copy.metadata.id);
  });
  test('imports a simple shared palette', () => {
    const result = parseImportedTheme(JSON.stringify({ name: 'Paper', variant: 'light', colors: {
      accent: '#da7756', background: '#f5f3ee', foreground: '#1d1b16',
    } }));
    expect(result.colors.primary.base).toBe('#da7756');
    expect(result.colors.surface.background).toBe('#f5f3ee');
    expect(result.colors.surface.foreground).toBe('#1d1b16');
  });
  test('rejects invalid JSON, unsafe CSS and incomplete palettes', () => {
    expect(() => parseImportedTheme('{')).toThrow('json');
    expect(() => parseImportedTheme('{"name":"bad"}')).toThrow('format');
    const theme = getDefaultTheme(false);
    const unsafe = { ...theme, colors: { ...theme.colors, primary: { ...theme.colors.primary, base: '#fff;} body {display:none' } } };
    expect(() => parseImportedTheme(JSON.stringify(unsafe))).toThrow('unsafe');
  });
});
