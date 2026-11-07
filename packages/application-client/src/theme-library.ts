/** Theme data travels with the Host's appearance preferences; rendering belongs to the UI. */
export interface ThemeLibrary {
  themes: unknown[];
  colors: Record<string, Partial<Record<'accent' | 'background' | 'foreground', string>>>;
}

export function normalizeThemeLibrary(value: unknown): ThemeLibrary | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const library = value as Record<string, unknown>;
  if (!Array.isArray(library.themes) || !library.colors || typeof library.colors !== 'object' || Array.isArray(library.colors)) return undefined;
  const entries: Array<[string, ThemeLibrary['colors'][string]]> = [];
  for (const [id, entry] of Object.entries(library.colors)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const fields: ThemeLibrary['colors'][string] = {};
    for (const field of ['accent', 'background', 'foreground'] as const) {
      const color = (entry as Record<string, unknown>)[field];
      if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) fields[field] = color.toLowerCase();
    }
    if (Object.keys(fields).length) entries.push([id, fields]);
  }
  return { themes: library.themes, colors: Object.fromEntries(entries) };
}
