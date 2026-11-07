import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThemeSystemProvider } from './ThemeSystemContext';
import { useThemeSystem } from './useThemeSystem';
import type { ThemeContextValue } from './theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { VARIN_THEME_STORAGE_KEY } from '@/lib/theme/themeStorage';
import { resetEmbeddedSessionChatCache } from '@/components/layout/contextPanelEmbeddedChat';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), native: vi.fn(), persist: vi.fn(), pointer: vi.fn(), ink: vi.fn(), runtimeKey: 'a', endpoint: undefined as undefined | ((detail: { runtimeKey: string; previousRuntimeKey: string }) => void) }));
vi.mock('@varin/application-client', async (importOriginal) => ({ ...await importOriginal<typeof import('@varin/application-client')>(), runtimeFetch: mocks.fetch, getRuntimeKey: () => mocks.runtimeKey, subscribeRuntimeEndpointChanged: (callback: typeof mocks.endpoint) => { mocks.endpoint = callback; return () => { mocks.endpoint = undefined; }; } }));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => true, isDesktopLocalOriginActive: () => true }));
vi.mock('@/lib/desktopNative', () => ({ setDesktopWindowTheme: mocks.native }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: mocks.persist }));
vi.mock('@/lib/motion/pointer', () => ({ trackRecentPointer: mocks.pointer }));
vi.mock('@/lib/motion/themeInk', () => ({ inkThemeChange: mocks.ink }));
let root: Root;
let current: ThemeContextValue;
let mediaListener: ((event: { matches: boolean }) => void) | undefined;
let stored: string;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
const state = (mode = 'light', lightThemeId = 'nord-light', darkThemeId = 'aura-dark') => JSON.stringify({ mode, lightThemeId, darkThemeId, splash: { light: { background: '#fff', foreground: '#000' }, dark: { background: '#000', foreground: '#fff' } } });
function Consumer() { current = useThemeSystem(); return <p>{current.currentTheme.metadata.id}</p>; }
const mount = async (passive = true) => { await act(async () => root.render(<ThemeSystemProvider passiveTransparent={passive}><Consumer /></ThemeSystemProvider>)); };
const settings = async (detail: object) => { await act(async () => window.dispatchEvent(new window.CustomEvent('varin:settings-synced', { detail }))); };
beforeEach(() => {
  vi.clearAllMocks(); mocks.persist.mockResolvedValue(true); mocks.runtimeKey = 'a'; mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ themes: [] }) });
  mocks.ink.mockImplementation((apply: () => void) => apply());
  const { document, window } = parseHTML('<html><head></head><body style="background-color:transparent"><div id="root"></div></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stored = state();
  const cache = new Map<string, string>();
  storage = { getItem: vi.fn((key: string) => key === VARIN_THEME_STORAGE_KEY ? stored : cache.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { cache.set(key, value); }) };
  Object.defineProperties(window, {
    location: { configurable: true, value: { search: '', origin: 'http://localhost' } },
    localStorage: { configurable: true, value: storage },
    matchMedia: { configurable: true, value: () => ({ matches: false, addEventListener: (_: string, listener: typeof mediaListener) => { mediaListener = listener; }, removeEventListener: () => { mediaListener = undefined; } }) },
    requestAnimationFrame: { configurable: true, value: vi.fn(() => 1) },
    cancelAnimationFrame: { configurable: true, value: vi.fn() },
  });
  resetEmbeddedSessionChatCache(); mediaListener = undefined;
  root = createRoot(document.getElementById('root')!);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('passively follows stored, settings, storage and OS themes without owning chrome, motion or preferences', async () => {
  await mount();
  expect(current.currentTheme.metadata.id).toBe('nord-light');
  await settings({ useSystemTheme: false, themeVariant: 'dark', darkThemeId: 'aura-dark' });
  expect(current.currentTheme.metadata.id).toBe('aura-dark');
  stored = state('system', 'vesper-light', 'mono-dark');
  await act(async () => {
    const event = new window.Event('storage');
    Object.assign(event, { key: VARIN_THEME_STORAGE_KEY, storageArea: window.localStorage });
    window.dispatchEvent(event);
  });
  expect(current.currentTheme.metadata.id).toBe('vesper-light');
  await act(async () => mediaListener?.({ matches: true }));
  expect(current.currentTheme.metadata.id).toBe('mono-dark');
  await act(async () => { current.setThemeMode('light'); current.setLightThemePreference('varin-light'); current.setDarkThemePreference('varin-dark'); });
  expect(current.currentTheme.metadata.id).toBe('mono-dark');
  expect(document.body.style.backgroundColor).toBe('transparent');
  expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
  expect(document.getElementById('opencode-theme-variables')?.textContent).toContain('--primary-base: #FFFFFF');
  expect(storage.setItem).not.toHaveBeenCalled(); expect(mocks.persist).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.ink).not.toHaveBeenCalled(); expect(mocks.pointer).not.toHaveBeenCalled();
});

