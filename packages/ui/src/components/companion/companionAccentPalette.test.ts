import { expect, test } from 'vitest';
import type { Theme } from '@/types/theme';
import { getThemeById } from '@/lib/theme/themes';
import { DEFAULT_COMPANION_ACCENT_PALETTE, resolveCompanionAccentPalette } from './companionAccentPalette';

const resolved = (id: string) => resolveCompanionAccentPalette(getThemeById(id));
const custom = (base: string) => ({ colors: { primary: { base } } }) as Theme;

test.each(['#808080', '#a277ff', '#d8a66b'])('custom accents produce bounded shades with preserved light-to-dark order: %s', base => {
  const palette = resolveCompanionAccentPalette(custom(base));
  expect(palette.tones).toHaveLength(768);
  expect(palette.tones.every(value => Number.isFinite(value) && value >= 0 && value <= 255)).toBe(true);
  for (let value = 1; value < 256; value++) for (let channel = 0; channel < 3; channel++) {
    expect(palette.tones[value * 3 + channel]).toBeGreaterThan(palette.tones[(value - 1) * 3 + channel]!);
  }
});

test('registered Varin defaults retain approved material; changed accents still use their actual value', () => {
  expect(resolved('varin-light')).toBe(DEFAULT_COMPANION_ACCENT_PALETTE);
  expect(resolved('varin-dark')).toBe(DEFAULT_COMPANION_ACCENT_PALETTE);
  const theme = structuredClone(getThemeById('varin-dark')!);
  theme.colors.primary.base = '#a277ff';
  expect(resolveCompanionAccentPalette(theme).tones).toEqual(resolved('aura-dark').tones);
});

test('unsupported accent formats fall back safely; opaque shorthand is deterministic', () => {
  for (const base of ['', '#12', '#zzzzzz', '#123456junk', '#1234', '#12345600', 'red', 'var(--accent)', 'rgb(1 2 3)', null]) {
    expect(resolveCompanionAccentPalette({ colors: { primary: { base } } } as Theme)).toBe(DEFAULT_COMPANION_ACCENT_PALETTE);
  }
  expect(resolveCompanionAccentPalette(null)).toBe(DEFAULT_COMPANION_ACCENT_PALETTE);
  expect(resolveCompanionAccentPalette(custom(' #ABC '))).toEqual(resolveCompanionAccentPalette(custom('#aabbcc')));
});
