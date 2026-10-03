import { describe, expect, test, vi } from 'vitest';
import type { SettingsRuntimeContext } from './page-types';

vi.doMock('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));

const { registerBuiltinSettingsWorkbench } = await import('@/workbenches/settings/register');
registerBuiltinSettingsWorkbench();

const { getSettingsPageMeta, getSettingsPageMetadata, resolveSettingsSlug } = await import('./metadata');
const {
  ensureBuiltinSettingsContributions,
  varinSurfaceRuntime,
  setBuiltinSettingsContributionsEnabled,
} = await import('./surface-registry');
const { BUILTIN_PI_INTEGRATION_DEFINITIONS, activateBuiltinPiIntegration } = await import('@/lib/extensions/builtin-pi-integrations');

await ensureBuiltinSettingsContributions();
for (const [index, definition] of BUILTIN_PI_INTEGRATION_DEFINITIONS.entries()) {
  if (!definition.manifest.contributions?.some((contribution) => contribution.kind === 'settings-page')) continue;
  await varinSurfaceRuntime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: definition.manifest.id,
      extensionVersion: definition.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: `builtins-test-${index}`,
    },
  }, activateBuiltinPiIntegration(definition));
}

const runtimeContext = (mcpInstalled: boolean): SettingsRuntimeContext => ({
  isDesktop: false,
  isMobile: false,
  isWeb: true,
  mcpInstalled,
});

describe('settings metadata', () => {


  test('exposes the split MCP page only for an installed adapter', async () => {
    await ensureBuiltinSettingsContributions();
    const mcp = getSettingsPageMetadata().find((page) => page.slug === 'mcp');
    expect(mcp?.kind).toBe('split');
    expect(mcp?.isAvailable?.(runtimeContext(false))).toBe(false);
    expect(mcp?.isAvailable?.(runtimeContext(true))).toBe(true);
  });


  test('adds and withdraws an extension-owned settings page without a document refresh', async () => {
    await ensureBuiltinSettingsContributions();
    const handle = await varinSurfaceRuntime.activate({
      owner: {
        extensionId: 'dev.example.settings-test',
        extensionVersion: '1.0.0',
        entrypointId: 'main',
        realmId: 'settings-test-realm',
        hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
        desiredRevision: 1,
        generation: 1,
      },
    }, (context) => {
      context.contribute({
        id: 'dev.example.settings-test.page',
        kind: 'settings-page',
        contractVersion: 1,
        supports: [varinSurfaceRuntime.surface],
        placement: { slot: 'settings.nav.general', order: 9 },
        data: {
          slug: 'extension-test',
          title: 'Extension Test',
          titleKey: 'settings.page.general.title',
          group: 'general',
          kind: 'single',
          icon: 'settings-3',
          order: 9,
          keywords: ['extension-test'],
        },
      }, { renderContent: () => null });
    });

    expect(getSettingsPageMeta('extension-test')?.title).toBe('Extension Test');
    expect(resolveSettingsSlug('extension-test')).toBe('extension-test');
    await handle.deactivate(2, 2);
    expect(getSettingsPageMeta('extension-test')).toBe(null);
    expect(resolveSettingsSlug('extension-test')).toBe('home');
  });

  test('withdraws and restores the built-in Settings contribution generation in place', async () => {
    await ensureBuiltinSettingsContributions();
    expect(getSettingsPageMeta('general')).not.toBe(null);

    await setBuiltinSettingsContributionsEnabled(false);
    expect(getSettingsPageMeta('general')).toBe(null);
    expect(getSettingsPageMeta('agents')).not.toBe(null);

    await setBuiltinSettingsContributionsEnabled(true);
    expect(getSettingsPageMeta('general')).not.toBe(null);
  });

  test('applies layout visibility through the same live Settings registry', async () => {
    await ensureBuiltinSettingsContributions();
    varinSurfaceRuntime.setLayoutReferences([
      { contributionId: 'varin.builtin.settings.page.general', visible: false },
      { contributionId: 'dev.example.temporarily-missing', order: 5 },
    ]);
    expect(getSettingsPageMeta('general')).toBe(null);
    expect(varinSurfaceRuntime.getSnapshot().layoutReferences[1]?.contributionId)
      .toBe('dev.example.temporarily-missing');

    varinSurfaceRuntime.setLayoutReferences([]);
    expect(getSettingsPageMeta('general')).not.toBe(null);
  });
});