it('retains active provider chrome, native, saved preference and ink behavior', async () => {
  await mount(false);
  expect(document.body.style.backgroundColor).toBe(current.currentTheme.colors.surface.background);
  expect(storage.setItem).toHaveBeenCalled(); expect(mocks.native).toHaveBeenCalled(); expect(mocks.pointer).toHaveBeenCalled();
  await act(async () => current.setThemeMode('dark'));
  expect(current.currentTheme.metadata.id).toBe('aura-dark'); expect(mocks.persist).toHaveBeenCalled(); expect(mocks.ink).toHaveBeenCalledTimes(1);
});

it('validates custom themes and rejects superseded requests across Host changes', async () => {
  let oldResponse!: (response: unknown) => void;
  mocks.fetch.mockReturnValueOnce(new Promise(resolve => { oldResponse = resolve; }));
  await mount();
  const custom = { ...getDefaultTheme(false), metadata: { ...getDefaultTheme(false).metadata, id: 'custom-light' } };
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ themes: [custom, { metadata: { id: 'bad' } }] }) });
  await act(async () => { mocks.runtimeKey = 'b'; mocks.endpoint?.({ runtimeKey: 'b', previousRuntimeKey: 'a' }); });
  await settings({ useSystemTheme: false, themeVariant: 'light', lightThemeId: 'custom-light' });
  expect(current.currentTheme).toEqual(custom);
  expect(current.availableThemes.some(theme => theme.metadata.id === 'bad')).toBe(false);
  await act(async () => oldResponse({ ok: true, json: async () => ({ themes: [{ ...custom, metadata: { ...custom.metadata, name: 'stale Host' } }] }) }));
  expect(current.currentTheme).toEqual(custom); expect(current.customThemesLoading).toBe(false);
  expect(storage.setItem).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
});

it('keeps the newer same-Host theme generation and accepts validated same-ID live edits', async () => {
  let finishOld!: (response: unknown) => void;
  mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
  await mount();
  const custom = { ...getDefaultTheme(false), metadata: { ...getDefaultTheme(false).metadata, id: 'custom-light' } };
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ themes: [custom] }) });
  await act(async () => current.reloadCustomThemes());
  await settings({ useSystemTheme: false, themeVariant: 'light', lightThemeId: 'custom-light' });
  await act(async () => finishOld({ ok: true, json: async () => ({ themes: [] }) }));
  expect(current.currentTheme).toEqual(custom);
  await settings({ lightThemeId: 'varin-light' });
  const edited = { ...getDefaultTheme(false), colors: { ...getDefaultTheme(false).colors, primary: { ...getDefaultTheme(false).colors.primary, base: '#886655' } } };
  await act(async () => window.dispatchEvent(new window.CustomEvent('varin:theme-hmr', { detail: edited })));
  expect(current.currentTheme.colors.primary.base).toBe('#886655');
  await act(async () => window.dispatchEvent(new window.CustomEvent('varin:theme-hmr', { detail: { metadata: edited.metadata } })));
  expect(current.currentTheme.colors.primary.base).toBe('#886655');
  expect(storage.setItem).not.toHaveBeenCalled(); expect(mocks.ink).not.toHaveBeenCalled();
});

