import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { useAppFontEffects } from './useAppFontEffects';

const mock = vi.hoisted(() => ({
  fonts: { uiFont: 'system', monoFont: 'system-mono' },
  theme: { metadata: { id: 'imported-codex', tags: ['codex-import'] }, config: { fonts: { sans: 'Figtree, "Noto Sans CJK SC"', mono: 'JetBrains Mono' } } },
}));
vi.mock('@/hooks/useFontPreferences', () => ({ useFontPreferences: () => mock.fonts }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: mock.theme }) }));
vi.mock('@/lib/fontLoader', () => ({ loadUiFont: vi.fn(), loadMonoFont: vi.fn() }));

function Probe() { useAppFontEffects(); return null; }
afterEach(() => vi.unstubAllGlobals());

it('uses imported Codex fonts with System defaults and respects explicit font choices', async () => {
  const { document, window } = parseHTML('<html><head></head><body><div id="root"></div></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<Probe />));
  expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('Figtree, "Noto Sans CJK SC"');
  expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('JetBrains Mono');
  mock.fonts = { uiFont: 'inter', monoFont: 'system-mono' };
  await act(async () => root.render(<Probe />));
  expect(document.documentElement.style.getPropertyValue('--font-sans')).not.toBe('Figtree, "Noto Sans CJK SC"');
  expect(document.documentElement.style.getPropertyValue('--font-mono')).toBe('JetBrains Mono');
  await act(async () => root.unmount());
});
