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