it('applies, saves and resets custom colors for the selected theme', async () => {
  await mount(false);
  const themeId = current.currentTheme.metadata.id;
  const initial = current.currentTheme.colors.surface.background;
  await act(async () => current.setCustomColor(themeId, 'background', '#f5f3ee'));
  expect(current.currentTheme.colors.surface.background).toBe('#f5f3ee');
  expect(document.getElementById('opencode-theme-variables')?.textContent).toContain('--surface-background: #f5f3ee');
  expect(mocks.persist).toHaveBeenLastCalledWith(expect.objectContaining({ themeLibrary: { themes: [], colors: { [themeId]: { background: '#f5f3ee' } } } }));
  await act(async () => current.resetCustomColors(themeId));
  expect(current.currentTheme.colors.surface.background).toBe(initial);
  expect(mocks.persist).toHaveBeenLastCalledWith(expect.objectContaining({ themeLibrary: { themes: [], colors: {} } }));
});

it('imports a copied palette, applies it and can remove it', async () => {
  await mount(false);
  const palette = JSON.stringify({ name: 'Paper', variant: 'light', colors: {
    accent: '#da7756', background: '#f5f3ee', foreground: '#1d1b16',
  } });
  await act(async () => current.importTheme(palette));
  expect(current.currentTheme.metadata.id).toBe('imported-Paper');
  expect(current.currentTheme.colors.surface.background).toBe('#f5f3ee');
  expect(mocks.persist).toHaveBeenLastCalledWith(expect.objectContaining({ lightThemeId: 'imported-Paper',
    themeLibrary: { themes: [expect.objectContaining({ metadata: expect.objectContaining({ id: 'imported-Paper' }) })], colors: {} } }));
  await act(async () => current.removeImportedTheme('imported-Paper'));
  expect(current.currentTheme.metadata.id).not.toBe('imported-Paper');
  expect(mocks.persist).toHaveBeenLastCalledWith(expect.objectContaining({ themeLibrary: { themes: [], colors: {} } }));
});

it('restores an imported definition and overrides from shared settings, scoped to the Host', async () => {
  await mount(false);
  const theme = { ...getDefaultTheme(false), metadata: { ...getDefaultTheme(false).metadata, id: 'imported-Shared' } };
  await settings({ useSystemTheme: false, themeVariant: 'light', lightThemeId: theme.metadata.id,
    themeLibrary: { themes: [theme], colors: { [theme.metadata.id]: { accent: '#aa5533' } } } });
  expect(current.currentTheme.colors.primary.base).toBe('#aa5533');
  expect(current.importedThemes).toHaveLength(1);
  await act(async () => { mocks.runtimeKey = 'b'; mocks.endpoint?.({ runtimeKey: 'b', previousRuntimeKey: 'a' }); });
  expect(current.importedThemes).toEqual([]);
  expect(current.customColors).toEqual({});
});

it('keeps the current theme when saving an import fails', async () => {
  await mount(false);
  const original = current.currentTheme;
  mocks.persist.mockResolvedValue(false);
  await act(async () => {
    await expect(current.importTheme(JSON.stringify(original))).rejects.toThrow('storage');
  });
  expect(current.currentTheme).toEqual(original);
  expect(current.importedThemes).toEqual([]);
});

it('does not restore the imported selection over a choice made while its save is pending', async () => {
  await mount(false);
  let finish!: (value: boolean) => void;
  mocks.persist.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  let importing!: Promise<void>;
  await act(async () => {
    importing = current.importTheme(JSON.stringify({ name: 'Pending', variant: 'light',
      colors: { accent: '#336699', background: '#f5f3ee', foreground: '#222222' } }));
  });
  await act(async () => current.setLightThemePreference('varin-light'));
  expect(mocks.persist).toHaveBeenLastCalledWith(expect.objectContaining({ lightThemeId: 'varin-light',
    themeLibrary: expect.objectContaining({ themes: [expect.objectContaining({ metadata: expect.objectContaining({ id: 'imported-Pending' }) })] }) }));
  await act(async () => { finish(true); await importing; });
  expect(current.lightThemeId).toBe('varin-light');
});
