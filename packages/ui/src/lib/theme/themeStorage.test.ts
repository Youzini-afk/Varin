import { describe, expect, test } from 'vitest';

import { parseStoredThemeState } from './themeStorage';

describe('theme storage', () => {
  test('accepts the complete current theme state', () => {
    expect(parseStoredThemeState(JSON.stringify({
      mode: 'system',
      lightThemeId: 'varin-light',
      darkThemeId: 'varin-dark',
      splash: {
        light: { background: '#fff', foreground: '#111' },
        dark: { background: '#111', foreground: '#fff' },
      },
    }))).toEqual({
      mode: 'system',
      lightThemeId: 'varin-light',
      darkThemeId: 'varin-dark',
      splash: {
        light: { background: '#fff', foreground: '#111' },
        dark: { background: '#111', foreground: '#fff' },
      },
    });
  });

  test('rejects partial, legacy, and malformed values', () => {
    expect(parseStoredThemeState(null)).toBeNull();
    expect(parseStoredThemeState('{')).toBeNull();
    expect(parseStoredThemeState(JSON.stringify({ themeMode: 'dark' }))).toBeNull();
    expect(parseStoredThemeState(JSON.stringify({
      mode: 'dark',
      lightThemeId: 'varin-light',
      darkThemeId: 'varin-dark',
      splash: { light: {}, dark: {} },
    }))).toBeNull();
  });
});

