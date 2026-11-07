import type { editor } from 'monaco-editor/editor';

import type { Theme } from '@/types/theme';

const tokenColor = (color: string): string => color.replace(/^#/, '').slice(0, 6);

export const monacoThemeName = (theme: Theme): string => (
  `varin-${theme.metadata.id.replace(/[^a-zA-Z0-9_-]+/g, '-')}`
);

export const createVarinMonacoTheme = (theme: Theme): editor.IStandaloneThemeData => {
  const base = theme.colors.syntax.base;
  const tokens = theme.colors.syntax.tokens ?? {};
  const highlights = theme.colors.syntax.highlights ?? {};
  const { interactive, status, surface } = theme.colors;
  const highContrast = theme.metadata.tags.some((tag) => tag.toLowerCase() === 'high-contrast');

  return {
    base: highContrast
      ? (theme.metadata.variant === 'dark' ? 'hc-black' : 'hc-light')
      : (theme.metadata.variant === 'dark' ? 'vs-dark' : 'vs'),
    inherit: true,
    rules: [
      { token: '', foreground: tokenColor(base.foreground) },
      { token: 'comment', foreground: tokenColor(base.comment), fontStyle: 'italic' },
      { token: 'comment.doc', foreground: tokenColor(tokens.commentDoc ?? base.comment) },
      { token: 'keyword', foreground: tokenColor(base.keyword) },
      { token: 'keyword.control.import', foreground: tokenColor(tokens.keywordImport ?? base.keyword) },
      { token: 'string', foreground: tokenColor(base.string) },
      { token: 'string.escape', foreground: tokenColor(tokens.stringEscape ?? base.string) },
      { token: 'number', foreground: tokenColor(base.number) },
      { token: 'regexp', foreground: tokenColor(tokens.regex ?? base.string) },
      { token: 'operator', foreground: tokenColor(base.operator) },
      { token: 'delimiter', foreground: tokenColor(tokens.punctuation ?? base.comment) },
      { token: 'identifier', foreground: tokenColor(base.variable) },
      { token: 'variable', foreground: tokenColor(base.variable) },
      { token: 'variable.predefined', foreground: tokenColor(tokens.constant ?? base.variable) },
      { token: 'type', foreground: tokenColor(base.type) },
      { token: 'type.identifier', foreground: tokenColor(tokens.className ?? base.type) },
      { token: 'function', foreground: tokenColor(base.function) },
      { token: 'tag', foreground: tokenColor(tokens.tag ?? base.keyword) },
      { token: 'attribute.name', foreground: tokenColor(tokens.tagAttribute ?? base.type) },
      { token: 'attribute.value', foreground: tokenColor(tokens.tagAttributeValue ?? base.string) },
    ],
    colors: {
      'editor.background': base.background,
      'editor.foreground': base.foreground,
      'editorCursor.foreground': interactive.cursor,
      'editor.selectionBackground': interactive.selection,
      'editor.inactiveSelectionBackground': interactive.hover,
      'editor.selectionHighlightBackground': interactive.hover,
      'editor.lineHighlightBackground': surface.overlay,
      'editorLineNumber.foreground': highlights.lineNumber ?? base.comment,
      'editorLineNumber.activeForeground': highlights.lineNumberActive ?? base.foreground,
      'editorGutter.background': base.background,
      'editorIndentGuide.background1': interactive.border,
      'editorIndentGuide.activeBackground1': interactive.borderFocus,
      'editorWhitespace.foreground': surface.subtle,
      'editorBracketMatch.background': interactive.selection,
      'editorBracketMatch.border': interactive.borderFocus,
      'editor.findMatchBackground': interactive.selection,
      'editor.findMatchHighlightBackground': interactive.hover,
      'editor.findRangeHighlightBackground': interactive.hover,
      'editorHoverWidget.background': surface.elevated,
      'editorHoverWidget.foreground': surface.elevatedForeground,
      'editorHoverWidget.border': interactive.border,
      'editorSuggestWidget.background': surface.elevated,
      'editorSuggestWidget.foreground': surface.elevatedForeground,
      'editorSuggestWidget.border': interactive.border,
      'editorSuggestWidget.selectedBackground': interactive.selection,
      'editorSuggestWidget.selectedForeground': interactive.selectionForeground,
      'editorWidget.background': surface.elevated,
      'editorWidget.foreground': surface.elevatedForeground,
      'editorWidget.border': interactive.border,
      'editorStickyScroll.background': base.background,
      'editorStickyScroll.border': interactive.border,
      'editorStickyScrollHover.background': surface.overlay,
      'editorError.foreground': status.error,
      'editorWarning.foreground': status.warning,
      'editorInfo.foreground': status.info,
      'diffEditor.insertedTextBackground': highlights.diffAddedBackground ?? status.successBackground,
      'diffEditor.removedTextBackground': highlights.diffRemovedBackground ?? status.errorBackground,
      'diffEditor.insertedLineBackground': highlights.diffAddedBackground ?? status.successBackground,
      'diffEditor.removedLineBackground': highlights.diffRemovedBackground ?? status.errorBackground,
      'minimap.background': base.background,
      'minimap.selectionHighlight': interactive.selection,
      'minimap.findMatchHighlight': interactive.active,
      'editorOverviewRuler.border': interactive.border,
      'editorOverviewRuler.errorForeground': status.error,
      'editorOverviewRuler.warningForeground': status.warning,
      'editorOverviewRuler.infoForeground': status.info,
      'scrollbarSlider.background': interactive.hover,
      'scrollbarSlider.hoverBackground': interactive.active,
      'scrollbarSlider.activeBackground': interactive.selection,
      focusBorder: interactive.focusRing,
    },
  };
};

export const registerVarinMonacoTheme = (
  monaco: typeof import('monaco-editor/editor'),
  theme: Theme,
): string => {
  const name = monacoThemeName(theme);
  monaco.editor.defineTheme(name, createVarinMonacoTheme(theme));
  return name;
};
