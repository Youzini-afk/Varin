import type { Theme } from '@/types/theme';
import { applyCustomColors } from './customColors';
import { getDefaultTheme } from './themes';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// Codex themes use six-digit colors, and editor colors may also include alpha.
function hex(value: unknown, alpha = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color = value.trim();
  if (/^#[\da-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  if (/^#[\da-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[\da-f]{8}$/i.test(color)) return (alpha ? color : color.slice(0, 7)).toLowerCase();
  return undefined;
}

const colorFrom = (...values: unknown[]) => values.map((value) => hex(value)).find(Boolean);

function variantFromBackground(background: string): 'light' | 'dark' {
  const channels = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16) / 255)
    .map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.179 ? 'light' : 'dark';
}

// Translate the common TextMate scopes into the token categories Varin exposes.
function syntaxColors(settings: unknown, base: Theme['colors']['syntax']['base']): Theme['colors']['syntax']['base'] {
  if (!Array.isArray(settings)) return base;
  const result = { ...base };
  const mappings: [keyof typeof result, string[]][] = [
    ['comment', ['comment']], ['string', ['string']], ['number', ['constant.numeric']],
    ['keyword', ['keyword', 'storage']], ['operator', ['keyword.operator']],
    ['function', ['entity.name.function', 'support.function', 'variable.function']],
    ['type', ['entity.name.type', 'support.type', 'support.class', 'entity.name.class']],
    ['variable', ['variable']],
  ];
  const specificity = new Map<keyof typeof result, number>();
  for (const item of settings) {
    const rule = record(item); const style = record(rule?.settings);
    const color = hex(style?.foreground);
    if (!color) continue;
    const scopes = Array.isArray(rule?.scope) ? rule.scope : typeof rule?.scope === 'string' ? rule.scope.split(',') : [];
    for (const scopeValue of scopes) {
      if (typeof scopeValue !== 'string') continue;
      const scope = scopeValue.trim();
      for (const [field, prefixes] of mappings) {
        const match = prefixes.find((prefix) => scope === prefix || scope.startsWith(`${prefix}.`));
        if (!match || (field === 'keyword' && scope.startsWith('keyword.operator'))) continue;
        const score = match.length + (scope === match ? 100 : 0);
        if (score > (specificity.get(field) ?? -1)) { result[field] = color; specificity.set(field, score); }
      }
    }
  }
  return result;
}

/** Convert Codex's exported editor theme and chromeTheme into Varin's theme model. */
export function parseCodexTheme(input: Record<string, unknown>): Theme | undefined {
  const chrome = record(input.chromeTheme) ?? (input.surface !== undefined && input.ink !== undefined ? input : undefined);
  if (!chrome) return undefined;
  const editor = record(input.colors) ?? {};
  const background = colorFrom(chrome.surface, input.bg, editor['editor.background']);
  const foreground = colorFrom(chrome.ink, input.fg, editor['editor.foreground'], editor.foreground);
  if (!background || !foreground) throw new Error('format');
  const variant = input.variant === 'light' || input.variant === 'dark' ? input.variant : variantFromBackground(background);
  const fallback = getDefaultTheme(variant === 'dark');
  const accent = colorFrom(chrome.accent, editor['button.background'], editor['focusBorder']) ?? fallback.colors.primary.base;
  const theme = applyCustomColors(fallback, { accent, background, foreground });
  const editorBackground = colorFrom(editor['editor.background']) ?? background;
  const codePalette = getDefaultTheme(variantFromBackground(editorBackground) === 'dark').colors.syntax;
  const semantic = record(chrome.semanticColors) ?? {};
  const added = hex(semantic.diffAdded); const removed = hex(semantic.diffRemoved);
  const highlights = { ...codePalette.highlights,
    ...(added ? { diffAdded: added, diffAddedBackground: `${added}26` } : {}),
    ...(removed ? { diffRemoved: removed, diffRemovedBackground: `${removed}26` } : {}),
    ...(hex(editor['editorLineNumber.foreground']) ? { lineNumber: hex(editor['editorLineNumber.foreground'])! } : {}),
    ...(hex(editor['editorLineNumber.activeForeground']) ? { lineNumberActive: hex(editor['editorLineNumber.activeForeground'])! } : {}),
  };
  const syntaxBase = syntaxColors(input.settings, { ...codePalette.base,
    background: editorBackground,
    foreground: colorFrom(editor['editor.foreground']) ?? foreground });
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Codex theme';
  const fonts = record(chrome.fonts) ?? {};
  const safeFont = (value: unknown): string | undefined =>
    typeof value === 'string' && !/[{};<>\\\r\n]/.test(value) && !/url\s*\(|@import/i.test(value) ? value : undefined;
  const uiFont = safeFont(fonts.ui); const codeFont = safeFont(fonts.code);
  return { ...theme,
    config: { ...theme.config, fonts: { ...theme.config?.fonts,
      ...(uiFont ? { sans: uiFont } : {}), ...(codeFont ? { mono: codeFont } : {}) } },
    metadata: { ...theme.metadata, id: name, name, variant, description: 'Imported from a Codex theme', tags: [variant, 'codex-import'] },
    colors: { ...theme.colors,
      markdown: { ...theme.colors.markdown, codeBackground: syntaxBase.background,
        codeForeground: syntaxBase.foreground, codeComment: syntaxBase.comment, codeString: syntaxBase.string,
        codeKeyword: syntaxBase.keyword, codeNumber: syntaxBase.number, codeFunction: syntaxBase.function,
        codeVariable: syntaxBase.variable, codeProperty: syntaxBase.variable, codeType: syntaxBase.type,
        codeOperator: syntaxBase.operator },
      syntax: { ...theme.colors.syntax, base: syntaxBase, highlights,
        tokens: { ...codePalette.tokens, commentDoc: syntaxBase.comment, stringEscape: syntaxBase.string,
          functionCall: syntaxBase.function, method: syntaxBase.function, className: syntaxBase.type,
          variableLocal: syntaxBase.variable, variableProperty: syntaxBase.variable } },
      interactive: { ...theme.colors.interactive,
        border: hex(editor['panel.border'], true) ?? theme.colors.interactive.border,
        selection: hex(editor['editor.selectionBackground'], true) ?? theme.colors.interactive.selection,
        cursor: hex(editor['editorCursor.foreground']) ?? theme.colors.interactive.cursor },
      sidebar: { ...theme.colors.sidebar,
        ...(hex(editor['sideBar.background']) ? { background: hex(editor['sideBar.background'])! } : {}),
        ...(hex(editor['sideBar.foreground']) ? { foreground: hex(editor['sideBar.foreground'])! } : {}) },
    },
  };
}
