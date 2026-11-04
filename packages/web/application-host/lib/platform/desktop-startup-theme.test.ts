import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDesktopSettingsOwner } from '../../desktop-settings.js';
import { desktopStartupTheme } from './desktop-startup-theme.js';

it('projects saved startup colors without changing settings or leaking other snapshot data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varin-startup-theme-'));
  try {
    const file = path.join(directory, 'settings.json');
    const saved = JSON.stringify({
      useSystemTheme: false, themeVariant: 'dark',
      splashBgLight: '#fdf6e3', splashFgLight: '#657b83', splashBgDark: '#002b36', splashFgDark: '#839496',
      desktopLocalClientToken: 'private-local-token', openaiApiKey: 'private-api-key',
      requestHeaders: { Authorization: 'private-remote-header' },
    });
    await writeFile(file, saved);
    const snapshot = await createDesktopSettingsOwner(file)('snapshot') as { startupTheme: unknown };
    expect(snapshot.startupTheme).toEqual({ mode: 'dark', splash: {
      light: { background: '#fdf6e3', foreground: '#657b83' },
      dark: { background: '#002b36', foreground: '#839496' },
    } });
    expect(JSON.stringify(snapshot.startupTheme)).not.toContain('private-');
    expect(await readFile(file, 'utf8')).toBe(saved);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps system intent ahead of the last resolved variant and tolerates missing settings', () => {
  expect(desktopStartupTheme({ useSystemTheme: true, themeVariant: 'dark' }).mode).toBe('system');
  expect(desktopStartupTheme({ themeMode: 'system', themeVariant: 'light' }).mode).toBe('system');
  expect(desktopStartupTheme({ themeMode: 'light', themeVariant: 'dark' }).mode).toBe('light');
  expect(desktopStartupTheme({ themeVariant: 'dark' }).mode).toBe('dark');
  expect(desktopStartupTheme({ themeMode: 'invalid', splashBgDark: 42 }).mode).toBe('system');
  expect(desktopStartupTheme({}).splash.dark.background).toBeUndefined();
});
