import type { Theme } from '@/types/theme';
import { isValidTheme } from '@/contexts/theme-validation';
import { getDefaultTheme } from './themes';
import { applyCustomColors, normalizeCustomColor } from './customColors';
import { parseCodexTheme } from './codexTheme';

export const IMPORTED_THEMES_STORAGE_KEY = 'varin.imported-themes.v1';
const MAX_THEME_BYTES = 1024 * 1024;

// Themes produce CSS variables. Do not permit JSON to break out of a CSS value.
function safeCssValues(value: unknown): boolean {
  if (typeof value === 'string') return value.length <= 2048 && !/[{};<>\\]/.test(value) && !/url\s*\(|@import/i.test(value);
  if (Array.isArray(value)) return value.every(safeCssValues);
  if (value && typeof value === 'object') return Object.entries(value).every(([key, item]) => /^[a-zA-Z0-9_.-]+$/.test(key) && safeCssValues(item));
  return value === undefined || typeof value === 'boolean' || typeof value === 'number';
}

const recordCodexTheme = (object: Record<string, unknown>): Theme | undefined => parseCodexTheme(object);

export function parseImportedTheme(raw: string): Theme {
  if (new TextEncoder().encode(raw).length > MAX_THEME_BYTES) throw new Error('size');
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Error('json'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('format');
  const object = input as Record<string, unknown>;
  let theme: Theme;
  if (isValidTheme(input)) {
    theme = input;
  } else if (object.chromeTheme !== undefined || (object.surface !== undefined && object.ink !== undefined)) {
    const codexTheme = recordCodexTheme(object);
    if (!codexTheme) throw new Error('format');
    theme = codexTheme;
  } else {
    // A small palette is convenient to copy from another editor or message.
    const palette = object.colors && typeof object.colors === 'object' && !Array.isArray(object.colors)
      ? object.colors as Record<string, unknown> : object;
    const accent = normalizeCustomColor(palette.accent);
    const background = normalizeCustomColor(palette.background);
    const foreground = normalizeCustomColor(palette.foreground);
    const variant = object.variant ?? object.mode;
    if (!accent || !background || !foreground || (variant !== 'light' && variant !== 'dark')) throw new Error('format');
    theme = applyCustomColors(getDefaultTheme(variant === 'dark'), { accent, background, foreground });
    const name = typeof object.name === 'string' && object.name.trim() ? object.name.trim() : 'Imported theme';
    theme = { ...theme, metadata: { ...theme.metadata, id: name, name, variant } };
  }
  if (!safeCssValues(theme.colors) || (theme.config && !safeCssValues(theme.config))) throw new Error('unsafe');
  const rawId = theme.metadata.id.replace(/^imported-/, '');
  const slug = rawId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 65);
  // Retain stable, distinct IDs for non-Latin theme names.
  const hash = [...rawId].reduce((state, char) => Math.imul(state ^ char.codePointAt(0)!, 16777619) >>> 0, 2166136261).toString(16);
  const originalId = /[^a-zA-Z0-9_-]/.test(rawId) ? `${slug || 'theme'}-${hash}` : slug;
  if (!originalId || theme.metadata.name.length > 120) throw new Error('format');
  return { ...theme, metadata: { ...theme.metadata, id: `imported-${originalId}`,
    name: theme.metadata.name.trim(), description: typeof theme.metadata.description === 'string' ? theme.metadata.description : '',
    version: typeof theme.metadata.version === 'string' ? theme.metadata.version : '1.0.0',
    tags: Array.isArray(theme.metadata.tags) ? theme.metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [] } };
}

export function readImportedThemes(): Theme[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(IMPORTED_THEMES_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value) => { try { return [parseImportedTheme(JSON.stringify(value))]; } catch { return []; } });
  } catch { return []; }
}

export function writeImportedThemes(themes: Theme[]): void {
  // Surface storage errors to the caller instead of reporting a successful import.
  window.localStorage.setItem(IMPORTED_THEMES_STORAGE_KEY, JSON.stringify(themes));
}
