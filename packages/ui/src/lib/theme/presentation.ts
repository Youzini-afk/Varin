import type { Theme } from '@/types/theme';
import type { I18nKey } from '@/lib/i18n';
import { getThemeById } from './themes';
import { CSSVariableGenerator } from './cssGenerator';

/** The picker describes the actual reading surface, not the syntax palette. */
export function getThemeSwatchColors(theme: Theme): readonly string[] {
  return [theme.colors.surface.background,
    theme.colors.markdown?.body || theme.colors.chat?.assistantMessage || theme.colors.surface.foreground,
    theme.colors.primary.base];
}

export const THEME_COLOR_GROUPS = ['default', 'neutral', 'blue', 'purple', 'green', 'warm', 'custom'] as const;
export type ThemeColorGroup = typeof THEME_COLOR_GROUPS[number];

/** Similar UI accents sit together; their named syntax palettes remain selectable. */
export function getThemeColorGroup(theme: Theme): ThemeColorGroup {
  if (theme.metadata.id === 'varin-dark' || theme.metadata.id === 'varin-light') return 'default';
  const hex = theme.colors.primary.base;
  if (!/^#[\da-f]{6}$/iu.test(hex)) return 'custom';
  const [r, g, b] = [1, 3, 5].map(start => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta < 0.025) return 'neutral';
  const hue = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  return hue >= 200 && hue < 250 ? 'blue' : hue >= 250 && hue < 330 ? 'purple' : hue >= 65 && hue < 200 ? 'green' : 'warm';
}

/** Scope the same resolved variables to the preview, including component fallbacks and reading accents. */
export function getThemePreviewVariables(theme: Theme): Record<`--${string}`, string> {
  const css = new CSSVariableGenerator().generate(theme);
  return Object.fromEntries([...css.matchAll(/^\s*(--[\w-]+):\s*(.+);$/gmu)]
    .map(([, key, value]) => [key, value.replace(/\s*!important$/u, '')]));
}

const presetKeys = {
  'varin': 'settings.theme.preset.varin',
  'flexoki': 'settings.theme.preset.flexoki',
  'fields-of-the-shire': 'settings.theme.preset.fields-of-the-shire',
  'aura': 'settings.theme.preset.aura',
  'ayu': 'settings.theme.preset.ayu',
  'carbonfox': 'settings.theme.preset.carbonfox',
  'catppuccin': 'settings.theme.preset.catppuccin',
  'dracula': 'settings.theme.preset.dracula',
  'gruvbox': 'settings.theme.preset.gruvbox',
  'jetbrains': 'settings.theme.preset.jetbrains',
  'kanagawa': 'settings.theme.preset.kanagawa',
  'monokai': 'settings.theme.preset.monokai',
  'nightowl': 'settings.theme.preset.nightowl',
  'nord': 'settings.theme.preset.nord',
  'onedarkpro': 'settings.theme.preset.onedarkpro',
  'solarized': 'settings.theme.preset.solarized',
  'tokyonight': 'settings.theme.preset.tokyonight',
  'vesper': 'settings.theme.preset.vesper',
  'mono-plus': 'settings.theme.preset.mono-plus',
  'mono': 'settings.theme.preset.mono',
  'vitesse': 'settings.theme.preset.vitesse',
} as const;

/** Translate built-in display copy without changing IDs or user-authored names. */
export function getThemePresentation(theme: Theme, t: (key: I18nKey) => string) {
  const builtin = getThemeById(theme.metadata.id);
  const family = theme.metadata.id.replace(/(?:-(?:light|dark))+$/, '');
  const key = presetKeys[family as keyof typeof presetKeys];
  return {
    name: builtin && key && theme.metadata.name === builtin.metadata.name
      ? t(`${key}.name`) : theme.metadata.name,
    description: builtin && key && theme.metadata.description === builtin.metadata.description
      ? t(`${key}.description`) : theme.metadata.description,
  };
}
