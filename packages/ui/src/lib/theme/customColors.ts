import type { Theme } from '@/types/theme';

export type CustomColorField = 'accent' | 'background' | 'foreground';
export type CustomColors = Partial<Record<CustomColorField, string>>;
export type CustomColorsByTheme = Record<string, CustomColors>;
export function normalizeCustomColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
  return value.toLowerCase();
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

/** Project named palette roles first. Equal source colors must not collapse distinct roles. */
export function applyCustomColors(theme: Theme, overrides?: CustomColors): Theme {
  if (!overrides || !Object.keys(overrides).length) return theme;
  const { primary, surface, interactive } = theme.colors;
  const background = overrides.background ?? surface.background;
  const foreground = overrides.foreground ?? surface.foreground;
  const accent = overrides.accent ?? primary.base;
  const nextPrimary = { ...primary };
  const nextSurface = { ...surface };
  const nextInteractive = { ...interactive };
  if (overrides.background) {
    Object.assign(nextSurface, { background, muted: mix(background, foreground, 0.035),
      elevated: mix(background, foreground, 0.02), subtle: mix(background, foreground, 0.09) });
    Object.assign(nextInteractive, { border: mix(background, foreground, 0.15),
      borderHover: mix(background, foreground, 0.25), hover: mix(background, foreground, 0.07),
      active: mix(background, foreground, 0.12) });
  }
  if (overrides.foreground) {
    Object.assign(nextSurface, { foreground, elevatedForeground: foreground,
      mutedForeground: mix(foreground, background, 0.43) });
    Object.assign(nextInteractive, { selectionForeground: foreground, cursor: foreground });
  }
  if (overrides.accent) {
    const rgb = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    Object.assign(nextPrimary, { base: accent, hover: mix(accent, foreground, 0.1),
      active: mix(accent, foreground, 0.2), emphasis: mix(accent, foreground, 0.1),
      muted: `${accent}66`, foreground: luminance > 0.179 ? '#000000' : '#ffffff' });
    Object.assign(nextInteractive, { borderFocus: `${accent}88`, focus: accent,
      focusRing: `${accent}50`, selection: `${accent}30` });
  }
  // Component JSON stores literal colors, not palette references. Only propagate
  // an unambiguous reference; a shared literal cannot tell us which role it meant.
  const mappings = new Map<string, Set<string>>();
  const collect = (before: object, after: object) => {
    for (const [key, value] of Object.entries(before)) {
      const oldColor = normalizeCustomColor(value);
      const newColor = normalizeCustomColor((after as Record<string, unknown>)[key]);
      if (!oldColor || !newColor) continue;
      const values = mappings.get(oldColor) ?? new Set<string>();
      values.add(newColor);
      mappings.set(oldColor, values);
    }
  };
  collect(primary, nextPrimary); collect(surface, nextSurface); collect(interactive, nextInteractive);
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
      const values = mappings.get(value.slice(0, 7).toLowerCase());
      return values?.size === 1 ? [...values][0] + value.slice(7) : value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  const colors = replace(theme.colors) as Theme['colors'];
  colors.primary = nextPrimary;
  colors.surface = nextSurface;
  colors.interactive = nextInteractive;
  colors.status = theme.colors.status;
  colors.pr = theme.colors.pr;
  colors.syntax = { ...theme.colors.syntax, base: { ...theme.colors.syntax.base,
    background: overrides.background ?? theme.colors.syntax.base.background,
    foreground: overrides.foreground ?? theme.colors.syntax.base.foreground } };
  if (overrides.accent && colors.buttons?.primary) {
    colors.buttons.primary = { ...colors.buttons.primary, bg: nextPrimary.base, fg: nextPrimary.foreground,
      hover: nextPrimary.hover, active: nextPrimary.active };
  }
  return { ...theme, colors };
}
