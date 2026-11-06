import type { Theme } from '@/types/theme';

export type CustomColorField = 'accent' | 'background' | 'foreground';
export type CustomColors = Partial<Record<CustomColorField, string>>;
export type CustomColorsByTheme = Record<string, CustomColors>;
export const CUSTOM_COLORS_STORAGE_KEY = 'varin.custom-colors.v1';

export function normalizeCustomColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  return value.toLowerCase();
}

export function readCustomColors(): CustomColorsByTheme {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(CUSTOM_COLORS_STORAGE_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result: CustomColorsByTheme = {};
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const source = value as Record<string, unknown>;
      const colors: CustomColors = {};
      for (const field of ['accent', 'background', 'foreground'] as const) {
        const color = normalizeCustomColor(source[field]);
        if (color) colors[field] = color;
      }
      if (Object.keys(colors).length) result[id] = colors;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeCustomColors(colors: CustomColorsByTheme): void {
  try { window.localStorage.setItem(CUSTOM_COLORS_STORAGE_KEY, JSON.stringify(colors)); } catch { /* storage may be disabled */ }
}

const mix = (base: string, target: string, amount: number): string => {
  const a = normalizeCustomColor(base);
  const b = normalizeCustomColor(target);
  if (!a || !b) return base;
  const parts = [1, 3, 5].map((i) => {
    const x = parseInt(a.slice(i, i + 2), 16);
    const y = parseInt(b.slice(i, i + 2), 16);
    return Math.round(x * (1 - amount) + y * amount).toString(16).padStart(2, '0');
  });
  return `#${parts.join('')}`;
};

/** Replace palette references throughout component colors while preserving alpha and syntax colors. */
export function applyCustomColors(theme: Theme, overrides?: CustomColors): Theme {
  if (!overrides || !Object.keys(overrides).length) return theme;
  const { primary, surface } = theme.colors;
  const background = overrides.background ?? surface.background;
  const foreground = overrides.foreground ?? surface.foreground;
  const accent = overrides.accent ?? primary.base;
  const mappings = new Map<string, string>();
  const add = (oldValue: string | undefined, newValue: string | undefined) => {
    const oldColor = normalizeCustomColor(oldValue);
    const newColor = normalizeCustomColor(newValue);
    if (oldColor && newColor) mappings.set(oldColor, newColor);
  };
  if (overrides.background) {
    add(surface.background, background);
    add(surface.muted, mix(background, foreground, 0.035));
    add(surface.elevated, mix(background, foreground, 0.02));
    add(surface.subtle, mix(background, foreground, 0.09));
  }
  if (overrides.foreground) {
    add(surface.foreground, foreground);
    add(surface.elevatedForeground, foreground);
    add(surface.mutedForeground, mix(foreground, background, 0.43));
  }
  if (overrides.accent) {
    add(primary.base, accent);
    add(primary.hover, mix(accent, foreground, 0.1));
    add(primary.active, mix(accent, foreground, 0.2));
    add(primary.emphasis, mix(accent, foreground, 0.1));
  }
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
      const base = mappings.get(value.slice(0, 7).toLowerCase());
      return base ? base + value.slice(7) : value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    }
    return value;
  };
  const colors = replace(theme.colors) as Theme['colors'];
  // Preserve readable button ink when a surface happened to use the same color.
  colors.primary.foreground = primary.foreground;
  if (overrides.accent) {
    const rgb = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    colors.primary.foreground = luminance > 0.179 ? '#000000' : '#ffffff';
    if (colors.buttons?.primary) colors.buttons.primary.fg = colors.primary.foreground;
  }
  // These semantic colors describe content, not the app palette.
  colors.status = theme.colors.status;
  colors.pr = theme.colors.pr;
  colors.syntax = { ...theme.colors.syntax, base: { ...theme.colors.syntax.base,
    background: overrides.background ?? theme.colors.syntax.base.background,
    foreground: overrides.foreground ?? theme.colors.syntax.base.foreground } };
  return { ...theme, colors };
}
