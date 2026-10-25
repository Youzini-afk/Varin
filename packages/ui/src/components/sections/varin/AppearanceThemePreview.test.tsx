import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { getDefaultTheme, getThemeById } from '@/lib/theme/themes';
import { AppearanceThemePreview } from './AppearanceThemePreview';
import { ThemePicker } from './ThemePicker';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
vi.mock('@/contexts/useThemeSystem', async () => {
  const { getDefaultTheme } = await import('@/lib/theme/themes');
  return { useThemeSystem: () => ({ themeMode: 'dark', currentTheme: getDefaultTheme(true), setThemeMode: () => {} }) };
});
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));

it('previews the selected light palette while the application remains dark, with actual fallback surfaces and syntax', () => {
  const theme = getThemeById('nord-light')!;
  const { document } = parseHTML(renderToStaticMarkup(<AppearanceThemePreview lightTheme={theme} previewVariant="light" />));
  const preview = document.querySelector<HTMLElement>('[data-theme-preview="nord-light"]')!;
  expect(preview).not.toBeNull();
  expect(preview.style.getPropertyValue('--workbench-frame')).toBe(theme.colors.surface.muted);
  expect(preview.style.getPropertyValue('--sidebar-base')).toBe(theme.colors.surface.muted);
  expect(preview.style.getPropertyValue('--primary-base')).toBe(theme.colors.primary.base);
  expect(preview.style.getPropertyValue('--syntax-string')).toBe(theme.colors.syntax.base.string);
  expect(preview.textContent).toContain('const message = "Hello"');
  expect(preview.style.getPropertyValue('--markdown-link')).toContain('var(--primary-base)');
});

it('keeps custom preview colors and renders background, body and accent swatches rather than syntax colors', () => {
  const original = getDefaultTheme(true);
  const custom = { ...original, metadata: { ...original.metadata, id: 'custom-theme', name: 'My palette' }, colors: { ...original.colors,
    header: { background: '#101218' }, sidebar: { background: '#222633' },
    markdown: { ...original.colors.markdown, body: '#aabbcc', link: '#bbccdd' } } };
  const { document } = parseHTML(renderToStaticMarkup(<>
    <AppearanceThemePreview darkTheme={custom} previewVariant="dark" />
    <ThemePicker themes={[custom]} selected={custom} onChange={() => {}} label="Palette" />
  </>));
  const preview = document.querySelector<HTMLElement>('[data-theme-preview="custom-theme"]')!;
  expect(preview.style.getPropertyValue('--workbench-frame')).toBe('#101218');
  expect(preview.style.getPropertyValue('--sidebar-base')).toBe('#222633');
  expect(preview.style.getPropertyValue('--markdown-link')).toBe('#bbccdd');
  const trigger = document.querySelector('[aria-label="Palette"]')!;
  const swatches = [...trigger.querySelectorAll<HTMLElement>('span[style]')].filter(span => span.style.backgroundColor);
  expect(swatches.map(span => span.style.backgroundColor)).toEqual([custom.colors.surface.background, '#aabbcc', custom.colors.primary.base]);
});
