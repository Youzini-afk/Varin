import type { Theme } from '@/types/theme';

// Dependency-free syntax color projection. This is consumed by ordinary code
// and markdown surfaces, so it must not import the Pierre diff runtime merely
// to construct CSS variables.
export const getMarkdownSyntaxVars = (theme: Theme, surface: 'code' | 'prose' = 'code'): Record<string, string> => {
  const base = theme.colors.syntax.base;
  const tokens = theme.colors.syntax.tokens ?? {};
  const status = theme.colors.status;
  // Prose fences have their own reading palette. File previews and tool output
  // keep the theme's syntax palette; neither path needs to re-tokenize on switch.
  const prose = surface === 'prose' ? theme.colors.markdown ?? {} : {};

  return {
    '--md-syntax-foreground': prose.codeForeground || base.foreground,
    '--md-syntax-comment': prose.codeComment || base.comment,
    '--md-syntax-string': prose.codeString || base.string,
    '--md-syntax-number': prose.codeNumber || base.number,
    '--md-syntax-keyword': prose.codeKeyword || base.keyword,
    '--md-syntax-operator': prose.codeOperator || base.operator,
    '--md-syntax-function': prose.codeFunction || base.function,
    '--md-syntax-type': prose.codeType || base.type,
    '--md-syntax-variable': prose.codeVariable || base.variable,
    '--md-syntax-property': prose.codeProperty || tokens.variableProperty || base.variable,
    '--md-syntax-inserted': status.success,
    '--md-syntax-deleted': status.error,
  };
};
