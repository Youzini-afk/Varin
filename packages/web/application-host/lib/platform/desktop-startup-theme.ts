/** Read-only first-paint projection of the existing settings owner. It is not a
 * frontend preference import and must never include Host or account settings. */
export function desktopStartupTheme(root: Record<string, unknown>) {
  const mode = root.themeMode === 'system' || root.useSystemTheme === true ? 'system'
    : root.themeMode === 'light' || root.themeMode === 'dark' ? root.themeMode
      : root.themeVariant === 'light' || root.themeVariant === 'dark' ? root.themeVariant : 'system';
  const color = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  return {
    mode,
    splash: {
      light: { background: color(root.splashBgLight), foreground: color(root.splashFgLight) },
      dark: { background: color(root.splashBgDark), foreground: color(root.splashFgDark) },
    },
  };
}
