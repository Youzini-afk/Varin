import { createVarinMonacoTheme } from '@/lib/monaco/theme';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownSyntaxVars';
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

describe('Codex theme compatibility', () => {
  test('imports the nested Codex chrome and TextMate settings from a copied theme', () => {
    const theme = parseImportedTheme(JSON.stringify({
      name: 'Absolutely', variant: 'light',
      chromeTheme: { accent: '#da7756', contrast: 60, ink: '#1d1b16', surface: '#f5f3ee',
        opaqueWindows: true, fonts: { ui: 'Figtree, "Noto Sans CJK SC"', code: 'JetBrains Mono', content: 'Source Serif 4' },
        semanticColors: { diffAdded: '#00c853', diffRemoved: '#ff5f38', skill: '#cc7d5e' } },
      colors: { 'editor.background': '#f5f3ee', 'editor.foreground': '#1d1b16', 'editorCursor.foreground': '#da7756',
        'sideBar.background': '#eeece6', 'editor.selectionBackground': '#da775633' },
      settings: [
        { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#667788' } },
        { scope: ['string', 'string.quoted'], settings: { foreground: '#228844' } },
        { scope: ['keyword', 'storage.type'], settings: { foreground: '#995588' } },
        { scope: 'entity.name.function', settings: { foreground: '#3355aa' } },
      ],
    }));
    expect(theme.metadata.name).toBe('Absolutely');
    expect(theme.metadata.variant).toBe('light');
    expect(theme.config?.fonts).toMatchObject({ sans: 'Figtree, "Noto Sans CJK SC"', mono: 'JetBrains Mono' });
    expect(theme.colors.primary.base).toBe('#da7756');
    expect(theme.colors.surface.background).toBe('#f5f3ee');
    expect(theme.colors.surface.foreground).toBe('#1d1b16');
    expect(theme.colors.sidebar?.background).toBe('#eeece6');
    expect(theme.colors.interactive.selection).toBe('#da775633');
    expect(theme.colors.syntax.base).toMatchObject({ comment: '#667788', string: '#228844', keyword: '#995588', function: '#3355aa' });
    expect(theme.colors.syntax.highlights).toMatchObject({ diffAdded: '#00c853', diffRemoved: '#ff5f38' });
    expect(parseImportedTheme(JSON.stringify(theme)).metadata.id).toBe(theme.metadata.id);
  });

  test('imports a Chinese-named compact Codex theme and infers a dark variant', () => {
    const theme = parseImportedTheme(JSON.stringify({ name: '我的主题', chromeTheme: {
      accent: '#0169cc', surface: '#111111', ink: '#fcfcfc', opaqueWindows: false,
    } }));
    expect(theme.metadata.name).toBe('我的主题');
    expect(theme.metadata.id).toMatch(/^imported-theme-[0-9a-f]+$/);
    expect(theme.metadata.variant).toBe('dark');
    expect(theme.colors.surface.background).toBe('#111111');
  });

  test('rejects malformed Codex color fields without accepting CSS injection', () => {
    expect(() => parseImportedTheme(JSON.stringify({ name: 'Bad', variant: 'light', chromeTheme: {
      surface: '#fff;}body{display:none', ink: '#000000', accent: '#ff0000',
    } }))).toThrow('format');
  });
});

test('carries a separate dark code palette through editors and prose in a light Codex theme', () => {
  const theme = parseImportedTheme(JSON.stringify({ name: 'Mixed', chromeTheme: { surface: '#ffffff', ink: '#222222' },
    colors: { 'editor.background': '#111111', 'editor.foreground': '#eeeeee' },
    settings: [{ scope: 'keyword', settings: { foreground: '#cc88aa' } }] }));
  const editor = createVarinMonacoTheme(theme);
  expect(theme.metadata.variant).toBe('light');
  expect(editor.colors['editor.background']).toBe('#111111');
  expect(editor.colors['editor.foreground']).toBe('#eeeeee');
  expect(theme.colors.markdown?.codeBackground).toBe('#111111');
  expect(getMarkdownSyntaxVars(theme, 'prose')['--md-syntax-keyword']).toBe('#cc88aa');
});
