import { describe, expect, test, vi } from 'vitest';
import type { SettingsSearchAvailabilityContext } from './search';

vi.doMock('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));

const { registerBuiltinSettingsWorkbench } = await import('@/workbenches/settings/register');
registerBuiltinSettingsWorkbench();

const { buildSettingsSearchResults } = await import('./search');
const { ensureBuiltinSettingsContributions } = await import('./surface-registry');

const runtimeContext = (mcpInstalled: boolean): SettingsSearchAvailabilityContext => ({
  isDesktop: false,
  isDesktopLocalOrigin: false,
  isLinux: false,
  isMac: false,
  isMobile: false,
  isWeb: true,
  isWindows: false,
  mcpInstalled,
});

describe('native settings search', () => {
  test('exposes built-in MCP and omits retired provider/plugin pages', async () => {
    await ensureBuiltinSettingsContributions();
    const build = (query: string) => buildSettingsSearchResults({ getPageTitle: slug => slug, query, runtimeCtx: runtimeContext(false), t: key => key });
    expect(build('mcp').some(result => result.page === 'mcp-connections')).toBe(true);
    expect(build('rtk optimizer').some(result => result.page === 'plugin-settings')).toBe(false);
  });
});
