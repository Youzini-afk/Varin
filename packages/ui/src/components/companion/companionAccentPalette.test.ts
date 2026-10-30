import { expect, test } from 'vitest';
import type { Theme } from '@/types/theme';
import { getThemeById, themes } from '@/lib/theme/themes';
import { DEFAULT_COMPANION_ACCENT_PALETTE, resolveCompanionAccentPalette } from './companionAccentPalette';

const resolved = (id: string) => resolveCompanionAccentPalette(getThemeById(id));
const tone = (id: string, value = 196) => resolved(id).tones.slice(value * 3, value * 3 + 3);

test('every registered theme resolves actual accent into bounded, ordered cloth shades', () => {
  expect(themes).toHaveLength(42);
  for (const theme of themes) {
    const palette = resolveCompanionAccentPalette(theme);
    expect(palette.tones).toHaveLength(768);
    expect(palette.tones.every(v => Number.isFinite(v) && v >= 0 && v <= 255)).toBe(true);
    if (!theme.metadata.id.startsWith('varin-')) expect(palette.signature).toContain(theme.colors.primary.base.slice(1).toLowerCase());
    for (let value = 1; value < 256; value++) for (let channel = 0; channel < 3; channel++) {
      expect(palette.tones[value * 3 + channel]).toBeGreaterThan(palette.tones[(value - 1) * 3 + channel]!);
    }
  }
});

test('registered Varin defaults retain approved material; changed accents still use their actual value', () => {
  expect(resolved('varin-light')).toBe(DEFAULT_COMPANION_ACCENT_PALETTE);
  expect(resolved('varin-dark')).toBe(DEFAULT_COMPANION_ACCENT_PALETTE);
  const theme = structuredClone(getThemeById('varin-dark')!);
  theme.colors.primary.base = '#a277ff';
  expect(resolveCompanionAccentPalette(theme).signature).toBe(resolved('aura-dark').signature);
});

test('Mono is layered neutral, Mono Plus stays blue, Nord light stays blue, and warm themes remain warm', () => {
  for (const id of ['mono-dark', 'mono-light']) {
    const rgb = tone(id);
    expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThan(0.001);
    expect(rgb[0]).toBeGreaterThan(100); expect(rgb[0]).toBeLessThan(200);
    expect(tone(id, 232)[0]! - tone(id, 64)[0]!).toBeGreaterThan(70);
  }
  expect(tone('mono-dark')[0]).toBeGreaterThan(tone('mono-light')[0]!);
  for (const id of ['mono-plus-dark', 'mono-plus-light', 'nord-light']) expect(tone(id)[2]).toBeGreaterThan(tone(id)[0]! + 10);
  for (const id of ['vesper-dark', 'vesper-light', 'flexoki-dark', 'flexoki-light']) expect(tone(id)[0]).toBeGreaterThan(tone(id)[2]! + 10);
  expect(tone('vesper-dark')).not.toEqual(tone('vesper-light'));
  expect(tone('nord-dark')).not.toEqual(tone('nord-light'));
});

test('unsupported accent formats fall back safely; opaque shorthand is deterministic', () => {
  for (const base of ['', '#12', '#zzzzzz', '#123456junk', '#1234', '#12345600', 'red', 'var(--accent)', 'rgb(1 2 3)', null]) {
    expect(resolveCompanionAccentPalette({ colors: { primary: { base } } } as Theme)).toBe(DEFAULT_COMPANION_ACCENT_PALETTE);
  }
  expect(resolveCompanionAccentPalette(null)).toBe(DEFAULT_COMPANION_ACCENT_PALETTE);
  const custom = (base: string) => ({ colors: { primary: { base } } }) as Theme;
  expect(resolveCompanionAccentPalette(custom(' #ABC '))).toEqual(resolveCompanionAccentPalette(custom('#aabbcc')));
});
