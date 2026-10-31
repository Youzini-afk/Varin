import { expect, test } from 'vitest';
import type { Theme } from '@/types/theme';
import { getThemeById, themes } from '@/lib/theme/themes';
import { DEFAULT_FIGURE_ACCENT, resolveFigureAccent } from './varinFigurePalette';

const KNIT = '#82a3e6';
const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const knit = (id: string): number[] => rgb(resolveFigureAccent(getThemeById(id)).tint(KNIT));

test('Varin themes keep the drawn mist blue; every other theme gets valid colours from its own accent', () => {
  expect(resolveFigureAccent(getThemeById('varin-light'))).toBe(DEFAULT_FIGURE_ACCENT);
  expect(resolveFigureAccent(getThemeById('varin-dark'))).toBe(DEFAULT_FIGURE_ACCENT);
  for (const theme of themes) {
    const accent = resolveFigureAccent(theme);
    expect(accent.tint(KNIT)).toMatch(/^#[0-9a-f]{6}$/);
    if (!theme.metadata.id.startsWith('varin-')) expect(accent.key).toContain(theme.colors.primary.base.slice(1).toLowerCase());
  }
});

test('hues follow the accent while the light and shade of the drawing stay', () => {
  for (const id of ['mono-dark', 'mono-light']) {
    const [r, g, b] = knit(id);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(1);
  }
  for (const id of ['vesper-dark', 'flexoki-dark', 'flexoki-light']) { const [r, , b] = knit(id); expect(r).toBeGreaterThan(b + 20); }
  for (const id of ['vitesse-dark-dark', 'fields-of-the-shire-dark']) { const [r, g, b] = knit(id); expect(g).toBeGreaterThan(r); expect(g).toBeGreaterThan(b); }
  const aura = resolveFigureAccent(getThemeById('aura-dark'));
  const lighter = rgb(aura.tint('#9cb6ec')), darker = rgb(aura.tint('#6c8dd5'));
  expect(lighter.reduce((a, v) => a + v, 0)).toBeGreaterThan(darker.reduce((a, v) => a + v, 0));
});

test('unsupported accent formats keep the drawn colours', () => {
  for (const base of ['', 'red', 'var(--accent)', '#12345600', null]) {
    expect(resolveFigureAccent({ colors: { primary: { base } } } as Theme)).toBe(DEFAULT_FIGURE_ACCENT);
  }
  expect(resolveFigureAccent(undefined)).toBe(DEFAULT_FIGURE_ACCENT);
});
