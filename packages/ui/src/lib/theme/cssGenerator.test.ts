import { describe, expect, test } from 'vitest';
import { CSSVariableGenerator } from './cssGenerator';
import { getDefaultTheme, themes } from './themes';

const variables = (css: string) => new Map(
  [...css.matchAll(/^\s*(--[\w-]+):\s*(.+);$/gm)].map((match) => [match[1], match[2]]),
);

describe('Markdown theme accents', () => {
  test('all built-in themes keep reading accents connected to the live primary color', () => {
    const generator = new CSSVariableGenerator();
    for (const theme of themes) {
      const css = variables(generator.generate(theme));
      expect(css.get('--primary-base')).toBe(theme.colors.primary.base);
      expect(css.get('--markdown-link'), theme.metadata.id).toContain('var(--primary-base)');
      expect(css.get('--markdown-link-hover'), theme.metadata.id).toContain('var(--primary-hover)');
      for (const property of ['inline-code', 'inline-code-bg', 'blockquote-border', 'selection']) {
        expect(css.get(`--markdown-${property}`), `${theme.metadata.id}: ${property}`)
          .toContain('var(--primary-base)');
      }
      expect(css.get('--syntax-keyword')).toBe(theme.colors.syntax.base.keyword);
      expect(css.get('--status-error')).toBe(theme.colors.status.error);
    }
  });

  test('custom themes can still author explicit Markdown colors', () => {
    const original = getDefaultTheme(true);
    const custom = {
      ...original,
      colors: {
        ...original.colors,
        markdown: { ...original.colors.markdown, link: '#e0a070', inlineCode: '#c0a0e0' },
      },
    };
    const css = variables(new CSSVariableGenerator().generate(custom));
    expect(css.get('--markdown-link')).toBe('#e0a070');
    expect(css.get('--markdown-inline-code')).toBe('#c0a0e0');
    expect(css.get('--markdown-body')).toBe(original.colors.markdown?.body);
  });
});

describe('neutral workbench surfaces', () => {
  const rgb = (value: string) => [1, 3, 5].map(start => Number.parseInt(value.slice(start, start + 2), 16));

  test('built-in palettes keep large surfaces neutral while their accents and syntax remain distinct', () => {
    for (const theme of themes) {
      const colors = [theme.colors.surface.background, theme.colors.surface.muted, theme.colors.surface.elevated,
        theme.colors.header?.background, theme.colors.sidebar?.background].filter((value): value is string => Boolean(value));
      for (const color of colors) {
        const [r, g, b] = rgb(color);
        expect(r === g && g === b, `${theme.metadata.id}: ${color}`).toBe(true);
      }
      expect(theme.colors.interactive.focus, theme.metadata.id).toBe(theme.colors.primary.base);
    }
    expect(new Set(themes.map(theme => theme.colors.primary.base)).size).toBeGreaterThan(1);
  });

  test('the default dark shell sits above the reading plane and floating surfaces above the composer', () => {
    const { surface, header, sidebar } = getDefaultTheme(true).colors;
    const shade = (value: string) => rgb(value)[0];
    expect(shade(header!.background)).toBeGreaterThan(shade(surface.background));
    expect(shade(sidebar!.background)).toBe(shade(header!.background));
    expect(shade(surface.muted)).toBeGreaterThan(shade(header!.background));
    expect(shade(surface.elevated)).toBeGreaterThan(shade(surface.muted));
  });
});
