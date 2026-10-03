export function speechLanguageLabel(names: Intl.DisplayNames, code: string): string {
    try { return names.of(code === 'jw' ? 'jv' : code) ?? code; }
    catch { return code; }
}
