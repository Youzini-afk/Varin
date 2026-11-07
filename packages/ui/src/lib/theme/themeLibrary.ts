import { getRuntimeKey, normalizeThemeLibrary, type ThemeLibrary } from '@varin/application-client';
import { parseImportedTheme } from './importedThemes';

// A first-paint cache, scoped to the Host. The settings API remains authoritative.
export const themeLibraryCacheKey = () => `varin.theme-library.v1:${getRuntimeKey()}`;
export function resolveThemeLibrary(value: unknown) {
  const library = normalizeThemeLibrary(value);
  return {
    themes: (library?.themes ?? []).flatMap((theme) => {
      try { return [parseImportedTheme(JSON.stringify(theme))]; } catch { return []; }
    }),
    colors: library?.colors ?? {},
  };
}
export function readThemeLibraryCache() {
  try { return resolveThemeLibrary(JSON.parse(window.localStorage.getItem(themeLibraryCacheKey()) ?? 'null')); }
  catch { return resolveThemeLibrary(null); }
}
export function writeThemeLibraryCache(library: ThemeLibrary) {
  try { window.localStorage.setItem(themeLibraryCacheKey(), JSON.stringify(library)); }
  catch { /* The Host owns the data; storage is only a first-paint optimization. */ }
}
